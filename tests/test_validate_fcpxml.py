"""validate_fcpxml.py 的引用完整性回归测试。

重点覆盖 2026-08-24 新增的地标：标准 FCP 结构里 `media` 用子元素
`<format ref="..."/>` 指向 format 资源（而非 asset），通用 ref 检查必须
按 `format` 元素分支解析，不能再把它当成缺失的 asset。其余结构（assets、
multicam、mc-clip/mc-source）也保持原生覆盖。

加载方式同其它 vendor 测试：相对脚本路径直接构建最小 FCPXML。
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "vendor" / "multicam-audio-sync" / "scripts"
VALIDATOR = SCRIPTS / "validate_fcpxml.py"


def _load_validator() -> "module":
    """独立加载 validate_fcpxml 核心函数（仅标准库依赖，无副作用）。"""
    spec = importlib.util.spec_from_file_location(
        "mirrororder_test_validate_fcpxml_core", str(VALIDATOR))
    assert spec and spec.loader
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _write_xml(tmp: Path, body: str) -> Path:
    f = tmp / "in.xml"
    f.write_text(body, encoding="utf-8")
    return f


def _run(xml_path: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), xml_path],
        capture_output=True, text=True,
    )


def _media_files(tmp: Path) -> Path:
    """在 tmp_path 下建持久子目录放 3 个假素材（不能用会被回收的临时上下文）。"""
    d = tmp / "media"
    d.mkdir(exist_ok=True)
    (d / "cam1.mov").write_bytes(b"m1")
    (d / "cam2.mov").write_bytes(b"m2")
    (d / "cam3.mov").write_bytes(b"m3")
    return d


_STD = """<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.8">
 <resources>
  <format id="f1" name="FFVideoFormat1080p25" frameDuration="2000/50000s" width="1920" height="1080"/>
  <asset id="a" name="A" src="file://{d}/cam1.mov"/>
  <asset id="b" name="B" src="file://{d}/cam2.mov"/>
  <asset id="c" name="C" src="file://{d}/cam3.mov"/>
  <media id="days_media">
   <format ref="f1"/>
   <multicam format="f1">
    <mc-angle angleID="angleA"><clip offset="0/50000s" duration="4000/50000s" ref="a"/></mc-angle>
    <mc-angle angleID="angleB"><clip offset="0/50000s" duration="4000/50000s" ref="b"/></mc-angle>
    <mc-angle angleID="angleC"><clip offset="0/50000s" duration="4000/50000s" ref="c"/></mc-angle>
   </multicam>
  </media>
 </resources>
 <library><event><project name="p"><sequence><spine>
  <mc-clip ref="days_media" format="f1" offset="0/50000s" duration="4000/50000s">
   <mc-source angleID="angleA"/>
  </mc-clip>
 </spine></sequence></project></event></library>
