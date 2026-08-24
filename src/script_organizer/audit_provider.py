from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .take_semantic_provider import TakeSemanticProvider
from .vision_provider import VisionProviderConfig


SHOT_TYPES = {
    "wide",
    "full",
    "medium",
    "medium_closeup",
    "closeup",
    "extreme_closeup",
    "big_closeup",
    "insert",
    "unknown",
}
COVERAGE_ROLES = {
    "master",
    "dialogue",
    "reaction",
    "insert",
    "establishing",
    "transition",
    "unknown",
}
TAKE_COMPLETENESS = {"complete", "partial", "pickup", "false_start", "unknown"}
TECHNICAL_USABILITY = {"good", "usable_with_caution", "poor", "unknown"}
CONTINUITY_RISK = {"low", "medium", "high", "unknown"}
VERDICTS = {"agree", "disagree", "insufficient_evidence"}
SEVERITIES = {"info", "warning", "error"}


def _remote_context(context: dict[str, Any]) -> dict[str, Any]:
    """Keep local biometric cluster handles out of VLM requests."""
    result = json.loads(json.dumps(context, ensure_ascii=False))
    people = result.get("people")
    if isinstance(people, dict):
        for kind in ("speakers", "faces"):
            rows = people.get(kind)
            if not isinstance(rows, list):
                continue
            for row in rows:
                if isinstance(row, dict):
                    row.pop("identity_id", None)
                    row.pop("local_identity_id", None)
    semantic = result.get("semantic")
    if isinstance(semantic, dict):
        data = semantic.get("data")
        if isinstance(data, dict):
            data.pop("provider", None)
            data.pop("model", None)
    return result


