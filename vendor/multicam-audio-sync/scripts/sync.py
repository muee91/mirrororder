#!/usr/bin/env python3
"""通用多机位音频同步引擎：TC prior + 音频互相关 + 鲁棒联合拟合。

模型：每台相机的 timecode (TC) 自由连续走（已验证）。因此每台相机是一根
"刚杆"：同一相机内片段位置由 TC 严格给出；相机之间由参考轴上的缓慢变化
仿射修正 delta(t) = a*t + b 联系。音频互相关在大量锚点上测出真实机位差；
鲁棒拟合剔除错误匹配；最后每个片段得到全局位置。

通用性：机位数、帧率、分辨率、目录命名、天命名全部来自 project_config，
不做任何硬编码猜测。参考相机取 cam_list[0]（按字母排序，如 A）。
"""
import numpy as np, pandas as pd, os, sys
from multiprocessing import Pool
from scipy.signal import correlate as scipy_correlate

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config

cfg = get_config()
SR = 8000          # correlation sample rate (decimated from 16k cache)
WORK = cfg.WORK or "/tmp/syncwork"
CAND_MARGIN = 140.0   # 候选窗口：TC 先验 ± margin 秒

# ---------------------------------------------------------------- data loading
def tc_to_sec(s, fps=None):
    fps = fps or cfg.fps
    try:
        h, m, sec, f = s.split(":")
        return int(h)*3600 + int(m)*60 + int(sec) + int(f)/fps
    except Exception:
        return np.nan

def load_data():
    inv = pd.read_csv(f"{WORK}/index.tsv", sep="\t", header=None,
                      names=["id", "day", "cam", "dir", "file"])
    dur = pd.read_csv(f"{WORK}/durations.tsv", sep="\t", header=None,
                      names=["dir", "file", "dur", "size"])
    tc = pd.read_csv(f"{WORK}/tc.tsv", sep="\t", header=None,
                     names=["dir", "file", "tc", "creation"])
    df = inv.merge(dur, on=["dir", "file"]).merge(tc, on=["dir", "file"])
    df["dur"] = pd.to_numeric(df["dur"], errors="coerce")
    df["tc_s"] = df["tc"].apply(tc_to_sec)
    df["day"] = df["day"].astype(str)
    df["cam"] = df["cam"].astype(str)
    # clipn：优先取文件名里的片段序号（如 C001 → 1）；取不到则按 天/相机 内
    # TC 顺序编号，保证每个相机内部编号唯一
    clip = df["file"].str.extract(r"[Cc](\d+)", expand=False)
    df["clipn"] = pd.to_numeric(clip, errors="coerce")
    missing = df["clipn"].isna()
    if missing.any():
        for (day, cam), idx in df.groupby(["day", "cam"]).groups.items():
            sub = df.loc[idx].sort_values(["tc_s", "file"])
            for k, (i, _) in enumerate(sub.iterrows(), 1):
                if df.at[i, "clipn"] != df.at[i, "clipn"]:  # NaN 判等
                    df.at[i, "clipn"] = k
    df["clipn"] = df["clipn"].astype(int)
    # TC is a useful prior, not a hard prerequisite. When a camera has no
    # usable TC, use its deterministic clip order and cumulative durations as
    # a local coordinate; cross-camera audio correlation then solves the offset.
    df["anchor_s"] = np.nan
    for (day, cam), idx in df.groupby(["day", "cam"]).groups.items():
        group = df.loc[idx]
        if group["tc_s"].notna().all():
            df.loc[idx, "anchor_s"] = group["tc_s"]
            continue
        ordered = group.sort_values(["clipn", "file"])
        cursor = 0.0
        for row_index, row in ordered.iterrows():
            df.at[row_index, "anchor_s"] = cursor
            cursor += float(row["dur"] or 0.0)
    return df

def load_audio(id_):
    p = f"{WORK}/audio/{id_}.f32"
    if not os.path.exists(p):
        return None
    return np.fromfile(p, dtype=np.float32)

def decimate(x, factor=2):
    return x[::factor]

