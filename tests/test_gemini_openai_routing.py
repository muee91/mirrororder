from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from script_organizer import model_connections
from script_organizer.model_registry import AssistantLanguageModel, AssistantModelConfig
from script_organizer.semantic_encoder import SemanticEmbeddingConfig, SemanticEncoder
from script_organizer.vision_provider import VisionProvider, VisionProviderConfig


class _FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self._body = json.dumps(payload).encode("utf-8")
        self.status = status

    def read(self, size: int = -1) -> bytes:
        return self._body if size < 0 else self._body[:size]

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_args) -> bool:
        return False


class GeminiOpenAIRoutingTests(unittest.TestCase):
    def test_save_gemini_and_openai_defaults_base_urls_without_exposing_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(model_connections, "application_support_root", return_value=root):
                saved = model_connections.save_model_connections(
                    {
                        "text": {
                            "enabled": True,
                            "provider": "gemini",
                            "base_url": "",
                            "model": "gemini-4-hydrogen",
                            "api_key": "secret-gemini-key",
                        },
                        "vision": {
                            "enabled": True,
                            "provider": "openai",
                            "base_url": "",
                            "model": "gpt-4.1",
                            "api_key": "secret-openai-key",
                        },
                        "embedding": {
                            "enabled": True,
                            "provider": "gemini",
                            "base_url": "",
                            "model": "gemini-embedding-2",
                            "api_key": "secret-embed-key",
                        },
                    }
                )
                self.assertEqual(saved["text"]["provider"], "gemini")
                self.assertEqual(saved["text"]["base_url"], model_connections.DEFAULT_GEMINI_BASE_URL)
                self.assertTrue(saved["text"]["has_api_key"])
                self.assertNotIn("api_key", saved["text"])
                self.assertEqual(saved["vision"]["base_url"], model_connections.DEFAULT_OPENAI_BASE_URL)
                self.assertEqual(saved["embedding"]["model"], "gemini-embedding-2")

    def test_resolve_openai_endpoint_avoids_double_v1(self) -> None:
        self.assertEqual(
            model_connections.resolve_openai_endpoint("https://api.openai.com/v1", "/chat/completions"),
            "https://api.openai.com/v1/chat/completions",
        )
        self.assertEqual(
            model_connections.resolve_openai_endpoint("https://generativelanguage.googleapis.com/v1beta/openai", "/chat/completions"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        )
        self.assertEqual(
            model_connections.resolve_openai_endpoint("http://127.0.0.1:11434", "/embeddings"),
            "http://127.0.0.1:11434/v1/embeddings",
        )

    def test_assistant_language_model_calls_gemini_interactions_api(self) -> None:
        captured: dict[str, object] = {}

        def fake_urlopen(req, timeout=0):
            captured["url"] = req.full_url
            captured["headers"] = dict(req.header_items())
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _FakeResponse({"output_text": '{"action":"answer","summary":"已定位第4场"}'})

        cfg = AssistantModelConfig(
            provider="gemini",
            base_url="https://generativelanguage.googleapis.com",
            api_key="gem-key-123",
            model="gemini-4-hydrogen",
            source="device-model-connection",
        )
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = AssistantLanguageModel(cfg).complete_json(system="返回严格 JSON", context={"q": "第4场"})

        self.assertEqual(result, {"action": "answer", "summary": "已定位第4场"})
        self.assertEqual(captured["url"], "https://generativelanguage.googleapis.com/v1beta/interactions")
        self.assertEqual(captured["headers"]["X-goog-api-key"], "gem-key-123")
        self.assertEqual(captured["body"]["model"], "gemini-4-hydrogen")
        self.assertEqual(captured["body"]["system_instruction"], "返回严格 JSON")
        self.assertFalse(captured["body"]["store"])

    def test_vision_provider_sends_multimodal_images_to_gemini_interactions(self) -> None:
        captured: dict[str, object] = {}

        def fake_urlopen(req, timeout=0):
            captured["url"] = req.full_url
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _FakeResponse(
                {
                    "outputs": [
                        {
                            "type": "text",
                            "text": '{"candidate_id":"SC_4_2","confidence":0.95,"visual_summary":"女主特写","reason":"匹配"}',
                        }
                    ]
                }
            )

        with tempfile.TemporaryDirectory() as tmp:
            frame = Path(tmp) / "frame.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0test-jpeg")
            cfg = VisionProviderConfig(
                provider="gemini",
                base_url="https://generativelanguage.googleapis.com",
                api_key="gem-vis-key",
                model="gemini-4-hydrogen",
            )
            with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
                res = VisionProvider(cfg).rescue({"candidates": ["SC_4_2"]}, [frame])

        self.assertIsNotNone(res)
        assert res is not None
        self.assertEqual(res["candidate_id"], "SC_4_2")
        self.assertAlmostEqual(res["confidence"], 0.95)
        parts = captured["body"]["input"]
        self.assertEqual(parts[0]["type"], "text")
        self.assertEqual(parts[1]["type"], "image")
        self.assertEqual(parts[1]["mime_type"], "image/jpeg")

    def test_semantic_encoder_calls_gemini_embed_content_per_text(self) -> None:
        calls: list[dict] = []

        def fake_urlopen(req, timeout=0):
            body = json.loads(req.data.decode("utf-8"))
            calls.append({"url": req.full_url, "body": body})
            return _FakeResponse({"embedding": {"values": [3.0, 4.0]}})

        cfg = SemanticEmbeddingConfig(
            provider="gemini",
            base_url="https://generativelanguage.googleapis.com",
            api_key="gem-emb-key",
            model="gemini-embedding-2",
        )
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            vectors = SemanticEncoder(cfg).encode(["别碰那份遗嘱", "红酒杯特写"])

        self.assertIsNotNone(vectors)
        assert vectors is not None
        self.assertEqual(len(vectors), 2)
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0]["url"].endswith("/v1beta/models/gemini-embedding-2:embedContent"))
        self.assertAlmostEqual(vectors[0][0], 0.6)
        self.assertAlmostEqual(vectors[0][1], 0.8)

    def test_connection_probe_validates_local_guard_and_gemini_probe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(model_connections, "application_support_root", return_value=root):
                with self.assertRaises(ValueError):
                    model_connections.test_model_connection(
                        {
                            "role": "text",
                            "provider": "local",
                            "base_url": "https://evil.example.com",
                            "model": "qwen2.5",
                        }
                    )

                with mock.patch("urllib.request.urlopen", return_value=_FakeResponse({"name": "models/gemini-4-hydrogen"})):
                    result = model_connections.test_model_connection(
                        {
                            "role": "text",
                            "provider": "gemini",
                            "base_url": "",
                            "model": "gemini-4-hydrogen",
                            "api_key": "probe-key",
                        }
                    )
                self.assertTrue(result["ok"])
                self.assertEqual(result["provider"], "gemini")
                self.assertNotIn("probe-key", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
