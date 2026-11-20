"""Automatic sync preflight. Discovery is NOT synchronization or provenance."""
from __future__ import annotations

import os
import wave
from pathlib import Path
from typing import Callable

from .media_identity import media_id_for_path


def discover_recordings(roots: tuple[Path, ...], *, output: Path,
                        roles: dict, check_cancelled: Callable[[], None], local_paths: dict | None = None) -> dict:
    rows: dict[str, dict] = {}
    unreadable = derived = excluded = 0
    visited: set[Path] = set()
    output = output.resolve()
    for root in sorted({Path(p).resolve() for p in roots}):
        check_cancelled()
        if not root.is_dir():
            unreadable += 1
            continue
        errors = []
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=errors.append):
            check_cancelled()
            here = Path(directory)
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d != '交付'
                             and (here / d).resolve() != output and not (here / d).is_symlink())
            for name in sorted(files):
                if name.startswith('._') or Path(name).suffix.lower() != '.wav':
                    continue
                path = here / name
                if path.is_symlink() or path.resolve() in visited:
                    continue
                visited.add(path.resolve())
                check_cancelled()
                if any(p.casefold().replace('_', ' ') == 'corrected audio' for p in path.relative_to(root).parts):
                    derived += 1
                    continue
                identity = media_id_for_path(path)
                if not identity:
                    unreadable += 1
                    continue
                if roles.get(identity, {}).get('sync_policy') == 'exclude':
                    excluded += 1
                    continue
                row = {'media_id': identity, 'status': 'unverified_candidate', 'source_kind': 'unverified'}
                try:
                    with wave.open(str(path), 'rb') as audio:
                        row.update(sample_rate=audio.getframerate(), sample_count=audio.getnframes(), channels=audio.getnchannels())
                    if row['sample_count'] <= 0:
                        row['status'] = 'invalid_or_empty_audio'
                except (OSError, EOFError, wave.Error):
                    row['status'] = 'unsupported_or_unreadable_audio'
                rows[identity] = row
                if local_paths is not None:
                    local_paths[identity] = path
        unreadable += len(errors)
    return {'contract': 'recording_inventory.v1', 'status': 'discovered_not_synchronized',
            'coverage': 'configured_media_roots_only_not_complete_recording_roster',
            'candidates': [rows[key] for key in sorted(rows)], 'unreadable_entries': unreadable,
            'derived_candidates_excluded': derived, 'explicitly_excluded': excluded}


def recording_diagnostics(inventory: dict) -> list[dict[str, str]]:
    if inventory['candidates'] or inventory['unreadable_entries'] or inventory['derived_candidates_excluded']:
        return [{'code': 'recordings_not_automatically_aligned', 'message':
                 '独立录音尚未自动对齐：已盘点登记素材根中的 WAV，但缺少可信原始时钟/事件锚点；发现不等于同步。已有录音摆位保留，不能宣称完整录音交付。'}]
    return [{'code': 'recording_roster_unknown', 'message':
             '登记素材根未发现可用独立 WAV；这不证明项目没有外录音，当前产物仅能视为视频/机内参考声同步。'}]
