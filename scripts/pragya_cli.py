#!/usr/bin/env python3
"""Pragya Companion CLI — dual-backend Google Workspace & snapshot JSON tool.

Supports:
  - book-list
  - book-add
  - book-update
  - progress
  - capture
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
#     rateLimitExceeded, userRateLimitExceeded, quotaExceeded, "quota exceeded",
#     "Resource has been exhausted", "User rate limit exceeded".
#  2. A bare 429 only in an HTTP/status context: preceded (within 3 non-word chars) by
#     HTTP[/x.y], HttpError (googleapiclient "<HttpError 429 when requesting …>"),
#     status[ code], code or error, and not followed by another digit.
#     So "HTTP 429", "status=429", '"code": 429', "Error 429" match, while ids/ranges
#     such as "sheet-4291", "Notes!A1429", "1a429bc", "line 429" do not.
#  3. A line that starts with the status code itself ("429", "429 Too Many…", "429: …").
# Case-insensitive + multiline. JS equivalent: new RegExp(RATE_LIMIT_PATTERN, "im").
RATE_LIMIT_PATTERN = (
    r"RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|Too Many Requests|rateLimitExceeded"
    r"|userRateLimitExceeded|quotaExceeded|quota exceeded"
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


def is_note_spoiler(note: dict[str, Any], book: dict[str, Any] | None) -> bool:
    if not book or book.get("status") == "finished":
        return False
    total_pos = _safe_float(book.get("totalPos"), 0.0)
    if total_pos > 0 or book.get("posUnit") == "percent":
        return effective_note_norm(note, book) > _safe_float(book.get("normalizedPos"), 0.0)
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
    return DO_PREFIX_RE.sub("", trimmed).strip()


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


def calendar_days_between(from_iso: str, to_date_str: str) -> int:
    start = parse_date_only_utc(from_iso)
    end = parse_date_only_utc(to_date_str)
    if start is None or end is None:
        return 0
    return (end - start).days


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
    last_reviewed = (note.get("meta") or {}).get("lastReviewedAt")
    if last_reviewed:
        lr = str(last_reviewed)
        if "T" in lr:
            dt = parse_iso_utc(lr)
            if dt is not None:
                local_lr = dt.astimezone().strftime("%Y-%m-%d")
                if local_lr == today_date or lr[:10] == today_date:
                    return False
            elif lr[:10] == today_date:
                return False
        elif lr[:10] == today_date:
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
    eligible.sort(key=lambda n: (fnv1a_32(f"{target_date}:{n['id']}"), n["id"]))
    return eligible[: max(0, limit)]


def format_pos_display(pos: float, pos_unit: str) -> str:
    clean = int(pos) if float(pos) == int(float(pos)) else round(float(pos), 2)
    if pos_unit == "percent":
        return f"{clean}%"
    if pos_unit == "loc":
        return f"loc {clean}"
    return f"p. {clean}"


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

BOOK_META_STRING_KEYS = ("coverUrl", "startedAt", "finishedAt", "currentChapter")
NOTE_META_STRING_KEYS = ("title", "exportedAt", "lastReviewedAt", "chapter")
NOTE_META_BOOLEAN_KEYS = ("isPrediction", "ocrBackfilled")
LEGACY_QUESTION_KEYS = ("q1", "q2", "q3")
MAX_SOCRATIC_QUESTIONS = 3
MAX_ATTACHMENTS = 3

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
            if expected_base_updated_at and not force and tab in ("Notes", "Books"):
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
    other_active = [
        n for n in notes if n["id"] != target_note_id and n.get("deltaStatus") == "active"
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


def cmd_book_list(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    ws = backend.load_workspace()
    active_delta_count = sum(1 for n in ws["notes"] if n.get("deltaStatus") == "active")
    books = list(ws["books"])

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
    )
    if all(v is None for v in mutable_values):
        raise CliError(
            "Provide at least one mutable field to update (e.g. --status, --pos, --total-pos, --title)."
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

    unlocked_count = 0
    if next_status == "finished" and updated.get("kind") == "fiction" and prev_status != "finished":
        unlocked_count = sum(
            1
            for n in ws["notes"]
            if n.get("bookId") == updated["id"] and bool((n.get("meta") or {}).get("isPrediction"))
        )

    return {
        "book": updated,
        "unlockedPredictionsCount": unlocked_count,
    }


def cmd_progress(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    if args.pos is None and args.delta is None and not args.finish:
        raise CliError("Provide --pos, --delta, or --finish.")
    if args.pos is not None and args.pos < 0:
        raise CliError("Position (--pos) cannot be negative.")

    ws = backend.load_workspace()
    book = resolve_book(ws["books"], args.book)
    base_updated_at = (book.get("meta") or {}).get("updatedAt")
    prev_pos = float(book.get("currentPos") or 0)
    total_pos = float(book.get("totalPos") or 0)
    pos_unit = book.get("posUnit") or "page"
    now_iso = now_iso_utc()

    if args.pos is not None:
        raw_target = float(args.pos)
    elif args.delta is not None:
        raw_target = prev_pos + float(args.delta)
    else:
        raw_target = 100.0 if pos_unit == "percent" else (total_pos if total_pos > 0 else prev_pos)

    if raw_target < 0:
        raise CliError(f"Resulting position ({clean_num(raw_target)}) cannot be negative.")

    clamped_target = raw_target
    if pos_unit == "percent":
        clamped_target = min(100.0, clamped_target)
    elif total_pos > 0:
        clamped_target = min(total_pos, clamped_target)

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

    force = bool(getattr(args, "force", False))
    if changed or finished_changed:
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

    return {
        "book": updated_book,
        "session": saved_session,
        "bookmarkChanged": changed,
        "coalesced": coalesced,
        "finished": bool(args.finish),
    }


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
            if n.get("deltaStatus") == "active":
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

    return {
        "exportedCount": len(exported_files),
        "exportedFiles": exported_files,
        "skippedCount": skipped,
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
        else:
            paragraph_lines.append(line)
    flush_paragraph()
    return ops


def _format_companion_entry(note: dict[str, Any], book: dict[str, Any]) -> str:
    meta = note.get("meta") or {}
    title = meta.get("title") or note["slug"]
    pos_str = format_pos_display(float(note.get("pos") or 0), book.get("posUnit") or "page")
    _, _, when_line, do_line = format_when_do_lines(
        note.get("deltaTrigger") or "",
        note.get("deltaAction") or "",
    )
    parts = [
        f"## {title} ({pos_str}) [note:{note['id']}]",
    ]
    if (note.get("quote") or "").strip():
        parts.append(f'Quote: "{note["quote"].strip()}"')
    if (note.get("takeaway") or "").strip():
        parts.append(f"Takeaway: {note['takeaway'].strip()}")
    if (note.get("contextMechanism") or "").strip():
        parts.append(f"Mechanism: {note['contextMechanism'].strip()}")
    if when_line:
        parts.append(when_line)
    if do_line:
        parts.append(do_line)
    if (note.get("critique") or "").strip():
        parts.append(f"Critique: {note['critique'].strip()}")
    return "\n".join(parts)


def cmd_book_doc_sync(args: argparse.Namespace, backend: WorkspaceBackend) -> dict[str, Any]:
    ws = backend.load_workspace()
    book = resolve_book(ws["books"], args.book)

    atomic_notes = [
        n
        for n in ws["notes"]
        if n.get("bookId") == book["id"] and n.get("status") == "atomic"
    ]
    atomic_notes.sort(key=lambda n: (float(n.get("pos") or 0), str(n.get("createdAt") or "")))

    existing_doc_url = (book.get("docUrl") or "").strip()
    doc_id = parse_doc_id(existing_doc_url)
    created_doc = False

    doc_out_path = Path(args.doc_out) if getattr(args, "doc_out", None) else None
    existing_text = ""
    if doc_out_path and doc_out_path.exists():
        existing_text = doc_out_path.read_text(encoding="utf-8")
    elif doc_id and isinstance(backend, GoogleWorkspaceBackend):
        existing_text = backend.read_doc_text(doc_id)

    unsynced = [
        n for n in atomic_notes if f"[note:{n['id']}]" not in existing_text
    ]

    header_block = f"# Pragya · {book['title']}\nAuthor: {book['author']}\n"
    entries_text = "\n\n".join(_format_companion_entry(n, book) for n in unsynced)

    if not doc_id:
        full_initial = header_block + ("\n" + entries_text if entries_text else "")
        doc_id, new_url = backend.create_companion_doc(
            f"Pragya · {book['title']}", "", book_id=book["id"]
        )
        created_doc = True
        updated_book = json.loads(json.dumps(book))
        updated_book["docUrl"] = new_url
        updated_book.setdefault("meta", {})["updatedAt"] = now_iso_utc()
        backend.save_book(
            updated_book,
            expected_base_updated_at=(book.get("meta") or {}).get("updatedAt"),
            force=bool(getattr(args, "force", False)),
        )
        if full_initial.strip():
            backend.append_doc_text(doc_id, full_initial.rstrip() + "\n")
        final_doc_url = new_url
        if doc_out_path:
            doc_out_path.parent.mkdir(parents=True, exist_ok=True)
            doc_out_path.write_text(full_initial.rstrip() + "\n", encoding="utf-8")
    else:
        final_doc_url = existing_doc_url
        if entries_text:
            # B4.5: an existing but empty Doc gets the header once, then the entries.
            prefix = "\n\n" if existing_text.strip() else header_block + "\n"
            append_payload = prefix + entries_text + "\n"
            backend.append_doc_text(doc_id, append_payload)
            if doc_out_path:
                doc_out_path.parent.mkdir(parents=True, exist_ok=True)
                base_txt = existing_text if existing_text.strip() else header_block
                doc_out_path.write_text(
                    base_txt.rstrip() + "\n\n" + entries_text + "\n",
                    encoding="utf-8",
                )
        elif doc_out_path and not doc_out_path.exists():
            doc_out_path.parent.mkdir(parents=True, exist_ok=True)
            doc_out_path.write_text(header_block.rstrip() + "\n", encoding="utf-8")

    return {
        "bookId": book["id"],
        "docId": doc_id,
        "docUrl": final_doc_url,
        "createdDoc": created_doc,
        "syncedNoteCount": len(unsynced),
        "syncedNoteIds": [n["id"] for n in unsynced],
    }


# ---------------------------------------------------------------------------
# Argument Parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
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

    parser = argparse.ArgumentParser(
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

    # 0d. progress
    p_prog = sub.add_parser("progress", parents=[common], help="Advance reading bookmark and log a coalesced session.")
    p_prog.add_argument("--book", required=True, help="Book UUID or title.")
    p_prog_grp = p_prog.add_mutually_exclusive_group()
    p_prog_grp.add_argument("--pos", type=float, default=None, help="New bookmark position in book units.")
    p_prog_grp.add_argument("--delta", type=float, default=None, help="Increment/decrement relative to currentPos.")
    p_prog.add_argument("--finish", action="store_true", help="Mark the book as finished (normalizedPos=1.0).")
    p_prog.add_argument("--session-note", default="", help="Optional short session note.")
    p_prog.add_argument("--force-pos", action="store_true", help="Allow moving bookmark backward.")

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

    # 6. book-doc-sync
    p_doc = sub.add_parser("book-doc-sync", parents=[common], help="Sync atomic notes to a Book Companion Doc.")
    p_doc.add_argument("--book", required=True, help="Book UUID or title.")
    p_doc.add_argument("--doc-out", default="", help="Optional local text output mirror for offline testing.")

    return parser


def main(argv: list[str] | None = None, runner: Callable[[list[str]], tuple[int, str, str]] = default_cmd_runner) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

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
