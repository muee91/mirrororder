"""并行抽取每个媒体文件的第一条音轨为 16k mono f32 缓存（{WORK}/audio/{id}.f32）。

从 make_index.py 输出的 index.tsv（id \t day \t cam \t dir \t file）读取素材列表。
用法：python3 extract_parallel.py [nproc]
"""
import subprocess, os, sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config

def extract_one(row):
    id_, day_, cam_, dir_, fname = row.split("\t")
    cfg = _CFG
    out = f"{cfg.WORK}/audio/{id_}.f32"
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return (id_, "cached")
    src = os.path.join(cfg.BASE, dir_, fname)
    r = subprocess.run(["ffmpeg", "-v", "error", "-y",
                        "-i", src,
                        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
                        "-f", "f32le", out],
                       capture_output=True)
    if r.returncode != 0:
        return (id_, f"FAIL {r.stderr.decode(errors='replace')[:200]}")
    return (id_, "ok")

_CFG = get_config()
if __name__ == "__main__":
    WORK = _CFG.WORK or "/tmp/syncwork"
    os.makedirs(f"{WORK}/audio", exist_ok=True)
    rows = [l.rstrip("\n") for l in open(f"{WORK}/index.tsv") if l.strip()]
    nproc = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    fails = 0
    with Pool(nproc) as pool:
        for k, (id_, st) in enumerate(pool.imap_unordered(extract_one, rows, chunksize=16)):
            if st != "ok" and st != "cached":
                fails += 1
                print(f"row {id_}: {st}", flush=True)
            if (k+1) % 300 == 0:
                print(f"进度 {k+1}/{len(rows)}", flush=True)
    print(f"完成 {len(rows)} 条, 失败 {fails}")
