# Real-media five-step chain fixture

`chain.json` describes a reproducible synthetic production fixture. It reuses the
logical script, Take, placement, slate, audit, and editorial facts from the
golden mini-drama scenario and adds seven generated camera files with explicit
frame rates, timecode, audio sample rates, and one rotation tag.

The files are generated into a temporary output directory by
`scripts/validate_real_media_chain.py`; no media bytes are checked into Git.
The validator exercises the complete local chain:

1. content-identity media recovery on a moved device root;
2. human script placement;
3. final Editorial Decision (separate from reviewer opinions);
4. assembly projection with the script-supervisor usable range and preferred angle;
5. FCPXML selection/timeline delivery and Premiere XMEML timeline delivery.

It also archives the ffprobe metadata in `media_metadata.json`, writes and
round-trips an evidence sidecar, and checks that persisted decision/report
artifacts do not expose the synthetic device-local source names.

Run from the repository root:

```bash
PYTHONPATH=src .venv/bin/python scripts/validate_real_media_chain.py
```

The validator requires `ffmpeg` and `ffprobe`. Use `--output-dir` to retain the
materialized project at a known location.
