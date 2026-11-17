"""M6 Batch 1: cross-brain metaJson pass-through and defensive drift codecs (CLI side).

Mirrors tests/unit/m6CodecsDrift.test.mjs. Offline only: every Workspace call goes
through an injected fake runner or a temp --state-file; nothing touches a real Sheet.
"""

from __future__ import annotations

import contextlib
import copy
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from test_pragya_cli import _decode_raw_batch, _fake_list_sheets_payload, _run_cli_json, pragya_cli

# ---------------------------------------------------------------------------
# Offline drift fixture reproducing the three live "Born a Crime" drift rows.
# (UUID middles are synthetic; prefixes/suffixes match the live rows.)
# ---------------------------------------------------------------------------

DRIFT_BOOK_ID = "a7d3e910-5c2b-4e8f-9a1d-3f6e8c20b301"
DRIFT_NOTE_Q_ID = "f4c82d19-7e3a-4b6c-8d2f-1a9e5b70a602"
DRIFT_NOTE_SPAR_ID = "9b4e7c12-2d8f-4a5e-b3c1-6e0f7d91d403"

BORN_A_CRIME_DRIFT_FIXTURE = {
    "version": 1,
    "exportedAt": "2026-11-16T00:00:00.000Z",
    "books": [
        {
            "id": DRIFT_BOOK_ID,
            "title": "Born a Crime",
            "author": "Trevor Noah",
            "format": "print",
            "kind": "nonfiction",
            "status": "reading",
            "currentPos": 120,
            "totalPos": 304,
            "posUnit": "page",
            "normalizedPos": round(120 / 304, 6),
            "docUrl": "",
            # Agent-written drift: chapterNote alias, unknown subgenre, no updatedAt.
            "meta": {"chapterNote": "Ch 7: Fufi", "subgenre": "memoir", "startedAt": "2026-11-01T09:00:00.000Z"},
        }
    ],
    "notes": [
        {
            "id": DRIFT_NOTE_Q_ID,
            "slug": "language-as-survival",
            "bookId": DRIFT_BOOK_ID,
            "createdAt": "2026-11-10T10:00:00.000Z",
            "updatedAt": "2026-11-10T10:05:00.000Z",
            "pos": 55,
            "normalizedPos": round(55 / 304, 6),
            "status": "in-reflection",
            "source": "companion",
            "tags": ["#language", "#identity"],
            "quote": "Language, even more than color, defines who you are to people.",
            "takeaway": "Speaking someone's language collapses the outsider frame.",
            "contextMechanism": "",
            "critique": "",
            "deltaTrigger": "",
            "deltaAction": "",
            "deltaStatus": "none",
            "meta": {
                "title": "Language as Survival",
                "chapter": "Ch 4",
                "q1": "When did a shared language change how you were treated?",
                "q2": "Where does this break down?",
                "attachments": [],
                "links": [],
            },
        },
        {
            "id": DRIFT_NOTE_SPAR_ID,
            "slug": "chameleon-belonging",
            "bookId": DRIFT_BOOK_ID,
            "createdAt": "2026-11-12T10:00:00.000Z",
            "updatedAt": "2026-11-12T10:05:00.000Z",
            "pos": 80,
            "normalizedPos": round(80 / 304, 6),
            "status": "saved",
            "source": "companion",
            "tags": ["#belonging"],
            "quote": "",
            "takeaway": "Being a chameleon buys entry, not belonging.",
            "contextMechanism": "",
            "critique": "",
            "deltaTrigger": "",
            "deltaAction": "",
            "deltaStatus": "none",
            "meta": {"chapter": "Ch 6", "sparStage": "stage-1", "attachments": [], "links": []},
        },
    ],
    "sessions": [],
    "deltaLogs": [],
}


def _fixture() -> dict:
    return copy.deepcopy(BORN_A_CRIME_DRIFT_FIXTURE)