# ---------------------------------------------------------------- correlation
def preemph(x, k=0.97):
    return np.concatenate([[x[0]], x[1:] - k * x[:-1]])

def corr_offset(a, b, sr=SR):
    """Real-time offset of a relative to b: pos_a = pos_b + offset.
    (Verified: corr_offset returns pos_a - pos_b, NOT pos_b - pos_a.)
    a, b: float32 mono arrays at sr."""
    if len(a) < sr or len(b) < sr:
        return None, 0.0
    a = preemph(a - a.mean()); b = preemph(b - b.mean())
    a = a / (np.linalg.norm(a) + 1e-9); b = b / (np.linalg.norm(b) + 1e-9)
    c = scipy_correlate(a, b, mode="full", method="fft")
    # np.correlate/scipy 'full' convention: index k -> lag k-(len(b)-1);
    # empirically lag = a_start - b_start, so offset (a_start - b_start) = -lag
    k = int(np.argmax(np.abs(c)))
    lag = k - (len(b) - 1)
    offset = -lag / sr
    # confidence: peak / median of |c| outside +/-5s around peak
    excl = slice(max(0, k - 5*sr), min(len(c), k + 5*sr))
    mask = np.ones(len(c), bool); mask[excl] = False
    med = np.median(np.abs(c[mask])) + 1e-12
    conf = float(np.abs(c[k]) / med)
    return offset, conf

# ---------------------------------------------------------------- matching
def build_blocks(df, day, cam):
    g = df[(df["day"] == day) & (df["cam"] == cam)].sort_values("tc_s").reset_index(drop=True)
    return g

def make_candidates(gX, gY, prior_delta, margin):
    """For each clip in X, candidate clip indices in Y whose TC is near
    TC_X + prior_delta (prior_delta = TC_Y - TC_X approx) within margin."""
    tcX = gX["tc_s"].values; tcY = gY["tc_s"].values
    cand = []
    for i, tx in enumerate(tcX):
        lo, hi = tx + prior_delta - margin, tx + prior_delta + margin
        js = np.where((tcY >= lo) & (tcY <= hi))[0]
        cand.append((i, js))
    return cand


def make_ordinal_candidates(gX, gY):
    """Pair clips by deterministic local order when TC is unavailable.

    Audio correlation remains the authority for the actual inter-camera offset;
    ordinal pairing only limits the expensive correlation search to plausible
    neighboring clips.
    """
    y_by_clip = {}
    for j, value in enumerate(gY["clipn"].astype(int).tolist()):
        y_by_clip.setdefault(value, []).append(j)
    candidates = []
    for i, value in enumerate(gX["clipn"].astype(int).tolist()):
        js = []
        for clip_number in range(value - 1, value + 2):
            js.extend(y_by_clip.get(clip_number, []))
        candidates.append((i, np.asarray(sorted(set(js)), dtype=int)))
    return candidates

def pair_worker(args):
    """Correlate one X clip against one Y clip; return (xid, yid, offset, conf).

    A clip without an audio track is valid media, just not usable as an audio
    correlation anchor. Treat it as zero-confidence evidence instead of letting
    decimation of a missing cache crash the whole synchronization run.
    """
    xid, yid = args
    ax_raw = load_audio(xid)
    ay_raw = load_audio(yid)
    if ax_raw is None or ay_raw is None:
        return (xid, yid, None, 0.0)
    ax = decimate(ax_raw)
    ay = decimate(ay_raw)
    if len(ax) < SR or len(ay) < SR:
        return (xid, yid, None, 0.0)
    off, conf = corr_offset(ax, ay)
    return (xid, yid, off, conf)

