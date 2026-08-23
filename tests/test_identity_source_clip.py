from __future__ import annotations

from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.identity_index import IdentityIndexer
from script_organizer.workspace_db import WorkspaceDatabase


def test_identity_assign_uses_each_observation_source_clip(tmp_path: Path) -> None:
    project = tmp_path / "project"
    output = project / "output"
    transcripts = project / "cache" / "transcripts"
    inputs = project / "inputs"
    output.mkdir(parents=True)
    transcripts.mkdir(parents=True)
    inputs.mkdir(parents=True)
    script = inputs / "script.md"
    script.write_text("第1集\n", encoding="utf-8")
    config_path = project / "project.toml"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    config = ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script,
        output_dir=output,
        transcript_dir=transcripts,
        input_kind="media-directory",
        media_root=None,
    )
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "project",
        name="demo",
        input_kind="media-directory",
        config_path=str(config_path),
        index={
            "stats": {"groups": 1, "clips": 2},
            "groups": [
                {
                    "group_id": "G1",
                    "start": 0.0,
                    "end": 4.0,
                    "duration": 4.0,
                    "cameras": ["A", "B"],
                    "members": [],
                }
            ],
        },
    )
    indexer = IdentityIndexer("ws", "project", config, database=database)
    written = indexer._assign(
        "face",
        "G1",
        [
            {
                "embedding": [1.0, 0.0, 0.0],
                "confidence": 0.95,
                "clip_id": "CAM_A_CLIP",
                "metadata": {"camera": "A", "track_id": "A:001"},
            },
            {
                "embedding": [0.0, 1.0, 0.0],
                "confidence": 0.94,
                "clip_id": "CAM_B_CLIP",
                "metadata": {"camera": "B", "track_id": "B:001"},
            },
        ],
        clip_id="PREFERRED_CLIP",
        threshold=0.90,
    )
    assert written == 2
    with database.connection() as connection:
        rows = connection.execute(
            """
            SELECT clip_id, metadata_json
            FROM identity_observations
            WHERE project_id='project' AND group_id='G1' AND kind='face'
            ORDER BY clip_id
            """
        ).fetchall()
    assert [str(row["clip_id"]) for row in rows] == ["CAM_A_CLIP", "CAM_B_CLIP"]
    assert all("PREFERRED_CLIP" not in str(row["metadata_json"]) for row in rows)
