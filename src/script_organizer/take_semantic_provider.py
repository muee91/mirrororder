from __future__ import annotations

import base64
import json
import mimetypes
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig
from .vision_provider import VisionProviderConfig


class TakeSemanticProvider:
    """Structured Take description using the configured local/remote VLM.

    This provider never sees raw video or audio. Callers pass a bounded set of
    sampled JPEG frames plus already-known project context. The result is
    descriptive metadata only; it cannot mutate review or mapping state. Speech
    remains a separate ASR evidence source instead of being invented by vision.
    """

    def __init__(self, config: VisionProviderConfig | None = None):
        self.config = config or VisionProviderConfig.from_env()
        self._local_runtime: LocalVisionRuntime | None = None

    @property
    def enabled(self) -> bool:
        return self.config.enabled

    def _base_url(self) -> str:
        if not self.config.enabled:
            return ""
        if not self.config.is_local:
            return self.config.base_url
        if self._local_runtime is None:
            self._local_runtime = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(self.config.model))
        return self._local_runtime.ensure_server()

    @staticmethod
    def _image_url(path: Path) -> str:
        mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
        return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"

    def describe(self, context: dict[str, Any], frames: list[Path]) -> dict[str, Any] | None:
        if not self.enabled or not frames:
            return None
        base_url = self._base_url()
        if not base_url:
            return None
        url = base_url.rstrip("/")
        if not url.endswith("/v1"):
            url += "/v1"
        url += "/chat/completions"
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
        content: list[dict[str, Any]] = [{"type": "text", "text": json.dumps(context, ensure_ascii=False)}]
        for frame in frames[:5]:
            if frame.is_file():
                content.append({"type": "image_url", "image_url": {"url": self._image_url(frame)}})
        payload = {
            "model": self.config.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
        }
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = "Bearer " + self.config.api_key
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            text = raw["choices"][0]["message"]["content"]
        except (OSError, urllib.error.URLError, urllib.error.HTTPError, UnicodeDecodeError, ValueError, KeyError, IndexError, TypeError):
            return None
        if isinstance(text, list):
            text = "".join(str(item.get("text", "")) for item in text if isinstance(item, dict))
        text = str(text or "").strip()
        if text.startswith("```"):
            text = text.strip("`").removeprefix("json").strip()
        try:
            result = json.loads(text)
        except ValueError:
            left, right = text.find("{"), text.rfind("}")
            if left < 0 or right <= left:
                return None
            try:
                result = json.loads(text[left : right + 1])
            except ValueError:
                return None
        if not isinstance(result, dict):
            return None

        def values(key: str, limit: int = 12) -> list[str]:
            raw_value = result.get(key, [])
            if not isinstance(raw_value, list):
                return []
            return [str(value).strip()[:120] for value in raw_value if str(value).strip()][:limit]

        return {
            "description": str(result.get("description", "") or "")[:1600],
            "location": str(result.get("location", "") or "")[:160],
            "shot_type": str(result.get("shot_type", "") or "")[:120],
            "visible_people": values("visible_people"),
            "actions": values("actions"),
            "props": values("props"),
            "emotion": values("emotion"),
            "continuity_clues": values("continuity_clues"),
            "extracted_text": str(result.get("extracted_text", "") or "")[:1200],
            "tags": values("tags", limit=8),
            "summary": str(result.get("summary", "") or "")[:1000],
            "provider": self.config.provider,
            "model": self.config.model,
        }