def collect_constraints(gX, gY, cand, nproc=8, conf_thresh=5.0, min_dur=5.0):
    """Return list of (tcY, delta, conf) for ALL candidate pairs with conf >= threshold.
    delta = tcX - tcY - offset, where offset = pos_X - pos_Y (corr_offset semantics).
    With X reference (delta_X=0): delta == delta_Y(tcY) - delta_X(tcX) == delta_Y."""
    tasks = []
    meta = {}
    for i, js in cand:
        if gX.iloc[i]["dur"] < min_dur:
            continue
        for j in js:
            if gY.iloc[j]["dur"] < min_dur:
                continue
            tasks.append((str(gX.iloc[i]["id"]), str(gY.iloc[j]["id"])))
            meta[(str(gX.iloc[i]["id"]), str(gY.iloc[j]["id"]))] = (i, j)
    cons = []
    if tasks:
        with Pool(nproc) as pool:
            for xid, yid, off, conf in pool.imap_unordered(pair_worker, tasks, chunksize=64):
                if conf < conf_thresh or off is None:
                    continue
                i, j = meta[(xid, yid)]
                tcX = gX.iloc[i]["anchor_s"]; tcY = gY.iloc[j]["anchor_s"]
                if np.isnan(tcX) or np.isnan(tcY):
                    continue
                delta = tcX - tcY - off
                cons.append((tcY, delta, conf))
    return cons

# ---------------------------------------------------------------- robust fit
def robust_line(x, y, max_iter=5):
    """Theil-Sen slope + intercept, then sigma-clip, then least squares on inliers.
    Returns (a, b, inlier_mask)."""
    x = np.asarray(x, float); y = np.asarray(y, float)
    n = len(x)
    if n < 5:
        return 0.0, float(np.median(y)), np.ones(n, bool)
    # Theil-Sen slope
    slopes = []
    idx = np.random.default_rng(0).choice(n, size=min(n, 400), replace=False)
    xa, ya = x[idx], y[idx]
    for p in range(len(xa)):
        d = xa - xa[p]
        m = d != 0
        if m.sum() > 0:
            slopes.append((ya[m] - ya[p]) / d[m])
    slopes = np.concatenate(slopes) if slopes else np.array([0.0])
    a = float(np.median(slopes))
    b = float(np.median(y - a * x))
    res = y - (a * x + b)
    mad = np.median(np.abs(res)) * 1.4826 + 1e-9
    mask = np.abs(res) < 4 * mad
    for _ in range(max_iter):
        a, b = np.polyfit(x[mask], y[mask], 1)
        res = y - (a * x + b)
        mad = np.median(np.abs(res[mask])) * 1.4826 + 1e-9
        newmask = np.abs(res) < 4 * mad
        if newmask.sum() == mask.sum():
            break
        mask = newmask
    return a, b, mask

def joint_fit(cons, order, conf_min=30.0, dev_max=10.0):
    """Weighted joint fit of delta_k(t)=a_k*t+b_k for every non-reference camera.

    order[0] 是参考相机（delta=0）。cons[(i,j)] = [(t_j, d, conf), ...]，
    含义：在 j 的 TC 时刻 t_j 上，delta_j(t) - delta_i(t) = d
    （d = tc_i - tc_j + 实测offset，见 collect_constraints）。

    鲁棒方案：每个约束族先保留 conf>=conf_min 的，再保留偏离族中位数
    dev_max 秒以内的（杀掉杂散假峰），最后 IRWLS 加权最小二乘。
    返回 {cam: (a, b)}（非参考相机）。
    """
    def clean(cons):
        if not cons:
            return []
        arr = np.array([[t, d, c] for t, d, c in cons])
        hi = arr[arr[:, 2] >= conf_min]
        if len(hi) == 0:
            hi = arr
        med = np.median(hi[:, 1])
        sel = hi[np.abs(hi[:, 1] - med) <= dev_max]
        if len(sel) == 0:
            return []
        return [(float(t), float(d), float(c)) for t, d, c in sel]

    idx = {c: k for k, c in enumerate(order)}
    n_unk = len(order) - 1               # 每个非参考相机 2 个未知数 (a_k, b_k)
    rows = []
    for (i, j), cj in cons.items():
        ki, kj = idx[i], idx[j]
        for t, d, conf in clean(cj):
            vec = [0.0] * (2 * n_unk)
            if kj > 0:
                vec[2 * (kj - 1)] += t
                vec[2 * (kj - 1) + 1] += 1.0
            if ki > 0:
                vec[2 * (ki - 1)] -= t
                vec[2 * (ki - 1) + 1] -= 1.0
            rows.append((vec, d, conf))
    out = {c: (0.0, 0.0) for c in order[1:]}
    if not rows:
        return out
    X = np.array([r[0] for r in rows]); y = np.array([r[1] for r in rows])
    confs = np.array([r[2] for r in rows])
    w = np.clip(np.log10(1.0 + confs), 1.0, 8.0)
    params = np.linalg.lstsq(X * w[:, None], y * w, rcond=None)[0]
    for _ in range(8):
        res = y - X @ params
        s = np.median(np.abs(res)) * 1.4826 * 3 + 1e-6
        w2 = np.where(np.abs(res) < s, 1.0, 0.05) * w
        params = np.linalg.lstsq(X * w2[:, None], y * w2, rcond=None)[0]
    for k, c in enumerate(order[1:], 1):
        out[c] = (float(params[2 * (k - 1)]), float(params[2 * (k - 1) + 1]))
    return out