def _book_row(book: dict) -> list:
    """Raw Books!A:L row exactly as drifted rows look in the live Sheet."""
    return [
        book["id"],
        book["title"],
        book["author"],
        book["format"],
        book["kind"],
        book["status"],
        book["currentPos"],
        book["totalPos"],
        book["posUnit"],
        book["normalizedPos"],
        book["docUrl"],
        json.dumps(book["meta"]),
    ]


def _note_row(note: dict) -> list:
    return [
        note["id"],
        note["slug"],
        note["bookId"],
        note["createdAt"],
        note["updatedAt"],
        note["pos"],
        note["normalizedPos"],
        note["status"],
        note["source"],
        ", ".join(note["tags"]),
        note["quote"],
        note["takeaway"],
        note["contextMechanism"],
        note["critique"],
        note["deltaTrigger"],
        note["deltaAction"],
        note["deltaStatus"],
        json.dumps(note["meta"]),
    ]


CAPSTONE = {
    "arcOrThesis": "Language is survival.",
    "keyLearnings": ["Code-switching is belonging", "Humor defuses violence"],
    "perspectiveShift": "Apartheid as a lived system.",
    "completedAt": "2026-11-10T12:00:00.000Z",
}


class TestM6MetaCodecs(unittest.TestCase):
    def test_book_row_round_trip_preserves_unknown_and_new_keys(self):
        fx = _fixture()
        book_in = fx["books"][0]
        book_in["meta"] = {
            "updatedAt": "2026-11-15T00:00:00.000Z",
            "subgenre": "memoir",
            "currentChapter": "Ch 7",
            "capstone": CAPSTONE,
            "nested": {"keep": [1, 2, {"deep": True}]},
        }
        b1 = pragya_cli.row_to_book(_book_row(book_in))
        b2 = pragya_cli.row_to_book(pragya_cli.book_to_row(b1))
        self.assertEqual(b1, b2)
        self.assertEqual(b2["meta"]["subgenre"], "memoir")
        self.assertEqual(b2["meta"]["currentChapter"], "Ch 7")
        self.assertEqual(b2["meta"]["capstone"], CAPSTONE)
        self.assertEqual(b2["meta"]["nested"], {"keep": [1, 2, {"deep": True}]})

    def test_note_row_round_trip_preserves_chapter_and_spar_stage(self):
        note_in = _fixture()["notes"][1]
        note_in["meta"]["customAgentKey"] = {"a": 1}
        n1 = pragya_cli.row_to_note(_note_row(note_in))
        n2 = pragya_cli.row_to_note(pragya_cli.note_to_row(n1))
        self.assertEqual(n1, n2)
        self.assertEqual(n2["meta"]["chapter"], "Ch 6")
        self.assertEqual(n2["meta"]["sparStage"], "stage-1")
        self.assertEqual(n2["meta"]["customAgentKey"], {"a": 1})
        self.assertEqual(n2["source"], "agent")

    def test_chapter_note_alias(self):
        book = pragya_cli.row_to_book(_book_row(_fixture()["books"][0]))
        self.assertEqual(book["meta"]["currentChapter"], "Ch 7: Fufi")
        self.assertNotIn("chapterNote", book["meta"])
        written = json.loads(pragya_cli.book_to_row(book)[11])
        self.assertNotIn("chapterNote", written)
        both = pragya_cli.normalize_book_meta({"chapterNote": "old", "currentChapter": "new"})
        self.assertEqual(both["currentChapter"], "new")
        self.assertNotIn("chapterNote", both)
        # A caller that spreads legacy keys still gets a canonical write.
        dirty = copy.deepcopy(book)
        dirty["meta"]["chapterNote"] = "Ch 9"
        written = json.loads(pragya_cli.book_to_row(dirty)[11])
        self.assertNotIn("chapterNote", written)
        self.assertEqual(written["currentChapter"], "Ch 7: Fufi")

    def test_socratic_questions_matrix(self):
        cases = [
            ({"q1": "a", "q2": "b"}, ["a", "b"]),
            ({"q1": "  a  ", "q2": ""}, ["a"]),
            ({"socraticQuestions": ["x"], "q1": "a", "q2": "b"}, ["x"]),
            ({"socraticQuestions": [], "q1": "a", "q2": "b"}, ["a", "b"]),
            ({"socraticQuestions": ["one"]}, ["one"]),
            ({"socraticQuestions": ["one", "two", "three"]}, ["one", "two", "three"]),
            ({"socraticQuestions": ["1", "2", "3", "4"]}, ["1", "2", "3"]),
            ({"socraticQuestions": []}, None),
            ({"socraticQuestions": ["", "   "]}, None),
            ({"socraticQuestions": [42, None, "ok"]}, ["ok"]),
            ({"q1": "", "q2": "  "}, None),
        ]
        base = _fixture()["notes"][0]
        for meta_in, expected in cases:
            with self.subTest(meta=meta_in):
                note_in = copy.deepcopy(base)
                note_in["meta"] = meta_in
                meta = pragya_cli.row_to_note(_note_row(note_in))["meta"]
                self.assertEqual(meta.get("socraticQuestions"), expected)
                self.assertNotIn("q1", meta)
                self.assertNotIn("q2", meta)
                written = json.loads(
                    pragya_cli.note_to_row(pragya_cli.row_to_note(_note_row(note_in)))[17]
                )
                self.assertNotIn("q1", written)
                self.assertNotIn("q2", written)
                self.assertEqual(written.get("socraticQuestions"), expected)

    def test_malformed_meta_never_raises(self):
        book = _fixture()["books"][0]
        note = _fixture()["notes"][0]
        for raw in ("[1,2]", "null", "oops", '"str"', "42", "", "{", None, 7, [1]):
            with self.subTest(raw=raw):
                brow = _book_row(book)
                brow[11] = raw
                self.assertEqual(pragya_cli.row_to_book(brow)["meta"], {"updatedAt": ""})
                nrow = _note_row(note)
                nrow[17] = raw
                self.assertEqual(
                    pragya_cli.row_to_note(nrow)["meta"], {"attachments": [], "links": []}
                )

    def test_known_keys_revalidated_and_capstone_preserved_verbatim(self):
        raw_capstone = {"arcOrThesis": "Arc", "keyLearnings": "single", "extra": "kept"}
        meta = pragya_cli.normalize_book_meta(
            {
                "coverUrl": "",
                "startedAt": 12345,
                "finishedAt": {"bad": True},
                "currentChapter": "   ",
                "updatedAt": "2026-11-15T00:00:00.000Z",
                "capstone": raw_capstone,
            }
        )
        self.assertNotIn("coverUrl", meta)
        self.assertEqual(meta["startedAt"], "12345")
        self.assertNotIn("finishedAt", meta)
        self.assertNotIn("currentChapter", meta)
        # Fix-up (R1#3): stored capstone is never rewritten ...
        self.assertEqual(meta["capstone"], raw_capstone)
        # ... and the typed accessor coerces for rendering.
        self.assertEqual(
            pragya_cli.get_book_capstone(meta),
            {"arcOrThesis": "Arc", "keyLearnings": ["single"], "perspectiveShift": "", "completedAt": ""},
        )
        rich = {"keyLearnings": ["a", 3, None, " b ", {"text": "t", "page": 12}]}
        kept = pragya_cli.normalize_book_meta({"capstone": rich})
        self.assertEqual(kept["capstone"], rich)
        self.assertEqual(pragya_cli.get_book_capstone(kept)["keyLearnings"], ["a", "3", "b"])
        for bad in ("str", 42, None, ["x"]):
            with self.subTest(bad=bad):
                kept_bad = pragya_cli.normalize_book_meta({"capstone": bad})
                self.assertEqual(kept_bad["capstone"], bad)
                self.assertIsNone(pragya_cli.get_book_capstone(kept_bad))
        self.assertIsNone(pragya_cli.get_book_capstone({}))
        self.assertIsNone(pragya_cli.get_book_capstone("nope"))

        # Capstone round-trips byte-for-byte through the Sheets row codec.
        book_in = _fixture()["books"][0]
        book_in["meta"] = {"updatedAt": "x", "capstone": rich}
        b2 = pragya_cli.row_to_book(pragya_cli.book_to_row(pragya_cli.row_to_book(_book_row(book_in))))
        self.assertEqual(b2["meta"]["capstone"], rich)

        note_meta = pragya_cli.normalize_note_meta(
            {"isPrediction": "false", "ocrBackfilled": 1, "title": "", "lastReviewedAt": "2026-11-15"}
        )
        self.assertIs(note_meta["isPrediction"], False)
        self.assertIs(note_meta["ocrBackfilled"], True)
        self.assertNotIn("title", note_meta)
        self.assertEqual(note_meta["lastReviewedAt"], "2026-11-15")
        # R2#4: an empty-string boolean is "absent" (dropped), not materialized as False.
        self.assertNotIn("isPrediction", pragya_cli.normalize_note_meta({"isPrediction": ""}))

    def test_spar_stage_passes_through_verbatim(self):
        for value in ({"stage": 2}, 2, "", "stage-1", [1, "a"], None):
            with self.subTest(value=value):
                note_in = _fixture()["notes"][1]
                note_in["meta"]["sparStage"] = value
                n1 = pragya_cli.row_to_note(_note_row(note_in))
                n2 = pragya_cli.row_to_note(pragya_cli.note_to_row(n1))
                self.assertIn("sparStage", n2["meta"])
                self.assertEqual(n2["meta"]["sparStage"], value)

    def test_attachments_round_trip_verbatim_including_invalid_and_beyond_three(self):
        raw = [
            {"id": "img-1", "type": "image", "driveFileId": "drv"},
            {"id": "aud-1", "type": "audio", "url": "https://x/a.mp3"},
            "stray-string",
            {"type": "link", "url": "https://no-id.example"},
            {"id": "link-1", "type": "link", "url": "https://example.com", "title": "L"},
            {"id": "doc-1", "type": "doc", "url": "https://docs.google.com/document/d/abc", "title": "D"},
            {"id": "link-2", "type": "link", "url": "https://fourth.example", "title": "4th"},
        ]
        note_in = _fixture()["notes"][1]
        note_in["meta"]["attachments"] = raw
        n1 = pragya_cli.row_to_note(_note_row(note_in))
        self.assertEqual(n1["meta"]["attachments"], raw)
        n2 = pragya_cli.row_to_note(pragya_cli.note_to_row(n1))
        self.assertEqual(n2["meta"]["attachments"], raw)
        # Render-time filter: <=3 valid entries with defaults.
        rendered = pragya_cli.renderable_attachments(n2["meta"])
        self.assertEqual([a["id"] for a in rendered], ["img-1", "link-1", "doc-1"])
        self.assertEqual(rendered[0]["fileName"], "image.webp")
        # Markdown export renders only the valid entries and never crashes on junk.
        md = pragya_cli._render_note_markdown(n2, pragya_cli.row_to_book(_book_row(_fixture()["books"][0])))
        self.assertIn("https://example.com", md)
        self.assertNotIn("a.mp3", md)
        self.assertNotIn("fourth.example", md)
        # State-file round-trip keeps every entry too.
        fx = _fixture()
        fx["notes"][1]["meta"]["attachments"] = raw
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(fx), encoding="utf-8")
            backend = pragya_cli.StateFileBackend(path)
            ws = backend.load_workspace()
            note = next(n for n in ws["notes"] if n["id"] == DRIFT_NOTE_SPAR_ID)
            self.assertEqual(note["meta"]["attachments"], raw)
            backend.save_note(note)
            stored = json.loads(path.read_text(encoding="utf-8"))
            snote = next(n for n in stored["notes"] if n["id"] == DRIFT_NOTE_SPAR_ID)
            self.assertEqual(snote["meta"]["attachments"], raw)

    def test_writer_drops_only_known_blank_keys(self):
        book = pragya_cli.row_to_book(_book_row(_fixture()["books"][0]))
        book["meta"]["coverUrl"] = ""
        book["meta"]["subgenreNote"] = ""
        written = json.loads(pragya_cli.book_to_row(book)[11])
        self.assertNotIn("coverUrl", written)
        self.assertEqual(written["subgenreNote"], "")

    def test_empty_meta_dict_parity_with_ts(self):
        """R1#7: `{}` meta writes {"updatedAt": ""} (TS semantics), never an invented timestamp."""
        book = pragya_cli.row_to_book(_book_row(_fixture()["books"][0]))
        book["meta"] = {}
        self.assertEqual(json.loads(pragya_cli.book_to_row(book)[11]), {"updatedAt": ""})
        book.pop("meta")
        self.assertTrue(json.loads(pragya_cli.book_to_row(book)[11])["updatedAt"])

    def test_non_finite_json_never_emitted(self):
        """QA-4: NaN/Infinity rejected on parse (JS parity) and never re-emitted."""
        self.assertEqual(pragya_cli.safe_json_parse('{"a":NaN}', {}), {})
        self.assertEqual(pragya_cli.safe_json_parse('{"a":Infinity}', {}), {})
        out = pragya_cli.json_dumps_strict({"a": float("nan"), "b": [1, float("inf")], "c": 1})
        self.assertEqual(json.loads(out), {"b": [1, None], "c": 1})
        book = pragya_cli.row_to_book(_book_row(_fixture()["books"][0]))
        book["meta"]["score"] = float("nan")
        cell = pragya_cli.book_to_row(book)[11]
        self.assertNotIn("NaN", cell)
        self.assertNotIn("score", json.loads(cell))

    def test_state_file_save_returns_normalized_dicts(self):
        """R1#6: CLI output matches what is persisted."""
        fx = _fixture()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(fx), encoding="utf-8")
            backend = pragya_cli.StateFileBackend(path)
            saved_book = backend.save_book(fx["books"][0])
            self.assertEqual(saved_book["format"], "physical")
            self.assertNotIn("chapterNote", saved_book["meta"])
            saved_note = backend.save_note(fx["notes"][0])
            self.assertEqual(saved_note["source"], "agent")
            self.assertNotIn("q1", saved_note["meta"])
            stored = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(stored["books"][0], saved_book)
            self.assertEqual(
                next(n for n in stored["notes"] if n["id"] == DRIFT_NOTE_Q_ID), saved_note
            )

    def test_normalize_attachments(self):
        out = pragya_cli.normalize_attachments(
            [
                None,
                "string",
                {"id": "", "type": "image"},
                {"id": "no-type"},
                {"id": "bad-type", "type": "video", "url": "x"},
                {"id": "link-no-url", "type": "link", "title": "x"},
                {"id": "img-1", "type": "image", "driveFileId": "drv"},
                {"id": "doc-1", "type": "doc", "url": "https://docs.google.com/document/d/abc", "title": "Doc"},
                {"id": "link-1", "type": "link", "url": "https://example.com"},
                {"id": "img-4", "type": "image", "fileName": "x.png", "mimeType": "image/png"},
            ]
        )
        self.assertEqual(len(out), 3)
        self.assertEqual(
            out[0],
            {"id": "img-1", "type": "image", "driveFileId": "drv", "fileName": "image.webp", "mimeType": "image/webp"},
        )
        self.assertEqual(out[1]["id"], "doc-1")
        self.assertEqual(out[2], {"id": "link-1", "type": "link", "url": "https://example.com", "title": ""})
        self.assertEqual(pragya_cli.normalize_attachments("nope"), [])

    def test_enum_coercion(self):
        for raw, expected in (
            ("print", "physical"),
            ("Hardcover", "physical"),
            (" paperback ", "physical"),
            ("physical", "physical"),
            ("Ebook", "kindle"),
            ("KINDLE", "kindle"),
            ("audiobook", "physical"),
            ("", "physical"),
            (None, "physical"),
        ):
            self.assertEqual(pragya_cli.normalize_book_format(raw), expected, raw)
        for raw, expected in (
            ("companion", "agent"),
            ("Agent", "agent"),
            ("assistant", "agent"),
            ("cli", "agent"),
            ("skill", "agent"),
            ("app", "app"),
            ("web", "app"),
            ("", "app"),
            (None, "app"),
        ):
            self.assertEqual(pragya_cli.normalize_note_source(raw), expected, raw)

    def test_missing_updated_at_reads_as_empty_string(self):
        book = pragya_cli.row_to_book(_book_row(_fixture()["books"][0]))
        self.assertEqual(book["meta"]["updatedAt"], "")

    def test_normalizers_are_idempotent(self):
        fx = _fixture()
        for b in fx["books"]:
            once = pragya_cli.normalize_book_dict(b)
            self.assertEqual(pragya_cli.normalize_book_dict(once), once)
        for n in fx["notes"]:
            once = pragya_cli.normalize_note_dict(n)
            self.assertEqual(pragya_cli.normalize_note_dict(once), once)


