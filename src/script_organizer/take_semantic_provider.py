from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

from .multimodal_client import MultimodalConfig, call_multimodal, parse_json_object
from .vision_provider import VisionProviderConfig


class TakeSemanticProvider:
    """Structured Take description using the configured local/remote VLM.

    This provider never sees raw video or audio. Callers pass a bounded set of
    sampled JPEG frames plus already-known project context. The result is
    descriptive metadata only; it cannot mutate review or mapping state. Speech
    remains a separate ASR evidence source instead of being invented by vision.
    Protocol routing (Gemini Interactions / OpenAI-compatible / local
    llama-server) is owned by the shared multimodal client.
    """

    def __init__(self, config: VisionProviderConfig | None = None):
        self.config = config or VisionProviderConfig.from_env()

    @property
    def enabled(self) -> bool:
        return self.config.enabled

    @staticmethod
    def _values(result: dict[str, Any], key: str, limit: int = 12) -> list[str]:
        raw = result.get(key, [])
        if not isinstance(raw, list):
            return []
        return [str(value).strip()[:120] for value in raw if str(value).strip()][:limit]

    def describe(self, context: dict[str, Any], frames: list[Path]) -> dict[str, Any] | None:
        if not self.enabled or not frames:
            return None
        pictures: list[tuple[bytes, str]] = []
        for frame in frames[:5]:
            if not frame:
                continue
            path = Path(frame)
            if not path.is_file():
                continue
            mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
            pictures.append((path.read_bytes(), mime))
        if not pictures:
            return None
        system = (
            "你是短剧素材的镜头语义索引器。只描述抽样画面中实际可见的内容和输入中已经明确给出的上下文，"
            "不猜真实演员姓名、人物关系、动机或未出现的剧情，不判断最终Best/Keep/Reject，也不发明剧本位置。"
            "不要把输入里的ASR文本说成你从图片听到的声音。"
            "输出严格JSON："
            '{"description":"对画面可见内容的具体描述","location":"","shot_type":"",'
            '"visible_people":[""],"actions":[""],"props":[""],"emotion":[""],'
            '"continuity_clues":[""],"extracted_text":"画面中明确可见的文字，无则空字符串",'
            '"tags":["不超过8个简短中文标签"],"summary":"简短中文总结"}。'
            "证据不足的字段返回空字符串或空数组。"
        )
        result = call_multimodal(
            MultimodalConfig(
                provider=self.config.provider,
                base_url=self.config.base_url,
                api_key=self.config.api_key,
                model=self.config.model,
                timeout_seconds=self.config.timeout_seconds,
            ),
            system=system,
            context=context,
            images=pictures,
            temperature=0.0,
        )
        if not result.ok:
            return None
        parsed = parse_json_object(result.text)
        if parsed is None:
            return None
        evidence = {
            "description": str(parsed.get("description", "") or "")[:1600],
            "location": str(parsed.get("location", "") or "")[:160],
            "shot_type": str(parsed.get("shot_type", "") or "")[:120],
            "visible_people": self._values(parsed, "visible_people"),
            "actions": self._values(parsed, "actions"),
            "props": self._values(parsed, "props"),
            "emotion": self._values(parsed, "emotion"),
            "continuity_clues": self._values(parsed, "continuity_clues"),
            "extracted_text": str(parsed.get("extracted_text", "") or "")[:1200],
            "tags": self._values(parsed, "tags", limit=8),
            "summary": str(parsed.get("summary", "") or "")[:1000],
        }
        if not any(evidence.values()):
            return None
        return {**evidence, "provider": self.config.provider, "model": self.config.model}


__all__ = ["TakeSemanticProvider"]
