#!/usr/bin/env python3
"""Pragya Companion CLI — dual-backend Google Workspace & snapshot JSON tool.

Supports:
  - book-list
  - book-add
  - book-update
  - book-capstone
  - progress
  - capture
  - note-update
  - reflect (--stage 1 | --stage commit)
  - recall (--mode qa | checkin | shuffle)
  - ocr-backfill
  - export-md
  - book-doc-sync

Uses Python 3 stdlib only.
"""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Callable

SPREADSHEET_TITLE = "Pragya Commonplace"
MEDIA_FOLDER_NAME = "Pragya Media"

BOOKS_HEADERS = [
    "id",
    "title",
    "author",
    "format",
    "kind",
    "status",
    "currentPos",
    "totalPos",
    "posUnit",
    "normalizedPos",
    "docUrl",
    "metaJson",
]

NOTES_HEADERS = [
    "id",
    "slug",
    "bookId",
    "createdAt",
    "updatedAt",
    "pos",
    "normalizedPos",
    "status",
    "source",
    "tags",
    "quote",
    "takeaway",
    "contextMechanism",
    "critique",
    "deltaTrigger",
    "deltaAction",
    "deltaStatus",
    "metaJson",
]

SESSIONS_HEADERS = [
    "id",
    "bookId",
    "date",
    "startPos",
    "endPos",
    "updatedAt",
    "note",
]

DELTA_LOGS_HEADERS = [
    "id",
    "noteId",
    "date",
    "outcome",
    "reflection",
]

COALESCE_WINDOW_SECONDS = 1800

# A5.5: Workspace CLI quota / rate-limit retry policy.
# Mirrored by the PWA classifier (Batch 3); keep both in sync. Rules:
#  1. A status token: RESOURCE_EXHAUSTED, RATE_LIMIT_EXCEEDED, "Too Many Requests",
#     rateLimitExceeded, userRateLimitExceeded, quotaExceeded, dailyLimitExceeded,
#     sharingRateLimitExceeded (camelCase reasons anchored with \b so e.g. Drive's
#     storageQuotaExceeded — "Drive is full" — is NOT a rate limit), "quota exceeded",
#     "Resource has been exhausted", "User rate limit exceeded".
#  2. A bare 429 only in an HTTP/status context: preceded (within 3 non-word chars) by
#     HTTP[/x.y], HttpError (googleapiclient "<HttpError 429 when requesting …>"),
#     status[ code], code or error, and not followed by another digit.
#     So "HTTP 429", "status=429", '"code": 429', "Error 429" match, while ids/ranges
#     such as "sheet-4291", "Notes!A1429", "1a429bc", "line 429" do not.
#  3. A line that starts with the status code itself ("429", "429 Too Many…", "429: …").
# Case-insensitive + multiline. JS equivalent: new RegExp(RATE_LIMIT_PATTERN, "im").
RATE_LIMIT_PATTERN = (
    r"RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|Too Many Requests|\brateLimitExceeded"
    r"|\buserRateLimitExceeded|\bquotaExceeded|\bdailyLimitExceeded|\bsharingRateLimitExceeded"
    r"|quota exceeded"
    r"|Resource has been exhausted|User rate limit exceeded"
    r"|(?:\bHTTP(?:/\d(?:\.\d)?)?|\bHttpError|\bstatus(?:[ _]?code)?|\bcode|\berror)\W{0,3}429(?!\d)"
    r"|^[ \t]*429(?![\w.])"
)
RATE_LIMIT_RE = re.compile(RATE_LIMIT_PATTERN, re.IGNORECASE | re.MULTILINE)


def is_rate_limited_output(text: str) -> bool:
    """True when Workspace CLI output signals a quota / rate-limit rejection (see rules above)."""
    return bool(RATE_LIMIT_RE.search(text or ""))
RATE_LIMIT_MAX_ATTEMPTS = 3
RATE_LIMIT_BACKOFF_SECONDS = (1, 2)
ACTIVE_DELTA_CAP = 5

DOC_URL_RE = re.compile(r"https?://docs\.google\.com/document/d/([a-zA-Z0-9_-]+)")
WHEN_PREFIX_RE = re.compile(r"^(?:when(?:\s+|:\s*|$))+", re.IGNORECASE)
DO_PREFIX_RE = re.compile(r"^(?:do(?:\s+|:\s*|$))+", re.IGNORECASE)
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


class CliError(Exception):
    """Domain or validation error reported cleanly with non-zero exit code."""


# ---------------------------------------------------------------------------
# Pure Domain Helpers (parity with src/utils/*.ts)
# ---------------------------------------------------------------------------


def now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso_utc(raw: str | None) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def local_date_str(dt: datetime | None = None) -> str:
    target = dt if dt is not None else datetime.now().astimezone()
    return target.strftime("%Y-%m-%d")


def clamp01(val: float) -> float:
    if val != val:  # NaN
        return 0.0
    return max(0.0, min(1.0, float(val)))


def compute_normalized_pos(pos: float, total_pos: float, pos_unit: str) -> float:
    safe_pos = max(0.0, float(pos or 0.0))
    if pos_unit == "percent":
        return clamp01(safe_pos / 100.0)
    safe_total = float(total_pos or 0.0)
    if safe_total > 0:
        return clamp01(safe_pos / safe_total)
    return 0.0


def effective_note_norm(note: dict[str, Any], book: dict[str, Any] | None) -> float:
    """Note position normalized against the book's *current* totalPos/posUnit.

    A stored note normalizedPos goes stale when the book's totalPos is edited later
    (e.g. 0 -> 300), so it is recomputed whenever the book has a usable scale.
    Parity with effectiveNoteNorm in src/utils/spoilerMath.ts (B2.4).
    """
    if book:
        total_pos = _safe_float(book.get("totalPos"), 0.0)
        pos_unit = book.get("posUnit") or "page"
        if total_pos > 0 or pos_unit == "percent":
            return compute_normalized_pos(_safe_float(note.get("pos"), 0.0), total_pos, pos_unit)
    return _safe_float(note.get("normalizedPos"), 0.0)


# Only safe because distinct positions are always > 1e-6 apart in normalized space, which
# holds for any book under 1,000,000 pages / locations (R2 nit).
SPOILER_NORM_EPSILON = 1e-6


def is_archived(entity: dict[str, Any] | None) -> bool:
    """C1.1 soft-archive: a non-empty `meta.archivedAt` (TS `isArchived` parity).

    Archived books/notes are excluded from default lists (book-list, recall, Doc/MD
    timelines, notesSummary) but still resolve by id/slug so they can be unarchived.
    """
    if not isinstance(entity, dict):
        return False
    value = (entity.get("meta") or {}).get("archivedAt")
    return isinstance(value, str) and value.strip() != ""


def is_note_spoiler(note: dict[str, Any], book: dict[str, Any] | None) -> bool:
    if not book or book.get("status") == "finished":
        return False
    total_pos = _safe_float(book.get("totalPos"), 0.0)
    if total_pos > 0 or book.get("posUnit") == "percent":
        # Stored normalizedPos is rounded to 6 decimals on every Sheet write (TS and CLI),
        # so a note exactly at the bookmark must not read as ahead of it (parity:
        # SPOILER_NORM_EPSILON in src/utils/spoilerMath.ts).
        return effective_note_norm(note, book) > _safe_float(book.get("normalizedPos"), 0.0) + SPOILER_NORM_EPSILON
    return _safe_float(note.get("pos"), 0.0) > _safe_float(book.get("currentPos"), 0.0)


def is_sealed_prediction(note: dict[str, Any], book: dict[str, Any] | None) -> bool:
    meta = note.get("meta") or {}
    return bool(
        meta.get("isPrediction")
        and book
        and book.get("kind") == "fiction"
        and book.get("status") != "finished"
    )


def is_unlocked_prediction(note: dict[str, Any], book: dict[str, Any] | None) -> bool:
    meta = note.get("meta") or {}
    return bool(
        meta.get("isPrediction")
        and book
        and book.get("kind") == "fiction"
        and book.get("status") == "finished"
    )


def strip_delta_prefix(value: str, prefix: str) -> str:
    trimmed = (value or "").strip()
    if not trimmed:
        return ""
    if prefix == "WHEN":
        return WHEN_PREFIX_RE.sub("", trimmed).strip()
    return strip_do_prefix(trimmed)


DO_NEGATION_RE = re.compile(r"^do\s+(?:not|nothing|n't|no|none)(?![\w'])", re.IGNORECASE)


def strip_do_prefix(value: str) -> str:
    """C5.3 / OQ-4: strip a DO prefix only when unambiguous (TS `stripDoPrefix` parity).

    `do:` (any case), repeated `DO DO`, or `do ` not followed by a negation word.
    `Do not reply after 9pm` stays intact; a lone `do` becomes ''.
    """
    s = (value or "").strip()
    while True:
        if re.fullmatch(r"do\s*", s, re.IGNORECASE):
            return ""
        colon = re.match(r"^do\s*:\s*", s, re.IGNORECASE)
        if colon:
            s = s[colon.end():].strip()
            continue
        if re.match(r"^do\s+", s, re.IGNORECASE) and not DO_NEGATION_RE.match(s):
            s = re.sub(r"^do\s+", "", s, count=1, flags=re.IGNORECASE).strip()
            continue
        return s


def normalize_delta_trigger(value: str) -> str:
    return strip_delta_prefix(value, "WHEN")


def normalize_delta_action(value: str) -> str:
    return strip_delta_prefix(value, "DO")


def format_when_do_lines(trigger: str, action: str) -> tuple[str, str, str, str]:
    trig_body = normalize_delta_trigger(trigger)
    act_body = normalize_delta_action(action)
    when_line = f"WHEN {trig_body}" if trig_body else ""
    do_line = f"DO {act_body}" if act_body else ""
    return trig_body, act_body, when_line, do_line


def slugify(text: str) -> str:
    cleaned = (text or "").lower().strip()
    cleaned = cleaned.replace("'", "").replace("\u2019", "")
    cleaned = re.sub(r"[^a-z0-9]+", "-", cleaned).strip("-")
    return cleaned or "note"


def generate_unique_slug(
    title_or_text: str, existing_slugs: list[str], exclude_self_slug: str | None = None
) -> str:
    base = slugify(title_or_text)
    taken = {s for s in existing_slugs if s and s != exclude_self_slug}
    if base not in taken:
        return base
    counter = 2
    while f"{base}-{counter}" in taken:
        counter += 1
    return f"{base}-{counter}"


def normalize_tag_list(tokens: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in tokens:
        trimmed = (raw or "").strip().lstrip("#").strip()
        if not trimmed:
            continue
        norm = "#" + re.sub(r"\s+", "-", trimmed.lower())
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def parse_tags_csv(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return normalize_tag_list([str(x or "") for x in raw])
    if not isinstance(raw, str):
        return []
    return normalize_tag_list(raw.split(","))


def serialize_tags_csv(tags: list[str]) -> str:
    return ", ".join(normalize_tag_list(tags))


def extract_wikilinks(text: str) -> list[str]:
    if not text:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for match in WIKILINK_RE.finditer(text):
        raw = (match.group(1) or "").strip()
        if not raw:
            continue
        norm = slugify(raw)
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def extract_note_wikilinks(note: dict[str, Any]) -> list[str]:
    combined = "\n".join(
        [
            note.get("takeaway") or "",
            note.get("contextMechanism") or "",
            note.get("critique") or "",
            note.get("quote") or "",
        ]
    )
    return extract_wikilinks(combined)


def fnv1a_32(text: str) -> int:
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def parse_date_only_utc(date_str: str) -> datetime | None:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", (date_str or "").strip())
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc)
    except ValueError:
        return None


def to_local_date_key(value: Any) -> str | None:
    """C5.1: the user's LOCAL calendar date (`YYYY-MM-DD`) for a stored value.

    Date-only strings pass through; ISO timestamps (with a `T`) convert via astimezone().
    A timestamp without an offset is read as UTC (parse_iso_utc). TS mirror:
    `toLocalDateKey` in src/utils/takeawayShuffle.ts.
    """
    s = value.strip() if isinstance(value, str) else ""
    if not s:
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    if "T" not in s:
        return m.group(1) if m else None
    dt = parse_iso_utc(s)
    if dt is None:
        return m.group(1) if m else None
    return dt.astimezone().strftime("%Y-%m-%d")


def calendar_days_between(from_iso: str, to_date_str: str) -> int:
    start = parse_date_only_utc(to_local_date_key(from_iso) or "")
    end = parse_date_only_utc(to_local_date_key(to_date_str) or "")
    if start is None or end is None:
        return 0
    return (end - start).days


def shuffle_staleness_bucket(note: dict[str, Any], today_date: str) -> int:
    """C5.2: 0 never reviewed, 1 reviewed > 30 days ago, 2 reviewed 8-30 days ago, 3 <= 7."""
    reviewed = to_local_date_key((note.get("meta") or {}).get("lastReviewedAt"))
    if not reviewed:
        return 0
    days = calendar_days_between(reviewed, today_date)
    if days > 30:
        return 1
    if days >= 8:
        return 2
    return 3


def is_favorite_note(note: dict[str, Any]) -> bool:
    for tag in note.get("tags") or []:
        lower = str(tag).strip().lower()
        if lower in ("#favorite", "#favorites", "favorite", "favorites"):
            return True
    return False


def is_eligible_for_shuffle(
    note: dict[str, Any], book: dict[str, Any] | None, today_date: str
) -> bool:
    if is_note_spoiler(note, book):
        return False
    if is_sealed_prediction(note, book):
        return False
    if is_archived(note):
        return False
    # C5.1: "reviewed today" means the user's local date (no UTC-slice shortcut).
    if to_local_date_key((note.get("meta") or {}).get("lastReviewedAt")) == today_date:
        return False
    if not (note.get("takeaway") or "").strip() and not (note.get("quote") or "").strip():
        return False
    if is_favorite_note(note):
        return True
    return calendar_days_between(str(note.get("createdAt") or ""), today_date) >= 14


def select_takeaway_shuffle(
    notes: list[dict[str, Any]],
    books: list[dict[str, Any]],
    today_date: str | None = None,
    limit: int = 3,
) -> list[dict[str, Any]]:
    target_date = today_date or local_date_str()
    book_map = {b["id"]: b for b in books}
    eligible = [
        n for n in notes if is_eligible_for_shuffle(n, book_map.get(n.get("bookId", "")), target_date)
    ]
    eligible.sort(
        key=lambda n: (
            shuffle_staleness_bucket(n, target_date),
            fnv1a_32(f"{target_date}:{n['id']}"),
            n["id"],
        )
    )
    return eligible[: max(0, limit)]


def format_pos_display(pos: float, pos_unit: str) -> str:
    clean = int(pos) if float(pos) == int(float(pos)) else round(float(pos), 2)
    if pos_unit == "percent":
        return f"{clean}%"
    if pos_unit == "loc":
        return f"loc {clean}"
    return f"p. {clean}"


def format_chapter_label(chapter: Any) -> str:
    """ux_spec B.3: a purely numeric chapter becomes `Ch. N`; anything else is verbatim.

    ASCII digits only (`[0-9]`, QA-17/R1#3) so the TS port (`/^[0-9]+$/`) labels the same
    chapter identically; Python `\\d` would also match Unicode digits like `३`.
    """
    text = (_coerce_meta_string(chapter) or "").strip()
    if not text:
        return ""
    return f"Ch. {text}" if re.fullmatch(r"[0-9]+", text) else text


def format_chapter_pos(chapter: Any, pos: float, pos_unit: str) -> str:
    """ux_spec B.3 `formatChapterPos`: `Ch. 3 · p. 42`, `Run · 10%`, or `10%` (no brackets).

    Parity target for the Batch 7 TS formatter; used for `notesSummary[].label` and by the
    Batch 6 Companion Doc / Markdown timelines (via format_chapter_badge).
    """
    pos_text = format_pos_display(_safe_float(pos, 0.0), pos_unit)
    label = format_chapter_label(chapter)
    return f"{label} · {pos_text}" if label else pos_text


def format_chapter_badge(chapter: Any, pos: float, pos_unit: str) -> str:
    """Plain-text rendering of format_chapter_pos with literal brackets (A3.1 / B.3 table):
    `[Ch. 3 · p. 42]`, `[Run · 10%]`, or `[10%]`."""
    return f"[{format_chapter_pos(chapter, pos, pos_unit)}]"


def _chapter_arg(raw: str | None) -> str | None:
    """None = flag omitted; "" = explicit clear; otherwise the trimmed chapter."""
    if raw is None:
        return None
    return raw.strip()


def _apply_chapter(meta: dict[str, Any], key: str, value: str) -> bool:
    """Set (non-empty) or clear (empty) meta[key]; returns True when it changed."""
    before = meta.get(key)
    if value:
        meta[key] = value
    else:
        meta.pop(key, None)
    return meta.get(key) != before


def clean_num(val: Any, fallback: float = 0.0) -> int | float:
    try:
        f = float(val)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(f):
        # NaN/Infinity cells fall back like TS asNumber (int(inf) would raise).
        return fallback
    return int(f) if f == int(f) else f


def safe_json_parse(raw: Any, fallback: Any) -> Any:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return fallback
    trimmed = raw.strip()
    if not trimmed:
        return fallback
    try:
        # Reject NaN/Infinity like JS JSON.parse does (parity + never re-emit invalid JSON).
        return json.loads(trimmed, parse_constant=_reject_json_constant)
    except ValueError:
        return fallback


def _reject_json_constant(token: str) -> Any:
    raise ValueError(f"Non-standard JSON constant: {token}")


def _strip_non_finite(value: Any) -> Any:
    """Drops NaN/Infinity (dict values omitted, list items -> None) so output is strict JSON."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {
            k: _strip_non_finite(v)
            for k, v in value.items()
            if not (isinstance(v, float) and not math.isfinite(v))
        }
    if isinstance(value, (list, tuple)):
        return [_strip_non_finite(v) for v in value]
    return value


def json_dumps_strict(value: Any, **kwargs: Any) -> str:
    """json.dumps that never emits NaN/Infinity (JS JSON.parse would reject the whole cell)."""
    try:
        return json.dumps(value, allow_nan=False, **kwargs)
    except ValueError:
        return json.dumps(_strip_non_finite(value), allow_nan=False, **kwargs)


# ---------------------------------------------------------------------------
# Defensive Drift Codecs (parity with src/utils/metaCodecs.ts)
#
# Unknown metaJson keys are always preserved. Known keys are re-validated and
# dropped only when empty or invalid. Legacy aliases are canonicalized
# (chapterNote -> currentChapter, q1/q2/q3 -> socraticQuestions). Never raises.
# Idempotent.
#
# Agent-owned structures are stored verbatim and filtered only at render/creation
# time (decisions.md, Batch 1 fix-up): `attachments` (all entries, any count; see
# renderable_attachments), `capstone` (see get_book_capstone) and `sparStage`.
# ---------------------------------------------------------------------------

BOOK_META_STRING_KEYS = ("coverUrl", "startedAt", "finishedAt", "currentChapter", "archivedAt")
NOTE_META_STRING_KEYS = ("title", "exportedAt", "lastReviewedAt", "chapter", "archivedAt")
NOTE_META_BOOLEAN_KEYS = ("isPrediction", "ocrBackfilled")
LEGACY_QUESTION_KEYS = ("q1", "q2", "q3")
MAX_SOCRATIC_QUESTIONS = 3
MAX_ATTACHMENTS = 3
MAX_KEY_LEARNINGS = 7
# A2.2 notesSummary contract (decisions Batch 5, mirrors ux_spec A.5 Copy Capstone Prompt).
NOTES_SUMMARY_MAX_ENTRIES = 60
NOTES_SUMMARY_TEXT_LIMIT = 280
NOTES_SUMMARY_ENTRY_KEYS = (
    "id", "slug", "status", "pos", "posDisplay", "label", "chapter", "title", "quote", "takeaway", "delta",
)
# Keys every transition into `finished` returns (progress --finish / book-update --status finished).
FINISH_RESULT_KEYS = ("unlockedPredictionsCount", "capstonePending")

BOOK_FORMAT_ALIASES = {"kindle": "kindle", "ebook": "kindle"}
NOTE_SOURCE_AGENT_ALIASES = ("agent", "companion", "assistant", "cli", "skill")

SHEET_SERIAL_MAX = 2_958_466  # exclusive upper bound (10000-01-01)
SHEET_SERIAL_UNIX_EPOCH = 25569  # 1970-01-01 as days since 1899-12-30
SHEET_SERIAL_STRING_RE = re.compile(r"^[0-9]{5}(\.[0-9]+)?$")  # ASCII only (JS \d parity)
_UNIX_EPOCH_UTC = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _js_number_str(value: float) -> str:
    """String(n) parity for finite numbers (integral floats render without '.0')."""
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    return str(value)


def _coerce_meta_string(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        return value if value.strip() else None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return _js_number_str(value)
    return None


def _coerce_meta_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes"):
            return True
        if lowered in ("false", "0", "no"):
            return False
    return None


def _apply_meta_string(out: dict[str, Any], key: str) -> None:
    if key not in out:
        return
    coerced = _coerce_meta_string(out[key])
    if coerced is None:
        del out[key]
    else:
        out[key] = coerced


def _to_question_list(value: Any) -> list[str]:
    if isinstance(value, list):
        items = value
    elif isinstance(value, str):
        items = [value]
    else:
        items = []
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        trimmed = item.strip()
        if trimmed:
            out.append(trimmed)
        if len(out) >= MAX_SOCRATIC_QUESTIONS:
            break
    return out


def get_book_capstone(meta: Any) -> dict[str, Any] | None:
    """Typed, render-safe view of meta.capstone (the stored object is never rewritten).

    Parity with getBookCapstone in src/utils/metaCodecs.ts.
    """
    value = meta.get("capstone") if isinstance(meta, dict) else None
    if not isinstance(value, dict):
        return None
    raw_learnings = value.get("keyLearnings")
    if isinstance(raw_learnings, list):
        learnings_list = raw_learnings
    elif raw_learnings is None:
        learnings_list = []
    else:
        learnings_list = [raw_learnings]
    learnings: list[str] = []
    for item in learnings_list:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            text = _coerce_meta_string(item) or ""
        else:
            text = ""
        if text:
            learnings.append(text)
    return {
        "arcOrThesis": _coerce_meta_string(value.get("arcOrThesis")) or "",
        "keyLearnings": learnings,
        "perspectiveShift": _coerce_meta_string(value.get("perspectiveShift")) or "",
        "completedAt": _coerce_meta_string(value.get("completedAt")) or "",
    }


def has_book_capstone(meta: Any) -> bool:
    """True when meta.capstone holds any user content (arc, learnings or shift)."""
    view = get_book_capstone(meta)
    if view is None:
        return False
    return bool(view["arcOrThesis"] or view["keyLearnings"] or view["perspectiveShift"])


def _parse_meta_input(raw: Any) -> dict[str, Any]:
    parsed = safe_json_parse(raw, {})
    return parsed if isinstance(parsed, dict) else {}


def normalize_book_meta(raw: Any) -> dict[str, Any]:
    src = _parse_meta_input(raw)
    out: dict[str, Any] = dict(src)

    if "chapterNote" in out:
        if _coerce_meta_string(out.get("currentChapter")) is None:
            legacy = _coerce_meta_string(out.get("chapterNote"))
            if legacy is not None:
                out["currentChapter"] = legacy
        del out["chapterNote"]

    for key in BOOK_META_STRING_KEYS:
        _apply_meta_string(out, key)

    # capstone passes through verbatim (see get_book_capstone for the typed view).

    out["updatedAt"] = _coerce_meta_string(src.get("updatedAt")) or ""
    return out


def _to_valid_attachment(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    att_id = item.get("id")
    if not isinstance(att_id, str) or not att_id.strip():
        return None
    att_type = item.get("type")
    if att_type == "image":
        att = dict(item)
        file_name = item.get("fileName")
        mime_type = item.get("mimeType")
        att["fileName"] = file_name if isinstance(file_name, str) and file_name.strip() else "image.webp"
        att["mimeType"] = mime_type if isinstance(mime_type, str) and mime_type.strip() else "image/webp"
        return att
    if att_type in ("doc", "link"):
        url = item.get("url")
        if not isinstance(url, str) or not url.strip():
            return None
        att = dict(item)
        if not isinstance(att.get("title"), str):
            att["title"] = ""
        return att
    return None


def normalize_attachments(raw: Any) -> list[dict[str, Any]]:
    """Render/creation-time validation (<=3 valid image/doc/link objects).

    Never used on the storage round-trip, which keeps every entry verbatim.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if len(out) >= MAX_ATTACHMENTS:
            break
        att = _to_valid_attachment(item)
        if att is not None:
            out.append(att)
    return out


def renderable_attachments(meta: Any) -> list[dict[str, Any]]:
    return normalize_attachments(meta.get("attachments") if isinstance(meta, dict) else None)


def _normalize_links(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        coerced = _coerce_meta_string(item)
        if coerced is not None:
            out.append(coerced)
    return out


def normalize_note_meta(raw: Any) -> dict[str, Any]:
    src = _parse_meta_input(raw)
    out: dict[str, Any] = dict(src)

    for key in NOTE_META_STRING_KEYS:
        _apply_meta_string(out, key)

    for key in NOTE_META_BOOLEAN_KEYS:
        if key not in out:
            continue
        coerced = _coerce_meta_bool(out[key])
        if coerced is None:
            del out[key]
        else:
            out[key] = coerced

    questions = _to_question_list(out.get("socraticQuestions"))
    if not questions:
        questions = _to_question_list([out.get(k) for k in LEGACY_QUESTION_KEYS])
    for key in LEGACY_QUESTION_KEYS:
        out.pop(key, None)
    if questions:
        out["socraticQuestions"] = questions
    else:
        out.pop("socraticQuestions", None)

    # Stored verbatim (every entry, any count); filtered only at render/creation time.
    raw_attachments = out.get("attachments")
    out["attachments"] = list(raw_attachments) if isinstance(raw_attachments, list) else []
    out["links"] = _normalize_links(out.get("links"))
    return out


def normalize_book_format(raw: Any) -> str:
    value = raw.strip().lower() if isinstance(raw, str) else ""
    return BOOK_FORMAT_ALIASES.get(value, "physical")


def normalize_note_source(raw: Any) -> str:
    value = raw.strip().lower() if isinstance(raw, str) else ""
    return "agent" if value in NOTE_SOURCE_AGENT_ALIASES else "app"


def _to_sheet_serial(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return float(value) if 0 < value < SHEET_SERIAL_MAX else None
    if isinstance(value, str):
        trimmed = value.strip()
        if not SHEET_SERIAL_STRING_RE.match(trimmed):
            return None
        n = float(trimmed)
        return n if 0 < n < SHEET_SERIAL_MAX else None
    return None


def _cell_str(value: Any) -> str:
    """String(v) parity with the TS codecs for raw Sheet cells."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and math.isfinite(value):
        return _js_number_str(value)
    return str(value)


def decode_sheet_date(value: Any) -> str:
    """Sheets serial date -> UTC 'YYYY-MM-DD'; anything else -> trimmed string.

    Parity with decodeSheetDate in src/utils/sheetCodecs.ts.
    """
    serial = _to_sheet_serial(value)
    if serial is None:
        return _cell_str(value).strip()
    days = int(math.floor(serial)) - SHEET_SERIAL_UNIX_EPOCH
    return (_UNIX_EPOCH_UTC + timedelta(days=days)).strftime("%Y-%m-%d")


def decode_sheet_timestamp(value: Any) -> str:
    """Sheets serial date-time -> ISO-8601 UTC with milliseconds; else trimmed string.

    Parity with decodeSheetTimestamp in src/utils/sheetCodecs.ts.
    """
    serial = _to_sheet_serial(value)
    if serial is None:
        return _cell_str(value).strip()
    # math.floor(x + 0.5) == JS Math.round (half-up), not Python's banker's round().
    ms = int(math.floor((serial - SHEET_SERIAL_UNIX_EPOCH) * 86_400_000 + 0.5))
    dt = _UNIX_EPOCH_UTC + timedelta(milliseconds=ms)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_float(value: Any, fallback: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    try:
        f = float(value)
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


def normalize_book_dict(book: dict[str, Any]) -> dict[str, Any]:
    """Idempotent drift normalization for snapshot/state-file book dicts.

    Unknown top-level and meta keys are preserved.
    """
    out = dict(book)
    out["format"] = normalize_book_format(book.get("format"))
    if out.get("kind") not in ("nonfiction", "fiction"):
        out["kind"] = "nonfiction"
    if out.get("status") not in ("reading", "queued", "finished", "paused"):
        out["status"] = "reading"
    if out.get("posUnit") not in ("page", "percent", "loc"):
        out["posUnit"] = "page"
    # QA-6: coerce known numeric fields (NaN/Infinity/garbage -> 0) instead of letting
    # json_dumps_strict silently drop the key on the next write.
    for key in ("currentPos", "totalPos"):
        if key in out:
            out[key] = clean_num(out.get(key), 0)
    if "normalizedPos" in out:
        out["normalizedPos"] = clamp01(_safe_float(out.get("normalizedPos"), 0.0))
    out["meta"] = normalize_book_meta(book.get("meta"))
    return out


def normalize_note_dict(note: dict[str, Any]) -> dict[str, Any]:
    """Idempotent drift normalization for snapshot/state-file note dicts.

    Unknown top-level and meta keys are preserved.
    """
    out = dict(note)
    out["source"] = normalize_note_source(note.get("source"))
    if out.get("status") not in ("saved", "inbox", "in-reflection", "atomic"):
        out["status"] = "saved"
    if out.get("deltaStatus") not in ("none", "active", "graduated", "paused"):
        out["deltaStatus"] = "none"
    if "pos" in out:
        out["pos"] = clean_num(out.get("pos"), 0)  # QA-6
    if "normalizedPos" in out:
        out["normalizedPos"] = clamp01(_safe_float(out.get("normalizedPos"), 0.0))
    out["meta"] = normalize_note_meta(note.get("meta"))
    return out


# ---------------------------------------------------------------------------
# Sheet Codecs (Books!A:L, Notes!A:R, Sessions!A:G, DeltaLogs!A:E)
# ---------------------------------------------------------------------------


def book_to_row(book: dict[str, Any]) -> list[Any]:
    return [
        book["id"],
        book["title"],
        book["author"],
        book["format"],
        book["kind"],
        book["status"],
        clean_num(book.get("currentPos", 0)),
        clean_num(book.get("totalPos", 0)),
        book["posUnit"],
        round(float(book.get("normalizedPos", 0.0)), 6),
        book.get("docUrl") or "",
        json_dumps_strict(
            normalize_book_meta(book["meta"])
            if book.get("meta") is not None
            else {"updatedAt": now_iso_utc()},
            ensure_ascii=False,
        ),
    ]


def row_to_book(row: list[Any]) -> dict[str, Any] | None:
    if not isinstance(row, list) or not row:
        return None
    bid = str(row[0] or "").strip()
    if not bid or bid == "id":
        return None

    def col(i: int, default: Any = "") -> Any:
        return row[i] if i < len(row) else default

    fmt = normalize_book_format(col(3, "physical"))
    kind = str(col(4, "nonfiction")).strip()
    if kind not in ("nonfiction", "fiction"):
        kind = "nonfiction"
    status = str(col(5, "reading")).strip()
    if status not in ("reading", "queued", "finished", "paused"):
        status = "reading"
    pos_unit = str(col(8, "page")).strip()
    if pos_unit not in ("page", "percent", "loc"):
        pos_unit = "page"

    current_pos = clean_num(col(6, 0), 0)
    total_pos = clean_num(col(7, 0), 0)
    norm_raw = col(9, "")
    if norm_raw not in ("", None):
        try:
            normalized_pos = clamp01(float(norm_raw))
        except (TypeError, ValueError):
            normalized_pos = 1.0 if status == "finished" else compute_normalized_pos(current_pos, total_pos, pos_unit)
    else:
        normalized_pos = 1.0 if status == "finished" else compute_normalized_pos(current_pos, total_pos, pos_unit)

    # Unknown keys pass through; missing updatedAt reads as "" (conflict guards fail open).
    meta = normalize_book_meta(col(11, "{}"))

    return {
        "id": bid,
        "title": str(col(1, "")),
        "author": str(col(2, "")),
        "format": fmt,
        "kind": kind,
        "status": status,
        "currentPos": current_pos,
        "totalPos": total_pos,
        "posUnit": pos_unit,
        "normalizedPos": normalized_pos,
        "docUrl": str(col(10, "")),
        "meta": meta,
    }


def note_to_row(note: dict[str, Any]) -> list[Any]:
    trigger = normalize_delta_trigger(note.get("deltaTrigger") or "")
    action = normalize_delta_action(note.get("deltaAction") or "")
    # Canonical write: unknown keys kept, legacy q1/q2 dropped, attachments stored verbatim.
    meta_in = normalize_note_meta(note.get("meta") or {})
    return [
        note["id"],
        note["slug"],
        note["bookId"],
        note["createdAt"],
        note["updatedAt"],
        clean_num(note.get("pos", 0)),
        round(float(note.get("normalizedPos", 0.0)), 6),
        note["status"],
        note["source"],
        serialize_tags_csv(note.get("tags") or []),
        note.get("quote") or "",
        note.get("takeaway") or "",
        note.get("contextMechanism") or "",
        note.get("critique") or "",
        trigger,
        action,
        note.get("deltaStatus") or "none",
        json_dumps_strict(meta_in, ensure_ascii=False),
    ]


def row_to_note(row: list[Any]) -> dict[str, Any] | None:
    if not isinstance(row, list) or not row:
        return None
    nid = str(row[0] or "").strip()
    if not nid or nid == "id":
        return None

    def col(i: int, default: Any = "") -> Any:
        return row[i] if i < len(row) else default

    status = str(col(7, "saved")).strip()
    if status not in ("saved", "inbox", "in-reflection", "atomic"):
        status = "saved"
    source = normalize_note_source(col(8, "app"))
    delta_status = str(col(16, "none")).strip()
    if delta_status not in ("none", "active", "graduated", "paused"):
        delta_status = "none"

    pos = clean_num(col(5, 0), 0)
    try:
        normalized_pos = clamp01(float(col(6, 0) or 0))
    except (TypeError, ValueError):
        # B4.6: a corrupt Notes!G cell must not abort the whole workspace load.
        normalized_pos = 0.0
    # Unknown keys pass through; legacy q1/q2 -> socraticQuestions (1-3 kept).
    meta = normalize_note_meta(col(17, "{}"))

    return {
        "id": nid,
        "slug": str(col(1, "")).strip() or nid,
        "bookId": str(col(2, "")).strip(),
        "createdAt": decode_sheet_timestamp(col(3, "")),
        "updatedAt": decode_sheet_timestamp(col(4, "")),
        "pos": pos,
        "normalizedPos": normalized_pos,
        "status": status,
        "source": source,
        "tags": parse_tags_csv(col(9, "")),
        "quote": str(col(10, "")),
        "takeaway": str(col(11, "")),
        "contextMechanism": str(col(12, "")),
        "critique": str(col(13, "")),
        "deltaTrigger": normalize_delta_trigger(str(col(14, ""))),
        "deltaAction": normalize_delta_action(str(col(15, ""))),
        "deltaStatus": delta_status,
        "meta": meta,
    }


def session_to_row(session: dict[str, Any]) -> list[Any]:
    return [
        session["id"],
        session["bookId"],
        session["date"],
        clean_num(session.get("startPos", 0)),
        clean_num(session.get("endPos", 0)),
        session["updatedAt"],
        session.get("note") or "",
    ]


def row_to_session(row: list[Any]) -> dict[str, Any] | None:
    if not isinstance(row, list) or not row:
        return None
    sid = str(row[0] or "").strip()
    if not sid or sid == "id":
        return None

    def col(i: int, default: Any = "") -> Any:
        return row[i] if i < len(row) else default

    return {
        "id": sid,
        "bookId": str(col(1, "")).strip(),
        "date": decode_sheet_date(col(2, "")),
        "startPos": clean_num(col(3, 0)),
        "endPos": clean_num(col(4, 0)),
        "updatedAt": decode_sheet_timestamp(col(5, "")),
        "note": str(col(6, "")),
    }


def delta_log_to_row(log: dict[str, Any]) -> list[Any]:
    return [
        log["id"],
        log["noteId"],
        log["date"],
        log["outcome"],
        log.get("reflection") or "",
    ]


def row_to_delta_log(row: list[Any]) -> dict[str, Any] | None:
    if not isinstance(row, list) or not row:
        return None
    lid = str(row[0] or "").strip()
    if not lid or lid == "id":
        return None

    def col(i: int, default: Any = "") -> Any:
        return row[i] if i < len(row) else default

    outcome = str(col(3, "no-trigger")).strip()
    if outcome not in ("applied", "missed", "no-trigger"):
        outcome = "no-trigger"

    return {
        "id": lid,
        "noteId": str(col(1, "")).strip(),
        "date": decode_sheet_date(col(2, "")),
        "outcome": outcome,
        "reflection": str(col(4, "")),
    }


# ---------------------------------------------------------------------------
# Monotonic Bookmark, Note Clamping & 30-Min Session Coalescing
# ---------------------------------------------------------------------------


def clamp_note_pos(raw_pos: float, book: dict[str, Any] | None) -> float:
    pos = max(0.0, float(raw_pos or 0))
    if not book:
        return pos
    pos_unit = book.get("posUnit") or "page"
    total_pos = float(book.get("totalPos") or 0)
    if pos_unit == "percent":
        pos = min(100.0, pos)
    if total_pos > 0:
        pos = min(total_pos, pos)
    return pos


def _to_epoch_ms(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        # Sheets UNFORMATTED_VALUE may surface serial dates (days since 1899-12-30).
        if 0 < value < 2_958_466:
            return round((value - 25569) * 86_400_000)
        return round(value)
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    dt = parse_iso_utc(trimmed)
    if dt is None:
        return None
    return round(dt.timestamp() * 1000)


def _is_remote_newer(remote_ts: Any, expected_ts: Any) -> bool:
    remote_ms = _to_epoch_ms(remote_ts)
    expected_ms = _to_epoch_ms(expected_ts)
    if remote_ms is None or expected_ms is None:
        return False
    return remote_ms > expected_ms


def apply_bookmark_advance(
    book: dict[str, Any],
    incoming_pos: float,
    *,
    manual_override: bool = False,
    now_iso: str | None = None,
) -> tuple[dict[str, Any], bool, bool, float, float]:
    iso = now_iso or now_iso_utc()
    prev_pos = float(book.get("currentPos") or 0)
    sanitized = max(0.0, float(incoming_pos or 0))
    total_pos = float(book.get("totalPos") or 0)
    pos_unit = book.get("posUnit") or "page"

    if pos_unit == "percent":
        sanitized = min(100.0, sanitized)
    elif total_pos > 0:
        sanitized = min(total_pos, sanitized)

    if sanitized < prev_pos and not manual_override:
        return book, False, True, prev_pos, prev_pos

    next_pos = sanitized if manual_override else max(prev_pos, sanitized)
    if clean_num(next_pos) == clean_num(prev_pos):
        return book, False, False, prev_pos, prev_pos

    next_norm = (
        1.0
        if book.get("status") == "finished"
        else compute_normalized_pos(next_pos, total_pos, pos_unit)
    )
    if not manual_override:
        next_norm = max(float(book.get("normalizedPos") or 0), next_norm)

    updated = json.loads(json.dumps(book))
    updated["currentPos"] = clean_num(next_pos)
    updated["normalizedPos"] = next_norm
    meta = updated.setdefault("meta", {})
    if updated.get("status") in ("queued", "paused"):
        updated["status"] = "reading"
        if not meta.get("startedAt"):
            meta["startedAt"] = iso
    meta["updatedAt"] = iso
    return updated, True, False, clean_num(prev_pos), clean_num(next_pos)


def upsert_coalesced_session(
    sessions: list[dict[str, Any]],
    *,
    book_id: str,
    prev_pos: float,
    next_pos: float,
    now_iso: str | None = None,
    note: str = "",
    manual_override: bool = False,
) -> tuple[dict[str, Any], bool]:
    iso = now_iso or now_iso_utc()
    now_dt = parse_iso_utc(iso) or datetime.now(timezone.utc)
    today = local_date_str(now_dt.astimezone())

    candidates: list[dict[str, Any]] = []
    for s in sessions:
        if s.get("bookId") != book_id or s.get("date") != today:
            continue
        dt = parse_iso_utc(s.get("updatedAt"))
        if dt is None:
            continue
        elapsed = (now_dt - dt).total_seconds()
        if -60 <= elapsed <= COALESCE_WINDOW_SECONDS:
            candidates.append(s)

    if candidates:
        candidates.sort(key=lambda x: str(x.get("updatedAt") or ""), reverse=True)
        existing = candidates[0]
        merged_end = (
            clean_num(next_pos)
            if manual_override
            else clean_num(max(float(existing.get("endPos") or 0), float(next_pos)))
        )
        updated = {
            **existing,
            "endPos": merged_end,
            "updatedAt": iso,
            "note": note.strip() if note.strip() else existing.get("note") or "",
        }
        return updated, False

    created = {
        "id": str(uuid.uuid4()),
        "bookId": book_id,
        "date": today,
        "startPos": clean_num(prev_pos),
        "endPos": clean_num(next_pos),
        "updatedAt": iso,
        "note": note.strip(),
    }
    return created, True


# ---------------------------------------------------------------------------
# Storage Backends
# ---------------------------------------------------------------------------


def default_cmd_runner(cmd: list[str]) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError as exc:
        tool = cmd[0] if cmd else "workspace CLI"
        raise CliError(
            f"Required Google Workspace CLI '{tool}' was not found on PATH. "
            "Use Mode B (native Google Workspace / MCP connector on 'Pragya Commonplace'), "
            "pass --state-file <snapshot.json> for offline snapshots, or render a Paste Card."
        ) from exc


class WorkspaceBackend:
    def load_workspace(self) -> dict[str, Any]:
        raise NotImplementedError

    def save_book(
        self,
        book: dict[str, Any],
        *,
        expected_base_updated_at: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def save_note(
        self,
        note: dict[str, Any],
        *,
        expected_base_updated_at: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def save_session(self, session: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def save_delta_log(self, log: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def upload_image(self, local_path: Path) -> dict[str, Any]:
        raise NotImplementedError

    def fetch_image_to_temp(self, attachment: dict[str, Any]) -> tuple[Path | None, bool]:
        raise NotImplementedError

    def create_companion_doc(
        self, title: str, initial_text: str, book_id: str = ""
    ) -> tuple[str, str]:
        raise NotImplementedError

    def read_doc_text(self, doc_id: str) -> str:
        raise NotImplementedError

    def append_doc_text(self, doc_id: str, text: str) -> None:
        raise NotImplementedError

    def read_doc_snapshot(self, doc_id: str) -> DocSnapshot | None:
        """Indexed Doc paragraphs + revisionId for in-place sync, or None when unsafe."""
        return None

    def read_doc_lines(self, doc_id: str) -> list[DocLine] | None:
        snap = self.read_doc_snapshot(doc_id)
        return snap.lines if snap is not None else None

    def batch_update_doc(
        self, doc_id: str, requests: list[dict[str, Any]], required_revision_id: str | None = None
    ) -> None:
        raise NotImplementedError


def _upsert_by_id(items: list[dict[str, Any]], item: dict[str, Any]) -> list[dict[str, Any]]:
    out = list(items)
    for idx, existing in enumerate(out):
        if isinstance(existing, dict) and existing.get("id") == item.get("id"):
            out[idx] = item
            return out
    out.append(item)
    return out


class StateFileBackend(WorkspaceBackend):
    def __init__(self, path: Path) -> None:
        self.path = path

    def _read_raw(self) -> dict[str, Any]:
        if not self.path.exists():
            raise CliError(f"State file not found: {self.path}")
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CliError(f"Invalid JSON in state file {self.path}: {exc}") from exc
        if not isinstance(data, dict) or data.get("version") != 1:
            raise CliError("State file must be a PragyaSnapshot JSON object with version == 1.")
        for key in ("books", "notes", "sessions", "deltaLogs"):
            if not isinstance(data.get(key), list):
                raise CliError(f"State file missing required '{key}' array.")
        return data

    def _write_raw(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data["version"] = 1
        data["exportedAt"] = now_iso_utc()
        fd, tmp_name = tempfile.mkstemp(
            prefix=".pragya_state_", suffix=".json", dir=str(self.path.parent)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json_dumps_strict(data, indent=2, ensure_ascii=False))
                fh.write("\n")
            os.replace(tmp_name, self.path)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)

    def load_workspace(self) -> dict[str, Any]:
        raw = self._read_raw()
        # Same drift codecs as the Sheets path (print/companion/q1-q2/chapterNote).
        return {
            "books": [normalize_book_dict(b) if isinstance(b, dict) else b for b in raw["books"]],
            "notes": [normalize_note_dict(n) if isinstance(n, dict) else n for n in raw["notes"]],
            "sessions": list(raw["sessions"]),
            "deltaLogs": list(raw["deltaLogs"]),
        }

    def save_book(
        self,
        book: dict[str, Any],
        *,
        expected_base_updated_at: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        raw = self._read_raw()
        normalized = normalize_book_dict(book)
        if expected_base_updated_at and not force:
            for existing in raw["books"]:
                if isinstance(existing, dict) and existing.get("id") == book.get("id"):
                    # Stored meta may be a JSON string or malformed (QA-1).
                    remote_ts = normalize_book_meta(existing.get("meta")).get("updatedAt")
                    if _is_remote_newer(remote_ts, expected_base_updated_at):
                        raise CliError(
                            f"Row conflict on Books {book.get('id')}: remote updatedAt ({remote_ts}) is newer than loaded base ({expected_base_updated_at}). Re-run or pass --force to overwrite."
                        )
                    break
        raw["books"] = _upsert_by_id(raw["books"], normalized)
        self._write_raw(raw)
        return normalized

    def save_note(
        self,
        note: dict[str, Any],
        *,
        expected_base_updated_at: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        raw = self._read_raw()
        normalized = normalize_note_dict(note)
        if expected_base_updated_at and not force:
            for existing in raw["notes"]:
                if isinstance(existing, dict) and existing.get("id") == note.get("id"):
                    remote_ts = existing.get("updatedAt")
                    if _is_remote_newer(remote_ts, expected_base_updated_at):
                        raise CliError(
                            f"Row conflict on Notes {note.get('id')}: remote updatedAt ({remote_ts}) is newer than loaded base ({expected_base_updated_at}). Re-run or pass --force to overwrite."
                        )
                    break
        raw["notes"] = _upsert_by_id(raw["notes"], normalized)
        self._write_raw(raw)
        return normalized

    def save_session(self, session: dict[str, Any]) -> dict[str, Any]:
        raw = self._read_raw()
        raw["sessions"] = _upsert_by_id(raw["sessions"], session)
        self._write_raw(raw)
        return session

    def save_delta_log(self, log: dict[str, Any]) -> dict[str, Any]:
        raw = self._read_raw()
        raw["deltaLogs"] = _upsert_by_id(raw["deltaLogs"], log)
        self._write_raw(raw)
        return log

    def upload_image(self, local_path: Path) -> dict[str, Any]:
        if not local_path.exists():
            raise CliError(f"Image file not found: {local_path}")
        mime, _ = mimetypes.guess_type(local_path.name)
        return {
            "id": str(uuid.uuid4()),
            "type": "image",
            "demoMediaId": str(uuid.uuid4()),
            "localPath": str(local_path.resolve()),
            "fileName": local_path.name,
            "mimeType": mime or "image/webp",
        }

    def fetch_image_to_temp(self, attachment: dict[str, Any]) -> tuple[Path | None, bool]:
        local = attachment.get("localPath")
        if local and Path(local).exists():
            return Path(local), False
        return None, False

    def create_companion_doc(
        self, title: str, initial_text: str, book_id: str = ""
    ) -> tuple[str, str]:
        safe_id = re.sub(r"[^a-zA-Z0-9_-]+", "-", (book_id or slugify(title))).strip("-") or "book"
        doc_id = f"pragya-doc-{safe_id}"
        url = f"https://docs.google.com/document/d/{doc_id}/edit"
        return doc_id, url

    def read_doc_text(self, doc_id: str) -> str:
        return ""

    def append_doc_text(self, doc_id: str, text: str) -> None:
        return None


def _raw_cell(value: Any) -> dict[str, Any]:
    """Sheets CellData for a raw write: numbers -> numberValue, everything else -> stringValue."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            # Intentional: NaN/Infinity is not valid JSON and Sheets rejects it as a
            # numberValue; write an empty cell (same policy as json_dumps_strict / QA-6).
            return {"userEnteredValue": {"stringValue": ""}}
        return {"userEnteredValue": {"numberValue": value}}
    if value is None:
        return {"userEnteredValue": {"stringValue": ""}}
    if isinstance(value, bool):
        return {"userEnteredValue": {"stringValue": "true" if value else "false"}}
    return {"userEnteredValue": {"stringValue": str(value)}}


class GoogleWorkspaceBackend(WorkspaceBackend):
    def __init__(
        self,
        spreadsheet_id: str | None = None,
        runner: Callable[[list[str]], tuple[int, str, str]] = default_cmd_runner,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._spreadsheet_id = spreadsheet_id
        self._media_folder_id: str | None = None
        self._runner = runner
        self._sleep = sleep
        self._schema_checked = False
        self._sheet_ids: dict[str, int] = {}

    def _run_with_retry(self, cmd: list[str]) -> tuple[int, str, str]:
        """Runs a Workspace CLI command, retrying quota/rate-limit failures (A5.5).

        At most RATE_LIMIT_MAX_ATTEMPTS attempts with RATE_LIMIT_BACKOFF_SECONDS sleeps.
        Non-rate-limit failures are returned immediately (never retried).
        """
        for attempt in range(1, RATE_LIMIT_MAX_ATTEMPTS + 1):
            rc, out, err = self._runner(cmd)
            if rc == 0 or not is_rate_limited_output(f"{out or ''}\n{err or ''}"):
                return rc, out, err
            if attempt < RATE_LIMIT_MAX_ATTEMPTS:
                self._sleep(RATE_LIMIT_BACKOFF_SECONDS[attempt - 1])
        raise CliError(
            "Google is limiting requests right now. Try again in a minute.\n"
            "Earlier steps of this command may already be saved, so check with `recall` or "
            "`book-list` before re-running (re-running `capture` would create a duplicate note). "
            "If it keeps happening, fall back to a Paste Card for the user to add manually.\n"
            f"Details: {' '.join(cmd[:3])} was rate-limited {RATE_LIMIT_MAX_ATTEMPTS} times: "
            f"{(err or out or '').strip()[:300]}"
        )

    def _run_json(self, cmd: list[str]) -> Any:
        rc, out, err = self._run_with_retry(cmd)
        if rc != 0:
            raise CliError(
                f"Command failed ({rc}): {' '.join(cmd)}\n{err.strip() or out.strip()}"
            )
        txt = (out or "").strip()
        if not txt:
            return {}
        try:
            return json.loads(txt)
        except json.JSONDecodeError:
            return {"rawText": txt}

    def _run_ok(self, cmd: list[str]) -> str:
        rc, out, err = self._run_with_retry(cmd)
        if rc != 0:
            raise CliError(
                f"Command failed ({rc}): {' '.join(cmd)}\n{err.strip() or out.strip()}"
            )
        return out

    def _extract_items(self, payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            return [x for x in payload if isinstance(x, dict)]
        if isinstance(payload, dict):
            for key in ("files", "spreadsheets", "items", "results", "sheets"):
                if isinstance(payload.get(key), list):
                    return [x for x in payload[key] if isinstance(x, dict)]
        return []

    def _extract_id(self, payload: Any, *keys: str) -> str | None:
        if isinstance(payload, dict):
            for k in keys:
                val = payload.get(k)
                if val:
                    return str(val)
            raw = payload.get("rawText")
            if isinstance(raw, str) and raw:
                for pat in (
                    r"\bID:\s*([A-Za-z0-9_-]{8,})",
                    r"/d/([A-Za-z0-9_-]{8,})",
                    r"/folders/([A-Za-z0-9_-]{8,})",
                ):
                    m = re.search(pat, raw)
                    if m:
                        return m.group(1)
        return None

    def resolve_spreadsheet_id(self) -> str:
        if self._spreadsheet_id:
            return self._spreadsheet_id

        listed = self._run_json(["gsheets", "readonly", "list", SPREADSHEET_TITLE, "--json"])
        for item in self._extract_items(listed):
            if item.get("trashed"):
                continue
            name = item.get("name") or item.get("title") or ""
            if name == SPREADSHEET_TITLE:
                sid = item.get("id") or item.get("spreadsheetId")
                if sid:
                    self._spreadsheet_id = str(sid)
                    return self._spreadsheet_id

        searched = self._run_json(
            [
                "gdrive",
                "readonly",
                "search",
                "--name-exact",
                SPREADSHEET_TITLE,
                "--type",
                "spreadsheet",
                "--json",
            ]
        )
        for item in self._extract_items(searched):
            if not item.get("trashed"):
                sid = item.get("id")
                if sid:
                    self._spreadsheet_id = str(sid)
                    return self._spreadsheet_id

        created = self._run_json(["gsheets", "mutate", "create", "--title", SPREADSHEET_TITLE, "--json"])
        sid = self._extract_id(created, "spreadsheetId", "id")
        if not sid:
            raise CliError("Failed to create or locate Pragya Commonplace spreadsheet.")
        self._spreadsheet_id = str(sid)
        return self._spreadsheet_id

    def _read_range(self, sid: str, range_a1: str) -> list[list[Any]]:
        res = self._run_json(
            [
                "gsheets",
                "readonly",
                "read",
                sid,
                range_a1,
                "--value-render-option",
                "UNFORMATTED_VALUE",
                "--json",
            ]
        )
        if isinstance(res, list):
            return [r for r in res if isinstance(r, list)]
        if isinstance(res, dict):
            vals = res.get("values")
            if isinstance(vals, list):
                return [r for r in vals if isinstance(r, list)]
        return []

    def _load_sheet_ids(self, sid: str) -> set[str]:
        """Returns tab titles from list-sheets and REPLACES the tab -> sheetId cache.

        Accepts both `{"properties": {"title", "sheetId"}}` and top-level
        `{"title", "sheetId"}` entries; sheetId 0 is valid.
        """
        sheets_raw = self._run_json(["gsheets", "readonly", "list-sheets", sid, "--json"])
        titles: set[str] = set()
        self._sheet_ids = {}
        for entry in self._extract_items(sheets_raw):
            props = entry.get("properties") if isinstance(entry.get("properties"), dict) else entry
            t = props.get("title") or props.get("name")
            if not t:
                continue
            titles.add(str(t))
            raw_id = props.get("sheetId", entry.get("sheetId"))
            if isinstance(raw_id, bool):
                continue
            try:
                self._sheet_ids[str(t)] = int(raw_id)
            except (TypeError, ValueError):
                continue
        return titles

    def _sheet_id(self, tab: str) -> int:
        if tab not in self._sheet_ids:
            raise CliError(
                f"Cannot write to tab '{tab}': its numeric sheetId was not returned by "
                "'gsheets readonly list-sheets' (properties.sheetId). Raw cell writes need it; "
                "nothing was written."
            )
        return self._sheet_ids[tab]

    def _write_cells(self, sid: str, ops: list[dict[str, Any]]) -> None:
        """Single seam for every Sheet data write (B1.1, raw values only).

        Each op is {"kind": "update", "tab", "row" (1-based), "values"} or
        {"kind": "append", "tab", "values"}. Emits Sheets API batchUpdate requests
        (updateCells / appendCells with userEnteredValue.stringValue|numberValue) via
        `gsheets mutate raw-batch`, so strings are never parsed as formulas or dates.
        """
        if not ops:
            return
        requests: list[dict[str, Any]] = []
        for op in ops:
            sheet_id = self._sheet_id(op["tab"])
            row_data = {"values": [_raw_cell(v) for v in op["values"]]}
            if op["kind"] == "update":
                row_index = int(op["row"]) - 1
                requests.append(
                    {
                        "updateCells": {
                            "range": {
                                "sheetId": sheet_id,
                                "startRowIndex": row_index,
                                "endRowIndex": row_index + 1,
                                "startColumnIndex": 0,
                                "endColumnIndex": len(op["values"]),
                            },
                            "rows": [row_data],
                            "fields": "userEnteredValue",
                        }
                    }
                )
            elif op["kind"] == "append":
                requests.append(
                    {
                        "appendCells": {
                            "sheetId": sheet_id,
                            "rows": [row_data],
                            "fields": "userEnteredValue",
                        }
                    }
                )
            else:
                raise CliError(f"Unknown write op kind: {op.get('kind')}")
        fd, tmp_path = tempfile.mkstemp(prefix=".pragya_raw_batch_", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json_dumps_strict({"requests": requests}, ensure_ascii=False))
            self._run_ok(["gsheets", "mutate", "raw-batch", sid, "-f", tmp_path, "--json"])
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    def ensure_schema(self) -> str:
        sid = self.resolve_spreadsheet_id()
        if self._schema_checked:
            return sid

        existing_titles = self._load_sheet_ids(sid)

        required_tabs: list[tuple[str, str, list[str]]] = [
            ("Books", "L", BOOKS_HEADERS),
            ("Notes", "R", NOTES_HEADERS),
            ("Sessions", "G", SESSIONS_HEADERS),
            ("DeltaLogs", "E", DELTA_LOGS_HEADERS),
        ]

        added_any = False
        for tab, _, _ in required_tabs:
            if tab not in existing_titles:
                self._run_ok(["gsheets", "mutate", "add-sheet", sid, "--title", tab, "--json"])
                added_any = True
        if added_any:
            # Refresh tab -> sheetId so the new tab is writable.
            self._load_sheet_ids(sid)

        header_ops: list[dict[str, Any]] = []
        for tab, last_col, headers in required_tabs:
            rows = self._read_range(sid, f"{tab}!A1:{last_col}1")
            first_row = [str(c) for c in rows[0]] if rows else []
            if first_row != headers:
                header_ops.append({"kind": "update", "tab": tab, "row": 1, "values": list(headers)})

        if header_ops:
            self._write_cells(sid, header_ops)

        self._schema_checked = True
        return sid

    def _verify_row_id(self, sid: str, tab: str, row_id: str, row: int) -> int:
        """Returns the 1-based row that holds `row_id`, re-resolving A:A once if it moved."""
        cell = self._read_range(sid, f"{tab}!A{row}")
        if cell and cell[0] and str(cell[0][0] or "").strip() == row_id:
            return row
        for idx, r in enumerate(self._read_range(sid, f"{tab}!A:A"), start=1):
            if r and str(r[0] or "").strip() == row_id:
                return idx
        raise CliError(
            f"{tab} row {row_id} moved or was deleted during write; nothing was written. "
            "Re-run the command."
        )

    def _upsert_row(
        self,
        tab: str,
        last_col: str,
        row_id: str,
        row_values: list[Any],
        *,
        expected_base_updated_at: str | None = None,
        force: bool = False,
    ) -> None:
        sid = self.ensure_schema()
        col_a = self._read_range(sid, f"{tab}!A:A")
        matched_row: int | None = None
        for idx, row in enumerate(col_a, start=1):
            if row and str(row[0] or "").strip() == row_id:
                matched_row = idx
                break

        if matched_row is not None:
            guarded = bool(expected_base_updated_at and not force and tab in ("Notes", "Books"))
            if not guarded:
                # R1#6: unguarded updates (--force, Sessions, DeltaLogs) re-read the one id
                # cell right before writing; the PWA's deleteSession shifts rows.
                matched_row = self._verify_row_id(sid, tab, row_id, matched_row)
            if guarded:
                tab_rows = self._read_range(sid, f"{tab}!A:{last_col}")
                target_row: list[Any] | None = None
                if 0 <= matched_row - 1 < len(tab_rows):
                    cand = tab_rows[matched_row - 1]
                    if cand and str(cand[0] or "").strip() == row_id:
                        target_row = cand
                if target_row is None:
                    # B4.2: the row shifted between the A:A read and this read; follow it.
                    for idx, cand in enumerate(tab_rows, start=1):
                        if cand and str(cand[0] or "").strip() == row_id:
                            target_row = cand
                            matched_row = idx
                            break
                if target_row is None:
                    raise CliError(
                        f"{tab} row {row_id} moved or was deleted during write; nothing was "
                        "written. Re-run the command."
                    )
                remote_ts: Any = None
                if tab == "Notes" and len(target_row) > 4:
                    remote_ts = target_row[4]
                elif tab == "Books" and len(target_row) > 11:
                    raw_meta = target_row[11]
                    if isinstance(raw_meta, dict):
                        remote_ts = raw_meta.get("updatedAt")
                    elif isinstance(raw_meta, str) and raw_meta.strip():
                        try:
                            parsed_meta = json.loads(raw_meta)
                            if isinstance(parsed_meta, dict):
                                remote_ts = parsed_meta.get("updatedAt")
                        except json.JSONDecodeError:
                            remote_ts = None
                if _is_remote_newer(remote_ts, expected_base_updated_at):
                    raise CliError(
                        f"Row conflict on {tab} {row_id}: remote updatedAt ({remote_ts}) is newer than loaded base ({expected_base_updated_at}). Re-run after syncing or pass --force to overwrite."
                    )

            op: dict[str, Any] = {
                "kind": "update",
                "tab": tab,
                "row": matched_row,
                "values": row_values,
            }
        else:
            op = {"kind": "append", "tab": tab, "values": row_values}
        self._write_cells(sid, [op])

    def load_workspace(self) -> dict[str, Any]:
        sid = self.ensure_schema()
        books_rows = self._read_range(sid, "Books!A:L")
        notes_rows = self._read_range(sid, "Notes!A:R")
        sessions_rows = self._read_range(sid, "Sessions!A:G")
        logs_rows = self._read_range(sid, "DeltaLogs!A:E")

        books = [b for b in (row_to_book(r) for r in books_rows[1:]) if b is not None]
        notes = [n for n in (row_to_note(r) for r in notes_rows[1:]) if n is not None]
        sessions = [s for s in (row_to_session(r) for r in sessions_rows[1:]) if s is not None]
        logs = [dl for dl in (row_to_delta_log(r) for r in logs_rows[1:]) if dl is not None]
        return {
            "books": books,
            "notes": notes,
            "sessions": sessions,
            "deltaLogs": logs,
        }

    def save_book(
        self,
        book: dict[str, Any],
        *,
        expected_base_updated_at: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        self._upsert_row(
            "Books",
            "L",
            book["id"],
            book_to_row(book),
            expected_base_updated_at=expected_base_updated_at,
            force=force,
        )
        return book

    def save_note(
        self,
        note: dict[str, Any],
        *,
        expected_base_updated_at: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        self._upsert_row(
            "Notes",
            "R",
            note["id"],
            note_to_row(note),
            expected_base_updated_at=expected_base_updated_at,
            force=force,
        )
        return note

    def save_session(self, session: dict[str, Any]) -> dict[str, Any]:
        self._upsert_row("Sessions", "G", session["id"], session_to_row(session))
        return session

    def save_delta_log(self, log: dict[str, Any]) -> dict[str, Any]:
        self._upsert_row("DeltaLogs", "E", log["id"], delta_log_to_row(log))
        return log

    def _ensure_media_folder(self) -> str:
        if self._media_folder_id:
            return self._media_folder_id
        res = self._run_json(
            [
                "gdrive",
                "readonly",
                "search",
                "--name-exact",
                MEDIA_FOLDER_NAME,
                "--type",
                "folder",
                "--json",
            ]
        )
        for item in self._extract_items(res):
            if not item.get("trashed") and item.get("id"):
                self._media_folder_id = str(item["id"])
                return self._media_folder_id

        created = self._run_json(["gdrive", "mutate", "mkdir", MEDIA_FOLDER_NAME, "--json"])
        fid = self._extract_id(created, "id", "folderId")
        if not fid:
            raise CliError("Failed to create Pragya Media folder on Google Drive.")
        self._media_folder_id = str(fid)
        return self._media_folder_id

    def upload_image(self, local_path: Path) -> dict[str, Any]:
        if not local_path.exists():
            raise CliError(f"Image file not found: {local_path}")
        folder_id = self._ensure_media_folder()
        mime, _ = mimetypes.guess_type(local_path.name)
        mime_type = mime or "image/webp"
        uploaded = self._run_json(
            [
                "gdrive",
                "mutate",
                "upload",
                str(local_path),
                "--parent",
                folder_id,
                "--mime-type",
                mime_type,
                "--json",
            ]
        )
        file_id = self._extract_id(uploaded, "id", "fileId")
        if not file_id:
            raise CliError("Google Drive upload succeeded without returning a file ID.")
        return {
            "id": str(uuid.uuid4()),
            "type": "image",
            "driveFileId": str(file_id),
            "fileName": local_path.name,
            "mimeType": mime_type,
        }

    def fetch_image_to_temp(self, attachment: dict[str, Any]) -> tuple[Path | None, bool]:
        drive_id = attachment.get("driveFileId")
        if not drive_id:
            local = attachment.get("localPath")
            if local and Path(local).exists():
                return Path(local), False
            return None, False
        suffix = Path(attachment.get("fileName") or "image.webp").suffix or ".webp"
        fd, tmp_name = tempfile.mkstemp(prefix="pragya_dl_", suffix=suffix)
        os.close(fd)
        dest = Path(tmp_name)
        try:
            self._run_ok(["gdrive", "readonly", "download", str(drive_id), "-o", str(dest)])
        except Exception:
            if dest.exists():
                dest.unlink()
            raise
        return dest, True

    def create_companion_doc(
        self, title: str, initial_text: str, book_id: str = ""
    ) -> tuple[str, str]:
        created = self._run_json(["gdocs", "mutate", "create", "--title", title, "--json"])
        doc_id = self._extract_id(created, "documentId", "id")
        if not doc_id:
            raise CliError("gdocs mutate create did not return a documentId.")
        if initial_text.strip():
            self.append_doc_text(str(doc_id), initial_text)
        url = f"https://docs.google.com/document/d/{doc_id}/edit"
        return str(doc_id), url

    def read_doc_text(self, doc_id: str) -> str:
        res = self._run_json(["gdocs", "readonly", "read", doc_id, "--json"])
        if isinstance(res, str):
            return res
        if isinstance(res, dict):
            for key in ("text", "content", "rawText"):
                if isinstance(res.get(key), str):
                    return res[key]
            ast_text = _extract_gdocs_text(res)
            if ast_text:
                return ast_text
            if _is_recognizably_empty_gdoc(res):
                # B4.5: a genuinely empty Doc reads as "", never the JSON AST.
                return ""
            # Unknown / unparseable shape (wrapper objects, table-only or inline-object
            # content, future CLI output): keep a non-empty, marker-searchable fallback so
            # book-doc-sync still dedups by [note:<uuid>] and never re-adds the header.
            return json.dumps(res, ensure_ascii=False)
        return ""

    def append_doc_text(self, doc_id: str, text: str) -> None:
        ops = _companion_text_to_gdocs_ops(text)
        if not ops:
            return
        fd, tmp_path = tempfile.mkstemp(prefix=".pragya_gdocs_", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json_dumps_strict(ops, ensure_ascii=False))
            self._run_ok(["gdocs", "mutate", "batch", doc_id, "-f", tmp_path, "--json"])
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    def read_doc_snapshot(self, doc_id: str) -> DocSnapshot | None:
        res = self._run_json(["gdocs", "readonly", "read", doc_id, "--json"])
        lines = parse_gdoc_lines(res)
        if lines is None:
            return None
        rev = res.get("revisionId") if isinstance(res, dict) else None
        return DocSnapshot(lines=lines, revision_id=rev if isinstance(rev, str) and rev else None)

    def batch_update_doc(
        self, doc_id: str, requests: list[dict[str, Any]], required_revision_id: str | None = None
    ) -> None:
        """A1.4 in-place sync: one Docs API `documents.batchUpdate` with raw requests.

        RELEASE GATE (like the Sheets raw-batch, decisions Batch 2): the `gdocs mutate
        raw-batch` transport is unverified offline; book-doc-sync falls back to
        append-only (with a warning) if it fails.
        """
        if not requests:
            return
        payload: dict[str, Any] = {"requests": requests}
        if required_revision_id:
            # R1#1: the Docs API rejects the whole batch if the Doc changed since our read,
            # so stale indexes can never delete user text typed in the meantime.
            payload["writeControl"] = {"requiredRevisionId": required_revision_id}
        fd, tmp_path = tempfile.mkstemp(prefix=".pragya_gdocs_raw_", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json_dumps_strict(payload, ensure_ascii=False))
            self._run_ok(["gdocs", "mutate", "raw-batch", doc_id, "-f", tmp_path, "--json"])
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Lookup & Domain Guards
# ---------------------------------------------------------------------------


def resolve_book(books: list[dict[str, Any]], query: str) -> dict[str, Any]:
    q = (query or "").strip()
    if not q:
        raise CliError("Book identifier or title is required.")
    for b in books:
        if b["id"] == q:
            return b
    ql = q.lower()
    for b in books:
        if b["title"].strip().lower() == ql:
            return b
    matches = [b for b in books if ql in b["title"].lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise CliError(f"Ambiguous book match '{query}': {[m['title'] for m in matches]}")
    raise CliError(f"Book not found: {query}")


def resolve_note(notes: list[dict[str, Any]], query: str) -> dict[str, Any]:
    q = (query or "").strip()
    if not q:
        raise CliError("Note identifier or slug is required.")
    for n in notes:
        if n["id"] == q:
            return n
    for n in notes:
        if n["slug"] == q:
            return n
    ql = slugify(q)
    for n in notes:
        if n["slug"] == ql:
            return n
    raise CliError(f"Note not found: {query}")


def check_active_delta_cap(
    notes: list[dict[str, Any]], target_note_id: str, next_delta_status: str
) -> None:
    if next_delta_status != "active":
        return
    # R1#3: archived notes never hold one of the 5 slots (matches the PWA Practice N/5).
    other_active = [
        n
        for n in notes
        if n["id"] != target_note_id and n.get("deltaStatus") == "active" and not is_archived(n)
    ]
    if len(other_active) >= ACTIVE_DELTA_CAP:
        raise CliError(
            f"Active Behavioral Delta cap ({ACTIVE_DELTA_CAP}/{ACTIVE_DELTA_CAP}) reached. "
            "Graduate or pause an active delta first."
        )


def parse_doc_id(url: str) -> str | None:
    m = DOC_URL_RE.search(url or "")
    return m.group(1) if m else None


def is_safe_http_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse((url or "").strip())
    except ValueError:
        return False
    return parsed.scheme.lower() in ("http", "https") and bool(parsed.netloc)


def _extract_gdocs_structural_elements(elements: Any, parts: list[str]) -> None:
    if not isinstance(elements, list):
        return
    for elem in elements:
        if not isinstance(elem, dict):
            continue
        para = elem.get("paragraph")
        if isinstance(para, dict):
            for p_elem in para.get("elements") or []:
                if isinstance(p_elem, dict):
                    tr = p_elem.get("textRun")
                    if isinstance(tr, dict) and isinstance(tr.get("content"), str):
                        parts.append(tr["content"])
        table = elem.get("table")
        if isinstance(table, dict):
            for row in table.get("tableRows") or []:
                if isinstance(row, dict):
                    for cell in row.get("tableCells") or []:
                        if isinstance(cell, dict):
                            _extract_gdocs_structural_elements(cell.get("content"), parts)
        toc = elem.get("tableOfContents")
        if isinstance(toc, dict):
            _extract_gdocs_structural_elements(toc.get("content"), parts)


def _extract_gdocs_tabs(tabs: Any, parts: list[str]) -> None:
    if not isinstance(tabs, list):
        return
    for tab in tabs:
        if not isinstance(tab, dict):
            continue
        doc_tab = tab.get("documentTab")
        if isinstance(doc_tab, dict):
            body = doc_tab.get("body")
            if isinstance(body, dict):
                _extract_gdocs_structural_elements(body.get("content"), parts)
        _extract_gdocs_tabs(tab.get("childTabs"), parts)


def _is_empty_structural_content(content: Any) -> bool:
    """True only for a list of sectionBreaks and whitespace-only text paragraphs."""
    if not isinstance(content, list):
        return False
    for elem in content:
        if not isinstance(elem, dict):
            return False
        if "sectionBreak" in elem:
            continue
        para = elem.get("paragraph")
        if not isinstance(para, dict):
            return False  # table, tableOfContents, unknown element ...
        for p_elem in para.get("elements") or []:
            if not isinstance(p_elem, dict):
                return False
            tr = p_elem.get("textRun")
            if not isinstance(tr, dict) or not isinstance(tr.get("content"), str):
                return False  # inline object, person chip, unknown run ...
            if tr["content"].strip():
                return False
    return True


def _collect_tab_bodies(tabs: Any, out: list[Any]) -> bool:
    if not isinstance(tabs, list):
        return False
    for tab in tabs:
        if not isinstance(tab, dict):
            return False
        doc_tab = tab.get("documentTab")
        body = doc_tab.get("body") if isinstance(doc_tab, dict) else None
        if not isinstance(body, dict):
            return False
        out.append(body.get("content"))
        if "childTabs" in tab and not _collect_tab_bodies(tab.get("childTabs"), out):
            return False
    return True


# Top-level keys of a Docs API `documents.get` response. Anything else (e.g. a
# `{"document": {...}}` wrapper) means the shape is unknown -> not "recognizably empty".
_GDOCS_DOCUMENT_KEYS = frozenset(
    {
        "documentId", "title", "revisionId", "suggestionsViewMode", "documentStyle",
        "namedStyles", "lists", "headers", "footers", "footnotes", "inlineObjects",
        "positionedObjects", "namedRanges", "suggestedDocumentStyleChanges",
        "suggestedNamedStylesChanges", "body", "tabs",
    }
)


def _is_recognizably_empty_gdoc(doc: Any) -> bool:
    """B4.5: only a Docs API document (has documentId, known keys) whose bodies are empty."""
    if not isinstance(doc, dict) or not doc.get("documentId"):
        return False
    if any(key not in _GDOCS_DOCUMENT_KEYS for key in doc):
        return False
    bodies: list[Any] = []
    body = doc.get("body")
    if body is not None:
        if not isinstance(body, dict):
            return False
        bodies.append(body.get("content"))
    if "tabs" in doc and not _collect_tab_bodies(doc.get("tabs"), bodies):
        return False
    # No body at all (metadata-only response) is NOT recognizably empty: fall back.
    return bool(bodies) and all(_is_empty_structural_content(c) for c in bodies)


def _extract_gdocs_text(doc: Any) -> str:
    if not isinstance(doc, dict):
        return ""
    parts: list[str] = []
    body = doc.get("body")
    if isinstance(body, dict):
        _extract_gdocs_structural_elements(body.get("content"), parts)
    _extract_gdocs_tabs(doc.get("tabs"), parts)
    return "".join(parts)


# ---------------------------------------------------------------------------
# Subcommand Handlers
# ---------------------------------------------------------------------------


def _normalize_book_title_key(title: str) -> str:
    return " ".join((title or "").strip().lower().split())


def count_unlocked_predictions(book: dict[str, Any], notes: list[dict[str, Any]]) -> int:
    """Fiction predictions on this book (unlocked by finishing it); nonfiction -> 0."""
    if book.get("kind") != "fiction":
        return 0
    return sum(
        1
        for n in notes
        if n.get("bookId") == book.get("id") and bool((n.get("meta") or {}).get("isPrediction"))
    )


def _truncate_summary_text(value: Any) -> str:
    """ux_spec A.5: cap quote/takeaway at 280 chars total, ending in `…` when cut."""
    text = value if isinstance(value, str) else ""
    if len(text) <= NOTES_SUMMARY_TEXT_LIMIT:
        return text
    return text[: NOTES_SUMMARY_TEXT_LIMIT - 1] + "…"


def _summary_delta(note: dict[str, Any]) -> dict[str, str] | None:
    """`{trigger, action}` (WHEN/DO prefixes stripped) for a note that carries a delta."""
    trigger = normalize_delta_trigger(note.get("deltaTrigger") or "")
    action = normalize_delta_action(note.get("deltaAction") or "")
    has_delta = (note.get("deltaStatus") or "none") != "none" or note.get("status") == "atomic"
    if not has_delta or not (trigger or action):
        return None
    return {"trigger": trigger, "action": action}


def build_notes_summary(
    book: dict[str, Any], notes: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    """A2.2: the book's saved + atomic notes in reading order, plus the omitted count.

    Sorted by (effective_note_norm, pos, createdAt). Over NOTES_SUMMARY_MAX_ENTRIES, keep
    all atomic notes first (most recent first if even those overflow), then the most recent
    saved notes, and re-sort to reading order (ux_spec A.5). Only ever called for a book
    that is finished, so no entry can be ahead of the bookmark (spoiler parity).
    """
    unit = book.get("posUnit") or "page"
    picked = [
        n
        for n in notes
        if n.get("bookId") == book.get("id")
        and n.get("status") in ("saved", "atomic")
        and not is_archived(n)
    ]

    def reading_key(n: dict[str, Any]) -> tuple[float, float, str]:
        return (
            effective_note_norm(n, book),
            _safe_float(n.get("pos"), 0.0),
            str(n.get("createdAt") or ""),
        )

    omitted = 0
    if len(picked) > NOTES_SUMMARY_MAX_ENTRIES:
        def recent_first(group: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return sorted(group, key=lambda n: str(n.get("createdAt") or ""), reverse=True)

        atomic = recent_first([n for n in picked if n.get("status") == "atomic"])
        saved = recent_first([n for n in picked if n.get("status") == "saved"])
        kept = (atomic + saved)[:NOTES_SUMMARY_MAX_ENTRIES]
        omitted = len(picked) - len(kept)
        picked = kept
    picked.sort(key=reading_key)

    out: list[dict[str, Any]] = []
    for n in picked:
        meta = n.get("meta") or {}
        pos = clean_num(n.get("pos"), 0)
        chapter = (_coerce_meta_string(meta.get("chapter")) or "").strip()
        out.append(
            {
                "id": n.get("id"),
                "slug": n.get("slug"),
                "status": n.get("status"),
                "pos": pos,
                "posDisplay": format_pos_display(pos, unit),
                "label": format_chapter_pos(chapter, pos, unit),
                "chapter": chapter,
                "title": _coerce_meta_string(meta.get("title")) or "",
                "quote": _truncate_summary_text(n.get("quote")),
                "takeaway": _truncate_summary_text(n.get("takeaway")),
                "delta": _summary_delta(n),
            }
        )
    return out, omitted


def finish_transition_extras(
    prev_status: Any, book: dict[str, Any], notes: list[dict[str, Any]]
) -> dict[str, Any]:
    """A2.2: extra keys for a transition into `finished` (shared by progress/book-update).

    Every call returns `unlockedPredictionsCount` (0 unless this call finished a fiction
    book). A transition into `finished` always adds `capstonePending` (bool); when it is
    true, `notesSummary` + `notesSummaryOmittedCount` are included too.
    """
    if prev_status == "finished" or book.get("status") != "finished":
        return {"unlockedPredictionsCount": 0}
    pending = not has_book_capstone(book.get("meta"))
    extras: dict[str, Any] = {
        "unlockedPredictionsCount": count_unlocked_predictions(book, notes),
        "capstonePending": pending,
    }
    if pending:
        summary, omitted = build_notes_summary(book, notes)
        extras["notesSummary"] = summary
        extras["notesSummaryOmittedCount"] = omitted
    return extras


def cmd_book_list(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    ws = backend.load_workspace()
    active_delta_count = sum(
        1 for n in ws["notes"] if n.get("deltaStatus") == "active" and not is_archived(n)
    )
    books = list(ws["books"])
    archived_count = sum(1 for b in books if is_archived(b))
    if not getattr(args, "include_archived", False):
        books = [b for b in books if not is_archived(b)]

    status_filter = getattr(args, "status", None)
    kind_filter = getattr(args, "kind", None)
    query_filter = (getattr(args, "query", "") or "").strip().lower()

    if status_filter:
        books = [b for b in books if b.get("status") == status_filter]
    if kind_filter:
        books = [b for b in books if b.get("kind") == kind_filter]
    if query_filter:
        books = [
            b
            for b in books
            if query_filter
            in f"{b.get('title', '')} {b.get('author', '')} {b.get('id', '')}".lower()
        ]

    return {
        "count": len(books),
        "activeDeltaCount": active_delta_count,
        "archivedCount": archived_count,
        "books": books,
    }


def cmd_book_add(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    title = (args.title or "").strip()
    if not title:
        raise CliError("Book --title is required and cannot be empty.")

    author = (args.author or "").strip() or "Unknown Author"
    fmt = args.format
    kind = args.kind
    status = args.status
    pos_unit = args.pos_unit

    if args.pos is not None and args.pos < 0:
        raise CliError("Position (--pos) cannot be negative.")
    raw_pos = float(args.pos or 0.0)

    if args.total_pos is not None:
        if args.total_pos < 0:
            raise CliError("Total position (--total-pos) cannot be negative.")
        total_pos = float(args.total_pos)
    else:
        total_pos = 100.0 if pos_unit == "percent" else 0.0

    doc_url = (args.doc_url or "").strip()
    if doc_url and not is_safe_http_url(doc_url):
        raise CliError(f"Invalid or unsafe --doc-url (must be http/https): {doc_url}")

    cover_url = (args.cover_url or "").strip()
    if cover_url and not is_safe_http_url(cover_url):
        raise CliError(f"Invalid or unsafe --cover-url (must be http/https): {cover_url}")

    ws = backend.load_workspace()
    norm_title = _normalize_book_title_key(title)
    if not args.allow_duplicate:
        for existing in ws["books"]:
            if _normalize_book_title_key(existing.get("title") or "") == norm_title:
                raise CliError(
                    f"Book '{existing['title']}' already exists (id={existing['id']}). "
                    "Pass --allow-duplicate to add another copy."
                )

    safe_pos = raw_pos
    if pos_unit == "percent":
        safe_pos = min(100.0, safe_pos)
    elif total_pos > 0:
        safe_pos = min(total_pos, safe_pos)

    if status == "finished" and args.pos is None and total_pos > 0:
        safe_pos = total_pos

    norm_pos = 1.0 if status == "finished" else compute_normalized_pos(safe_pos, total_pos, pos_unit)
    now_iso = now_iso_utc()
    meta: dict[str, Any] = {"updatedAt": now_iso}
    if cover_url:
        meta["coverUrl"] = cover_url
    if status == "reading":
        meta["startedAt"] = now_iso
    elif status == "finished":
        meta["startedAt"] = now_iso
        meta["finishedAt"] = now_iso

    new_book = {
        "id": str(uuid.uuid4()),
        "title": title,
        "author": author,
        "format": fmt,
        "kind": kind,
        "status": status,
        "currentPos": clean_num(safe_pos),
        "totalPos": clean_num(total_pos),
        "posUnit": pos_unit,
        "normalizedPos": norm_pos,
        "docUrl": doc_url,
        "meta": meta,
    }
    backend.save_book(new_book)
    return {"book": new_book}


def cmd_book_update(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    mutable_values = (
        args.title,
        args.author,
        args.format,
        args.kind,
        args.status,
        args.pos,
        args.total_pos,
        args.pos_unit,
        args.doc_url,
        args.cover_url,
        getattr(args, "chapter", None),
    )
    archive_flag = bool(getattr(args, "archive", False))
    unarchive_flag = bool(getattr(args, "unarchive", False))
    if all(v is None for v in mutable_values) and not (archive_flag or unarchive_flag):
        raise CliError(
            "Provide at least one mutable field to update "
            "(e.g. --status, --pos, --total-pos, --title, --chapter, --archive)."
        )

    if args.title is not None and not args.title.strip():
        raise CliError("Book --title cannot be empty.")
    if args.pos is not None and args.pos < 0:
        raise CliError("Position (--pos) cannot be negative.")
    if args.total_pos is not None and args.total_pos < 0:
        raise CliError("Total position (--total-pos) cannot be negative.")
    if args.doc_url is not None and args.doc_url.strip() and not is_safe_http_url(args.doc_url):
        raise CliError(f"Invalid or unsafe --doc-url (must be http/https): {args.doc_url}")
    if args.cover_url is not None and args.cover_url.strip() and not is_safe_http_url(args.cover_url):
        raise CliError(f"Invalid or unsafe --cover-url (must be http/https): {args.cover_url}")

    ws = backend.load_workspace()
    book = resolve_book(ws["books"], args.book)
    base_updated_at = (book.get("meta") or {}).get("updatedAt")
    prev_pos = float(book.get("currentPos") or 0)
    prev_status = book.get("status")

    if args.pos is not None and float(args.pos) < prev_pos and not args.force_pos:
        raise CliError(
            f"Cannot lower currentPos from {clean_num(prev_pos)} to {clean_num(args.pos)} without --force-pos."
        )

    updated = json.loads(json.dumps(book))
    if args.title is not None:
        updated["title"] = args.title.strip()
    if args.author is not None:
        updated["author"] = args.author.strip() or "Unknown Author"
    if args.format is not None:
        updated["format"] = args.format
    if args.kind is not None:
        updated["kind"] = args.kind
    if args.pos_unit is not None:
        updated["posUnit"] = args.pos_unit
    if args.total_pos is not None:
        updated["totalPos"] = clean_num(args.total_pos)
    if args.doc_url is not None:
        updated["docUrl"] = args.doc_url.strip()

    meta = updated.setdefault("meta", {})
    if args.cover_url is not None:
        if args.cover_url.strip():
            meta["coverUrl"] = args.cover_url.strip()
        else:
            meta.pop("coverUrl", None)
    chapter = _chapter_arg(getattr(args, "chapter", None))
    if chapter is not None:
        _apply_chapter(meta, "currentChapter", chapter)
    if archive_flag and not is_archived(updated):
        meta["archivedAt"] = now_iso_utc()
    elif unarchive_flag:
        meta.pop("archivedAt", None)

    next_unit = updated.get("posUnit") or "page"
    next_total = float(updated.get("totalPos") or 0)
    if args.pos is not None:
        next_pos = float(args.pos)
        if next_unit == "percent":
            next_pos = min(100.0, next_pos)
        elif next_total > 0:
            next_pos = min(next_total, next_pos)
        updated["currentPos"] = clean_num(next_pos)

    next_status = args.status or prev_status
    updated["status"] = next_status
    now_iso = now_iso_utc()
    if next_status == "reading" and not meta.get("startedAt"):
        meta["startedAt"] = now_iso
    elif next_status == "finished":
        if not meta.get("startedAt"):
            meta["startedAt"] = now_iso
        meta["finishedAt"] = meta.get("finishedAt") or now_iso
        if args.pos is None and next_total > 0 and float(updated.get("currentPos") or 0) < next_total:
            updated["currentPos"] = clean_num(next_total)

    if next_status == "finished":
        updated["normalizedPos"] = 1.0
    else:
        updated["normalizedPos"] = compute_normalized_pos(
            float(updated.get("currentPos") or 0), next_total, next_unit
        )

    meta["updatedAt"] = now_iso
    force = bool(getattr(args, "force", False))
    backend.save_book(updated, expected_base_updated_at=base_updated_at, force=force)

    result: dict[str, Any] = {"book": updated}
    result.update(finish_transition_extras(prev_status, updated, ws["notes"]))
    return result


def cmd_progress(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    chapter = _chapter_arg(getattr(args, "chapter", None))
    if args.pos is None and args.delta is None and not args.finish and chapter is None:
        raise CliError("Provide --pos, --delta, --finish, or --chapter.")
    if args.pos is not None and args.pos < 0:
        raise CliError("Position (--pos) cannot be negative.")

    ws = backend.load_workspace()
    book = resolve_book(ws["books"], args.book)
    base_updated_at = (book.get("meta") or {}).get("updatedAt")
    prev_pos = float(book.get("currentPos") or 0)
    prev_status = book.get("status")
    total_pos = float(book.get("totalPos") or 0)
    pos_unit = book.get("posUnit") or "page"
    now_iso = now_iso_utc()

    if args.pos is not None:
        raw_target = float(args.pos)
    elif args.delta is not None:
        raw_target = prev_pos + float(args.delta)
    elif args.finish:
        raw_target = 100.0 if pos_unit == "percent" else (total_pos if total_pos > 0 else prev_pos)
    else:
        raw_target = prev_pos  # --chapter only (OQ-19): keep the bookmark where it is

    if raw_target < 0:
        raise CliError(f"Resulting position ({clean_num(raw_target)}) cannot be negative.")

    clamped_target = raw_target
    if pos_unit == "percent":
        clamped_target = min(100.0, clamped_target)
    elif total_pos > 0:
        clamped_target = min(total_pos, clamped_target)

    if args.pos is None and args.delta is None and not args.finish:
        clamped_target = prev_pos  # --chapter only: never a bookmark move

    if clamped_target < prev_pos and not args.force_pos:
        raise CliError(
            f"Cannot move bookmark backward from {clean_num(prev_pos)} to {clean_num(clamped_target)} without --force-pos."
        )

    updated_book, changed, _, old_pos, new_pos = apply_bookmark_advance(
        book,
        clamped_target,
        manual_override=bool(args.force_pos),
        now_iso=now_iso,
    )

    finished_changed = bool(args.finish and updated_book.get("status") != "finished")
    if args.finish:
        updated_book = json.loads(json.dumps(updated_book))
        updated_book["status"] = "finished"
        updated_book["normalizedPos"] = 1.0
        meta = updated_book.setdefault("meta", {})
        if not meta.get("startedAt"):
            meta["startedAt"] = now_iso
        meta["finishedAt"] = meta.get("finishedAt") or now_iso
        meta["updatedAt"] = now_iso

    chapter_changed = False
    if chapter is not None:
        # A3.1 / OQ-19: the chapter saves even when the position is unchanged (no session).
        candidate = json.loads(json.dumps(updated_book))
        cmeta = candidate.setdefault("meta", {})
        if _apply_chapter(cmeta, "currentChapter", chapter):
            cmeta["updatedAt"] = now_iso
            updated_book = candidate
            chapter_changed = True

    force = bool(getattr(args, "force", False))
    if changed or finished_changed or chapter_changed:
        backend.save_book(
            updated_book,
            expected_base_updated_at=base_updated_at,
            force=force,
        )

    saved_session: dict[str, Any] | None = None
    coalesced = False
    if changed:
        sess, created = upsert_coalesced_session(
            ws["sessions"],
            book_id=book["id"],
            prev_pos=old_pos,
            next_pos=new_pos,
            now_iso=now_iso,
            note=args.session_note or "",
            manual_override=bool(args.force_pos),
        )
        saved_session = backend.save_session(sess)
        coalesced = not created

    result: dict[str, Any] = {
        "book": updated_book,
        "session": saved_session,
        "bookmarkChanged": changed,
        "coalesced": coalesced,
        "finished": bool(args.finish),
        "chapterChanged": chapter_changed,
    }
    # R2#3: always present (0 when this call didn't finish a fiction book).
    result.update(finish_transition_extras(prev_status, updated_book, ws["notes"]))
    return result


def cmd_capture(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    if args.pos is not None and args.pos < 0:
        raise CliError("Position (--pos) cannot be negative.")
    if args.spar and args.atomic:
        raise CliError("--spar and --atomic cannot be used together.")

    delta_status = getattr(args, "delta_status", "none") or "none"
    if delta_status not in ("none", "active", "paused", "graduated"):
        raise CliError(f"Invalid --delta-status: {delta_status}")
    if delta_status != "none" and not args.atomic:
        raise CliError("--delta-status requires --atomic when capturing directly as an atomic note.")

    trig_body = normalize_delta_trigger(getattr(args, "trigger", "") or "")
    act_body = normalize_delta_action(getattr(args, "action", "") or "")
    if delta_status == "active" and not trig_body and not act_body:
        raise CliError("Provide a WHEN trigger or DO action to activate a Behavioral Delta.")

    image_paths = list(args.image or [])
    doc_urls = list(args.doc_url or [])
    link_urls = list(args.link or [])
    if len(image_paths) + len(doc_urls) + len(link_urls) > 3:
        raise CliError("Maximum 3 attachments per note exceeded.")

    for doc_url in doc_urls:
        url = doc_url.strip()
        if not is_safe_http_url(url):
            raise CliError(f"Invalid or unsafe --doc-url (must be http/https): {url}")

    for link_url in link_urls:
        url = link_url.strip()
        if not is_safe_http_url(url):
            raise CliError(f"Invalid or unsafe --link (must be http/https): {url}")

    for img_path in image_paths:
        if not Path(img_path).exists():
            raise CliError(f"Image file not found: {img_path}")

    quote = (args.quote or "").strip()
    takeaway = (args.takeaway or "").strip()
    title = (args.title or "").strip()
    context_mech = (getattr(args, "context", "") or "").strip()
    critique = (getattr(args, "critique", "") or "").strip()

    if not takeaway and not quote and not (image_paths or doc_urls or link_urls):
        raise CliError("Provide at least one of --takeaway, --quote, or an attachment.")

    ws = backend.load_workspace()
    book = resolve_book(ws["books"], args.book)
    if is_archived(book):
        raise CliError(
            f"Book \"{book.get('title', '')}\" is archived. Restore it first with "
            f"`book-update --book {book.get('id')} --unarchive`, then capture."
        )
    check_active_delta_cap(ws["notes"], "", delta_status)

    now_iso = now_iso_utc()
    pos_provided = args.pos is not None
    incoming_pos = (
        clamp_note_pos(args.pos, book)
        if pos_provided
        else float(book.get("currentPos") or 0)
    )
    normalized_pos = compute_normalized_pos(
        incoming_pos, float(book.get("totalPos") or 0), book.get("posUnit") or "page"
    )

    # All pre-flight validations passed: now perform attachment uploads.
    attachments: list[dict[str, Any]] = []
    for img_path in image_paths:
        attachments.append(backend.upload_image(Path(img_path)))

    for doc_url in doc_urls:
        url = doc_url.strip()
        doc_id = parse_doc_id(url)
        att: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "type": "doc",
            "title": "Google Doc",
            "url": url,
        }
        if doc_id:
            att["docId"] = doc_id
        attachments.append(att)

    for link_url in link_urls:
        url = link_url.strip()
        attachments.append(
            {
                "id": str(uuid.uuid4()),
                "type": "link",
                "title": url,
                "url": url,
            }
        )

    links = [a["url"] for a in attachments if a["type"] != "image"]
    slug_override = (getattr(args, "slug", None) or "").strip()
    slug_seed = (
        slug_override
        or title
        or " ".join(takeaway.split()[:6])
        or " ".join(quote.split()[:6])
        or f"{book['title']} p{clean_num(incoming_pos)}"
    )
    slug = generate_unique_slug(slug_seed, [n["slug"] for n in ws["notes"]])

    meta: dict[str, Any] = {
        "attachments": attachments,
        "links": links,
    }
    if title:
        meta["title"] = title
    if args.prediction and book.get("kind") == "fiction":
        meta["isPrediction"] = True
    chapter = _chapter_arg(getattr(args, "chapter", None))
    if chapter is None:
        # A3.1: inherit the book's current chapter only when the note sits at the bookmark
        # (no --pos, or a --pos that clamps to currentPos) — never at an earlier position.
        at_bookmark = (not pos_provided) or clean_num(incoming_pos) == clean_num(
            float(book.get("currentPos") or 0)
        )
        inherited = _coerce_meta_string((book.get("meta") or {}).get("currentChapter"))
        if at_bookmark and inherited:
            meta["chapter"] = inherited
    elif chapter:
        meta["chapter"] = chapter

    note_status = "atomic" if args.atomic else ("inbox" if args.spar else "saved")
    note = {
        "id": str(uuid.uuid4()),
        "slug": slug,
        "bookId": book["id"],
        "createdAt": now_iso,
        "updatedAt": now_iso,
        "pos": clean_num(incoming_pos),
        "normalizedPos": normalized_pos,
        "status": note_status,
        "source": "agent",
        "tags": parse_tags_csv(args.tags or ""),
        "quote": quote,
        "takeaway": takeaway,
        "contextMechanism": context_mech,
        "critique": critique,
        "deltaTrigger": trig_body,
        "deltaAction": act_body,
        "deltaStatus": delta_status,
        "meta": meta,
    }
    backend.save_note(note)

    updated_book = book
    changed = False
    rejected_backward = False
    saved_session: dict[str, Any] | None = None
    force = bool(getattr(args, "force", False))

    if pos_provided:
        updated_book, changed, rejected_backward, prev_pos, next_pos = apply_bookmark_advance(
            book,
            incoming_pos,
            manual_override=bool(args.force_pos),
            now_iso=now_iso,
        )
        if changed:
            backend.save_book(
                updated_book,
                expected_base_updated_at=(book.get("meta") or {}).get("updatedAt"),
                force=force,
            )
            sess, _ = upsert_coalesced_session(
                ws["sessions"],
                book_id=book["id"],
                prev_pos=prev_pos,
                next_pos=next_pos,
                now_iso=now_iso,
                manual_override=bool(args.force_pos),
            )
            saved_session = backend.save_session(sess)

    return {
        "note": note,
        "book": updated_book,
        "session": saved_session,
        "bookmarkChanged": changed,
        "rejectedBackward": rejected_backward,
    }


def cmd_book_capstone(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    """A2.1: write Books.metaJson.capstone (zero AI — the text is the user's own words)."""
    arc = (args.arc or "").strip()
    shift = (args.shift or "").strip()
    learnings = [t.strip() for t in (args.learnings or []) if t and t.strip()]
    if not arc:
        raise CliError("--arc cannot be empty.")
    if not shift:
        raise CliError("--shift cannot be empty.")
    if not learnings:
        raise CliError("Provide at least one non-empty --learnings.")
    if len(learnings) > MAX_KEY_LEARNINGS:
        raise CliError(f"At most {MAX_KEY_LEARNINGS} --learnings are allowed (got {len(learnings)}).")
    completed_arg = (getattr(args, "completed_at", None) or "").strip()
    if completed_arg and parse_iso_utc(completed_arg) is None:
        raise CliError(f"Invalid --completed-at (expected ISO-8601): {completed_arg}")

    ws = backend.load_workspace()
    book = resolve_book(ws["books"], args.book)
    if book.get("status") != "finished" and not getattr(args, "allow_unfinished", False):
        raise CliError(
            f"Book '{book.get('title')}' is not finished. Finish it first "
            "(progress --finish) or pass --allow-unfinished."
        )
    base_updated_at = (book.get("meta") or {}).get("updatedAt")
    now_iso = now_iso_utc()

    updated = json.loads(json.dumps(book))
    meta = updated.setdefault("meta", {})
    existing = meta.get("capstone")
    # Unknown keys inside a stored capstone object pass through verbatim (decisions R1#3).
    capstone: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
    replaced_non_object = existing is not None and not isinstance(existing, dict)
    previous_raw = capstone.get("completedAt")
    previous_completed = (_coerce_meta_string(previous_raw) or "").strip()
    # QA-15: a stored completedAt that isn't a timestamp ("soon", 123) is repaired to now.
    completed_repaired = False
    if previous_completed and parse_iso_utc(previous_completed) is None:
        previous_completed = ""
        completed_repaired = not completed_arg
    elif previous_raw is not None and not previous_completed:
        completed_repaired = not completed_arg
    capstone["arcOrThesis"] = arc
    capstone["keyLearnings"] = learnings
    capstone["perspectiveShift"] = shift
    capstone["completedAt"] = completed_arg or previous_completed or now_iso
    meta["capstone"] = capstone
    meta["updatedAt"] = now_iso

    force = bool(getattr(args, "force", False))
    backend.save_book(updated, expected_base_updated_at=base_updated_at, force=force)
    result: dict[str, Any] = {"book": updated, "capstone": capstone}
    if completed_repaired:
        result["completedAtRepaired"] = True
    if replaced_non_object:
        # R1#6 nit: a legacy non-object capstone (e.g. a string) was replaced.
        result["replacedNonObjectCapstone"] = True
    return result


NOTE_UPDATE_FIELDS = (
    "status",
    "title",
    "quote",
    "takeaway",
    "context",
    "critique",
    "trigger",
    "action",
    "delta_status",
    "chapter",
    "tags",
)


def cmd_note_update(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    """A4.2: field edits + the inbox/in-reflection -> saved "just save it" escape hatch.

    Only the flags that were passed change; meta (socraticQuestions, sparStage,
    attachments, unknown keys) is carried over untouched. The slug is intentionally never
    re-derived (even when --title/--takeaway change) so existing [[wikilinks]] keep
    resolving; renaming a slug stays a reflect --stage commit --slug / EditNoteModal action.
    """
    archive_flag = bool(getattr(args, "archive", False))
    unarchive_flag = bool(getattr(args, "unarchive", False))
    if all(getattr(args, f, None) is None for f in NOTE_UPDATE_FIELDS) and not (
        archive_flag or unarchive_flag
    ):
        raise CliError(
            "Provide at least one field to update "
            "(e.g. --status saved, --takeaway, --chapter, --archive)."
        )

    ws = backend.load_workspace()
    note = resolve_note(ws["notes"], args.note)
    updated = json.loads(json.dumps(note))
    meta = updated.setdefault("meta", {})

    if args.status is not None:
        updated["status"] = args.status
    if args.title is not None:
        if args.title.strip():
            meta["title"] = args.title.strip()
        else:
            meta.pop("title", None)
    if args.quote is not None:
        updated["quote"] = args.quote.strip()
    if args.takeaway is not None:
        updated["takeaway"] = args.takeaway.strip()
    if args.context is not None:
        updated["contextMechanism"] = args.context.strip()
    if args.critique is not None:
        updated["critique"] = args.critique.strip()
    if args.trigger is not None:
        updated["deltaTrigger"] = normalize_delta_trigger(args.trigger)
    if args.action is not None:
        updated["deltaAction"] = normalize_delta_action(args.action)
    if args.delta_status is not None:
        updated["deltaStatus"] = args.delta_status
    chapter = _chapter_arg(args.chapter)
    if chapter is not None:
        _apply_chapter(meta, "chapter", chapter)
    if args.tags is not None:
        updated["tags"] = parse_tags_csv(args.tags)

    # C1.1 soft-archive (OQ-3): archiving pauses an ACTIVE delta and remembers it in
    # meta.archivedDeltaStatus; unarchiving reactivates it only while under the cap.
    archive_extras: dict[str, Any] = {}
    if archive_flag and not is_archived(updated):
        meta["archivedAt"] = now_iso_utc()
        if (updated.get("deltaStatus") or "none") == "active" and args.delta_status is None:
            updated["deltaStatus"] = "paused"
            meta["archivedDeltaStatus"] = "active"
            archive_extras["deltaPaused"] = True
    elif unarchive_flag:
        wanted = meta.get("archivedDeltaStatus") == "active" and updated.get("deltaStatus") == "paused"
        meta.pop("archivedAt", None)
        meta.pop("archivedDeltaStatus", None)
        if wanted and args.delta_status is None:
            others = sum(
                1
                for n in ws["notes"]
                if n.get("id") != note["id"] and n.get("deltaStatus") == "active" and not is_archived(n)
            )
            if others < ACTIVE_DELTA_CAP:
                updated["deltaStatus"] = "active"
                archive_extras["deltaReactivated"] = True
            else:
                archive_extras["deltaCapped"] = True

    next_delta = updated.get("deltaStatus") or "none"
    delta_flags_passed = (
        args.delta_status is not None or args.trigger is not None or args.action is not None
    )
    # R1#1 / QA-16: only an ACTIVE delta needs an atomic note. Paused / graduated / legacy
    # deltas on saved or inbox notes are harmless history and are kept as-is, so the
    # "just save it" escape hatch (--status saved) always works without discarding them.
    if (args.delta_status is not None or args.status is not None) and next_delta == "active":
        if updated.get("status") != "atomic":
            raise CliError(
                "An active Behavioral Delta needs an atomic note: pass --status atomic, or "
                "pause it with --delta-status paused to keep it in Practice history."
            )
    if args.delta_status is not None:
        check_active_delta_cap(ws["notes"], note["id"], next_delta)
    # R1#2: the WHEN/DO requirement is checked only when the delta itself is being edited,
    # so unrelated edits on legacy rows (active with empty WHEN/DO) are not blocked.
    if (
        delta_flags_passed
        and next_delta == "active"
        and not (updated.get("deltaTrigger") or updated.get("deltaAction"))
    ):
        raise CliError("Provide a WHEN trigger or DO action to activate a Behavioral Delta.")
    if not (
        (updated.get("takeaway") or "").strip()
        or (updated.get("quote") or "").strip()
        or renderable_attachments(meta)
    ):
        raise CliError("A note needs a takeaway, a quote, or an attachment.")

    updated["updatedAt"] = now_iso_utc()
    force = bool(getattr(args, "force", False))
    backend.save_note(updated, expected_base_updated_at=note.get("updatedAt"), force=force)
    result: dict[str, Any] = {"note": updated}
    result.update(archive_extras)
    return result


def _build_spoiler_safe_questions(book: dict[str, Any]) -> list[str]:
    """B2.5: default questions for a note beyond the bookmark — no note position/title."""
    ceiling_str = format_pos_display(
        _safe_float(book.get("currentPos"), 0.0),
        book.get("posUnit") or "page",
    )
    q1 = (
        f"Thinking only about what you have read so far in '{book['title']}', what craft choice "
        "or emotional tension made this moment worth saving?"
    )
    q2 = (
        f"Strictly considering what you have read up to {ceiling_str}, what unspoken subtext "
        "or character shift do you expect next?"
    )
    return [q1, q2]


def _build_socratic_questions(note: dict[str, Any], book: dict[str, Any] | None) -> list[str]:
    pos_str = format_pos_display(
        float(note.get("pos") or 0),
        (book or {}).get("posUnit") or "page",
    )
    title = (note.get("meta") or {}).get("title") or note.get("slug") or "this passage"
    if book and book.get("kind") == "fiction":
        ceiling_str = format_pos_display(
            float(book.get("currentPos") or 0),
            book.get("posUnit") or "page",
        )
        q1 = (
            f"At {pos_str} in '{book['title']}', what specific craft choice or emotional tension "
            f"made '{title}' resonate with you?"
        )
        q2 = (
            f"Strictly considering what you have read up to {ceiling_str}, what unspoken subtext "
            "or character shift does this moment hint at?"
        )
        return [q1, q2]

    q1 = (
        f"What underlying mechanism or real-life pattern makes '{title}' ring true—and where "
        "in your own life, work, or mental models does it connect?"
    )
    q2 = (
        f"What boundary condition, counterexample, or context could limit '{title}'?"
    )
    return [q1, q2]


def cmd_reflect(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    ws = backend.load_workspace()
    note = resolve_note(ws["notes"], args.note)
    book_map = {b["id"]: b for b in ws["books"]}
    book = book_map.get(note.get("bookId", ""))
    now_iso = now_iso_utc()

    if args.stage == "1":
        spoiler_guarded = bool(
            book and book.get("kind") == "fiction" and is_note_spoiler(note, book)
        )
        defaults = (
            _build_spoiler_safe_questions(book)
            if spoiler_guarded and book
            else _build_socratic_questions(note, book)
        )
        q1_arg = (getattr(args, "q1", None) or "").strip()
        q2_arg = (getattr(args, "q2", None) or "").strip()
        questions = [
            q1_arg if q1_arg else defaults[0],
            q2_arg if q2_arg else defaults[1],
        ]
        updated = json.loads(json.dumps(note))
        updated["status"] = "in-reflection"
        updated["updatedAt"] = now_iso
        updated.setdefault("meta", {})["socraticQuestions"] = questions
        force = bool(getattr(args, "force", False))
        backend.save_note(
            updated,
            expected_base_updated_at=note.get("updatedAt"),
            force=force,
        )
        result: dict[str, Any] = {
            "stage": 1,
            "status": "awaiting_user_reply",
            "noteId": updated["id"],
            "slug": updated["slug"],
            "socraticQuestions": questions,
            "instruction": (
                "STAGE 2 BLOCKING WAIT: Present these two Socratic questions to the user and "
                "stop to await their reply before running reflect --stage commit."
            ),
        }
        if spoiler_guarded:
            # B2.5 / QA-8: slugs are title-derived; return only the UUID for shielded notes.
            result.pop("slug", None)
            result["spoilerGuarded"] = True
        return result

    if args.stage == "commit":
        next_delta_status = args.delta_status or note.get("deltaStatus") or "none"
        if next_delta_status not in ("none", "active", "paused", "graduated"):
            raise CliError(f"Invalid deltaStatus: {next_delta_status}")

        check_active_delta_cap(ws["notes"], note["id"], next_delta_status)

        next_trigger = (
            normalize_delta_trigger(args.trigger)
            if args.trigger is not None
            else normalize_delta_trigger(note.get("deltaTrigger") or "")
        )
        next_action = (
            normalize_delta_action(args.action)
            if args.action is not None
            else normalize_delta_action(note.get("deltaAction") or "")
        )
        if next_delta_status == "active" and not next_trigger and not next_action:
            raise CliError(
                "Provide a WHEN trigger or DO action to activate a Behavioral Delta."
            )

        updated = json.loads(json.dumps(note))
        if args.title is not None:
            if args.title.strip():
                updated.setdefault("meta", {})["title"] = args.title.strip()
            else:
                updated.setdefault("meta", {}).pop("title", None)

        slug_input = (args.slug or "").strip()
        if slug_input:
            updated["slug"] = generate_unique_slug(
                slug_input,
                [n["slug"] for n in ws["notes"]],
                exclude_self_slug=note["slug"],
            )

        if args.takeaway is not None:
            updated["takeaway"] = args.takeaway.strip()
        if args.context is not None:
            updated["contextMechanism"] = args.context.strip()
        if args.critique is not None:
            updated["critique"] = args.critique.strip()
        chapter = _chapter_arg(getattr(args, "chapter", None))
        if chapter is not None:
            _apply_chapter(updated.setdefault("meta", {}), "chapter", chapter)

        updated["deltaTrigger"] = next_trigger
        updated["deltaAction"] = next_action
        updated["deltaStatus"] = next_delta_status
        updated["status"] = "atomic"
        updated["updatedAt"] = now_iso
        force = bool(getattr(args, "force", False))
        backend.save_note(
            updated,
            expected_base_updated_at=note.get("updatedAt"),
            force=force,
        )
        return {
            "stage": "commit",
            "note": updated,
        }

    raise CliError(f"Unsupported reflect stage: {args.stage}")


def cmd_recall(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    ws = backend.load_workspace()
    book_map = {b["id"]: b for b in ws["books"]}

    if args.mode == "qa":
        target_book = resolve_book(ws["books"], args.book) if args.book else None
        q = (args.query or "").strip().lower()
        terms = [t for t in re.split(r"\s+", q) if t]

        matches: list[dict[str, Any]] = []
        excluded_spoilers = 0
        for n in ws["notes"]:
            b = book_map.get(n.get("bookId", ""))
            if target_book and n.get("bookId") != target_book["id"]:
                continue
            if is_archived(n):
                continue
            if is_note_spoiler(n, b):
                excluded_spoilers += 1
                continue
            haystack = " ".join(
                [
                    str((n.get("meta") or {}).get("title") or ""),
                    n.get("slug") or "",
                    n.get("quote") or "",
                    n.get("takeaway") or "",
                    n.get("contextMechanism") or "",
                    n.get("critique") or "",
                    " ".join(n.get("tags") or []),
                    (b or {}).get("title") or "",
                    (b or {}).get("author") or "",
                ]
            ).lower()
            if not terms or all(t in haystack for t in terms):
                matches.append(
                    {
                        "id": n["id"],
                        "slug": n["slug"],
                        "title": (n.get("meta") or {}).get("title") or n["slug"],
                        "bookTitle": (b or {}).get("title") or "",
                        "pos": n.get("pos"),
                        "status": n.get("status"),
                        "quote": n.get("quote"),
                        "takeaway": n.get("takeaway"),
                        "contextMechanism": n.get("contextMechanism"),
                        "critique": n.get("critique"),
                    }
                )
        return {
            "mode": "qa",
            "query": args.query or "",
            "matches": matches,
            "excludedSpoilersCount": excluded_spoilers,
        }

    if args.mode == "checkin":
        has_note = bool((args.note or "").strip())
        has_outcome = bool((args.outcome or "").strip())
        if has_note != has_outcome:
            raise CliError(
                "Provide both --note and --outcome together to log a delta check-in."
            )
        if has_note and has_outcome:
            if args.outcome not in ("applied", "missed", "no-trigger"):
                raise CliError(f"Invalid check-in outcome: {args.outcome}")
            note = resolve_note(ws["notes"], args.note)
            today = local_date_str()
            log = {
                "id": str(uuid.uuid4()),
                "noteId": note["id"],
                "date": today,
                "outcome": args.outcome,
                "reflection": (args.reflection or "").strip(),
            }
            backend.save_delta_log(log)

            updated_note = None
            if args.trigger is not None:
                updated_note = json.loads(json.dumps(note))
                updated_note["deltaTrigger"] = normalize_delta_trigger(args.trigger)
                updated_note["updatedAt"] = now_iso_utc()
                backend.save_note(
                    updated_note,
                    expected_base_updated_at=note.get("updatedAt"),
                    force=bool(getattr(args, "force", False)),
                )

            return {
                "mode": "checkin",
                "logged": log,
                "updatedNote": updated_note,
            }

        active = []
        for n in ws["notes"]:
            if n.get("deltaStatus") == "active" and not is_archived(n):
                _, _, when_line, do_line = format_when_do_lines(
                    n.get("deltaTrigger") or "",
                    n.get("deltaAction") or "",
                )
                b = book_map.get(n.get("bookId", ""))
                active.append(
                    {
                        "id": n["id"],
                        "slug": n["slug"],
                        "bookTitle": (b or {}).get("title") or "",
                        "whenLine": when_line,
                        "doLine": do_line,
                    }
                )
        return {
            "mode": "checkin",
            "activeCount": len(active),
            "cap": ACTIVE_DELTA_CAP,
            "activeDeltas": active,
        }

    if args.mode == "shuffle":
        today = args.date or local_date_str()
        if args.mark_reviewed:
            note = resolve_note(ws["notes"], args.mark_reviewed)
            updated = json.loads(json.dumps(note))
            updated.setdefault("meta", {})["lastReviewedAt"] = today
            # Reviewing is not editing: preserve updatedAt so export-md isn't triggered needlessly.
            backend.save_note(
                updated,
                expected_base_updated_at=note.get("updatedAt"),
                force=bool(getattr(args, "force", False)),
            )
            return {
                "mode": "shuffle",
                "markedReviewed": updated["slug"],
                "date": today,
            }

        picked = select_takeaway_shuffle(ws["notes"], ws["books"], today, limit=args.limit)
        return {
            "mode": "shuffle",
            "date": today,
            "candidates": [
                {
                    "id": n["id"],
                    "slug": n["slug"],
                    "title": (n.get("meta") or {}).get("title") or n["slug"],
                    "bookTitle": (book_map.get(n.get("bookId", "")) or {}).get("title") or "",
                    "pos": n.get("pos"),
                    "quote": n.get("quote"),
                    "takeaway": n.get("takeaway"),
                }
                for n in picked
            ],
        }

    raise CliError(f"Unsupported recall mode: {args.mode}")


def cmd_ocr_backfill(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    if (args.ocr_text or "").strip() and not (getattr(args, "note", None) or "").strip():
        # B4.4: one literal OCR string must never be applied to every image note.
        raise CliError("--ocr-text applies to a single note; pass --note <slug|id> with it.")
    ws = backend.load_workspace()
    ocr_map: dict[str, str] = {}
    if args.ocr_map_json:
        map_path = Path(args.ocr_map_json)
        if not map_path.exists():
            raise CliError(f"OCR map JSON not found: {map_path}")
        try:
            raw_map = json.loads(map_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise CliError(f"Invalid OCR map JSON in {map_path}: {exc}") from exc
        if not isinstance(raw_map, dict):
            raise CliError("OCR map JSON must be an object mapping note/file keys to OCR text.")
        ocr_map = {str(k): str(v) for k, v in raw_map.items()}

    target_note_id: str | None = None
    if args.note:
        target_note_id = resolve_note(ws["notes"], args.note)["id"]

    updated_notes: list[dict[str, Any]] = []
    skipped_notes: list[str] = []

    for n in ws["notes"]:
        if target_note_id and n["id"] != target_note_id:
            continue
        meta = n.get("meta") or {}
        img_attachments = [a for a in renderable_attachments(meta) if a.get("type") == "image"]
        if not img_attachments:
            continue
        if (n.get("quote") or "").strip():
            skipped_notes.append(n["slug"])
            continue
        if meta.get("ocrBackfilled"):
            skipped_notes.append(n["slug"])
            continue

        resolved_text = ""
        for key in (
            n["id"],
            n["slug"],
            *(str(a.get("id") or "") for a in img_attachments),
            *(str(a.get("driveFileId") or "") for a in img_attachments),
            *(str(a.get("fileName") or "") for a in img_attachments),
        ):
            if key and key in ocr_map and ocr_map[key].strip():
                resolved_text = ocr_map[key].strip()
                break

        if not resolved_text and args.ocr_text:
            resolved_text = args.ocr_text.strip()

        if not resolved_text and args.ocr_cmd:
            for att in img_attachments:
                img_file, is_temp = backend.fetch_image_to_temp(att)
                try:
                    if img_file and img_file.exists():
                        parts = [
                            part.replace("{path}", str(img_file))
                            for part in shlex.split(args.ocr_cmd)
                        ]
                        rc, out, _ = default_cmd_runner(parts)
                        if rc == 0 and out.strip():
                            resolved_text = out.strip()
                            break
                finally:
                    if is_temp and img_file is not None and img_file.exists():
                        img_file.unlink()

        if not resolved_text:
            skipped_notes.append(n["slug"])
            continue

        updated = json.loads(json.dumps(n))
        updated["quote"] = resolved_text
        updated.setdefault("meta", {})["ocrBackfilled"] = True
        updated["updatedAt"] = now_iso_utc()
        backend.save_note(
            updated,
            expected_base_updated_at=n.get("updatedAt"),
            force=bool(getattr(args, "force", False)),
        )
        updated_notes.append(updated)

    return {
        "updatedCount": len(updated_notes),
        "updatedSlugs": [u["slug"] for u in updated_notes],
        "skippedSlugs": skipped_notes,
    }


def _needs_md_export(note: dict[str, Any]) -> bool:
    if note.get("status") != "atomic":
        return False
    # QA-25 / R1#4: archived notes aren't exported (matches the MD index and doc-sync).
    # Files already written are left alone (never delete user-visible output).
    if is_archived(note):
        return False
    exported_raw = (note.get("meta") or {}).get("exportedAt")
    if not exported_raw:
        return True
    updated_dt = parse_iso_utc(note.get("updatedAt"))
    exported_dt = parse_iso_utc(str(exported_raw))
    if updated_dt is not None and exported_dt is not None:
        return updated_dt > exported_dt
    return str(note.get("updatedAt") or "") > str(exported_raw)


def _render_note_markdown(note: dict[str, Any], book: dict[str, Any] | None) -> str:
    meta = note.get("meta") or {}
    title = meta.get("title") or note["slug"]
    book_title = (book or {}).get("title") or "Unknown Book"
    author = (book or {}).get("author") or ""
    pos_display = format_pos_display(float(note.get("pos") or 0), (book or {}).get("posUnit") or "page")
    tags = note.get("tags") or []
    trig_body, act_body, when_line, do_line = format_when_do_lines(
        note.get("deltaTrigger") or "",
        note.get("deltaAction") or "",
    )
    wikilinks = extract_note_wikilinks(note)
    attachments = renderable_attachments(meta)

    def yaml_str(val: str) -> str:
        escaped = val.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'

    lines: list[str] = [
        "---",
        f"id: {yaml_str(note['id'])}",
        f"slug: {yaml_str(note['slug'])}",
        f"book: {yaml_str(book_title)}",
        f"author: {yaml_str(author)}",
        f"pos: {yaml_str(pos_display)}",
        f"tags: [{', '.join(yaml_str(t) for t in tags)}]",
        f"updatedAt: {yaml_str(str(note.get('updatedAt') or ''))}",
        "---",
        "",
        f"# {title}",
        "",
    ]

    if (note.get("quote") or "").strip():
        lines.extend(["## Quote", "", f"> {note['quote'].strip()}", ""])

    if (note.get("takeaway") or "").strip():
        lines.extend(["## Core Takeaway", "", note["takeaway"].strip(), ""])

    if (note.get("contextMechanism") or "").strip():
        lines.extend(["## Context & Mechanism", "", note["contextMechanism"].strip(), ""])

    if when_line or do_line or note.get("deltaStatus") not in ("", "none", None):
        lines.extend(["## Behavioral Delta", ""])
        lines.append(f"- Status: `{note.get('deltaStatus') or 'none'}`")
        if trig_body:
            lines.append(f"- **WHEN** {trig_body}")
        if act_body:
            lines.append(f"- **DO** {act_body}")
        lines.append("")

    if (note.get("critique") or "").strip():
        lines.extend(["## Socratic Critique", "", note["critique"].strip(), ""])

    if attachments:
        lines.extend(["## Attachments", ""])
        for att in attachments:
            if att.get("type") == "image":
                ref = att.get("driveFileId") or att.get("demoMediaId") or att.get("id")
                lines.append(f"- Image: `{att.get('fileName')}` (`{ref}`)")
            else:
                lines.append(f"- [{att.get('title') or att.get('url')}]({att.get('url')})")
        lines.append("")

    if wikilinks:
        lines.extend(["## Related Concepts", ""])
        lines.append(", ".join(f"[[{wl}]]" for wl in wikilinks))
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def cmd_export_md(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    ws = backend.load_workspace()
    book_map = {b["id"]: b for b in ws["books"]}
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_dir_resolved = out_dir.resolve()

    exported_files: list[str] = []
    skipped = 0

    for n in ws["notes"]:
        if not _needs_md_export(n):
            skipped += 1
            continue

        book = book_map.get(n.get("bookId", ""))
        md_content = _render_note_markdown(n, book)
        safe_slug = slugify(str(n.get("slug") or n.get("id") or "note"))
        dest_file = out_dir / f"{safe_slug}.md"
        if not dest_file.resolve().is_relative_to(out_dir_resolved):
            raise CliError(f"Unsafe export path for slug: {n.get('slug')}")

        fd, tmp_name = tempfile.mkstemp(prefix=".pragya_md_", suffix=".md", dir=str(out_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(md_content)
            os.replace(tmp_name, dest_file)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)

        # Stamp exportedAt ONLY AFTER disk write succeeds; preserve updatedAt!
        updated_dt = parse_iso_utc(n.get("updatedAt"))
        now_dt = datetime.now(timezone.utc)
        stamp_dt = now_dt if (updated_dt is None or now_dt >= updated_dt) else updated_dt
        stamp_iso = stamp_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")

        updated_note = json.loads(json.dumps(n))
        updated_note.setdefault("meta", {})["exportedAt"] = stamp_iso
        backend.save_note(
            updated_note,
            expected_base_updated_at=n.get("updatedAt"),
            force=bool(getattr(args, "force", False)),
        )
        exported_files.append(str(dest_file))

    # A1.5: per-book Markdown index books/<book-slug>.md (atomic files above stay OQ-8).
    books_dir = out_dir / "books"
    books_dir_resolved = books_dir.resolve()
    index_written: list[str] = []
    index_unchanged = 0
    include_drafts = bool(getattr(args, "include_drafts", False))
    include_spoilers = bool(getattr(args, "include_spoilers", False))
    shielded_total = 0
    pending: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for book in ws["books"]:
        timeline, shielded = select_book_timeline_with_shield(
            ws["notes"], book, include_drafts, include_spoilers
        )
        shielded_total += shielded
        if timeline or has_book_capstone(book.get("meta")):
            pending.append((book, timeline))
    slugs = assign_book_index_slugs([b for b, _ in pending])
    for book, timeline in pending:
        dest = books_dir / f"{slugs[str(book.get('id'))]}.md"
        if not dest.resolve().is_relative_to(books_dir_resolved):
            raise CliError(f"Unsafe book index path for: {book.get('title')}")
        content = render_book_index_md(book, timeline)
        if dest.exists() and dest.read_text(encoding="utf-8") == content:
            index_unchanged += 1
            continue
        books_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=".pragya_book_", suffix=".md", dir=str(books_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.replace(tmp_name, dest)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        index_written.append(str(dest))

    return {
        "exportedCount": len(exported_files),
        "exportedFiles": exported_files,
        "skippedCount": skipped,
        "bookIndexWritten": len(index_written),
        "bookIndexFiles": index_written,
        "bookIndexUnchanged": index_unchanged,
        "shieldedCount": shielded_total,
    }


def _companion_text_to_gdocs_ops(text: str) -> list[dict[str, Any]]:
    ops: list[dict[str, Any]] = []
    paragraph_lines: list[str] = []

    def flush_paragraph() -> None:
        if paragraph_lines:
            body = "\n".join(paragraph_lines).strip("\n")
            if body.strip():
                ops.append({"op": "append", "text": body})
            paragraph_lines.clear()

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if line.startswith("# "):
            flush_paragraph()
            ops.append({"op": "heading", "text": line[2:].strip(), "level": "1"})
        elif line.startswith("## "):
            flush_paragraph()
            ops.append({"op": "heading", "text": line[3:].strip(), "level": "2"})
        elif line.startswith("### "):
            flush_paragraph()
            ops.append({"op": "heading", "text": line[4:].strip(), "level": "3"})
        else:
            paragraph_lines.append(line)
    flush_paragraph()
    return ops


# ---------------------------------------------------------------------------
# Batch 6: Companion Doc / Markdown timelines (ux_spec E.1 / E.2)
# ---------------------------------------------------------------------------

TIMELINE_STATUSES = ("saved", "atomic")
DRAFT_STATUSES = ("inbox", "in-reflection")
# OQ-3: lines that belong to a Pragya-managed block (anything else is user prose).
PRAGYA_FIELD_PREFIXES = (
    "Quote:", "Takeaway:", "Mechanism:", "Critique:", "WHEN ", "DO ",
    "Thesis:", "Arc:", "Key Learnings:", "• ", "How My Thinking Shifted:", "Written ",
)
# R1 nit 8: the marker is the LAST `[note:…]` / `[capstone:…]` in a heading; any text a
# user typed after it is kept as a suffix (not a reason to treat the block as unknown).
DOC_MARKER_RE = re.compile(r"\[(note|capstone):([^\]\s]+)\]")
# R1#2 / QA-18: per-kind block grammar — each field at most once, in render order.
NOTE_FIELD_ORDER = ("Quote:", "Takeaway:", "Mechanism:", "WHEN ", "DO ", "Critique:")
SAVED_FIELD_COUNT = 2  # HEADING_3 (saved / draft) blocks only ever render Quote + Takeaway
CAPSTONE_FIELD_ORDER = (("Thesis:", "Arc:"), ("Key Learnings:",), ("• ",), ("How My Thinking Shifted:",), ("Written ",))
CAPSTONE_BULLET_INDEX = 2
# Header lines the planner recognizes under the H1 (R1 nit 7; `Now in:` = pre-Batch-6 Docs).
DOC_HEADER_PREFIXES = ("Author:", "Now in:")
# Result vocabularies (quoted by the Batch 7 skill docs).
DOC_SYNC_MODES = ("created", "in-place", "append", "append-fallback", "unchanged")
CAPSTONE_SYNC_STATES = ("absent", "unchanged", "added", "updated", "removed", "skipped")
SAVED_TITLE_WORDS = 8
UNTITLED_NOTE_TITLE = "Quick Note"


def _is_timeline_shielded(note: dict[str, Any], book: dict[str, Any]) -> bool:
    """decisions Batch 6 (1): notes ahead of the bookmark and sealed fiction predictions of
    an unfinished book are shielded from Doc / Markdown timelines by default."""
    return is_note_spoiler(note, book) or is_sealed_prediction(note, book)


def select_book_timeline_with_shield(
    notes: list[dict[str, Any]],
    book: dict[str, Any],
    include_drafts: bool = False,
    include_spoilers: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    """(timeline, shieldedCount): see select_book_timeline."""
    statuses = TIMELINE_STATUSES + (DRAFT_STATUSES if include_drafts else ())
    # C1.1: archived notes never enter the Doc / Markdown timeline.
    picked = [
        n
        for n in notes
        if n.get("bookId") == book.get("id") and n.get("status") in statuses and not is_archived(n)
    ]
    shielded = 0
    if not include_spoilers:
        visible = [n for n in picked if not _is_timeline_shielded(n, book)]
        shielded = len(picked) - len(visible)
        picked = visible
    picked.sort(
        key=lambda n: (
            effective_note_norm(n, book),
            _safe_float(n.get("pos"), 0.0),
            str(n.get("createdAt") or ""),
        )
    )
    return picked, shielded


def select_book_timeline(
    notes: list[dict[str, Any]],
    book: dict[str, Any],
    include_drafts: bool = False,
    include_spoilers: bool = False,
) -> list[dict[str, Any]]:
    """A1.1: the book's saved + atomic notes (plus inbox / in-reflection with
    --include-drafts) in reading order: (effective_note_norm, pos, createdAt).

    Spoiler notes and sealed predictions of an unfinished book are excluded unless
    include_spoilers (decisions Batch 6). Already-synced Doc blocks of a note that becomes
    shielded later (bookmark moved back) are left in the Doc untouched by the planner.
    """
    return select_book_timeline_with_shield(notes, book, include_drafts, include_spoilers)[0]


def _one_line(value: Any) -> str:
    """OQ-3: newlines inside a field value collapse to single spaces."""
    text = value if isinstance(value, str) else ("" if value is None else str(value))
    return re.sub(r"\s*[\r\n]+\s*", " ", text).strip()


def _saved_title_info(note: dict[str, Any]) -> tuple[str, bool]:
    """(title, takeaway_redundant) for a saved / draft note.

    decisions #1: meta.title -> first 8 words of the takeaway (+ "…" when cut) -> Quick Note.
    R2#1: a derived heading drops one trailing "." and, when it carries the WHOLE takeaway
    (nothing was cut), the Takeaway line is omitted (it would only echo the heading).
    """
    title = _one_line((note.get("meta") or {}).get("title"))
    if title:
        return title, False
    words = _one_line(note.get("takeaway")).split()
    if words:
        head = " ".join(words[:SAVED_TITLE_WORDS])
        cut = len(words) > SAVED_TITLE_WORDS
        stripped = head[:-1] if head.endswith(".") and len(head) > 1 else head
        return (stripped + "…", False) if cut else (stripped, True)
    return UNTITLED_NOTE_TITLE, False


def _saved_note_title(note: dict[str, Any]) -> str:
    return _saved_title_info(note)[0]


def _note_heading_title(note: dict[str, Any]) -> str:
    if note.get("status") == "atomic":
        return _one_line((note.get("meta") or {}).get("title")) or str(note.get("slug") or "")
    return _saved_note_title(note)


def _note_badge(note: dict[str, Any], book: dict[str, Any]) -> str:
    chapter = (note.get("meta") or {}).get("chapter")
    return format_chapter_badge(chapter, _safe_float(note.get("pos"), 0.0), book.get("posUnit") or "page")


def _iso_date(value: Any) -> str:
    dt = parse_iso_utc(_coerce_meta_string(value) or "")
    return dt.strftime("%Y-%m-%d") if dt else ""


def _kind_label(book: dict[str, Any]) -> str:
    return "Fiction" if book.get("kind") == "fiction" else "Non-fiction"


@dataclass
class DocLine:
    """One Doc paragraph / text line. `level` 0 = normal text, 1-3 = heading level.

    `raw` is the exact original text line (text mode) so untouched lines are written
    back byte-for-byte; `start`/`end` are Docs API UTF-16 indexes (Docs mode).
    """

    level: int
    text: str
    raw: str | None = None
    start: int | None = None
    end: int | None = None

    def key(self) -> tuple[int, str]:
        return (self.level, self.text.rstrip())


@dataclass
class DocSnapshot:
    """A documents.get read: indexed lines + the revisionId used for writeControl."""

    lines: list[DocLine]
    revision_id: str | None = None


def _new_line(level: int, text: str) -> DocLine:
    return DocLine(level=level, text=text)


def render_doc_header(book: dict[str, Any]) -> list[DocLine]:
    """E.1 header: H1 + `Author: … · Kind · Finished YYYY-MM-DD` (decisions Batch 6 (3):
    no `Now in:` line — it would go stale because header lines are never rewritten)."""
    meta = book.get("meta") or {}
    parts = [f"Author: {_one_line(book.get('author')) or 'Unknown Author'}", _kind_label(book)]
    if book.get("status") == "finished":
        finished = _iso_date(meta.get("finishedAt"))
        parts.append(f"Finished {finished}" if finished else "Finished")
    return [_new_line(1, f"Pragya · {_one_line(book.get('title'))}"), _new_line(0, " · ".join(parts))]


def render_capstone_block(book: dict[str, Any]) -> list[DocLine]:
    """A1.3 / E.1: `## Whole-Book Picture [capstone:<bookId>]` + label lines (empty if none)."""
    meta = book.get("meta") or {}
    if not has_book_capstone(meta):
        return []
    cap = get_book_capstone(meta) or {}
    lines = [_new_line(2, f"Whole-Book Picture [capstone:{book['id']}]")]
    arc = _one_line(cap.get("arcOrThesis"))
    if arc:
        lines.append(_new_line(0, f"{'Arc' if book.get('kind') == 'fiction' else 'Thesis'}: {arc}"))
    learnings = [_one_line(item) for item in cap.get("keyLearnings") or []]
    learnings = [item for item in learnings if item]
    if learnings:
        lines.append(_new_line(0, "Key Learnings:"))
        lines.extend(_new_line(0, f"• {item}") for item in learnings)
    shift = _one_line(cap.get("perspectiveShift"))
    if shift:
        lines.append(_new_line(0, f"How My Thinking Shifted: {shift}"))
    written = _iso_date(cap.get("completedAt"))
    if written:
        lines.append(_new_line(0, f"Written {written}"))
    return lines


def render_note_block(note: dict[str, Any], book: dict[str, Any]) -> list[DocLine]:
    """A1.2: atomic = HEADING_2 with every non-empty field; saved (and drafts) = HEADING_3
    with Quote (if any) + Takeaway only. Heading `[<badge>] <Title> [note:<uuid>]`."""
    atomic = note.get("status") == "atomic"
    heading = f"{_note_badge(note, book)} {_note_heading_title(note)} [note:{note['id']}]"
    lines = [_new_line(2 if atomic else 3, heading)]
    quote = _one_line(note.get("quote"))
    takeaway = _one_line(note.get("takeaway"))
    takeaway_redundant = (not atomic) and _saved_title_info(note)[1]
    if quote:
        lines.append(_new_line(0, f'Quote: "{quote}"'))
    if takeaway and not takeaway_redundant:
        lines.append(_new_line(0, f"Takeaway: {takeaway}"))
    if atomic:
        mechanism = _one_line(note.get("contextMechanism"))
        if mechanism:
            lines.append(_new_line(0, f"Mechanism: {mechanism}"))
        _, _, when_line, do_line = format_when_do_lines(
            _one_line(note.get("deltaTrigger")), _one_line(note.get("deltaAction"))
        )
        if when_line:
            lines.append(_new_line(0, when_line))
        if do_line:
            lines.append(_new_line(0, do_line))
        critique = _one_line(note.get("critique"))
        if critique:
            lines.append(_new_line(0, f"Critique: {critique}"))
    return lines


def _format_companion_entry(note: dict[str, Any], book: dict[str, Any]) -> str:
    """Plain-text rendering of one note block (kept for callers of the old helper)."""
    return lines_to_text(render_note_block(note, book))


def render_full_companion_doc(book: dict[str, Any], timeline: list[dict[str, Any]]) -> list[DocLine]:
    """A fresh Doc: header, capstone (if any), then every timeline note, blank-separated."""
    lines = render_doc_header(book)
    for block in [render_capstone_block(book)] + [render_note_block(n, book) for n in timeline]:
        if block:
            lines.append(_new_line(0, ""))
            lines.extend(block)
    return lines


def text_to_doc_lines(text: str) -> list[DocLine]:
    lines: list[DocLine] = []
    if not text:
        return lines
    for raw in text.split("\n"):
        level = 0
        body = raw
        for lvl, prefix in ((3, "### "), (2, "## "), (1, "# ")):
            if raw.startswith(prefix):
                level, body = lvl, raw[len(prefix):]
                break
        lines.append(DocLine(level=level, text=body.rstrip("\r"), raw=raw))
    return lines


def lines_to_text(lines: list[DocLine]) -> str:
    out = []
    for ln in lines:
        if ln.raw is not None:
            out.append(ln.raw)
        else:
            out.append(("#" * ln.level + " " if ln.level else "") + ln.text)
    return "\n".join(out)


def _is_blank(line: DocLine) -> bool:
    return not line.text.strip()


@dataclass
class DocBlock:
    kind: str
    ident: str
    start: int
    end: int  # exclusive
    suffix: str = ""  # user text after the marker in the heading (kept verbatim)


@dataclass
class DocEdit:
    """Replace lines[start:end] with `lines` (start == end -> pure insertion)."""

    start: int
    end: int
    lines: list[DocLine]


@dataclass
class CompanionDocPlan:
    edits: list[DocEdit] = field(default_factory=list)
    added_ids: list[str] = field(default_factory=list)
    updated_ids: list[str] = field(default_factory=list)
    capstone: str = "absent"  # absent | unchanged | added | updated | removed

    @property
    def only_tail_appends(self) -> bool:
        return all(e.start == e.end for e in self.edits)


def _block_field_index(kind: str, level: int, text: str) -> int | None:
    if kind == "note":
        allowed = NOTE_FIELD_ORDER[:SAVED_FIELD_COUNT] if level == 3 else NOTE_FIELD_ORDER
        for idx, prefix in enumerate(allowed):
            if text.startswith(prefix):
                return idx
        return None
    for idx, prefixes in enumerate(CAPSTONE_FIELD_ORDER):
        if text.startswith(prefixes):
            return idx
    return None


def parse_doc_blocks(lines: list[DocLine]) -> list[DocBlock]:
    """A1.4: a block = a HEADING_2/3 carrying a `[note:<id>]` / `[capstone:<id>]` marker plus
    the following normal lines that fit that block kind's grammar (R1#2 / QA-18):

    - note blocks: Quote, Takeaway, Mechanism, WHEN, DO, Critique — each at most once and
      in render order (HEADING_3 saved blocks: Quote, Takeaway only);
    - capstone blocks: Thesis/Arc, Key Learnings:, `• ` lines only after Key Learnings:,
      How My Thinking Shifted:, Written (last).

    Parsing stops at the first line that doesn't fit, so a user line typed directly under a
    block (a second `Takeaway:`, `• aside`, `Written …`) stays prose and is never deleted.
    """
    blocks: list[DocBlock] = []
    i, n = 0, len(lines)
    while i < n:
        ln = lines[i]
        matches = list(DOC_MARKER_RE.finditer(ln.text)) if ln.level in (2, 3) else []
        if not matches:
            i += 1
            continue
        m = matches[-1]
        kind = m.group(1)
        j = i + 1
        last = -1
        while j < n and lines[j].level == 0:
            idx = _block_field_index(kind, ln.level, lines[j].text)
            if idx is None:
                break
            if kind == "capstone" and idx == CAPSTONE_BULLET_INDEX:
                if last not in (CAPSTONE_BULLET_INDEX - 1, CAPSTONE_BULLET_INDEX):
                    break
            elif idx <= last:
                break
            last = idx
            j += 1
        blocks.append(
            DocBlock(kind=kind, ident=m.group(2), start=i, end=j, suffix=ln.text[m.end():].rstrip())
        )
        i = j
    return blocks


def _header_end(lines: list[DocLine], blocks: list[DocBlock]) -> int:
    """Index just after the H1 + its `Author:` (and legacy `Now in:`) lines (R1 nit 7: user
    prose typed directly under the header is not header, so a capstone goes above it)."""
    block_starts = {b.start for b in blocks}
    for idx, ln in enumerate(lines):
        if ln.level == 1:
            j = idx + 1
            while (
                j < len(lines)
                and lines[j].level == 0
                and lines[j].text.startswith(DOC_HEADER_PREFIXES)
                and j not in block_starts
            ):
                j += 1
            return j
    return 0


def plan_companion_doc(
    lines: list[DocLine], book: dict[str, Any], timeline: list[dict[str, Any]]
) -> CompanionDocPlan:
    """A1.4 pure planner (decisions OQ-2 override): only Pragya-managed marker blocks are
    replaced or deleted, new blocks are inserted at computed positions, and every other
    line (header, user prose, unknown / other-book markers) is left untouched.

    - Changed `[note:]` blocks are re-rendered in place (incl. `###` -> `##` upgrades and
      the legacy `Title (p. N) [note:id]` format); unchanged ones produce no edit.
    - New notes are inserted before the next timeline note already in the Doc (so a
      backfilled earlier note lands in reading order and prose anchored after the
      previous block stays with it); with no later neighbour they append at the end.
    - The capstone block sits directly under the H1 header lines; it is replaced when it
      changes and removed when the capstone is cleared.
    - Duplicate markers are never created; extra copies already in the Doc are left alone.
    """
    plan = CompanionDocPlan()
    blocks = parse_doc_blocks(lines)
    first: dict[tuple[str, str], DocBlock] = {}
    for b in blocks:
        first.setdefault((b.kind, b.ident), b)
    n = len(lines)
    inserts: dict[int, list[tuple[int, list[DocLine]]]] = {}

    def existing_keys(b: DocBlock) -> list[tuple[int, str]]:
        return [ln.key() for ln in lines[b.start:b.end]]

    def matches_render(b: DocBlock, rendered: list[DocLine]) -> bool:
        """Unchanged if the block equals the render, or its first lines do and the rest
        are user lines that merely fit the grammar (QA-18: never 'update' those away)."""
        want = [ln.key() for ln in rendered]
        if existing_keys(b) == want:
            return True
        end = b.start + len(want)
        return end < b.end and [ln.key() for ln in lines[b.start:end]] == want

    def narrowed(b: DocBlock, rendered: list[DocLine], note: dict[str, Any] | None = None) -> DocBlock:
        """R1 R2-a / QA-21: a grammar line is managed only if its field is present in the
        fresh render; lines for absent / cleared fields stay as prose (a cleared field's
        old line becomes a stale line — fail-safe, never a deletion of user text).

        A saved (HEADING_3) block only ever had a Pragya `Takeaway:` line when its heading
        was a cut (`…`) derived title or an explicit meta.title; otherwise (heading-only
        block) a `Takeaway:` line under it is the user's, even if the note is now atomic."""
        level = 2 if b.kind == "note" else 0
        allowed = {_block_field_index(b.kind, level, ln.text) for ln in rendered[1:]}
        allowed.discard(None)
        if b.kind == "note" and note is not None and lines[b.start].level == 3:
            head = lines[b.start].text
            marker = list(DOC_MARKER_RE.finditer(head))[-1]
            old_title = head[: marker.start()].rstrip()
            had_takeaway_line = old_title.endswith("…") or bool(_one_line((note.get("meta") or {}).get("title")))
            if not had_takeaway_line:
                allowed.discard(NOTE_FIELD_ORDER.index("Takeaway:"))
        j = b.start + 1
        while j < b.end and _block_field_index(b.kind, level, lines[j].text) in allowed:
            j += 1
        return DocBlock(kind=b.kind, ident=b.ident, start=b.start, end=j, suffix=b.suffix)

    def with_suffix(rendered: list[DocLine], b: DocBlock) -> list[DocLine]:
        if not b.suffix:
            return rendered
        head = rendered[0]
        return [DocLine(level=head.level, text=head.text + " " + b.suffix.lstrip())] + rendered[1:]

    # Capstone
    desired_cap = render_capstone_block(book)
    cap_block = first.get(("capstone", str(book.get("id"))))
    if desired_cap and cap_block:
        desired_cap = with_suffix(desired_cap, cap_block)
        cap_block = narrowed(cap_block, desired_cap)
        if not matches_render(cap_block, desired_cap):
            plan.edits.append(DocEdit(cap_block.start, cap_block.end, desired_cap))
            plan.capstone = "updated"
        else:
            plan.capstone = "unchanged"
    elif desired_cap:
        at = _header_end(lines, blocks)
        if at == 0:
            new = desired_cap + [_new_line(0, "")]
        else:
            new = [_new_line(0, "")] + desired_cap
            if at < n and not _is_blank(lines[at]):
                new.append(_new_line(0, ""))
        inserts.setdefault(at, []).append((0, new))
        plan.capstone = "added"
    elif cap_block:
        start = cap_block.start
        if start > 0 and _is_blank(lines[start - 1]):
            start -= 1
        plan.edits.append(DocEdit(start, cap_block.end, []))
        plan.capstone = "removed"

    # Notes
    present = [first.get(("note", str(note["id"]))) for note in timeline]
    for idx, note in enumerate(timeline):
        rendered = render_note_block(note, book)
        block = present[idx]
        if block is not None:
            rendered = with_suffix(rendered, block)
            block = narrowed(block, rendered, note)
            if not matches_render(block, rendered):
                plan.edits.append(DocEdit(block.start, block.end, rendered))
                plan.updated_ids.append(note["id"])
            continue
        successor = next((present[k] for k in range(idx + 1, len(timeline)) if present[k] is not None), None)
        if successor is not None:
            inserts.setdefault(successor.start, []).append((1, rendered + [_new_line(0, "")]))
        else:
            inserts.setdefault(n, []).append((1, [_new_line(0, "")] + rendered))
        plan.added_ids.append(note["id"])

    for at, chunks in inserts.items():
        chunks.sort(key=lambda c: c[0])  # capstone first; notes keep timeline order (stable)
        new_lines: list[DocLine] = []
        for _prio, chunk in chunks:
            new_lines.extend(chunk)
        if at == n and n > 0 and new_lines and _is_blank(new_lines[0]) and _is_blank(lines[-1]):
            new_lines = new_lines[1:]
        plan.edits.append(DocEdit(at, at, new_lines))
    return plan


def _sorted_edits(edits: list[DocEdit]) -> list[DocEdit]:
    # Bottom-up so earlier indexes stay valid; at one position, replace before insert.
    return sorted(edits, key=lambda e: (e.start, 1 if e.end > e.start else 0), reverse=True)


def apply_doc_plan(lines: list[DocLine], plan: CompanionDocPlan) -> list[DocLine]:
    out = list(lines)
    for e in _sorted_edits(plan.edits):
        out[e.start:e.end] = e.lines
    return out


def plan_companion_text(
    existing_text: str, book: dict[str, Any], timeline: list[dict[str, Any]]
) -> tuple[str, list[str], list[str]]:
    """Pure text form of the planner: (full_text, added_ids, updated_ids)."""
    lines = text_to_doc_lines(existing_text)
    if not any(ln.text.strip() for ln in lines):
        full = render_full_companion_doc(book, timeline)
        return lines_to_text(full) + "\n", [n["id"] for n in timeline], []
    plan = plan_companion_doc(lines, book, timeline)
    return lines_to_text(apply_doc_plan(lines, plan)), plan.added_ids, plan.updated_ids


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


_NAMED_STYLE = {0: "NORMAL_TEXT", 1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3"}


# R1#4: inserted Pragya text must not inherit the anchor's character style / list bullets.
RESET_TEXT_STYLE_FIELDS = (
    "bold,italic,underline,strikethrough,smallCaps,link,foregroundColor,backgroundColor,"
    "baselineOffset,fontSize,weightedFontFamily"
)


def _style_requests(start: int, new_lines: list[DocLine]) -> list[dict[str, Any]]:
    total = sum(_utf16_len(ln.text) + 1 for ln in new_lines)
    reqs: list[dict[str, Any]] = []
    if total:
        rng = {"startIndex": start, "endIndex": start + total}
        reqs.append({"updateTextStyle": {"range": dict(rng), "textStyle": {}, "fields": RESET_TEXT_STYLE_FIELDS}})
        reqs.append({"deleteParagraphBullets": {"range": dict(rng)}})
    offset = start
    for ln in new_lines:
        length = _utf16_len(ln.text) + 1
        reqs.append(
            {
                "updateParagraphStyle": {
                    "range": {"startIndex": offset, "endIndex": offset + length},
                    "paragraphStyle": {"namedStyleType": _NAMED_STYLE.get(ln.level, "NORMAL_TEXT")},
                    "fields": "namedStyleType",
                }
            }
        )
        offset += length
    return reqs


def doc_plan_to_requests(lines: list[DocLine], plan: CompanionDocPlan) -> list[dict[str, Any]]:
    """Docs API batchUpdate requests touching ONLY the planned block ranges (OQ-2).

    Edits are emitted bottom-up, so every request's indexes are valid when it runs.
    Paragraph indexes are the Docs API's UTF-16 offsets from documents.get.
    """
    reqs: list[dict[str, Any]] = []
    n = len(lines)
    for e in _sorted_edits(plan.edits):
        texts = [ln.text for ln in e.lines]
        if e.end > e.start and e.lines:
            start = lines[e.start].start
            keep_end = lines[e.end - 1].end - 1  # keep the block's final newline
            if keep_end > start:
                reqs.append({"deleteContentRange": {"range": {"startIndex": start, "endIndex": keep_end}}})
            reqs.append({"insertText": {"location": {"index": start}, "text": "\n".join(texts)}})
            reqs.extend(_style_requests(start, e.lines))
        elif e.end > e.start:
            if e.end < n:
                rng = (lines[e.start].start, lines[e.end].start)
            elif e.start > 0:
                rng = (lines[e.start - 1].end - 1, lines[e.end - 1].end - 1)
            else:
                rng = (lines[e.start].start, lines[e.end - 1].end - 1)
            if rng[1] > rng[0]:
                reqs.append({"deleteContentRange": {"range": {"startIndex": rng[0], "endIndex": rng[1]}}})
        elif e.start < n:
            at = lines[e.start].start
            reqs.append({"insertText": {"location": {"index": at}, "text": "\n".join(texts) + "\n"}})
            reqs.extend(_style_requests(at, e.lines))
        else:
            at = lines[n - 1].end - 1
            reqs.append({"insertText": {"location": {"index": at}, "text": "\n" + "\n".join(texts)}})
            reqs.extend(_style_requests(at + 1, e.lines))
    return reqs


def _gdoc_paragraph_level(para: dict[str, Any]) -> int:
    style = (para.get("paragraphStyle") or {}).get("namedStyleType")
    return {"HEADING_1": 1, "TITLE": 1, "HEADING_2": 2, "HEADING_3": 3}.get(style, 0)


def parse_gdoc_lines(doc: Any) -> list[DocLine] | None:
    """Docs API documents.get JSON -> indexed DocLines, or None when the structure can't be
    parsed safely (unknown wrapper, multiple / nested tabs, missing indexes). Tables, TOCs
    and other non-paragraph elements become opaque lines that are never edited."""
    if not isinstance(doc, dict) or not doc.get("documentId"):
        return None
    if any(key not in _GDOCS_DOCUMENT_KEYS for key in doc):
        return None
    body = doc.get("body")
    tabs = doc.get("tabs")
    if tabs is not None:
        if not isinstance(tabs, list) or len(tabs) != 1 or not isinstance(tabs[0], dict):
            return None
        if tabs[0].get("childTabs"):
            return None
        tab_body = (tabs[0].get("documentTab") or {}).get("body")
        if body is not None and body != tab_body:
            return None
        body = tab_body
    if not isinstance(body, dict) or not isinstance(body.get("content"), list):
        return None
    lines: list[DocLine] = []
    for elem in body["content"]:
        if not isinstance(elem, dict):
            return None
        if "sectionBreak" in elem:
            continue
        start, end = elem.get("startIndex"), elem.get("endIndex")
        if not isinstance(start, int) or not isinstance(end, int) or end <= start:
            return None
        para = elem.get("paragraph")
        if isinstance(para, dict):
            parts: list[str] = []
            for p_elem in para.get("elements") or []:
                tr = p_elem.get("textRun") if isinstance(p_elem, dict) else None
                if isinstance(tr, dict) and isinstance(tr.get("content"), str):
                    parts.append(tr["content"])
                else:
                    parts.append("\ufffc")  # inline object / chip: opaque, never a field line
            text = "".join(parts)
            if text.endswith("\n"):
                text = text[:-1]
            lines.append(DocLine(level=_gdoc_paragraph_level(para), text=text, start=start, end=end))
        else:
            lines.append(DocLine(level=0, text="\ufffc", start=start, end=end))
    if lines and lines[0].start is not None and any(
        lines[i].start != lines[i - 1].end for i in range(1, len(lines))
    ):
        return None  # non-contiguous indexes: not a structure we can safely edit
    return lines


def _yaml_str(val: Any) -> str:
    text = "" if val is None else str(val)
    escaped = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    return f'"{escaped}"'


BOOK_INDEX_SLUG_MAX = 80  # QA-20: keeps `<slug>[-<id>][-N].md` well under ~120 bytes
BOOK_INDEX_ID_SUFFIX_MAX = 24


def assign_book_index_slugs(books: list[dict[str, Any]]) -> dict[str, str]:
    """QA-19 / QA-20: unique, length-capped `books/<slug>.md` names that don't depend on the
    order of `books`. Within a title collision the smallest id keeps the plain slug; the
    others get the shortest unique `-<id-slug>` prefix (8 chars and up), then `-2`, `-3`…"""
    def base_of(book: dict[str, Any]) -> str:
        base = slugify(str(book.get("title") or ""))[:BOOK_INDEX_SLUG_MAX].strip("-")
        return base or "book"

    ordered = sorted(books, key=lambda b: (base_of(b), str(b.get("id") or "")))
    taken: set[str] = set()
    out: dict[str, str] = {}
    bases = [base_of(b) for b in ordered]
    for book, base in zip(ordered, bases):
        book_id = str(book.get("id") or "")
        candidate = base
        if candidate in taken:
            id_slug = slugify(book_id)[:BOOK_INDEX_ID_SUFFIX_MAX]
            candidate = ""
            for length in range(min(8, len(id_slug)), len(id_slug) + 1):
                trial = f"{base}-{id_slug[:length].strip('-')}"
                if trial not in taken:
                    candidate = trial
                    break
            counter = 2
            while not candidate or candidate in taken:
                candidate = f"{base}-{id_slug[:8].strip('-') or 'book'}-{counter}"
                counter += 1
        taken.add(candidate)
        out[book_id] = candidate
    return out


def render_book_index_md(book: dict[str, Any], timeline: list[dict[str, Any]]) -> str:
    """A1.5 / ux_spec E.2: per-book Markdown index (front-matter, capstone, both tiers)."""
    meta = book.get("meta") or {}
    lines = [
        "---",
        f"title: {_yaml_str(book.get('title'))}",
        f"author: {_yaml_str(book.get('author'))}",
        f"kind: {book.get('kind') or 'nonfiction'}",
        f"status: {book.get('status') or 'reading'}",
    ]
    chapter = format_chapter_label(meta.get("currentChapter"))
    if chapter:
        lines.append(f"currentChapter: {_yaml_str(chapter)}")
    lines.extend([f"pragya_book_id: {_yaml_str(book.get('id'))}", "---", "", f"# {_one_line(book.get('title'))}"])
    byline = [_one_line(book.get("author")) or "Unknown Author", _kind_label(book)]
    if book.get("status") == "finished":
        finished = _iso_date(meta.get("finishedAt"))
        byline.append(f"Finished {finished}" if finished else "Finished")
    lines.append(f"*{' · '.join(byline)}*")

    if has_book_capstone(meta):
        cap = get_book_capstone(meta) or {}
        lines.extend(["", "## Whole-Book Picture", f"<!-- capstone:{book['id']} -->"])
        arc = _one_line(cap.get("arcOrThesis"))
        if arc:
            lines.append(f"**{'Arc' if book.get('kind') == 'fiction' else 'Thesis'}:** {arc}")
        learnings = [x for x in (_one_line(i) for i in cap.get("keyLearnings") or []) if x]
        if learnings:
            lines.extend(["", "**Key Learnings**"])
            lines.extend(f"- {item}" for item in learnings)
        shift = _one_line(cap.get("perspectiveShift"))
        if shift:
            lines.extend(["", f"**How My Thinking Shifted:** {shift}"])
        written = _iso_date(cap.get("completedAt"))
        if written:
            lines.extend(["", f"*Written {written}*"])

    for note in timeline:
        atomic = note.get("status") == "atomic"
        badge = _note_badge(note, book)
        if atomic:
            lines.extend(["", f"## {badge} [[{note.get('slug')}]]"])
        else:
            lines.extend(["", f"### {badge} {_saved_note_title(note)}"])
        lines.append(f"<!-- note:{note['id']} -->")
        quote = (note.get("quote") or "").strip()
        if quote:
            lines.extend(f"> {q}".rstrip() for q in quote.splitlines())
        body: list[str] = []
        takeaway = _one_line(note.get("takeaway"))
        if takeaway and (atomic or not _saved_title_info(note)[1]):
            body.append(f"**Takeaway:** {takeaway}")
        if atomic:
            trig, act, _, _ = format_when_do_lines(
                _one_line(note.get("deltaTrigger")), _one_line(note.get("deltaAction"))
            )
            delta_parts = []
            if trig:
                delta_parts.append(f"**WHEN** {trig}")
            if act:
                delta_parts.append(f"**DO** {act}")
            if delta_parts:
                body.append(" → ".join(delta_parts))
        if body:
            if quote:
                lines.append("")
            # Markdown hard line break ("two trailing spaces") between Takeaway and Delta.
            lines.extend(line + ("  " if i < len(body) - 1 else "") for i, line in enumerate(body))
    return "\n".join(lines).rstrip() + "\n"


DOC_FALLBACK_WARNING = (
    "The Companion Doc's structure could not be parsed safely, so only new notes were "
    "appended at the end; existing entries and the capstone were not updated in place."
)
DOC_INPLACE_FAILED_WARNING = (
    "In-place Doc update is unavailable (gdocs mutate raw-batch failed); only new notes "
    "were appended at the end. Existing entries were left as they were."
)


def _append_only_payload(
    existing_text: str, book: dict[str, Any], timeline: list[dict[str, Any]]
) -> tuple[str, list[str]]:
    """Legacy-safe path: append blocks whose marker is missing (header once if empty)."""
    missing = [n for n in timeline if f"[note:{n['id']}]" not in existing_text]
    if not existing_text.strip():
        return lines_to_text(render_full_companion_doc(book, timeline)) + "\n", [n["id"] for n in timeline]
    if not missing:
        return "", []
    entries = "\n\n".join(lines_to_text(render_note_block(n, book)) for n in missing)
    return "\n\n" + entries + "\n", [n["id"] for n in missing]


DOC_NO_REVISION_WARNING = (
    "The Companion Doc read did not include a revisionId, so in-place edits could not be "
    "guarded against concurrent typing; only new notes were appended at the end."
)


@dataclass
class SyncOutcome:
    """Result of syncing into an existing Doc (R2#2)."""

    mode: str = "unchanged"
    added: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    capstone: str = "absent"
    mirror_text: str | None = None
    warnings: list[str] = field(default_factory=list)


def _fallback_append(
    backend: WorkspaceBackend,
    doc_id: str,
    book: dict[str, Any],
    timeline: list[dict[str, Any]],
    warning: str,
    planned_capstone: str | None = None,
) -> SyncOutcome:
    """Append-only by marker from a FRESH read of the Doc (R1#3), plus a warning."""
    existing_text = backend.read_doc_text(doc_id)
    payload, added = _append_only_payload(existing_text, book, timeline)
    out = SyncOutcome(mode="append-fallback", added=added, warnings=[warning])
    if payload:
        backend.append_doc_text(doc_id, payload)
        out.mirror_text = (existing_text.rstrip() + payload) if existing_text.strip() else payload
    if render_capstone_block(book):
        present = f"[capstone:{book['id']}]" in existing_text
        needs_edit = planned_capstone in ("added", "updated", "removed") or not present
        out.capstone = "skipped" if needs_edit else "unchanged"
    return out


def _sync_existing_doc(
    backend: WorkspaceBackend,
    doc_id: str,
    book: dict[str, Any],
    timeline: list[dict[str, Any]],
    doc_out_path: Path | None,
) -> SyncOutcome:
    """A1.4 sync into an existing Doc. Google: documents.get snapshot -> pure plan -> one
    revision-guarded raw-batch (re-read + re-plan once on rejection, else append-only from a
    fresh read). Text (doc-out / state file): plan applied to the mirror file."""
    if isinstance(backend, GoogleWorkspaceBackend):
        snap = backend.read_doc_snapshot(doc_id)
        if snap is None:
            return _fallback_append(backend, doc_id, book, timeline, DOC_FALLBACK_WARNING)
        lines, docs_mode = snap.lines, True
    elif doc_out_path is not None and doc_out_path.exists():
        snap, docs_mode = None, False
        lines = text_to_doc_lines(doc_out_path.read_text(encoding="utf-8"))
    else:
        snap, docs_mode, lines = None, False, []

    if not any(ln.text.strip() for ln in lines):
        # B4.5: an existing but empty Doc gets the header once, then the timeline.
        full = lines_to_text(render_full_companion_doc(book, timeline)) + "\n"
        backend.append_doc_text(doc_id, full)
        has_content = bool(timeline) or bool(render_capstone_block(book))
        return SyncOutcome(
            mode="append" if has_content else "unchanged",
            added=[n["id"] for n in timeline],
            capstone="added" if render_capstone_block(book) else "absent",
            mirror_text=full,
        )

    plan = plan_companion_doc(lines, book, timeline)
    out = SyncOutcome(capstone=plan.capstone)
    if not plan.edits:
        if doc_out_path is not None and not doc_out_path.exists():
            out.mirror_text = lines_to_text(lines)
        return out

    if not docs_mode:
        out.mode, out.added, out.updated = "in-place", plan.added_ids, plan.updated_ids
        out.mirror_text = lines_to_text(apply_doc_plan(lines, plan))
        return out

    if all(e.start == e.end == len(lines) for e in plan.edits):
        tail = "\n".join(lines_to_text(e.lines) for e in plan.edits)
        backend.append_doc_text(doc_id, tail + "\n")
        out.mode, out.added, out.updated = "append", plan.added_ids, plan.updated_ids
        out.mirror_text = lines_to_text(apply_doc_plan(lines, plan))
        return out

    assert snap is not None
    if not snap.revision_id:
        return _fallback_append(backend, doc_id, book, timeline, DOC_NO_REVISION_WARNING, plan.capstone)

    applied_plan = plan
    for attempt in range(2):
        try:
            backend.batch_update_doc(doc_id, doc_plan_to_requests(lines, plan), snap.revision_id)
            out.mode, out.added, out.updated = "in-place", plan.added_ids, plan.updated_ids
            out.capstone = plan.capstone
            out.mirror_text = lines_to_text(apply_doc_plan(lines, plan))
            return out
        except CliError:
            fresh = backend.read_doc_snapshot(doc_id)
            if fresh is None:
                break
            replan = plan_companion_doc(fresh.lines, book, timeline)
            if not replan.edits:
                # The batch landed after all (late success) or the Doc already matches.
                out.mode, out.added, out.updated = "in-place", applied_plan.added_ids, applied_plan.updated_ids
                out.mirror_text = lines_to_text(fresh.lines)
                return out
            if attempt == 0 and fresh.revision_id and fresh.revision_id != snap.revision_id:
                # Rejected because the Doc changed: re-plan once against the fresh read.
                snap, lines, plan = fresh, fresh.lines, replan
                applied_plan = replan
                continue
            break
    return _fallback_append(backend, doc_id, book, timeline, DOC_INPLACE_FAILED_WARNING, plan.capstone)


def cmd_book_doc_sync(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    """A1.1-A1.4: two-tier timeline sync with true in-place block replacement (OQ-2).

    `mode` is one of DOC_SYNC_MODES:
    - created: a new Doc was created with the full timeline.
    - in-place: planned block replacements/insertions (doc-out text, or one
      revision-guarded Docs batchUpdate).
    - append: only tail additions / an empty existing Doc (sent through the append ops).
    - append-fallback: structure unsafe, no revisionId, or the in-place write failed ->
      append-only by marker from a fresh read + a warning.
    - unchanged: nothing to write.
    `capstone` is one of CAPSTONE_SYNC_STATES.
    """
    ws = backend.load_workspace()
    book = resolve_book(ws["books"], args.book)
    timeline, shielded_count = select_book_timeline_with_shield(
        ws["notes"],
        book,
        bool(getattr(args, "include_drafts", False)),
        bool(getattr(args, "include_spoilers", False)),
    )

    existing_doc_url = (book.get("docUrl") or "").strip()
    doc_id = parse_doc_id(existing_doc_url)
    doc_out_path = Path(args.doc_out) if getattr(args, "doc_out", None) else None
    created_doc = False

    if not doc_id:
        doc_id, new_url = backend.create_companion_doc(f"Pragya · {book['title']}", "", book_id=book["id"])
        created_doc = True
        updated_book = json.loads(json.dumps(book))
        updated_book["docUrl"] = new_url
        updated_book.setdefault("meta", {})["updatedAt"] = now_iso_utc()
        backend.save_book(
            updated_book,
            expected_base_updated_at=(book.get("meta") or {}).get("updatedAt"),
            force=bool(getattr(args, "force", False)),
        )
        full = lines_to_text(render_full_companion_doc(book, timeline)) + "\n"
        backend.append_doc_text(doc_id, full)
        outcome = SyncOutcome(
            mode="created",
            added=[n["id"] for n in timeline],
            capstone="added" if render_capstone_block(book) else "absent",
            mirror_text=full,
        )
        final_doc_url = new_url
    else:
        final_doc_url = existing_doc_url
        outcome = _sync_existing_doc(backend, doc_id, book, timeline, doc_out_path)

    if doc_out_path is not None:
        text = outcome.mirror_text
        if text is None and not doc_out_path.exists():
            text = lines_to_text(render_doc_header(book))
        if text is not None:
            doc_out_path.parent.mkdir(parents=True, exist_ok=True)
            doc_out_path.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")

    synced = outcome.added + [i for i in outcome.updated if i not in outcome.added]
    return {
        "bookId": book["id"],
        "docId": doc_id,
        "docUrl": final_doc_url,
        "createdDoc": created_doc,
        "mode": outcome.mode,
        "syncedNoteCount": len(synced),
        "syncedNoteIds": synced,
        "addedNoteIds": outcome.added,
        "updatedNoteIds": outcome.updated,
        "capstone": outcome.capstone,
        "shieldedCount": shielded_count,
        "warnings": outcome.warnings,
    }


# ---------------------------------------------------------------------------
# Argument Parser
# ---------------------------------------------------------------------------


class CliUsageError(Exception):
    """argparse usage error, reported through the same JSON error envelope as CliError."""

    def __init__(self, message: str, usage: str) -> None:
        super().__init__(message)
        self.usage = usage


class JsonErrorArgumentParser(argparse.ArgumentParser):
    """R2 nit: missing/invalid flags (e.g. a required --book) yield `{"error": ...}` on stderr
    with exit code 2 instead of argparse's plain-text usage dump."""

    def error(self, message: str) -> None:  # type: ignore[override]
        raise CliUsageError(message, self.format_usage().strip())


def build_parser() -> argparse.ArgumentParser:
    common = JsonErrorArgumentParser(add_help=False)
    common.add_argument(
        "--state-file",
        default=argparse.SUPPRESS,
        help="Path to PragyaSnapshot JSON v1 file (offline/test backend).",
    )
    common.add_argument(
        "--spreadsheet-id",
        default=argparse.SUPPRESS,
        help="Target Google Spreadsheet ID (defaults to discovering 'Pragya Commonplace').",
    )
    common.add_argument(
        "--force",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Bypass pre-write updatedAt row conflict guard on Books/Notes updates.",
    )

    parser = JsonErrorArgumentParser(
        prog="pragya_cli.py",
        description="Pragya Companion CLI for Google Workspace and JSON snapshot workflows.",
        parents=[common],
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # 0a. book-list
    p_blist = sub.add_parser("book-list", parents=[common], help="List books and active delta count.")
    p_blist.add_argument("--status", default=None, choices=["reading", "queued", "finished", "paused"], help="Filter by shelf status.")
    p_blist.add_argument("--kind", default=None, choices=["nonfiction", "fiction"], help="Filter by book kind.")
    p_blist.add_argument("--query", default="", help="Case-insensitive title/author/ID filter.")
    p_blist.add_argument("--include-archived", action="store_true", help="Include soft-archived books (meta.archivedAt).")

    # 0b. book-add
    p_badd = sub.add_parser("book-add", parents=[common], help="Add a book to the shelf.")
    p_badd.add_argument("--title", required=True, help="Book title.")
    p_badd.add_argument("--author", default="Unknown Author", help="Book author (defaults to 'Unknown Author').")
    p_badd.add_argument("--format", default="physical", choices=["physical", "kindle"], help="Reading format.")
    p_badd.add_argument("--kind", default="nonfiction", choices=["nonfiction", "fiction"], help="Book genre kind.")
    p_badd.add_argument("--status", default="reading", choices=["reading", "queued", "finished", "paused"], help="Shelf status.")
    p_badd.add_argument("--pos", "--current-pos", dest="pos", type=float, default=None, help="Starting position.")
    p_badd.add_argument("--total-pos", "--total", dest="total_pos", type=float, default=None, help="Total book length in units (100 default for percent).")
    p_badd.add_argument("--pos-unit", "--unit", dest="pos_unit", default="page", choices=["page", "percent", "loc"], help="Position unit.")
    p_badd.add_argument("--doc-url", default="", help="Optional companion Google Doc URL.")
    p_badd.add_argument("--cover-url", default="", help="Optional cover image URL.")
    p_badd.add_argument("--allow-duplicate", action="store_true", help="Allow adding a book with an existing title.")

    # 0c. book-update
    p_bupd = sub.add_parser("book-update", parents=[common], help="Update metadata, status, or position on a book.")
    p_bupd.add_argument("--book", required=True, help="Book UUID or title.")
    p_bupd.add_argument("--title", default=None, help="Updated book title.")
    p_bupd.add_argument("--author", default=None, help="Updated author.")
    p_bupd.add_argument("--format", default=None, choices=["physical", "kindle"], help="Updated format.")
    p_bupd.add_argument("--kind", default=None, choices=["nonfiction", "fiction"], help="Updated kind.")
    p_bupd.add_argument("--status", default=None, choices=["reading", "queued", "finished", "paused"], help="Updated status.")
    p_bupd.add_argument("--pos", "--current-pos", dest="pos", type=float, default=None, help="Updated currentPos.")
    p_bupd.add_argument("--total-pos", "--total", dest="total_pos", type=float, default=None, help="Updated totalPos.")
    p_bupd.add_argument("--pos-unit", "--unit", dest="pos_unit", default=None, choices=["page", "percent", "loc"], help="Updated posUnit.")
    p_bupd.add_argument("--doc-url", default=None, help="Updated companion Google Doc URL.")
    p_bupd.add_argument("--cover-url", default=None, help="Updated cover image URL.")
    p_bupd.add_argument("--force-pos", action="store_true", help="Allow lowering currentPos below current bookmark.")
    p_bupd.add_argument("--chapter", default=None, help="Set meta.currentChapter (empty string clears).")
    g_barch = p_bupd.add_mutually_exclusive_group()
    g_barch.add_argument("--archive", action="store_true", help="Soft-archive the book (sets meta.archivedAt).")
    g_barch.add_argument("--unarchive", action="store_true", help="Restore a soft-archived book.")

    # 0c2. book-capstone
    p_bcap = sub.add_parser("book-capstone", parents=[common], help="Write the end-of-book capstone (arc, learnings, shift).")
    p_bcap.add_argument("--book", required=True, help="Book UUID or title.")
    p_bcap.add_argument("--arc", "--thesis", dest="arc", required=True, help="Arc (fiction) or thesis (non-fiction) of the whole book, in your words.")
    p_bcap.add_argument("--learnings", "--learning", dest="learnings", action="append", default=[], help="A key learning (repeat 1-7 times).")
    p_bcap.add_argument("--shift", required=True, help="How your perspective shifted.")
    p_bcap.add_argument("--completed-at", default=None, help="Override completedAt (ISO-8601).")
    p_bcap.add_argument("--allow-unfinished", action="store_true", help="Allow a capstone on a book that is not finished.")

    # 0d. progress
    p_prog = sub.add_parser("progress", parents=[common], help="Advance reading bookmark and log a coalesced session.")
    p_prog.add_argument("--book", required=True, help="Book UUID or title.")
    p_prog_grp = p_prog.add_mutually_exclusive_group()
    p_prog_grp.add_argument("--pos", type=float, default=None, help="New bookmark position in book units.")
    p_prog_grp.add_argument("--delta", type=float, default=None, help="Increment/decrement relative to currentPos.")
    p_prog.add_argument("--finish", action="store_true", help="Mark the book as finished (normalizedPos=1.0).")
    p_prog.add_argument("--session-note", default="", help="Optional short session note.")
    p_prog.add_argument("--force-pos", action="store_true", help="Allow moving bookmark backward.")
    p_prog.add_argument("--chapter", default=None, help="Set meta.currentChapter (saves even if the position is unchanged; empty clears).")

    # 1. capture
    p_cap = sub.add_parser("capture", parents=[common], help="Capture a note and optionally advance bookmark.")
    p_cap.add_argument("--book", required=True, help="Book UUID or title.")
    p_cap.add_argument("--pos", default=None, type=float, help="Optional position in book units (defaults to book currentPos).")
    p_cap.add_argument("--quote", default="", help="Verbatim quote.")
    p_cap.add_argument("--takeaway", default="", help="User's own takeaway / why it mattered.")
    p_cap.add_argument("--title", default="", help="Optional concept title.")
    p_cap.add_argument("--slug", default=None, help="Optional custom concept slug.")
    p_cap.add_argument("--tags", default="", help="Comma-separated #tags.")
    p_cap.add_argument("--spar", action="store_true", help="Flag note for Socratic sparring (inbox).")
    p_cap.add_argument("--atomic", action="store_true", help="Capture directly as an atomic note (conversation-first deepening).")
    p_cap.add_argument("--context", "--context-mechanism", dest="context", default="", help="Layer 2 context & mechanism.")
    p_cap.add_argument("--critique", default="", help="Layer 2 Socratic critique & boundary conditions.")
    p_cap.add_argument("--trigger", "--delta-trigger", dest="trigger", default="", help="Behavioral Delta WHEN trigger.")
    p_cap.add_argument("--action", "--delta-action", dest="action", default="", help="Behavioral Delta DO action.")
    p_cap.add_argument("--delta-status", default="none", choices=["none", "active", "paused", "graduated"], help="Behavioral Delta status (requires --atomic if not 'none').")
    p_cap.add_argument("--prediction", action="store_true", help="Mark as fiction prediction.")
    p_cap.add_argument("--image", action="append", default=[], help="Local image path (max 3 attachments).")
    p_cap.add_argument("--doc-url", action="append", default=[], help="Google Doc URL to attach.")
    p_cap.add_argument("--link", action="append", default=[], help="External URL to attach.")
    p_cap.add_argument("--force-pos", action="store_true", help="Override monotonic bookmark ceiling.")
    p_cap.add_argument("--chapter", default=None, help="Note chapter (default: inherit the book's current chapter at the bookmark; empty = none).")

    # 1b. note-update
    p_nupd = sub.add_parser("note-update", parents=[common], help="Edit note fields or move inbox -> saved.")
    p_nupd.add_argument("--note", required=True, help="Note UUID or slug.")
    p_nupd.add_argument("--status", default=None, choices=["saved", "inbox", "in-reflection", "atomic"], help="New note status (e.g. saved = 'just save it').")
    p_nupd.add_argument("--title", default=None, help="Concept title (empty clears).")
    p_nupd.add_argument("--quote", default=None, help="Verbatim quote.")
    p_nupd.add_argument("--takeaway", default=None, help="Takeaway in your words.")
    p_nupd.add_argument("--context", "--context-mechanism", dest="context", default=None, help="Context & mechanism.")
    p_nupd.add_argument("--critique", default=None, help="Critique & boundary conditions.")
    p_nupd.add_argument("--trigger", "--delta-trigger", dest="trigger", default=None, help="WHEN trigger.")
    p_nupd.add_argument("--action", "--delta-action", dest="action", default=None, help="DO action.")
    p_nupd.add_argument("--delta-status", default=None, choices=["none", "active", "paused", "graduated"], help="Behavioral Delta status.")
    p_nupd.add_argument("--chapter", default=None, help="Note chapter (empty clears).")
    p_nupd.add_argument("--tags", default=None, help="Comma-separated #tags (replaces the list; empty clears).")
    g_narch = p_nupd.add_mutually_exclusive_group()
    g_narch.add_argument("--archive", action="store_true", help="Soft-archive the note (an active delta is paused).")
    g_narch.add_argument("--unarchive", action="store_true", help="Restore a soft-archived note (reactivates a delta archiving paused, if under the cap).")

    # 2. reflect
    p_ref = sub.add_parser("reflect", parents=[common], help="4-stage Socratic reflection.")
    p_ref.add_argument("--note", required=True, help="Note UUID or slug.")
    p_ref.add_argument("--stage", required=True, choices=["1", "commit"], help="Reflection stage.")
    p_ref.add_argument("--q1", default=None, help="Optional custom first Socratic question for --stage 1.")
    p_ref.add_argument("--q2", default=None, help="Optional custom second Socratic question for --stage 1.")
    p_ref.add_argument("--title", default=None, help="Updated concept title.")
    p_ref.add_argument("--slug", default=None, help="Updated wikilink slug.")
    p_ref.add_argument("--takeaway", default=None, help="Distilled takeaway in user's own words.")
    p_ref.add_argument("--context", "--context-mechanism", dest="context", default=None, help="Context & mechanism.")
    p_ref.add_argument("--critique", default=None, help="Socratic critique & boundary conditions.")
    p_ref.add_argument("--trigger", "--delta-trigger", dest="trigger", default=None, help="WHEN trigger condition.")
    p_ref.add_argument("--action", "--delta-action", dest="action", default=None, help="DO action.")
    p_ref.add_argument("--delta-status", default=None, choices=["none", "active", "paused", "graduated"])
    p_ref.add_argument("--chapter", default=None, help="Set the note chapter on --stage commit (empty clears).")

    # 3. recall
    p_rec = sub.add_parser("recall", parents=[common], help="Spoiler-safe Q&A, check-in, and shuffle.")
    p_rec.add_argument("--mode", required=True, choices=["qa", "checkin", "shuffle"], help="Recall mode.")
    p_rec.add_argument("--query", default="", help="Search query for qa mode.")
    p_rec.add_argument("--book", default="", help="Optional book filter for qa mode.")
    p_rec.add_argument("--note", default="", help="Note UUID or slug for checkin mode.")
    p_rec.add_argument("--outcome", default="", choices=["", "applied", "missed", "no-trigger"], help="Check-in outcome.")
    p_rec.add_argument("--reflection", default="", help="Optional reflection note.")
    p_rec.add_argument("--trigger", default=None, help="Updated WHEN trigger on missed check-in.")
    p_rec.add_argument("--date", default="", help="Override YYYY-MM-DD date for shuffle mode.")
    p_rec.add_argument("--limit", type=int, default=3, help="Max shuffle candidates.")
    p_rec.add_argument("--mark-reviewed", default="", help="Mark note reviewed for today in shuffle mode.")

    # 4. ocr-backfill
    p_ocr = sub.add_parser("ocr-backfill", parents=[common], help="Lazy OCR quote backfill for image notes.")
    p_ocr.add_argument("--note", default="", help="Optional note UUID or slug filter.")
    p_ocr.add_argument("--ocr-text", default="", help="Direct OCR text to apply (requires --note).")
    p_ocr.add_argument("--ocr-map-json", default="", help="JSON mapping note/attachment keys to OCR text.")
    p_ocr.add_argument("--ocr-cmd", default="", help="External OCR command template with {path}.")

    # 5. export-md
    p_exp = sub.add_parser("export-md", parents=[common], help="Idempotent 1-way Markdown export.")
    p_exp.add_argument("--output-dir", default="./reading-notes", help="Target directory for .md files.")
    p_exp.add_argument("--include-drafts", action="store_true", help="Also list inbox / in-reflection notes in books/<book>.md.")
    p_exp.add_argument("--include-spoilers", action="store_true", help="Also list notes ahead of the bookmark / sealed predictions in books/<book>.md.")

    # 6. book-doc-sync
    p_doc = sub.add_parser("book-doc-sync", parents=[common], help="Sync the book's notes timeline (atomic + saved) and capstone into its Companion Doc, in place; never touches your own text.")
    p_doc.add_argument("--book", required=True, help="Book UUID or title.")
    p_doc.add_argument("--doc-out", default="", help="Optional local text output mirror for offline testing.")
    p_doc.add_argument("--include-drafts", action="store_true", help="Also sync inbox / in-reflection notes (as saved-tier entries).")
    p_doc.add_argument("--include-spoilers", action="store_true", help="Also sync notes ahead of the bookmark / sealed predictions of an unfinished book.")

    return parser


def main(argv: list[str] | None = None, runner: Callable[[list[str]], tuple[int, str, str]] = default_cmd_runner) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except CliUsageError as exc:
        sys.stderr.write(json.dumps({"error": str(exc), "usage": exc.usage}) + "\n")
        return 2

    state_file = getattr(args, "state_file", None)
    spreadsheet_id = getattr(args, "spreadsheet_id", None)
    backend: WorkspaceBackend = (
        StateFileBackend(Path(state_file))
        if state_file
        else GoogleWorkspaceBackend(spreadsheet_id=spreadsheet_id, runner=runner)
    )

    handlers = {
        "book-list": cmd_book_list,
        "book-add": cmd_book_add,
        "book-update": cmd_book_update,
        "book-capstone": cmd_book_capstone,
        "note-update": cmd_note_update,
        "progress": cmd_progress,
        "capture": cmd_capture,
        "reflect": cmd_reflect,
        "recall": cmd_recall,
        "ocr-backfill": cmd_ocr_backfill,
        "export-md": cmd_export_md,
        "book-doc-sync": cmd_book_doc_sync,
    }

    try:
        result = handlers[args.command](args, backend)
    except CliError as exc:
        sys.stderr.write(json.dumps({"error": str(exc)}) + "\n")
        return 1

    sys.stdout.write(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
