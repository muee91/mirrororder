"""Narrow automatic waveform route, called only by the durable sync worker."""
from __future__ import annotations

import csv
import hashlib
import json
import subprocess
from time import monotonic
from fractions import Fraction
from pathlib import Path

import numpy as np

from .media_identity import DeviceMediaStore, media_id_for_path
from .recording_waveform_solver import WaveformReference, solve_recording_waveform, solve_long_recording
from .timebase import fcpxml_project_timebase

SR = 16000

def _normalized(samples):
    return samples / max(1.0, float(np.max(np.abs(samples), initial=0)))


def _process(command, check_cancelled):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(150):
            check_cancelled()
            try:
                out, _err = process.communicate(timeout=0.2)
                if process.returncode:
                    raise ValueError('media_decode_failed')
                return out
            except subprocess.TimeoutExpired:
                continue
        raise ValueError('media_decode_timeout')
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def _audio_start(path: Path, check_cancelled) -> Fraction:
    data = json.loads(_process(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(path)], check_cancelled))
    video = next(s for s in data['streams'] if s.get('codec_type') == 'video')
    audio = next(s for s in data['streams'] if s.get('codec_type') == 'audio')
    # An explicit stream timestamp is needed; metadata absence is not zero.
    return Fraction(audio['start_time']) - Fraction(video['start_time'])


