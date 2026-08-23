from __future__ import annotations

import json
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.script_supervisor_store import ScriptSupervisorStore
from script_organizer.semantic_index import ProjectSemanticIndexer
from script_organizer.semantic_search import SemanticSearcher, safe_search_payload
from script_organizer.semantic_store import SemanticStore
from script_organizer.workspace_db import WorkspaceDatabase


class _FakePublicConfig:
    def __init__(self, enabled: bool):
        self.enabled = enabled

    def public(self) -> dict:
        return {
            "enabled": self.enabled,
            "provider": "fake" if self.enabled else "none",
            "model": "fake-2d" if self.enabled else "",
            "source": "test",
            "local": True,
        }


class FakeEncoder:
    enabled = True
    identity = "fake:fake-2d"

    def __init__(self):
        self.config = _FakePublicConfig(True)
        self.encoded_batches: list[list[str]] = []

    @staticmethod
    def _vector(text: str) -> list[float]:
        value = text.casefold()
        if any(token in value for token in ("入口", "门口", "推门", "反应")):
            return [1.0, 0.0]
        return [0.0, 1.0]

    def encode(self, texts):
        rows = [str(value) for value in texts]
        self.encoded_batches.append(rows)
        return [self._vector(value) for value in rows]

    def encode_one(self, text: str):
        self.encoded_batches.append([str(text)])
        return self._vector(text)


class DisabledEncoder:
    enabled = False
    identity = ""

    def __init__(self):
        self.config = _FakePublicConfig(False)

    def encode(self, _texts):
        raise AssertionError("disabled encoder must not be called")

    def encode_one(self, _text):
        raise AssertionError("disabled encoder must not be called")


class BrokenEncoder(FakeEncoder):
    def encode_one(self, text: str):
        self.encoded_batches.append([str(text)])
        return None


class NoMediaStore:
    def resolve(self, *_args, **_kwargs):
        return ""


def _database(tmp_path: Path) -> WorkspaceDatabase:
    return WorkspaceDatabase("semantic-test", path=tmp_path / "workspace.sqlite3")


def _doc(document_id: str, source: str, text: str, vector=None, group_id: str = "") -> dict:
    return {
        "document_id": document_id,
        "group_id": group_id,
        "clip_id": "",
        "media_id": "",
        "source": source,
        "start": 0,
        "end": 4,
        "text": text,
        "metadata": {"evidence": source},
        "content_fingerprint": document_id + "-v1",
        "embedding": vector,
        "embedding_model": "fake:fake-2d" if vector else "",
    }


