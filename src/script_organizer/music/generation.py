from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from .models import MusicBrief


@dataclass(frozen=True)
class GeneratedTrack:
    path: Path
    provider: str
    model: str
    prompt: str
    duration: float
    seed: str = ""
    provider_metadata: dict[str, Any] | None = None

    def provenance(self, *, cue_id: str, rights_confirmed: bool) -> dict[str, Any]:
        return {
            "version": 1,
            "event": "generated_music",
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "cue_id": cue_id,
            "provider": self.provider,
            "model": self.model,
            "prompt": self.prompt,
            "duration": round(self.duration, 3),
            "seed": self.seed,
            "path": self.path.name,
            "rights_confirmed": bool(rights_confirmed),
            "provider_metadata": self.provider_metadata or {},
        }


class MusicGenerationProvider(Protocol):
    name: str

    def generate(self, brief: MusicBrief, output_dir: Path, *, count: int) -> list[GeneratedTrack]: ...


def generation_prompt(brief: MusicBrief) -> str:
    tags = ", ".join(brief.tags) or "cinematic"
    dialogue = "sparse midrange and dialogue-friendly arrangement" if brief.dialogue_density >= 0.45 else "clear cinematic arrangement"
    intensity = (
        "restrained"
        if brief.target_energy < 0.38
        else "moderate controlled intensity"
        if brief.target_energy < 0.68
        else "high dramatic intensity"
    )
    return (
        f"Instrumental cinematic underscore for a short drama. {brief.purpose}. "
        f"Mood: {tags}. {intensity}. {dialogue}. No vocals, no spoken words. "
        f"Build and resolve naturally within about {max(10, round(brief.duration))} seconds. "
        "Avoid a dominant lead melody when dialogue is present. Editing-friendly intro and ending."
    )


def _target_bpm(brief: MusicBrief) -> int:
    return max(60, min(138, round(72 + brief.target_energy * 58)))


def _write_sidecar(track: GeneratedTrack, brief: MusicBrief, *, rights_confirmed: bool) -> None:
    license_id = "stability-ai-community" if track.provider == "stable-audio3" else "ace-step-output-user-confirmed"
    source_url = (
        "https://huggingface.co/stabilityai/stable-audio-3-small-music"
        if track.provider == "stable-audio3"
        else "https://github.com/ace-step/ACE-Step-1.5"
    )
    metadata = {
        "title": f"Generated {brief.cue_id} · {track.provider}",
        "tags": list(brief.tags),
        "moods": list(brief.tags),
        "styles": ["cinematic", "underscore", "generated"],
        "energy": brief.target_energy,
        "vocal_probability": 0.0,
        "bpm": _target_bpm(brief),
        "license": {
            "source": track.provider,
            "license_id": license_id,
            "source_url": source_url,
            "creator": "AI generated",
            "commercial_use": bool(rights_confirmed),
            "sync_right": bool(rights_confirmed),
            "attribution_required": False,
            "attribution_text": "",
        },
        "provenance": track.provenance(cue_id=brief.cue_id, rights_confirmed=rights_confirmed),
    }
    sidecar = track.path.with_suffix(track.path.suffix + ".music.json")
    sidecar.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def prepare_generated_tracks(
    tracks: list[GeneratedTrack],
    brief: MusicBrief,
    *,
    rights_confirmed: bool,
) -> list[dict[str, Any]]:
    rows = []
    for track in tracks:
        if not track.path.is_file():
            continue
        _write_sidecar(track, brief, rights_confirmed=rights_confirmed)
        rows.append(track.provenance(cue_id=brief.cue_id, rights_confirmed=rights_confirmed))
    return rows