class TestM6CorruptNumerics(unittest.TestCase):
    def test_corrupt_notes_g_yields_zero_without_raising(self):
        row = _note_row(_fixture()["notes"][0])
        for bad in ("abc", "#REF!", {"x": 1}, [1]):
            with self.subTest(bad=bad):
                row[6] = bad
                note = pragya_cli.row_to_note(row)
                self.assertEqual(note["normalizedPos"], 0.0)
        row[6] = "0.25"
        self.assertEqual(pragya_cli.row_to_note(row)["normalizedPos"], 0.25)

    def test_load_workspace_keeps_other_rows_when_one_g_is_corrupt(self):
        fx = _fixture()
        bad_row = _note_row(fx["notes"][0])
        bad_row[6] = "not-a-number"
        good_row = _note_row(fx["notes"][1])
        rows = {
            "Books!A:L": [pragya_cli.BOOKS_HEADERS, _book_row(fx["books"][0])],
            "Notes!A:R": [pragya_cli.NOTES_HEADERS, bad_row, good_row],
            "Sessions!A:G": [pragya_cli.SESSIONS_HEADERS],
            "DeltaLogs!A:E": [pragya_cli.DELTA_LOGS_HEADERS],
        }
        backend = pragya_cli.GoogleWorkspaceBackend(
            spreadsheet_id="sheet-m6", runner=_make_fake_runner(rows, [])
        )
        ws = backend.load_workspace()
        self.assertEqual([n["id"] for n in ws["notes"]], [DRIFT_NOTE_Q_ID, DRIFT_NOTE_SPAR_ID])
        self.assertEqual(ws["notes"][0]["normalizedPos"], 0.0)