</fcpxml>
"""


def test_standard_fcp_media_format_ref_passes(tmp_path) -> None:
    """media>format ref 指向真实 format —— 必须通过（不误报 asset 缺失）。"""
    d = _media_files(tmp_path)
    f = _write_xml(tmp_path, _STD.format(d=d))
    r = _run(str(f))
    assert r.returncode == 0, r.stdout


def test_broken_format_ref_is_caught(tmp_path) -> None:
    """media>format ref 指向不存在的 format —— 必须被拦截为 format 缺失。"""
    d = _media_files(tmp_path)
    body = _STD.format(d=d).replace('<format ref="f1"/>', '<format ref="nope"/>')
    f = _write_xml(tmp_path, body)
    r = _run(str(f))
    assert r.returncode == 1
    assert "format ref: format 引用缺失 -> nope" in r.stdout


def test_broken_asset_ref_is_caught(tmp_path) -> None:
    """普通 asset ref 缺失仍按 asset 判定（不被 format 分支吞掉）。"""
    d = _media_files(tmp_path)
    body = _STD.format(d=d).replace('ref="a"', 'ref="missing_a"')
    f = _write_xml(tmp_path, body)
    r = _run(str(f))
    assert r.returncode == 1
    assert "asset 引用缺失 -> missing_a" in r.stdout


def test_broken_mc_source_angle_is_caught(tmp_path) -> None:
    """mc-source angleID 指向不存在的 mc-angle —— 必须被拦截。"""
    d = _media_files(tmp_path)
    body = _STD.format(d=d).replace(
        '<mc-source angleID="angleA"/>', '<mc-source angleID="angXX"/>')
    f = _write_xml(tmp_path, body)
    r = _run(str(f))
    assert r.returncode == 1
    assert "mc-source angleID: mc-angle 缺失 -> angXX" in r.stdout


# --- DTD 校验（find_dtd / dtd_errors）----------------------------------
# 用自洽最小 DTD 做可移植测试，不依赖本机是否装有 Final Cut / Creator Studio。
_MIN_DTD = """<!ELEMENT fcpxml (item*)>
<!ELEMENT item EMPTY>
<!ATTLIST item id ID #REQUIRED>
"""


def _dtd_dir(tmp: Path, dtd_text: str = _MIN_DTD) -> Path:
    d = tmp / "dtd"
    d.mkdir(exist_ok=True)
    (d / "FCPXMLv1_8.dtd").write_text(dtd_text, encoding="utf-8")
    return d


def _min_xml(kwargs: str = ' id="a"') -> str:
    return f"<?xml version=\"1.0\"?>\n<fcpxml><item{kwargs}/></fcpxml>\n"


@pytest.mark.skipif(
    __import__("shutil").which("xmllint") is None,
    reason="需要 macOS 命令行工具 xmllint")
def test_dtd_errors_passes_on_valid(tmp_path) -> None:
    v = _load_validator()
    dtd = _dtd_dir(tmp_path) / "FCPXMLv1_8.dtd"
    f = _write_xml(tmp_path, _min_xml())
    assert v.dtd_errors(str(f), str(dtd)) == []


@pytest.mark.skipif(
    __import__("shutil").which("xmllint") is None,
    reason="需要 macOS 命令行工具 xmllint")
def test_dtd_errors_catches_missing_required_attr(tmp_path) -> None:
    v = _load_validator()
    dtd = _dtd_dir(tmp_path) / "FCPXMLv1_8.dtd"
    # item 缺必填的 id 属性（ID 类型 #REQUIRED）→ DTD validity error
    f = _write_xml(tmp_path, _min_xml(kwargs=""))
    errs = v.dtd_errors(str(f), str(dtd))
    assert errs and "validity error" in errs[0]


@pytest.mark.skipif(
    __import__("shutil").which("xmllint") is None,
    reason="需要 macOS 命令行工具 xmllint")
def test_dtd_errors_catches_undeclared_element(tmp_path) -> None:
    v = _load_validator()
    dtd = _dtd_dir(tmp_path) / "FCPXMLv1_8.dtd"
    f = _write_xml(tmp_path, _min_xml(kwargs=' id="a"').replace("<item", "<bogus"))
    errs = v.dtd_errors(str(f), str(dtd))
    assert errs


def test_find_dtd_resolves_file_and_dir(tmp_path) -> None:
    v = _load_validator()
    dtd = _dtd_dir(tmp_path) / "FCPXMLv1_8.dtd"
    # 给文件
    assert v.find_dtd(str(dtd)) == str(dtd)
    # 给目录
    assert v.find_dtd(str(dtd.parent)) == str(dtd)
    # 不存在的路径 → None
    assert v.find_dtd(str(tmp_path / "nope")) is None


def test_find_dtd_autolocates_on_this_machine_or_none() -> None:
    seen = set()
    v = _load_validator()
    path = v.find_dtd(None)
    if path is not None:
        assert path.endswith(v.DTD_NAME)
    seen.add("find_dtd(None) 调用无异常")
    assert seen