# ---------------------------------------------------------------- main
def run_day(day, order=None):
    order = order or cfg.cam_list
    df = load_data()
    cams = {}
    for c in order:
        g = build_blocks(df, day, c)
        if len(g) > 0:
            cams[c] = g
    counts = " ".join(f"{c}={len(cams[c])}" for c in cams)
    print(f"\n===== {day} ===== 片段数: {counts}")
    for c, g in cams.items():
        label = "TC/本地锚点"
        print(f"  {c}: {label} {g['anchor_s'].min():.1f} -> {g['anchor_s'].max():.1f}s")

    # priors from TC start values: use FIRST NORMAL-LENGTH clip per cam.
    # (Some days have a stray <1s leftover clip from a previous day whose TC
    # is far off; using it poisons the candidate window, so skip dur<5s.)
    def first_valid(g):
        g2 = g[g["dur"] >= 5.0]
        return g2["anchor_s"].iloc[0] if len(g2) else g["anchor_s"].iloc[0]
    t0 = {c: first_valid(cams[c]) for c in cams}
    present = list(cams)
    ref = order[0] if order[0] in cams else present[0]
    pairs = [(present[i], present[j])
             for i in range(len(present)) for j in range(i + 1, len(present))]
    print(f"  参考相机: {ref}  " + "  ".join(
        f"时间先验 {j}-{i}={t0[j] - t0[i]:.2f}s" for i, j in pairs))

    def pair_candidates(pair):
        left, right = cams[pair[0]], cams[pair[1]]
        if left["tc_s"].notna().all() and right["tc_s"].notna().all():
            return make_candidates(left, right, t0[pair[1]] - t0[pair[0]], CAND_MARGIN)
        return make_ordinal_candidates(left, right)

    cands = {p: pair_candidates(p) for p in pairs}
    print("  候选数:", " ".join(f"{j}-{i}={len(v)}" for (i, j), v in cands.items()))

    cons = {p: collect_constraints(cams[p[0]], cams[p[1]], cands[p]) for p in pairs}
    print("  约束(高置信):", " ".join(
        f"{j}-{i}={len(v)}" for (i, j), v in cons.items()))

    fit = joint_fit(cons, present)
    print("  拟合:", "  ".join(
        f"delta_{c}(t)={a:.6f}*t+{b:.3f}s" for c, (a, b) in fit.items()))

    # positions
    out = []
    for cam, g in cams.items():
        t = g["anchor_s"].values
        if cam == ref:
            pos = t
        else:
            a, b = fit[cam]
            pos = t + a * t + b
        g = g.copy(); g["pos"] = pos
        out.append(g)
    return pd.concat(out), (cons, fit)

if __name__ == "__main__":
    day = sys.argv[1]
    res, info = run_day(day)
    res.to_csv(f"{WORK}/positions_{day}.tsv", sep="\t", index=False)
    print(f"\n保存 {WORK}/positions_{day}.tsv  ({len(res)} 片段)")
    print(res[["cam", "clipn", "file", "dur", "tc_s", "pos"]].head(10).to_string(index=False))
