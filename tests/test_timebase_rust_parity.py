from __future__ import annotations

import json
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest

from script_organizer.timebase import fcpxml_project_timebase


ROOT = Path(__file__).resolve().parents[1]
CRATE = ROOT / "desktop" / "src-tauri" / "crates" / "timeline-core"


@lru_cache(maxsize=1)
def _rust_cli() -> Path:
    configured = os.environ.get("MIRRORORDER_TIMEBASE_BIN")
    if configured:
        binary = Path(configured)
        if not binary.is_file():
            pytest.skip(f"MIRRORORDER_TIMEBASE_BIN does not exist: {binary}")
        return binary

    cargo = os.environ.get("CARGO") or shutil.which("cargo")
    if not cargo:
        pytest.skip("cargo is unavailable; Rust parity tests require the timebase CLI")
    subprocess.run(
        [cargo, "build", "--locked", "--bin", "mirrororder-timebase", "--manifest-path", str(CRATE / "Cargo.toml")],
        cwd=ROOT,
        check=True,
    )
    binary = CRATE / "target" / "debug" / ("mirrororder-timebase.exe" if os.name == "nt" else "mirrororder-timebase")
    if not binary.is_file():
        pytest.fail(f"Rust build completed without producing {binary}")
    return binary


def _rust_result(path: Path) -> dict:
    completed = subprocess.run(
        [_rust_cli()],
        input=json.dumps(
            {
                "contract": "timebase.v1",
                "operation": "fcpxml_project_timebase",
                "path": str(path),
            }
        ),
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["contract"] == "timebase.v1"
    return payload["result"]


def _write(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    return path


def test_rust_timebase_matches_python_for_ntsc_and_integer_rates(tmp_path: Path) -> None:
    cases = (
        (
            "1001/24000s",
            {
                "status": "confirmed",
                "source": "fcpxml_sequence",
                "format_id": "r1",
                "frame_duration": "1001/24000s",
                "numerator": 24000,
                "denominator": 1001,
            },
        ),
        (
            "1/50s",
            {
                "status": "confirmed",
                "source": "fcpxml_sequence",
                "format_id": "r1",
                "frame_duration": "1/50s",
                "numerator": 50,
                "denominator": 1,
            },
        ),
    )
    for index, (frame_duration, expected) in enumerate(cases):
        path = _write(
            tmp_path / f"case-{index}.fcpxml",
            f'<fcpxml><resources><format id="r1" frameDuration="{frame_duration}"/></resources>'
            '<library><event><project><sequence format="r1"/></project></event></library></fcpxml>',
        )
        python_result = fcpxml_project_timebase(path)
        rust_result = _rust_result(path)
        assert python_result == expected
        assert rust_result == expected


def test_rust_timebase_matches_python_for_namespace_decimal_and_duplicates(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "namespaced.fcpxml",
        '<fcpxml xmlns="urn:fcpxml"><resources>'
        '<format id="r1" frameDuration="1/25s"/>'
        '<format id="r1" frameDuration="0.04s"/>'
        '<format id="r1" frameDuration="invalid"/>'
        '</resources><library><event><project><sequence format="r1"/></project></event></library></fcpxml>',
    )
    expected = {
        "status": "confirmed",
        "source": "fcpxml_sequence",
        "format_id": "r1",
        "frame_duration": "1/25s",
        "numerator": 25,
        "denominator": 1,
    }
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


@pytest.mark.parametrize(
    "filename, content, expected",
    [
        (
            "predefined-and-numeric-entities.fcpxml",
            '<fcpxml><resources><format id="r1" frameDuration="1/25s"/></resources>'
            '<library><event><project><sequence format="r1"/>text &amp; &#65; &#x41; '
            '&lt; &gt; &apos; &quot;</project></event></library></fcpxml>',
            {
                "status": "confirmed",
                "source": "fcpxml_sequence",
                "format_id": "r1",
                "frame_duration": "1/25s",
                "numerator": 25,
                "denominator": 1,
            },
        ),
        (
            "undefined-named-entity.fcpxml",
            '<fcpxml><resources><format id="r1" frameDuration="1/25s"/></resources>'
            '<library><event><project><sequence format="r1"/>text &undefined;'
            '</project></event></library></fcpxml>',
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
    ],
)
def test_rust_timebase_matches_python_for_xml_entity_references(
    tmp_path: Path, filename: str, content: str, expected: dict
) -> None:
    path = _write(tmp_path / filename, content)
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


def _special_node_document(prefix: str = "", content: str = "", suffix: str = "") -> str:
    return (
        prefix
        + '<fcpxml><resources><format id="r1" frameDuration="1/25s"/></resources>'
        + '<project><sequence format="r1"/>'
        + content
        + "</project></fcpxml>"
        + suffix
    )


@pytest.mark.parametrize(
    "prefix, content, suffix",
    [
        pytest.param('<?xml version="1.0"?>', "", "", id="minimal-declaration"),
        pytest.param(
            "\ufeff<?xml\nversion = '1.0'\tencoding = 'uTf-8' standalone = 'yes' ?>",
            "",
            "",
            id="bom-and-declaration-whitespace",
        ),
        pytest.param('<?xml version="1.1" standalone="no"?>', "", "", id="standalone-without-encoding"),
        pytest.param("<!DOCTYPE fcpxml>", "", "", id="bare-doctype"),
        pytest.param("<!-- comment -->\n<!DOCTYPE fcpxml [ \n ]>", "", "", id="empty-internal-subset"),
        pytest.param('<!DOCTYPE fcpxml SYSTEM "unused.dtd">', "", "", id="external-system-id"),
        pytest.param(
            '<!DOCTYPE fcpxml PUBLIC "-//Example//DTD FCPXML//EN" "unused.dtd" []>',
            "",
            "",
            id="external-public-id",
        ),
        pytest.param(
            '<?xml version="1.0"?><?xml-stylesheet href="unused.xsl"?><!DOCTYPE fcpxml>',
            "<?editor ignored &undefined; <element/><!-- opaque -->?>",
            "<?end?>",
            id="processing-instructions-in-all-positions",
        ),
        pytest.param("<?editor 数据?>", "<?pi?>", "<!-- after root --><?pi?>", id="unicode-pi-content"),
        pytest.param("", "<![CDATA[]]><![CDATA[ ]]>", "", id="empty-and-whitespace-cdata"),
        pytest.param(
            "",
            '<![CDATA[<project><sequence format="unknown"/> &undefined;]]>',
            "",
            id="cdata-is-opaque-text",
        ),
    ],
)
def test_rust_timebase_matches_python_for_valid_special_nodes(
    tmp_path: Path, prefix: str, content: str, suffix: str
) -> None:
    path = _write(tmp_path / "special-nodes.fcpxml", _special_node_document(prefix, content, suffix))
    expected = {
        "status": "confirmed",
        "source": "fcpxml_sequence",
        "format_id": "r1",
        "frame_duration": "1/25s",
        "numerator": 25,
        "denominator": 1,
    }
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


@pytest.mark.parametrize(
    "prefix, content, suffix",
    [
        pytest.param("<?xml?>", "", "", id="declaration-without-version"),
        pytest.param('<?xml encoding="UTF-8"?>', "", "", id="encoding-without-version"),
        pytest.param('<?xml encoding="UTF-8" version="1.0"?>', "", "", id="version-not-first"),
        pytest.param('<?xml version=""?>', "", "", id="empty-version"),
        pytest.param('<?xml version="1&0"?>', "", "", id="invalid-version-token"),
        pytest.param('<?xml version="1.0" extra="yes"?>', "", "", id="unknown-declaration-field"),
        pytest.param('<?xml version="1.0" version="1.0"?>', "", "", id="duplicate-version"),
        pytest.param(
            '<?xml version="1.0" encoding="UTF-8" encoding="UTF-8"?>', "", "", id="duplicate-encoding"
        ),
        pytest.param('<?xml version="1.0"encoding="UTF-8"?>', "", "", id="missing-field-separator"),
        pytest.param('<?xml version=1.0?>', "", "", id="unquoted-version"),
        pytest.param('<?xml version="1.0" standalone="true"?>', "", "", id="invalid-standalone-value"),
        pytest.param(
            '<?xml version="1.0" standalone="yes" encoding="UTF-8"?>', "", "", id="encoding-after-standalone"
        ),
        pytest.param(
            '<?xml version="1.0" standalone="yes" standalone="no"?>', "", "", id="duplicate-standalone"
        ),
        pytest.param('<?xml version="1.0"?><?xml version="1.0"?>', "", "", id="duplicate-declaration"),
        pytest.param('<!-- before --><?xml version="1.0"?>', "", "", id="declaration-after-comment"),
        pytest.param('<?pi?><?xml version="1.0"?>', "", "", id="declaration-after-pi"),
        pytest.param('<!DOCTYPE fcpxml><?xml version="1.0"?>', "", "", id="declaration-after-doctype"),
        pytest.param("", '<?xml version="1.0"?>', "", id="declaration-inside-root"),
        pytest.param("", "", '<?xml version="1.0"?>', id="declaration-after-root"),
        pytest.param("<??>", "", "", id="empty-pi-target"),
        pytest.param("<?9bad?>", "", "", id="invalid-pi-target"),
        pytest.param("<?a:b?>", "", "", id="colon-in-pi-target"),
        pytest.param("<?XML?>", "", "", id="reserved-pi-target"),
        pytest.param("", "<?xMl?>", "", id="reserved-pi-inside-root"),
        pytest.param("", "", "<?9bad?>", id="invalid-pi-after-root"),
        pytest.param("<![CDATA[]]>", "", "", id="empty-cdata-before-root"),
        pytest.param("<![CDATA[ ]]>", "", "", id="whitespace-cdata-before-root"),
        pytest.param("", "", "<![CDATA[]]>", id="empty-cdata-after-root"),
        pytest.param("", "", "<![CDATA[\n ]]>", id="whitespace-cdata-after-root"),
        pytest.param("<!DOCTYPE fcpxml><!DOCTYPE fcpxml>", "", "", id="duplicate-doctype"),
        pytest.param("<!doctype fcpxml>", "", "", id="lowercase-doctype"),
        pytest.param("<!DOCTYPEfcpxml>", "", "", id="doctype-without-separator"),
        pytest.param("<!DOCTYPE 9bad>", "", "", id="invalid-doctype-name"),
        pytest.param("<!DOCTYPE fcpxml garbage>", "", "", id="doctype-garbage"),
        pytest.param('<!DOCTYPE fcpxml SYSTEM "unused.dtd" extra>', "", "", id="doctype-trailing-garbage"),
        pytest.param('<!DOCTYPE fcpxml PUBLIC "id">', "", "", id="public-id-without-system-id"),
        pytest.param('<!DOCTYPE fcpxml PUBLIC "bad[]" "unused.dtd">', "", "", id="invalid-public-id"),
        pytest.param("<!DOCTYPE fcpxml [garbage]>", "", "", id="invalid-internal-subset"),
        pytest.param("", "<!DOCTYPE fcpxml>", "", id="doctype-inside-root"),
        pytest.param("", "", "<!DOCTYPE fcpxml>", id="doctype-after-root"),
    ],
)
def test_rust_timebase_matches_python_for_malformed_special_nodes(
    tmp_path: Path, prefix: str, content: str, suffix: str
) -> None:
    path = _write(tmp_path / "malformed-special-nodes.fcpxml", _special_node_document(prefix, content, suffix))
    expected = {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"}
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


def test_rust_timebase_rejects_unsupported_dtd_defaults_instead_of_ignoring_them(tmp_path: Path) -> None:
    document = _special_node_document('<!DOCTYPE fcpxml [<!ATTLIST sequence format CDATA "r1">]>')
    path = _write(tmp_path / "dtd-default.fcpxml", document.replace('<sequence format="r1"/>', '<sequence/>'))
    # Python remains authoritative for DTD-aware inputs. The Rust v1 boundary
    # must fail closed rather than resolve a document with silently lost data.
    assert fcpxml_project_timebase(path)["status"] == "confirmed"
    assert _rust_result(path) == {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"}


@pytest.mark.parametrize("name", ["\u037f", "\u200c", "\u3001", "\U00010000", "a\u203f"])
@pytest.mark.parametrize("location", ["pi-before-root", "pi-inside-root", "pi-after-root", "doctype"])
def test_rust_timebase_rejects_unicode_names_that_expat_does_not_accept(
    tmp_path: Path, name: str, location: str
) -> None:
    node = f"<?{name}?>"
    positions = {
        "pi-before-root": (node, "", ""),
        "pi-inside-root": ("", node, ""),
        "pi-after-root": ("", "", node),
        "doctype": (f"<!DOCTYPE {name}>", "", ""),
    }
    path = _write(tmp_path / "unicode-name.fcpxml", _special_node_document(*positions[location]))
    expected = {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"}
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


def test_rust_timebase_explicitly_limits_special_node_names_to_ascii(tmp_path: Path) -> None:
    path = _write(tmp_path / "unsupported-pi-name.fcpxml", _special_node_document("<?提示 数据?>"))
    assert fcpxml_project_timebase(path)["status"] == "confirmed"
    assert _rust_result(path) == {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"}


@pytest.mark.parametrize("character", ["\x01", "\ufffe", "\uffff"])
@pytest.mark.parametrize("location", ["pi", "cdata", "comment", "attribute", "text", "doctype-system-id"])
def test_rust_timebase_rejects_illegal_xml_characters_in_all_payloads(
    tmp_path: Path, character: str, location: str
) -> None:
    nodes = {
        "pi": f"<?editor {character}?>",
        "cdata": f"<![CDATA[{character}]]>",
        "comment": f"<!-- {character} -->",
        "attribute": f'<note value="{character}"/>',
        "text": character,
    }
    document = (
        _special_node_document(prefix=f'<!DOCTYPE fcpxml SYSTEM "{character}">')
        if location == "doctype-system-id"
        else _special_node_document(content=nodes[location])
    )
    path = _write(tmp_path / "illegal-character.fcpxml", document)
    expected = {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"}
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


def test_rust_timebase_preserves_valid_unicode_payloads(tmp_path: Path) -> None:
    value = "中文\t\n\r\ufffd\U00010000\U0001fffe\U0001ffff\U0010fffe\U0010ffff"
    content = f'<?editor {value}?><![CDATA[{value}]]><!-- {value} --><note value="{value}"/>{value}'
    path = _write(tmp_path / "valid-unicode.fcpxml", _special_node_document(content=content))
    expected = fcpxml_project_timebase(path)
    assert expected["status"] == "confirmed"
    assert _rust_result(path) == expected


@pytest.mark.parametrize(
    "filename, content, expected",
    [
        (
            "missing-sequence-format.fcpxml",
            '<fcpxml><library><event><project><sequence format="unknown"/></project></event></library></fcpxml>',
            {
                "status": "unknown",
                "source": "fcpxml_sequence",
                "reason": "sequence_format_missing",
                "format_id": "unknown",
            },
        ),
        (
            "missing-sequence.fcpxml",
            "<fcpxml><library><event><project/></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "project_sequence_missing"},
        ),
        (
            "malformed.fcpxml",
            "<fcpxml><library>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "leading-junk.fcpxml",
            "junk<fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "trailing-junk.fcpxml",
            "<fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>junk",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "unbound-prefix.fcpxml",
            "<x:fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></x:fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "unbound-attribute-prefix.fcpxml",
            "<fcpxml x:bad=\"value\"><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "invalid-control.fcpxml",
            "<fcpxml><library><event><project><sequence format=\"r1\" note=\"bad\x01value\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "encoding-mismatch.fcpxml",
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?><fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "declaration-after-whitespace.fcpxml",
            " <?xml version=\"1.0\"?><fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "sequence-outside-project.fcpxml",
            "<fcpxml><library><event><project/></event><sequence format=\"r1\"/></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "project_sequence_missing"},
        ),
        (
            "sequence-in-foreign-element.fcpxml",
            "<fcpxml><library><event><project/><other><sequence format=\"r1\"/></other></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "project_sequence_missing"},
        ),
        (
            "invalid-comment.fcpxml",
            "<!-- invalid--comment --><fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "malformed-nesting.fcpxml",
            "<fcpxml><library><event><project><sequence format=\"r1\"></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
    ],
)
def test_rust_timebase_matches_python_fail_closed(tmp_path: Path, filename: str, content: str, expected: dict) -> None:
    path = _write(tmp_path / filename, content)
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


def test_rust_timebase_matches_python_for_missing_source(tmp_path: Path) -> None:
    path = tmp_path / "does-not-exist.fcpxml"
    expected = {"status": "unknown", "source": "fcpxml_sequence", "reason": "source_missing"}
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected
