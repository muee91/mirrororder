"""Read-only shorthand classification at the paper scene-authority boundary."""

import re
import unicodedata

PAUSE_REASON = "paper_scene_shorthand_requires_review"

_ASCII_ARROW = re.compile(r"(?:[<>=-]*(?:<[-=]|[-=]>)[<>=-]*|<{2,}|>{2,}|\^+)")
_UNICODE_ARROWS = frozenset("↑↓→←↗↘↖↙↔↕⇆⇄⇅⇐⇒⇑⇓⇔➜➝➞➟➠➡↦⟵⟶⟷")
_STRUCTURAL = frozenset({
    '〃', '同上', 'ditto', '"', '″', '-', '--', '---', '—', '——', '–', '―',
    '/', '//', '\\', '...', '....', '…', '?', '??', '<>', '⟷',
})


def is_paper_scene_shorthand(scene: object) -> bool:
    """Recognize exact whole-cell marks, never rewrite or inherit a value."""
    if not isinstance(scene, str):
        return False
    token = "".join(ch for ch in unicodedata.normalize("NFKC", scene)
                    if not ch.isspace() and ch not in ("\ufe0e", "\ufe0f"))
    return bool(token and (token in _STRUCTURAL or _ASCII_ARROW.fullmatch(token)
                           or all(ch in _UNICODE_ARROWS for ch in token)))


def blocked_paper_interval_scene(row: dict) -> bool:
    provenance = row.get("provenance")
    paper_origin = (isinstance(provenance, dict)
                    and provenance.get("origin") == "imported_paper_transcription")
    return bool((row.get("paper_row_id") or paper_origin) and is_paper_scene_shorthand(row.get("scene")))