def auto_align_recordings(*, inventory, local_paths, work: Path, media_base: Path,
                          days, master: Path, roots, context, prior, check_cancelled, log=lambda text: None):
    budget_start = monotonic()
    def pending(reason):
        return None, [{'code': reason, 'message': '独立录音未自动确认：' + reason + '；保留既有摆位，不以机内参考声冒充完整录音交付。'}]
    if prior and (not isinstance(prior, dict) or prior.get('confirmation_source') != 'automatic_waveform.v1'):
        return pending('existing_recording_authority_preserved')
    if not inventory['candidates']:
        return pending('recording_roster_unknown')
    if not context or not all(context):
        return pending('missing_sync_revision_context')
    if len(days) != 1:
        return pending('multi_day_waveform_alignment_not_supported')
    if len(inventory['candidates']) > 64:
        return pending('recording_batch_exceeds_bounded_route')
    day = days[0]
    def table(path):
        with path.open(newline='', encoding='utf-8') as stream:
            return list(csv.DictReader(stream, delimiter='\t'))
    rows = table(work / f'positions_{day}_compressed.tsv')
    raw = {r['id']: r for r in table(work / f'positions_{day}.tsv')}
    if not rows or len(rows) != len(raw):
        return pending('ambiguous_master_coordinates')
    timebase = fcpxml_project_timebase(master)
    if timebase['status'] != 'confirmed':
        return pending('unverified_master_timebase')
    rate = Fraction(timebase['numerator'], timebase['denominator'])
    zero = min(Fraction(r['pos']) for r in rows)
    physical_zero = min(Fraction(r['pos']) for r in raw.values())
    from .recording_reference_index import build_recording_reference_candidates
    from .media_identity import _atomic_json
    reference_rows = []
    seen = set()
    # Cache only verified stream offsets, keyed by content identity (not filename).
    clocks_path = work / 'recording_reference_clocks.json'
    clocks = json.loads(clocks_path.read_text()) if clocks_path.exists() else {}
    for row in rows:
        check_cancelled()
        if monotonic()-budget_start > 300:
            _atomic_json(clocks_path, clocks)
            return pending('reference_probe_budget_incomplete')
        if row['cam'] == '?':
            continue
        path = (media_base / row['dir'] / row['file']).resolve(strict=True)
        if not any(path.is_relative_to(Path(root).resolve()) for root in roots):
            return pending('reference_outside_media_roots')
        identity = media_id_for_path(path)
        if not identity or identity in seen:
            return pending('duplicate_or_unverified_reference_media')
        seen.add(identity)
        occurrence = '\0'.join((str(day), row['cam'], str(Path(row['dir']) / row['file']), identity))
        expected_id = 'v2_' + hashlib.sha1(occurrence.encode('utf-8')).hexdigest()[:32]
        if row['id'] != expected_id:
            return pending('reference_cache_identity_changed')
        cache = work / 'audio' / (row['id'] + '.f32')
        if not cache.is_file() or cache.stat().st_size < 4*SR*4:
            continue
        if identity not in clocks:
            offset = _audio_start(path, check_cancelled)
            clocks[identity] = [offset.numerator, offset.denominator]
        start = (Fraction(raw[row['id']]['pos']) - physical_zero + Fraction(*clocks[identity])) * SR
        reference_rows.append(dict(media_id=identity, camera=row['cam'], cache_path=cache,
                                   timeline_start_samples=round(start)))
    from .media_identity import _atomic_json
    _atomic_json(clocks_path, clocks)
    if len({r['camera'] for r in reference_rows}) < 2:
        return pending('insufficient_independent_references')
    placements, evidence, unresolved = [], [], []
    for number, row in enumerate(inventory['candidates'], 1):
        check_cancelled()
        log(f"原录音波形核对 {number}/{len(inventory['candidates'])}")
        identity = row['media_id']; path = local_paths.get(identity)
        duration_s = Fraction(row.get('sample_count', 0), row.get('sample_rate', 1))
        if (row['status'] != 'unverified_candidate' or not path or not 1 <= row.get('channels',0) <= 2
                or not 20 <= duration_s <= 4*3600 or monotonic()-budget_start > 300):
            unresolved.append(identity)
            evidence.append({'media_id':identity,'status':'unresolved','reason':'duration_channel_or_budget_unsupported'})
            continue
        # Five bounded 8s windows; do not decode hours or pretend a prefix is a file.
        measurement_count = int(duration_s * SR)
        window_seconds = 8 if duration_s >= 40 else 4
        starts = [i*(measurement_count-window_seconds*SR)//4 for i in range(5)]
        def measure(window_starts):
            windows = []
            for source_start in window_starts:
                check_cancelled()
                if monotonic()-budget_start > 300:
                    return {'status':'unresolved','reason':'budget_incomplete'}
                data = _process(['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(float(Fraction(source_start,SR))),
                    '-i', str(path), '-map', '0:a:0', '-t', str(window_seconds), '-ac', '1', '-ar', str(SR), '-f', 'f32le', 'pipe:1'], check_cancelled)
                samples = _normalized(np.frombuffer(data, dtype='<f4'))
                if len(samples) != window_seconds*SR:
                    return {'status':'unresolved','reason':'original_window_boundary_unverified'}
                windows.append((source_start, samples))
            if media_id_for_path(path) != identity:
                return {'status':'unresolved','reason':'original_identity_changed'}
            candidates = build_recording_reference_candidates(reference_rows, windows, work/'recording-fingerprints',
                                                              sample_rate=SR, check_cancelled=check_cancelled)
            if not candidates.complete:
                return {'status':'unresolved','reason':candidates.reason}
            result = solve_long_recording(windows, measurement_count, candidates.references, SR, check_cancelled=check_cancelled)
            result['candidate_search'] = candidates.metadata
            return result
        result = measure(starts)
        # AAC start/seek transients may invalidate a whole anchor. Retest only weak
        # evidence, never conflicts/drift. Keep head/tail, shift interiors once.
        if result.get('reason') == 'insufficient_anchor_corroboration' and duration_s >= 45:
            shifted = [start + (SR if 0 < i < 4 else 0) for i,start in enumerate(starts)]
            result = measure(shifted)
            result['anchor_retry'] = 'interior_plus_1_second'
        if result['status'] != 'aligned':
            unresolved.append(identity)
            evidence.append({'media_id':identity,'status':'unresolved','reason':result['reason']})
            continue
        physical_start = Fraction(*result['timeline_start_seconds'])
        physical_end = max(Fraction(r['pos'])-physical_zero+Fraction(r['dur']) for r in raw.values())
        if physical_start < 0 or physical_start+duration_s > physical_end:
            unresolved.append(identity)
            evidence.append({'media_id':identity,'status':'unresolved','reason':'original_range_outside_master'})
            continue
        # Prove a single translation from physical time into this compressed master.
        # A removed gap changes that translation; never split the original to hide it.
        offsets = []
        for camera_row in rows:
            physical = Fraction(raw[camera_row['id']]['pos']) - physical_zero
            if physical < physical_start + duration_s and physical + Fraction(camera_row['dur']) > physical_start:
                offsets.append(Fraction(camera_row['pos']) - zero - physical)
        if not offsets or max(offsets)-min(offsets) > Fraction(1, SR):
            unresolved.append(identity)
            evidence.append({'media_id': identity, 'status': 'unresolved', 'reason': 'crosses_deleted_common_gap'})
            continue
        at_exact = (physical_start + offsets[0]) * rate
        at = round(at_exact)
        duration = Fraction(row['sample_count'], row['sample_rate']) * rate
        frames = duration.numerator // duration.denominator
        master_end = max(Fraction(r['pos'])-zero+Fraction(r['dur']) for r in rows) * rate
        if at < 0 or frames <= 0 or at+frames > master_end or abs(at-at_exact) > Fraction(1,4):
            unresolved.append(identity); continue
        placements.append(dict(media_id=identity, name=path.name, track='原录音_'+identity,
            at=at, source=0, frames=frames, source_kind='original', timing_basis='original_unretimed', source_rate_ratio=[1,1]))
        tail_samples = Fraction(row['sample_count']) - Fraction(frames, 1) / rate * row['sample_rate']
        evidence.append(dict(media_id=identity, reference_media_ids=[r['media_id'] for r in reference_rows],
            waveform=result, quantization_error_frames=[(Fraction(at)-at_exact).numerator,(Fraction(at)-at_exact).denominator],
            omitted_tail_samples=[tail_samples.numerator, tail_samples.denominator]))
    if not placements:
        reason = next((r['reason'] for r in evidence if r.get('status') == 'unresolved'), 'no_unambiguous_bounded_waveform_match')
        return pending(reason)
    if prior and (unresolved or {p['media_id'] for p in prior.get('placements', [])} - {p['media_id'] for p in placements}):
        return pending('partial_result_existing_authority_preserved')
    workspace_id, project_id, task_id = context
    check_cancelled()
    DeviceMediaStore().scan(workspace_id, project_id,
        {'clips':[{'media_id':p['media_id'],'name':p['name']} for p in placements]},
        [str(root) for root in roots], cancelled=lambda: (check_cancelled() or False))
    alignment = dict(status='confirmed', sync_task_id=task_id, confirmation_source='automatic_waveform.v1',
        method='waveform_alignment_not_lip_sync_verification', placements=placements, evidence=evidence,
        unresolved_media_ids=unresolved, coverage='partial' if unresolved else 'discovered_candidates_only')
    diagnostics = [{'code':'waveform_alignment_partial' if unresolved else 'waveform_alignment_completed',
        'message':f'已自动波形对齐 {len(placements)} 条原 WAV，未解 {len(unresolved)} 条；未验证口型同步，未切分或变速。'}]
    return alignment, diagnostics
