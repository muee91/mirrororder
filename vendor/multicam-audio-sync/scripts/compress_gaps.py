#!/usr/bin/env python3
"""压缩"三机全停"时段：删掉无任何机位在录的时段，其后所有素材一起前移。

关键性质：同一活跃区间内（其间隔无全停时段），所有素材平移量完全相同，
因此机位间相对偏移严格不变。单机自身停机间隙保留（删了会破坏同步）。

用法: python3 compress_gaps.py positions_813.tsv positions_814.tsv
输出: positions_813_compressed.tsv 等（新增 pos_orig 列留存原始位置）。
"""
import sys
import os
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config

cfg = get_config()
CAM_LIST = cfg.cam_list


def compress(df):
    """Return (compressed_df, dead_periods)."""
    iv = sorted(zip(df.pos, df.pos + df.dur))
    merged = []
    for s, e in iv:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    dead = [(merged[i][1], merged[i + 1][0])
            for i in range(len(merged) - 1) if merged[i + 1][0] > merged[i][1]]

    def shift(t):
        tot = 0.0
        for a, b in dead:
            if t >= b:
                tot += b - a
            elif t > a:
                tot += t - a
                break
            else:
                break
        return t - tot

    df = df.copy()
    df["pos_orig"] = df["pos"]
    df["pos"] = df["pos"].apply(shift)
    return df, dead


def verify(cdf, dead):
    """同步保持验证：同一活跃区间内的配对，压缩前后偏移变化必须为 0。
    cdf 须同时含 pos（压缩后）与 pos_orig（压缩前）两列。"""
    def region(t, merged):
        for i, (a, b) in enumerate(merged):
            if a <= t <= b:
                return i
        return -1
    iv = sorted(zip(cdf.pos_orig, cdf.pos_orig + cdf.dur))
    merged = []
    for s, e in iv:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    cdf["reg"] = cdf.pos_orig.apply(lambda t: region(t, merged))
    c = cdf.set_index("id")
    pairs = 0
    maxdiff = 0.0
    for ca, cb in [(CAM_LIST[i], CAM_LIST[j])
                   for i in range(len(CAM_LIST)) for j in range(i + 1, len(CAM_LIST))]:
        a = cdf[cdf.cam == ca].set_index("id")
        b = cdf[cdf.cam == cb].set_index("id")
        for idx_a, ra in a.iterrows():
            for idx_b, rb in b.iterrows():
                if ra.reg != rb.reg or ra.reg < 0:
                    continue
                diff = abs((c.loc[idx_a, "pos"] - c.loc[idx_b, "pos"]) - (ra.pos_orig - rb.pos_orig))
                maxdiff = max(maxdiff, diff)
                pairs += 1
    print(f"  verify: {pairs} simultaneous pairs, max offset change = {maxdiff:.9f} s")
    if maxdiff > 1e-6:
        print("  !! WARNING: sync not preserved")


def main():
    for path in sys.argv[1:]:
        df = pd.read_csv(path, sep="\t")
        orig_span = (df.pos + df.dur).max() - df.pos.min()
        cdf, dead = compress(df)
        z = cdf.pos.min()
        new_span = (cdf.pos + cdf.dur).max() - z
        out = path.replace(".tsv", "_compressed.tsv")
        cdf.to_csv(out, sep="\t", index=False)
        print(f"{path}: {orig_span/3600:.2f}h -> {new_span/3600:.2f}h "
              f"(dead {sum(b-a for a, b in dead)/3600:.2f}h in {len(dead)} periods) -> {out}")
        verify(cdf, dead)


if __name__ == "__main__":
    main()
