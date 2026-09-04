from pathlib import Path

from script_organizer.project_package import load_project_package_manifest
from script_organizer.workspace import WorkspaceConfig, WorkspaceRegistry


def test_workspace_create_writes_v1_and_escaped_toml(tmp_path):
    projects = tmp_path / 'projects'
    projects.mkdir()
    workspace_path = tmp_path / 'workspace.toml'
    workspace_path.write_text(
        '[workspace]\nid = "ws_test"\nname = "Test"\nregistry = "./projects/registry.json"\nweb_directory = "./web"\n',
        encoding='utf-8',
    )
    script = tmp_path / 'script.txt'
    script.write_text('hello', encoding='utf-8')
    fcpxml = tmp_path / 'source.fcpxml'
    fcpxml.write_text('<fcpxml/>', encoding='utf-8')

    registry = WorkspaceRegistry(WorkspaceConfig.from_file(workspace_path))
    registry.preflight_create = lambda payload: {'ready': True, 'errors': []}
    entry = registry.create({
        'name': 'Demo "Quoted" 项目',
        'project_id': 'demo',
        'input_kind': 'fcpxml',
        'script': str(script),
        'fcpxml': str(fcpxml),
        'camera_patterns': {'A-B': 'cam \"quoted\"'},
    })

    manifest_path = tmp_path / entry['config_path']
    manifest = load_project_package_manifest(manifest_path)
    assert manifest.schema_version == 1
    assert manifest.project_id == 'demo'
    assert manifest.name == 'Demo "Quoted" 项目'
    assert manifest.data['input']['script'] == './inputs/script.txt'
    assert manifest.data['input']['fcpxml'] == './inputs/source.fcpxml'
    assert manifest.data['media']['camera_patterns']['A-B'] == 'cam "quoted"'


def test_register_existing_rejects_v1_identity_mismatch(tmp_path):
    projects = tmp_path / 'projects'
    projects.mkdir()
    workspace_path = tmp_path / 'workspace.toml'
    workspace_path.write_text(
        '[workspace]\nid = "ws_test"\nregistry = "./projects/registry.json"\n',
        encoding='utf-8',
    )
    project = projects / 'one'
    project.mkdir()
    (project / 'project.toml').write_text(
        '[project]\nformat="mirrororder-project"\nschema_version=1\nid="one"\nname="One"\n'
        '[input]\nkind="media-directory"\nscript="./inputs/script.txt"\n',
        encoding='utf-8',
    )
    registry = WorkspaceRegistry(WorkspaceConfig.from_file(workspace_path))
    try:
        registry.register_existing('two', project / 'project.toml')
    except ValueError as exc:
        assert 'manifest id' in str(exc)
    else:
        raise AssertionError('identity mismatch was accepted')