class AceStepHttpProvider:
    name = "acestep"

    def __init__(self, base_url: str, *, api_key: str = "", timeout_seconds: int = 600) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = max(30, int(timeout_seconds))

    def _headers(self) -> dict[str, str]:
        result = {"Content-Type": "application/json"}
        if self.api_key:
            result["Authorization"] = f"Bearer {self.api_key}"
        return result

    def _post(self, path: str, payload: object, *, timeout: int = 30) -> Any:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8"),
            headers=self._headers(),
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            wrapper = json.loads(response.read().decode("utf-8"))
        if not isinstance(wrapper, dict) or int(wrapper.get("code", 500) or 500) != 200:
            raise RuntimeError(str(wrapper.get("error", "ACE-Step API error") if isinstance(wrapper, dict) else "ACE-Step API error"))
        return wrapper.get("data")

    def available(self) -> bool:
        try:
            request = urllib.request.Request(self.base_url + "/health", headers=self._headers())
            with urllib.request.urlopen(request, timeout=2) as response:
                return 200 <= int(response.status) < 300
        except (OSError, urllib.error.URLError, ValueError):
            return False

    def generate(self, brief: MusicBrief, output_dir: Path, *, count: int) -> list[GeneratedTrack]:
        output_dir.mkdir(parents=True, exist_ok=True)
        prompt = generation_prompt(brief)
        duration = max(10.0, min(600.0, brief.duration + 4.0))
        payload = {
            "prompt": prompt,
            "lyrics": "[Instrumental]",
            "audio_duration": duration,
            "bpm": _target_bpm(brief),
            "audio_format": "wav",
            "batch_size": max(1, min(8, int(count))),
            "task_type": "text2music",
            "thinking": False,
            "inference_steps": 8,
        }
        data = self._post("/release_task", payload)
        task_id = str((data or {}).get("task_id", "") if isinstance(data, dict) else "")
        if not task_id:
            raise RuntimeError("ACE-Step did not return task_id")

        deadline = time.monotonic() + self.timeout_seconds
        rows: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            result = self._post("/query_result", {"task_id_list": [task_id]})
            item = result[0] if isinstance(result, list) and result else {}
            status = int(item.get("status", 0) or 0) if isinstance(item, dict) else 0
            if status == 2:
                raise RuntimeError(f"ACE-Step generation failed: {item}")
            if status == 1:
                raw = item.get("result", "[]") if isinstance(item, dict) else "[]"
                parsed = json.loads(raw) if isinstance(raw, str) else raw
                rows = [row for row in parsed if isinstance(row, dict)] if isinstance(parsed, list) else []
                break
            time.sleep(1.0)
        if not rows:
            raise RuntimeError("ACE-Step generation timed out or returned no audio")

        tracks: list[GeneratedTrack] = []
        for index, row in enumerate(rows[: max(1, count)], start=1):
            file_value = str(row.get("file", "") or "")
            if not file_value:
                continue
            source_url = urllib.parse.urljoin(self.base_url + "/", file_value.lstrip("/"))
            target = output_dir / f"acestep_{index:02d}.wav"
            request = urllib.request.Request(source_url, headers=self._headers())
            with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as handle:
                shutil.copyfileobj(response, handle)
            metas = row.get("metas", {}) if isinstance(row.get("metas"), dict) else {}
            tracks.append(
                GeneratedTrack(
                    path=target,
                    provider=self.name,
                    model=str(row.get("dit_model", "acestep-v15-turbo") or "acestep-v15-turbo"),
                    prompt=str(row.get("prompt", prompt) or prompt),
                    duration=float(metas.get("duration", duration) or duration),
                    seed=str(row.get("seed_value", "") or ""),
                    provider_metadata={
                        "task_id": task_id,
                        "bpm": metas.get("bpm"),
                        "keyscale": metas.get("keyscale"),
                        "timesignature": metas.get("timesignature"),
                    },
                )
            )
        return tracks


class StableAudio3CliProvider:
    name = "stable-audio3"

    def __init__(self, executable: str, *, model: str = "small-music", timeout_seconds: int = 900) -> None:
        self.executable = executable
        self.model = model
        self.timeout_seconds = max(60, int(timeout_seconds))

    def available(self) -> bool:
        return bool(shutil.which(self.executable) or Path(self.executable).expanduser().is_file())

    def generate(self, brief: MusicBrief, output_dir: Path, *, count: int) -> list[GeneratedTrack]:
        output_dir.mkdir(parents=True, exist_ok=True)
        prompt = generation_prompt(brief)
        duration = max(10.0, min(120.0 if self.model == "small-music" else 380.0, brief.duration + 4.0))
        tracks: list[GeneratedTrack] = []
        for index in range(1, max(1, count) + 1):
            target = output_dir / f"stable_audio3_{index:02d}.wav"
            result = subprocess.run(
                [
                    self.executable,
                    "--model", self.model,
                    "-p", prompt,
                    "--duration", f"{duration:.3f}",
                    "-o", str(target),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
            if result.returncode != 0 or not target.is_file():
                raise RuntimeError((result.stderr or result.stdout or "Stable Audio 3 generation failed")[-1200:])
            tracks.append(
                GeneratedTrack(
                    path=target,
                    provider=self.name,
                    model=self.model,
                    prompt=prompt,
                    duration=duration,
                    provider_metadata={"cli": self.executable},
                )
            )
        return tracks


def resolve_generation_provider(
    mode: str,
    *,
    acestep_url: str = "",
    stable_audio_bin: str = "",
):
    normalized = str(mode or "off").strip().casefold()
    if normalized == "off":
        return None
    if normalized not in {"auto", "acestep", "stable-audio3"}:
        raise ValueError(f"不支持的生成 Provider：{mode}")

    api_url = acestep_url.strip() or os.environ.get("MIRRORORDER_ACESTEP_URL", "").strip() or "http://127.0.0.1:8001"
    api_key = os.environ.get("ACESTEP_API_KEY", "").strip()
    if normalized in {"auto", "acestep"}:
        provider = AceStepHttpProvider(api_url, api_key=api_key)
        if normalized == "acestep" or provider.available():
            return provider

    binary = stable_audio_bin.strip() or os.environ.get("MIRRORORDER_STABLE_AUDIO_BIN", "").strip() or "stable-audio"
    provider = StableAudio3CliProvider(binary)
    if normalized == "stable-audio3" or provider.available():
        return provider
    return None
