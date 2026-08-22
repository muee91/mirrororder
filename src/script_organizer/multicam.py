"""Stable public multicamera grouping API."""

from .fcpxml_reader import build_multicam_groups, group_id_for, overlap_seconds

__all__ = ["build_multicam_groups", "group_id_for", "overlap_seconds"]