class TakeAuditProvider(TakeSemanticProvider):
    """Bounded multimodal critic for one Take.

    The provider is deliberately a judge, not an authority. It may report
    disagreement, material problems and shot intelligence, but it cannot emit
    Best/Keep/Reject or mutate mapping/review state.
    """

    def __init__(self, config: VisionProviderConfig | None = None):
        super().__init__(config)

    def audit(self, context: dict[str, Any], frames: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        usable_frames = [
            item for item in frames
            if isinstance(item, dict) and Path(str(item.get("path", ""))).is_file()
        ][:6]
        if not usable_frames:
            return None
        base_url = self._base_url()
        if not base_url:
            return None
        url = base_url.rstrip("/")
        if not url.endswith("/v1"):
            url += "/v1"
        url += "/chat/completions"

        system = (
            "你是短剧后期素材的审计员和算法红队评委。目标是找出当前算法判断可能错在哪里，并为后续粗剪提供结构化素材信息。"
            "只能使用输入证据，不搜索整本剧本、不发明人物身份、不修改任何人工审核。多机位时，镜头里的人不一定是正在说台词的人；"
            "除非输入已经给出可靠视听绑定，否则不得把画面人物直接认作台词角色。不得输出Best/Keep/Reject。"
            "请严格输出JSON，结构为："
            '{"verdict":"agree|disagree|insufficient_evidence","confidence":0.0,'
            '"reason":"","issues":[{"code":"","severity":"info|warning|error","detail":""}],'
            '"algorithm_feedback":{"failure_class":"","suspected_missing_feature":"","counterexample":""},'
            '"angles":[{"clip_id":"","camera":"","shot_type":"wide|full|medium|medium_closeup|closeup|extreme_closeup|big_closeup|insert|unknown",'
            '"visible_people":[""],"technical_issues":[""],"coverage_role":"master|dialogue|reaction|insert|establishing|transition|unknown"}],'
            '"rough_cut":{"technical_usability":"good|usable_with_caution|poor|unknown",'
            '"take_completeness":"complete|partial|pickup|false_start|unknown",'
            '"coverage_role":"master|dialogue|reaction|insert|establishing|transition|unknown",'
            '"continuity_risk":"low|medium|high|unknown"}}。'
            "景别按每个clip_id分别判断；证据不足时用unknown。"
        )
        content: list[dict[str, Any]] = [
            {"type": "text", "text": json.dumps(_remote_context(context), ensure_ascii=False)}
        ]
        for index, item in enumerate(usable_frames, start=1):
            path = Path(str(item.get("path", "")))
            content.append(
                {
                    "type": "text",
                    "text": (
                        f"frame {index}: clip_id={item.get('clip_id','')} "
                        f"camera={item.get('camera','')} source_time={item.get('source_time',0)}"
                    ),
                }
            )
            content.append({"type": "image_url", "image_url": {"url": self._image_url(path)}})

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
        except (
            OSError,
            urllib.error.URLError,
            urllib.error.HTTPError,
            UnicodeDecodeError,
            ValueError,
            KeyError,
            IndexError,
            TypeError,
        ):
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
        return self._sanitize(result, usable_frames)

    def _sanitize(self, result: dict[str, Any], frames: list[dict[str, Any]]) -> dict[str, Any]:
        verdict = str(result.get("verdict", "") or "")
        if verdict not in VERDICTS:
            verdict = "insufficient_evidence"
        try:
            confidence = max(0.0, min(1.0, float(result.get("confidence", 0) or 0)))
        except (TypeError, ValueError):
            confidence = 0.0
        issues = []
        for raw in result.get("issues", []) if isinstance(result.get("issues"), list) else []:
            if not isinstance(raw, dict):
                continue
            severity = str(raw.get("severity", "warning") or "warning")
            if severity not in SEVERITIES:
                severity = "warning"
            issues.append(
                {
                    "code": str(raw.get("code", "other") or "other")[:80],
                    "severity": severity,
                    "detail": str(raw.get("detail", "") or "")[:500],
                }
            )
        known_clips = {str(item.get("clip_id", "")) for item in frames if item.get("clip_id")}
        angles = []
        seen: set[str] = set()
        for raw in result.get("angles", []) if isinstance(result.get("angles"), list) else []:
            if not isinstance(raw, dict):
                continue
            clip_id = str(raw.get("clip_id", "") or "")
            if not clip_id or clip_id not in known_clips or clip_id in seen:
                continue
            seen.add(clip_id)
            shot_type = str(raw.get("shot_type", "unknown") or "unknown")
            if shot_type not in SHOT_TYPES:
                shot_type = "unknown"
            coverage_role = str(raw.get("coverage_role", "unknown") or "unknown")
            if coverage_role not in COVERAGE_ROLES:
                coverage_role = "unknown"
            visible = raw.get("visible_people", []) if isinstance(raw.get("visible_people"), list) else []
            technical = raw.get("technical_issues", []) if isinstance(raw.get("technical_issues"), list) else []
            angles.append(
                {
                    "clip_id": clip_id,
                    "camera": str(raw.get("camera", "") or "")[:20],
                    "shot_type": shot_type,
                    "visible_people": [str(value)[:80] for value in visible if str(value).strip()][:8],
                    "technical_issues": [str(value)[:120] for value in technical if str(value).strip()][:8],
                    "coverage_role": coverage_role,
                }
            )
        feedback = result.get("algorithm_feedback", {}) if isinstance(result.get("algorithm_feedback"), dict) else {}
        rough = result.get("rough_cut", {}) if isinstance(result.get("rough_cut"), dict) else {}
        technical_usability = str(rough.get("technical_usability", "unknown") or "unknown")
        if technical_usability not in TECHNICAL_USABILITY:
            technical_usability = "unknown"
        take_completeness = str(rough.get("take_completeness", "unknown") or "unknown")
        if take_completeness not in TAKE_COMPLETENESS:
            take_completeness = "unknown"
        coverage_role = str(rough.get("coverage_role", "unknown") or "unknown")
        if coverage_role not in COVERAGE_ROLES:
            coverage_role = "unknown"
        continuity_risk = str(rough.get("continuity_risk", "unknown") or "unknown")
        if continuity_risk not in CONTINUITY_RISK:
            continuity_risk = "unknown"
        return {
            "verdict": verdict,
            "confidence": confidence,
            "reason": str(result.get("reason", "") or "")[:1000],
            "issues": issues[:16],
            "algorithm_feedback": {
                "failure_class": str(feedback.get("failure_class", "") or "")[:120],
                "suspected_missing_feature": str(feedback.get("suspected_missing_feature", "") or "")[:200],
                "counterexample": str(feedback.get("counterexample", "") or "")[:500],
            },
            "angles": angles,
            "rough_cut": {
                "technical_usability": technical_usability,
                "take_completeness": take_completeness,
                "coverage_role": coverage_role,
                "continuity_risk": continuity_risk,
            },
            "provider": self.config.provider,
            "model": self.config.model,
        }
