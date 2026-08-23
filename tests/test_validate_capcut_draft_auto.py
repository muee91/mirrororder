"""validate_capcut_draft.py 的 --mode 解析与 auto 推导测试。

覆盖方案 2 的自动推导语义（2026-08-24）：
    auto: subdraft 子目录数
        == 1 -> raw（build_capcut_draft_31 单一组合原始产物）
        != 1（0 或多个，剪映保存后组合被拆/合并）-> saved

加载方式与本仓库其它 vendor 测试一致：用 spec_from_file_location 独立注入，
每用例一个全新模块实例，避免全局 MODE 串扰。parse_mode 会改模块级 MODE，
无其它副作用；main() 不执行。
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "vendor" / "multicam-audio-sync" / "scripts"


def _load_validator(monkeypatch) -> "module":
    """独立加载 validate_capcut_draft.py 为全新模块（隔离全局 MODE）。"""
    monkeypatch.setitem(sys.modules, "pandas", type(sys)("pandas"))  # 防止环境缺 pandas 拉崩
    spec = importlib.util.spec_from_file_location(
        "mirrororder_test_validate_draft",
        str(SCRIPTS / "validate_capcut_draft.py"),
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- 定位子目录数推导的核心语义 ----------------------------------------


def test_auto_single_subdir_is_raw(monkeypatch) -> None:
    v = _load_validator(monkeypatch)
    mode, _ = v.parse_mode([], sub_counts=1)
    assert mode == "raw"
    assert v.MODE == "raw"


@pytest.mark.parametrize("count", [2, 3, 8])
def test_auto_multiple_subdirs_is_saved(monkeypatch, count) -> None:
    """多子目录（剪映保存后组合被拆）必须识别为 saved——方案 2 的核心场景。"""
    v = _load_validator(monkeypatch)
    mode, _ = v.parse_mode([], sub_counts=count)
    assert mode == "saved"
    assert v.MODE == "saved"


def test_auto_zero_subdirs_is_saved(monkeypatch) -> None:
    """无 UUID 子目录也可存在（特殊保存态），不能按 raw 强判。"""
    v = _load_validator(monkeypatch)
    mode, _ = v.parse_mode([], sub_counts=0)
    assert mode == "saved"


# --- 显式覆盖 auto ------------------------------------------------------


def test_explicit_raw_overrides_multiple_subdirs(monkeypatch) -> None:
    v = _load_validator(monkeypatch)
    mode, _ = v.parse_mode(["--mode=raw"], sub_counts=5)
    assert mode == "raw"
    assert v.MODE == "raw"


def test_explicit_saved_overrides_single_subdir(monkeypatch) -> None:
    v = _load_validator(monkeypatch)
    mode, _ = v.parse_mode(["--mode=saved"], sub_counts=1)
    assert mode == "saved"
    assert v.MODE == "saved"


def test_explicit_auto_still_derives(monkeypatch) -> None:
    v = _load_validator(monkeypatch)
    assert v.parse_mode(["--mode=auto"], sub_counts=1)[0] == "raw"
    # 同一模块内再推导多子目录，应切到 saved（验证推导非一次性的）
    assert v.parse_mode(["--mode=auto"], sub_counts=3)[0] == "saved"


# --- 位置参数与标量返回 ------------------------------------------------


@pytest.mark.parametrize(
    "args,expected_pt",
    [
        (["/tmp/d", "--mode=saved"], "/tmp/d"),
        (["--mode=raw", "/tmp/d"], "/tmp/d"),
        (["--mode=auto", "/tmp/d"], "/tmp/d"),
        (["/tmp/d"], "/tmp/d"),
    ],
)
def test_parse_mode_returns_positional_path(monkeypatch, args, expected_pt) -> None:
    v = _load_validator(monkeypatch)
    _, positional = v.parse_mode(args, sub_counts=1)
    assert positional == expected_pt


def test_positional_extraction_matches_parse_mode(monkeypatch) -> None:
    """main() 直接用 next(...) 抽位置参数，应与 parse_mode 的返回一致。"""
    v = _load_validator(monkeypatch)
    args = ["--mode=saved", "/abs/draft"]
    manual = next((a for a in args if not a.startswith("--mode=")), None)
    _, pm_positional = v.parse_mode(args, sub_counts=3)
    assert manual == pm_positional == "/abs/draft"


def test_no_positional_returns_none(monkeypatch) -> None:
    v = _load_validator(monkeypatch)
    _, positional = v.parse_mode(["--mode=saved"], sub_counts=3)
    assert positional is None


# --- 非法模式必须拒绝 ----------------------------------------------------


@pytest.mark.parametrize("bad", ["bogus", "sav", "saved=1", ""])
def test_invalid_mode_exits_2(monkeypatch, capsys, bad) -> None:
    v = _load_validator(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        v.parse_mode([f"--mode={bad}"], sub_counts=1)
    assert exc.value.code == 2
    assert "非法 --mode" in capsys.readouterr().out