class TestM6SerialDates(unittest.TestCase):
    def test_decode_sheet_date_and_timestamp(self):
        d = pragya_cli.decode_sheet_date
        self.assertEqual(d(46342), "2026-11-16")
        self.assertEqual(d(46342.0), "2026-11-16")
        self.assertEqual(d("46342"), "2026-11-16")
        self.assertEqual(d(46342.99), "2026-11-16")
        self.assertEqual(d(" 46342.25 "), "2026-11-16")
        self.assertEqual(d(1), "1899-12-31")
        self.assertEqual(d("2026-11-16"), "2026-11-16")
        self.assertEqual(d("  2026-11-16 "), "2026-11-16")
        self.assertEqual(d("garbage"), "garbage")
        self.assertEqual(d("1234"), "1234")
        self.assertEqual(d(0), "0")
        self.assertEqual(d(-5), "-5")
        self.assertEqual(d(3_000_000), "3000000")
        self.assertEqual(d(None), "")
        self.assertEqual(d(True), "true")  # bools are never serials (String(true) parity)

        t = pragya_cli.decode_sheet_timestamp
        self.assertEqual(t(46342), "2026-11-16T00:00:00.000Z")
        self.assertEqual(t(46342.5), "2026-11-16T12:00:00.000Z")
        self.assertEqual(t("2026-11-16T08:00:00.000Z"), "2026-11-16T08:00:00.000Z")
        self.assertEqual(t("oops"), "oops")

    def test_rows_decode_serial_columns(self):
        s = pragya_cli.row_to_session(["s1", "b1", 46342, 1, 5, 46342.5, ""])
        self.assertEqual(s["date"], "2026-11-16")
        self.assertEqual(s["updatedAt"], "2026-11-16T12:00:00.000Z")
        dl = pragya_cli.row_to_delta_log(["d1", "n1", 46342, "applied", ""])
        self.assertEqual(dl["date"], "2026-11-16")
        row = _note_row(_fixture()["notes"][0])
        row[3] = 46342
        row[4] = "46342.5"
        n = pragya_cli.row_to_note(row)
        self.assertEqual(n["createdAt"], "2026-11-16T00:00:00.000Z")
        self.assertEqual(n["updatedAt"], "2026-11-16T12:00:00.000Z")

    def test_coalescing_matches_decoded_serial_today_session(self):
        now = datetime.now(timezone.utc)
        today = pragya_cli.local_date_str(now.astimezone())
        y, m, dd = (int(x) for x in today.split("-"))
        today_serial = (datetime(y, m, dd, tzinfo=timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)).days + 25569
        five_min_ago = (now - timedelta(minutes=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        session = pragya_cli.row_to_session(["sess-serial", "book-1", today_serial, 10, 20, five_min_ago, ""])
        self.assertEqual(session["date"], today)
        upserted, is_new = pragya_cli.upsert_coalesced_session(
            [session],
            book_id="book-1",
            prev_pos=20,
            next_pos=30,
            now_iso=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        )
        self.assertFalse(is_new)
        self.assertEqual(upserted["id"], "sess-serial")
        self.assertEqual(upserted["endPos"], 30)


def _make_fake_runner(rows: dict, batch_ops_seen: list):
    def fake_runner(cmd: list) -> tuple:
        if cmd[:3] == ["gsheets", "readonly", "list-sheets"]:
            return 0, _fake_list_sheets_payload(("Books", "Notes", "Sessions", "DeltaLogs")), ""
        if cmd[:3] == ["gsheets", "readonly", "read"]:
            rng = cmd[4]
            headers = {
                "Books!A1:L1": pragya_cli.BOOKS_HEADERS,
                "Notes!A1:R1": pragya_cli.NOTES_HEADERS,
                "Sessions!A1:G1": pragya_cli.SESSIONS_HEADERS,
                "DeltaLogs!A1:E1": pragya_cli.DELTA_LOGS_HEADERS,
            }
            if rng in headers:
                return 0, json.dumps({"values": [headers[rng]]}), ""
            if rng in rows:
                return 0, json.dumps({"values": rows[rng]}), ""
            if rng.endswith("!A:A"):
                tab = rng.split("!")[0]
                full = next(v for k, v in rows.items() if k.startswith(tab + "!"))
                return 0, json.dumps({"values": [[r[0]] for r in full]}), ""
        if cmd[:3] == ["gsheets", "mutate", "raw-batch"]:
            batch_file = Path(cmd[cmd.index("-f") + 1])
            batch_ops_seen.append(_decode_raw_batch(json.loads(batch_file.read_text(encoding="utf-8"))))
            return 0, json.dumps({"replies": []}), ""
        return 1, "", f"Unexpected command: {cmd}"

    return fake_runner


class TestM6DriftThroughCli(unittest.TestCase):
    def test_state_file_book_list_and_update_canonicalize_and_keep_unknown_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            state_path.write_text(json.dumps(_fixture()), encoding="utf-8")

            rc, res, err = _run_cli_json(["--state-file", str(state_path), "book-list"])
            self.assertEqual(rc, 0, err)
            book = res["books"][0]
            self.assertEqual(book["format"], "physical")
            self.assertEqual(book["meta"]["subgenre"], "memoir")
            self.assertEqual(book["meta"]["currentChapter"], "Ch 7: Fufi")
            self.assertNotIn("chapterNote", book["meta"])
            self.assertEqual(book["meta"]["updatedAt"], "")

            # No updatedAt on the stored book → update must not raise a conflict.
            rc, res, err = _run_cli_json(
                ["--state-file", str(state_path), "book-update", "--book", DRIFT_BOOK_ID, "--title", "x"]
            )
            self.assertEqual(rc, 0, err)
            self.assertEqual(res["book"]["title"], "x")

            stored = json.loads(state_path.read_text(encoding="utf-8"))
            sbook = stored["books"][0]
            self.assertEqual(sbook["title"], "x")
            self.assertEqual(sbook["format"], "physical")
            self.assertEqual(sbook["meta"]["subgenre"], "memoir")
            self.assertEqual(sbook["meta"]["currentChapter"], "Ch 7: Fufi")
            self.assertNotIn("chapterNote", sbook["meta"])
            self.assertTrue(sbook["meta"]["updatedAt"])

    def test_state_file_notes_normalized_on_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            state_path.write_text(json.dumps(_fixture()), encoding="utf-8")
            ws = pragya_cli.StateFileBackend(state_path).load_workspace()
            by_id = {n["id"]: n for n in ws["notes"]}
            q_note = by_id[DRIFT_NOTE_Q_ID]
            self.assertEqual(q_note["source"], "agent")
            self.assertEqual(q_note["meta"]["chapter"], "Ch 4")
            self.assertEqual(
                q_note["meta"]["socraticQuestions"],
                [
                    "When did a shared language change how you were treated?",
                    "Where does this break down?",
                ],
            )
            self.assertNotIn("q1", q_note["meta"])
            self.assertNotIn("q2", q_note["meta"])
            spar = by_id[DRIFT_NOTE_SPAR_ID]
            self.assertEqual(spar["source"], "agent")
            self.assertEqual(spar["meta"]["sparStage"], "stage-1")
            self.assertEqual(spar["meta"]["chapter"], "Ch 6")

    def test_sheets_backend_drift_rows_update_writes_canonical_row(self):
        fx = _fixture()
        rows = {
            "Books!A:L": [pragya_cli.BOOKS_HEADERS, _book_row(fx["books"][0])],
            "Notes!A:R": [pragya_cli.NOTES_HEADERS] + [_note_row(n) for n in fx["notes"]],
            "Sessions!A:G": [pragya_cli.SESSIONS_HEADERS],
            "DeltaLogs!A:E": [pragya_cli.DELTA_LOGS_HEADERS],
        }
        batch_ops_seen: list = []
        runner = _make_fake_runner(rows, batch_ops_seen)

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = pragya_cli.main(["--spreadsheet-id", "sheet-m6", "book-list"], runner=runner)
        self.assertEqual(rc, 0)
        listed = json.loads(buf.getvalue())["books"][0]
        self.assertEqual(listed["format"], "physical")
        self.assertEqual(listed["meta"]["subgenre"], "memoir")
        self.assertEqual(listed["meta"]["updatedAt"], "")

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = pragya_cli.main(
                ["--spreadsheet-id", "sheet-m6", "book-update", "--book", DRIFT_BOOK_ID, "--title", "x"],
                runner=runner,
            )
        self.assertEqual(rc, 0)
        write_ops = [op for ops in batch_ops_seen for op in ops if op.get("range") == "Books!A2:L2"]
        self.assertEqual(len(write_ops), 1)
        written = write_ops[0]["data"][0]
        self.assertEqual(written[1], "x")
        self.assertEqual(written[3], "physical")
        meta = json.loads(written[11])
        self.assertEqual(meta["subgenre"], "memoir")
        self.assertEqual(meta["currentChapter"], "Ch 7: Fufi")
        self.assertNotIn("chapterNote", meta)
        self.assertTrue(meta["updatedAt"])

        # Notes: canonical source + socraticQuestions after a decode/encode cycle.
        q_note = pragya_cli.row_to_note(rows["Notes!A:R"][1])
        q_row = pragya_cli.note_to_row(q_note)
        self.assertEqual(q_row[8], "agent")
        q_meta = json.loads(q_row[17])
        self.assertNotIn("q1", q_meta)
        self.assertNotIn("q2", q_meta)
        self.assertEqual(len(q_meta["socraticQuestions"]), 2)
        self.assertEqual(q_meta["chapter"], "Ch 4")


if __name__ == "__main__":
    unittest.main()