def test_keyword_retrieval_works_when_embedding_is_disabled(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = SemanticStore(database)
    store.replace_documents(
        "demo",
        "slate",
        [_doc("slate-1", "slate", "24场3镜第二次，前半段可用，后面笑场", group_id="G1")],
    )
    searcher = SemanticSearcher(
        "semantic-test",
        "demo",
        object(),
        database=database,
        encoder=DisabledEncoder(),
    )
    payload = searcher.search("后面笑场", refresh=False)
    assert payload["mode"] == "keyword"
    assert payload["summary"]["vector_available"] is False
    assert payload["results"][0]["source"] == "slate"
    assert payload["results"][0]["group_id"] == "G1"


def test_same_encoder_space_enables_vector_recall_without_literal_keyword(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = SemanticStore(database)
    store.replace_documents(
        "demo",
        "visual",
        [
            _doc(
                "visual-door",
                "visual",
                "人物从室内走向外景并回头看向身后，镜头保持中近景。",
                [1.0, 0.0],
                "G-door",
            ),
            _doc("visual-cup", "visual", "桌面摆着红色杯子和白色纸张。", [0.0, 1.0], "G-cup"),
        ],
    )
    encoder = FakeEncoder()
    searcher = SemanticSearcher(
        "semantic-test",
        "demo",
        object(),
        database=database,
        encoder=encoder,
    )
    payload = searcher.search("找入口附近的反应镜头", refresh=False)
    assert payload["mode"] == "vector"
    assert payload["results"][0]["group_id"] == "G-door"
    assert payload["results"][0]["vector_similarity"] == 1.0
    assert encoder.encoded_batches[-1] == ["找入口附近的反应镜头"]
    assert payload["semantics"]["shared_encoder_for_documents_and_query"] is True


def test_vector_failure_degrades_to_keyword_recall(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = SemanticStore(database)
    store.replace_documents(
        "demo",
        "speech",
        [_doc("speech-1", "speech", "B机 对白：你回来了，我们走吧。", group_id="G2")],
    )
    searcher = SemanticSearcher(
        "semantic-test",
        "demo",
        object(),
        database=database,
        encoder=BrokenEncoder(),
    )
    payload = searcher.search("你回来了", refresh=False)
    assert payload["mode"] == "keyword"
    assert payload["results"][0]["source"] == "speech"
    assert payload["summary"]["vector_available"] is False


def _project(tmp_path: Path) -> tuple[ProjectConfig, WorkspaceDatabase]:
    root = tmp_path / "project"
    output = root / "output"
    transcript_dir = root / "cache" / "transcripts"
    output.mkdir(parents=True)
    transcript_dir.mkdir(parents=True)
    config_path = root / "project.toml"
    script_path = root / "script.txt"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    script_path.write_text("demo", encoding="utf-8")
    group = {
        "group_id": "G1",
        "start": 0.0,
        "end": 8.0,
        "duration": 8.0,
        "cameras": ["A", "B"],
        "members": [
            {"clip_id": "CA", "media_id": "MA", "camera": "A", "name": "/Volumes/SECRET/A001.mov", "duration": 8.0},
            {"clip_id": "CB", "media_id": "MB", "camera": "B", "name": "B001.mov", "duration": 8.0},
        ],
    }
    material = {"groups": [group], "clips": [], "stats": {"groups": 1, "clips": 2}}
    (output / "material_index.json").write_text(json.dumps(material, ensure_ascii=False), encoding="utf-8")
    config = ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script_path,
        output_dir=output,
        transcript_dir=transcript_dir,
        input_kind="media-directory",
        media_root=None,
    )
    database = _database(tmp_path)
    database.sync_take_index(
        "demo",
        name="demo",
        input_kind="media-directory",
        config_path=str(config_path),
        index=material,
    )
    database.set_semantic(
        "demo",
        "G1",
        {
            "description": "室内中近景，人物推门后回头。",
            "location": "室内门口",
            "shot_type": "中近景",
            "visible_people": ["一名人物"],
            "actions": ["推门", "回头"],
            "props": ["门"],
            "emotion": ["紧张"],
            "continuity_clues": [],
            "extracted_text": "",
            "tags": ["门口", "反应"],
            "summary": "人物在门口回头。",
        },
        "ready",
    )
    return config, database


def test_indexer_keeps_visual_and_human_slate_provenance_path_safe(tmp_path: Path) -> None:
    config, database = _project(tmp_path)
    supervisor = ScriptSupervisorStore(config.output_dir)
    supervisor.apply_record(
        {
            "record_id": "R1",
            "expected_revision": 0,
            "actor": "场记",
            "record": {
                "source_group_id": "G1",
                "scene": "24",
                "shot": "3",
                "take_number": 2,
                "status": "partial",
                "note": "只要前半段，后面笑场",
                "attachments": [
                    {
                        "clip_id": "CB",
                        "media_id": "MB",
                        "camera": "B",
                        "display_name": "/Volumes/SECRET/B001.mov",
                        "shot_type": "closeup",
                        "source_role": "sync_camera",
                    }
                ],
            },
        }
    )
    indexer = ProjectSemanticIndexer(
        "semantic-test",
        "demo",
        config,
        database=database,
        media_store=NoMediaStore(),
        encoder=DisabledEncoder(),
    )
    report = indexer.refresh(sources={"visual", "slate"})
    documents = SemanticStore(database).documents("demo")
    assert {row["source"] for row in documents} == {"visual", "slate"}
    visual = next(row for row in documents if row["source"] == "visual")
    slate = next(row for row in documents if row["source"] == "slate")
    assert "推门" in visual["text"]
    assert "后面笑场" in slate["text"]
    assert slate["metadata"]["evidence"] == "script_supervisor"
    serialized = json.dumps(documents, ensure_ascii=False)
    assert "/Volumes/SECRET" not in serialized
    assert report["semantics"]["new_vlm_inference"] is False
    assert not (config.output_dir / "review.json").exists()
    assert not (config.output_dir / "editorial.json").exists()
    assert not (config.output_dir / "auto_decisions.json").exists()


def test_safe_search_payload_hides_model_details() -> None:
    safe = safe_search_payload(
        {
            "contract": "semantic_search.v1",
            "query": "门口",
            "mode": "hybrid",
            "results": [],
            "summary": {"vector_available": True},
            "encoder": {"provider": "secret-provider", "model": "secret-model"},
            "refresh": {"encoder": {"model": "secret-model"}},
            "semantics": {"read_only": True},
        }
    )
    assert "encoder" not in safe
    assert "refresh" not in safe
    assert "secret-model" not in json.dumps(safe, ensure_ascii=False)


def test_static_semantic_runtime_stays_read_only_and_is_installed_last() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "semantic_runtime.py").read_text(encoding="utf-8")
    editorial = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")
    agent_tools = (root / "src" / "script_organizer" / "agent_tools.py").read_text(encoding="utf-8")
    indexer = (root / "src" / "script_organizer" / "semantic_index.py").read_text(encoding="utf-8")
    provider = (root / "src" / "script_organizer" / "take_semantic_provider.py").read_text(encoding="utf-8")
    web = (root / "web" / "index.html").read_text(encoding="utf-8")

    assert 'parts[4] == "semantic-search"' in runtime
    assert 'self._agent("read", project_id)' in runtime
    assert '"result_is_editorial_decision": False' in (root / "src" / "script_organizer" / "semantic_search.py").read_text(encoding="utf-8")
    assert "AgentToolRegistry.search_project_semantics" in runtime
    assert '"search_project_semantics"' not in agent_tools.split("SAFE_ACTIONS", 1)[1].split("}", 1)[0]
    assert "new_vlm_inference" in indexer
    assert "False" in indexer[indexer.index("new_vlm_inference"):indexer.index("new_vlm_inference") + 80]
    assert "不要把输入里的ASR文本说成你从图片听到的声音" in provider
    assert '"extracted_text"' in provider
    assert '"tags"' in provider
    assert editorial.index("install_assistant_runtime()") < editorial.index("install_semantic_runtime()")
    assert '/semantic_search.css' in web
    assert '/semantic_search_ui.js' in web
