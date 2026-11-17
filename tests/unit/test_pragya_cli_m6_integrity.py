"""M6 Batch 2: CLI data integrity (Python only).

Covers B1.1 raw-value writes, B4.2 row-shift TOCTOU, B4.4 ocr-backfill --ocr-text guard,
B4.5 empty Doc text, A5.5 rate-limit backoff, B2.5 CLI spoiler parity, plus the QA-6 /
sparStage carry-forwards. Offline only: every Workspace call goes through an injected
fake runner or a temp --state-file.
"""

from __future__ import annotations

import contextlib
import copy
import io
import json
import re
import tempfile
import unittest
from pathlib import Path

from test_pragya_cli import (
    FAKE_SHEET_IDS,
    _decode_raw_batch,
    _fake_list_sheets_payload,
    _make_sample_snapshot,
    _run_cli_json,
    pragya_cli,
)

ALL_TABS = ("Books", "Notes", "Sessions", "DeltaLogs")
HEADERS = {
    "Books": pragya_cli.BOOKS_HEADERS,
    "Notes": pragya_cli.NOTES_HEADERS,
    "Sessions": pragya_cli.SESSIONS_HEADERS,
    "DeltaLogs": pragya_cli.DELTA_LOGS_HEADERS,
}
LAST_COL = {"Books": "L", "Notes": "R", "Sessions": "G", "DeltaLogs": "E"}


class FakeWorkspace:
    """Minimal fake gsheets/gdocs CLI. Records raw-batch payloads and every command."""

    def __init__(self, rows: dict | None = None, *, list_sheets_payload: str | None = None):
        snap = _make_sample_snapshot()
        self.rows = rows or {
            "Books": [pragya_cli.BOOKS_HEADERS] + [pragya_cli.book_to_row(b) for b in snap["books"]],
            "Notes": [pragya_cli.NOTES_HEADERS] + [pragya_cli.note_to_row(n) for n in snap["notes"]],
            "Sessions": [pragya_cli.SESSIONS_HEADERS],
            "DeltaLogs": [pragya_cli.DELTA_LOGS_HEADERS],
        }
        self.header_rows = {t: [HEADERS[t]] for t in ALL_TABS}
        self.list_sheets_payload = list_sheets_payload or _fake_list_sheets_payload(ALL_TABS)
        self.calls: list[list[str]] = []
        self.raw_payloads: list[dict] = []
        self.full_read_override = None  # callable(tab, read_count) -> rows | None
        self.single_cell_rows = None  # callable(tab) -> rows used for `Tab!A{n}` reads
        self.read_counts: dict[str, int] = {}
        self.doc_read_payload: dict = {"text": ""}
        self.doc_batches: list[list[dict]] = []

    @property
    def write_ops(self) -> list[dict]:
        return [op for p in self.raw_payloads for op in _decode_raw_batch(p)]

    def __call__(self, cmd: list[str]) -> tuple[int, str, str]:
        self.calls.append(list(cmd))
        if cmd[:3] == ["gsheets", "readonly", "list-sheets"]:
            return 0, self.list_sheets_payload, ""
        if cmd[:3] == ["gsheets", "readonly", "read"]:
            rng = cmd[4]
            tab, a1 = rng.split("!")
            if a1 == f"A1:{LAST_COL[tab]}1":
                return 0, json.dumps({"values": self.header_rows[tab]}), ""
            if a1 == "A:A":
                return 0, json.dumps({"values": [[r[0]] for r in self.rows[tab]]}), ""
            single = re.fullmatch(r"A(\d+)", a1)
            if single:  # R1#6 one-cell id re-read before unguarded updates
                idx = int(single.group(1)) - 1
                rows = self.single_cell_rows(tab) if self.single_cell_rows else self.rows[tab]
                cell = [[rows[idx][0]]] if 0 <= idx < len(rows) else []
                return 0, json.dumps({"values": cell}), ""
            if a1 == f"A:{LAST_COL[tab]}":
                self.read_counts[tab] = self.read_counts.get(tab, 0) + 1
                if self.full_read_override:
                    override = self.full_read_override(tab, self.read_counts[tab])
                    if override is not None:
                        return 0, json.dumps({"values": override}), ""
                return 0, json.dumps({"values": self.rows[tab]}), ""
        if cmd[:3] == ["gsheets", "mutate", "raw-batch"]:
            payload = json.loads(Path(cmd[cmd.index("-f") + 1]).read_text(encoding="utf-8"))
            self.raw_payloads.append(payload)
            return 0, json.dumps({"replies": []}), ""
        if cmd[:3] == ["gdocs", "readonly", "read"]:
            return 0, json.dumps(self.doc_read_payload), ""
        if cmd[:3] == ["gdocs", "mutate", "batch"]:
            self.doc_batches.append(json.loads(Path(cmd[cmd.index("-f") + 1]).read_text(encoding="utf-8")))
            return 0, json.dumps({"ok": True}), ""
        return 1, "", f"Unexpected command: {cmd}"


def _backend(fake: FakeWorkspace, sleeps: list | None = None) -> pragya_cli.GoogleWorkspaceBackend:
    sink = sleeps if sleeps is not None else []
    return pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="sid-m6", runner=fake, sleep=sink.append)


def _note(**overrides) -> dict:
    note = copy.deepcopy(_make_sample_snapshot()["notes"][0])
    note.update(overrides)
    return note


class TestRawValueWrites(unittest.TestCase):
    def test_strings_are_exact_string_values_and_numbers_are_number_values(self):
        fake = FakeWorkspace()
        backend = _backend(fake)
        note = _note(
            id="note-formula",
            slug="note-formula",
            takeaway="=SUM(1,2)",
            quote="+10%",
            critique="- bullet",
            tags=["#- bullet"],
        )
        backend.save_note(note)
        backend.save_session(
            {
                "id": "sess-1",
                "bookId": "book-systems",
                "date": "2026-11-16",
                "startPos": 10,
                "endPos": 20.5,
                "updatedAt": "2026-11-16T10:00:00.000Z",
                "note": "@mention",
            }
        )
        self.assertFalse(any(c[:3] == ["gsheets", "mutate", "batch"] for c in fake.calls))
        self.assertEqual(len(fake.raw_payloads), 2)

        note_req = fake.raw_payloads[0]["requests"][0]["appendCells"]
        self.assertEqual(note_req["sheetId"], FAKE_SHEET_IDS["Notes"])
        self.assertEqual(note_req["fields"], "userEnteredValue")
        cells = [c["userEnteredValue"] for c in note_req["rows"][0]["values"]]
        self.assertEqual(len(cells), 18)
        self.assertEqual(cells[11], {"stringValue": "=SUM(1,2)"})
        self.assertEqual(cells[10], {"stringValue": "+10%"})
        self.assertEqual(cells[13], {"stringValue": "- bullet"})
        self.assertEqual(cells[9], {"stringValue": pragya_cli.serialize_tags_csv(["#- bullet"])})
        self.assertEqual(cells[5], {"numberValue": 142})  # pos
        self.assertIn("numberValue", cells[6])  # normalizedPos
        self.assertIn("stringValue", cells[17])  # metaJson

        sess_cells = [
            c["userEnteredValue"]
            for c in fake.raw_payloads[1]["requests"][0]["appendCells"]["rows"][0]["values"]
        ]
        self.assertEqual(sess_cells[2], {"stringValue": "2026-11-16"})
        self.assertEqual(sess_cells[3], {"numberValue": 10})
        self.assertEqual(sess_cells[4], {"numberValue": 20.5})
        self.assertEqual(sess_cells[6], {"stringValue": "@mention"})

    def test_update_targets_uuid_row_with_update_cells(self):
        fake = FakeWorkspace()
        backend = _backend(fake)
        ws = backend.load_workspace()
        target = copy.deepcopy(ws["notes"][2])  # Notes row 4
        target["takeaway"] = "edited"
        backend.save_note(target)
        req = fake.raw_payloads[-1]["requests"][0]["updateCells"]
        self.assertEqual(
            req["range"],
            {
                "sheetId": FAKE_SHEET_IDS["Notes"],
                "startRowIndex": 3,
                "endRowIndex": 4,
                "startColumnIndex": 0,
                "endColumnIndex": 18,
            },
        )
        self.assertEqual(fake.write_ops[-1]["data"][0][11], "edited")

    def test_header_repair_uses_raw_batch(self):
        fake = FakeWorkspace()
        fake.header_rows["DeltaLogs"] = []
        _backend(fake).ensure_schema()
        self.assertEqual(len(fake.raw_payloads), 1)
        op = fake.write_ops[0]
        self.assertEqual(op["op"], "write")
        self.assertEqual(op["range"], "DeltaLogs!A1:E1")
        self.assertEqual(op["data"], [pragya_cli.DELTA_LOGS_HEADERS])

    def test_sheet_ids_refreshed_after_add_sheet(self):
        fake = FakeWorkspace()
        state = {"added": False}
        base_call = fake.__call__

        def runner(cmd):
            if cmd[:3] == ["gsheets", "readonly", "list-sheets"]:
                tabs = ALL_TABS if state["added"] else ALL_TABS[:3]
                fake.calls.append(list(cmd))
                return 0, _fake_list_sheets_payload(tabs), ""
            if cmd[:3] == ["gsheets", "mutate", "add-sheet"]:
                fake.calls.append(list(cmd))
                state["added"] = True
                return 0, json.dumps({"ok": True}), ""
            return base_call(cmd)

        fake.header_rows["DeltaLogs"] = []
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="sid-m6", runner=runner, sleep=lambda s: None)
        backend.ensure_schema()
        self.assertEqual(fake.write_ops[0]["range"], "DeltaLogs!A1:E1")

    def test_missing_sheet_id_is_a_clear_error_and_writes_nothing(self):
        fake = FakeWorkspace(
            list_sheets_payload=json.dumps({"sheets": [{"properties": {"title": t}} for t in ALL_TABS]})
        )
        with self.assertRaises(pragya_cli.CliError) as ctx:
            _backend(fake).save_note(_note(id="n-new", slug="n-new"))
        self.assertIn("sheetId", str(ctx.exception))
        self.assertEqual(fake.raw_payloads, [])

    def test_raw_cell_mapping(self):
        rc = pragya_cli._raw_cell
        self.assertEqual(rc(3), {"userEnteredValue": {"numberValue": 3}})
        self.assertEqual(rc(0.25), {"userEnteredValue": {"numberValue": 0.25}})
        self.assertEqual(rc("46342"), {"userEnteredValue": {"stringValue": "46342"}})
        self.assertEqual(rc(None), {"userEnteredValue": {"stringValue": ""}})
        self.assertEqual(rc(True), {"userEnteredValue": {"stringValue": "true"}})
        self.assertEqual(rc(float("nan")), {"userEnteredValue": {"stringValue": ""}})


class TestRowShiftToctou(unittest.TestCase):
    def test_guarded_write_follows_the_row_after_a_shift(self):
        fake = FakeWorkspace()
        backend = _backend(fake)
        ws = backend.load_workspace()
        target = copy.deepcopy(ws["notes"][2])  # A:A says row 4
        shifted = list(fake.rows["Notes"])
        shifted.insert(1, ["inserted-by-someone-else"] + [""] * 17)  # now row 5

        def override(tab, count):
            # count 1 = load_workspace; later full reads are the guarded re-read.
            return shifted if tab == "Notes" and count >= 2 else None

        fake.full_read_override = override
        target["takeaway"] = "edited after shift"
        backend.save_note(target, expected_base_updated_at=target["updatedAt"])
        req = fake.raw_payloads[-1]["requests"][0]["updateCells"]
        self.assertEqual(req["range"]["startRowIndex"], 4)
        self.assertEqual(req["range"]["endRowIndex"], 5)

    def test_vanished_uuid_raises_and_writes_nothing(self):
        fake = FakeWorkspace()
        backend = _backend(fake)
        ws = backend.load_workspace()
        target = copy.deepcopy(ws["notes"][2])
        without = [r for r in fake.rows["Notes"] if r[0] != target["id"]]
        fake.full_read_override = lambda tab, count: without if tab == "Notes" and count >= 2 else None
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend.save_note(target, expected_base_updated_at=target["updatedAt"])
        self.assertIn("moved or was deleted", str(ctx.exception))
        self.assertEqual(fake.raw_payloads, [])

    def test_vanished_uuid_via_cli_exits_non_zero(self):
        fake = FakeWorkspace()
        target_id = fake.rows["Notes"][2][0]
        without = [r for r in fake.rows["Notes"] if r[0] != target_id]
        fake.full_read_override = lambda tab, count: without if tab == "Notes" and count >= 2 else None
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            rc = pragya_cli.main(
                ["--spreadsheet-id", "sid-m6", "reflect", "--note", target_id, "--stage", "1"],
                runner=fake,
            )
        self.assertNotEqual(rc, 0)
        self.assertIn("moved or was deleted", err.getvalue())
        self.assertEqual(fake.raw_payloads, [])


def _ocr_state() -> dict:
    snap = _make_sample_snapshot()
    img_notes = []
    for i in (1, 2):
        n = copy.deepcopy(snap["notes"][4])
        n["id"] = f"note-img-{i}"
        n["slug"] = f"img-note-{i}"
        n["quote"] = ""
        n["meta"] = {
            "attachments": [{"id": f"att-{i}", "type": "image", "fileName": f"p{i}.webp", "mimeType": "image/webp"}],
            "links": [],
        }
        img_notes.append(n)
    snap["notes"].extend(img_notes)
    return snap


class TestOcrBackfillGuard(unittest.TestCase):
    def test_ocr_text_without_note_fails_and_leaves_state_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(_ocr_state()), encoding="utf-8")
            before = path.read_bytes()
            rc, res, _err = _run_cli_json(["--state-file", str(path), "ocr-backfill", "--ocr-text", "OCR!"])
            self.assertNotEqual(rc, 0)
            self.assertIn("--note", json.dumps(res))
            self.assertEqual(path.read_bytes(), before)

    def test_ocr_text_with_note_updates_only_that_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(_ocr_state()), encoding="utf-8")
            rc, _res, err = _run_cli_json(
                ["--state-file", str(path), "ocr-backfill", "--note", "img-note-1", "--ocr-text", "OCR!"]
            )
            self.assertEqual(rc, 0, err)
            notes = {n["id"]: n for n in json.loads(path.read_text(encoding="utf-8"))["notes"]}
            self.assertEqual(notes["note-img-1"]["quote"], "OCR!")
            self.assertEqual(notes["note-img-2"]["quote"], "")


class TestEmptyDocText(unittest.TestCase):
    def test_empty_doc_ast_reads_as_empty_string(self):
        fake = FakeWorkspace()
        fake.doc_read_payload = {"documentId": "x", "body": {"content": []}}
        self.assertEqual(_backend(fake).read_doc_text("x"), "")

    def test_doc_sync_into_empty_existing_doc_writes_header_and_entries_once(self):
        snap = _make_sample_snapshot()
        snap["books"][0]["docUrl"] = "https://docs.google.com/document/d/doc-empty-123/edit"
        fake = FakeWorkspace(
            rows={
                "Books": [pragya_cli.BOOKS_HEADERS] + [pragya_cli.book_to_row(b) for b in snap["books"]],
                "Notes": [pragya_cli.NOTES_HEADERS] + [pragya_cli.note_to_row(n) for n in snap["notes"]],
                "Sessions": [pragya_cli.SESSIONS_HEADERS],
                "DeltaLogs": [pragya_cli.DELTA_LOGS_HEADERS],
            }
        )
        fake.doc_read_payload = {"documentId": "doc-empty-123", "body": {"content": []}}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = pragya_cli.main(
                ["--spreadsheet-id", "sid-m6", "book-doc-sync", "--book", "book-systems"], runner=fake
            )
        self.assertEqual(rc, 0)
        self.assertEqual(len(fake.doc_batches), 1)
        ops = fake.doc_batches[0]
        blob = json.dumps(ops)
        self.assertNotIn("documentId", blob)
        self.assertNotIn("\\\"body\\\"", blob)
        h1 = [op for op in ops if op.get("op") == "heading" and op.get("level") == "1"]
        self.assertEqual(len(h1), 1)
        self.assertIn("Thinking in Systems", h1[0]["text"])
        res = json.loads(out.getvalue())
        self.assertGreaterEqual(res["syncedNoteCount"], 1)
        entry_markers = [op for op in ops if op.get("op") == "heading" and op.get("level") == "2"]
        self.assertEqual(len(entry_markers), res["syncedNoteCount"])


class TestRateLimitBackoff(unittest.TestCase):
    def _runner(self, responses):
        calls = []

        def runner(cmd):
            calls.append(cmd)
            return responses[min(len(calls), len(responses)) - 1]

        return runner, calls

    def test_429_twice_then_ok_succeeds_with_1_2_backoff(self):
        runner, calls = self._runner(
            [
                (1, "", "HTTP 429 Too Many Requests"),
                (1, "", "RESOURCE_EXHAUSTED: quota"),
                (0, json.dumps({"values": [["id"]]}), ""),
            ]
        )
        sleeps: list = []
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=sleeps.append)
        self.assertEqual(backend._read_range("s", "Books!A:A"), [["id"]])
        self.assertEqual(sleeps, [1, 2])
        self.assertEqual(len(calls), 3)

    def test_persistent_rate_limit_raises_paste_card_error_after_three_attempts(self):
        runner, calls = self._runner([(1, "", "userRateLimitExceeded")])
        sleeps: list = []
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=sleeps.append)
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend._run_ok(["gsheets", "mutate", "raw-batch", "s", "-f", "x", "--json"])
        self.assertIn("Paste Card", str(ctx.exception))
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleeps, [1, 2])

    def test_non_rate_limit_errors_are_not_retried(self):
        runner, calls = self._runner([(1, "", "PERMISSION_DENIED: no access")])
        sleeps: list = []
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=sleeps.append)
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend._read_range("s", "Books!A:A")
        self.assertNotIn("Paste Card", str(ctx.exception))
        self.assertEqual(len(calls), 1)
        self.assertEqual(sleeps, [])


def _spoiler_state() -> dict:
    snap = _make_sample_snapshot()
    book = snap["books"][1]  # fiction "Exhalation"
    book["totalPos"] = 300
    book["currentPos"] = 100
    book["normalizedPos"] = 100 / 300
    note = next(n for n in snap["notes"] if n["id"] == "note-future-spoiler")
    note["pos"] = 250
    note["normalizedPos"] = 0  # stale: written while totalPos was 0
    return snap


class TestCliSpoilerParity(unittest.TestCase):
    def test_effective_note_norm_and_is_note_spoiler(self):
        snap = _spoiler_state()
        book = snap["books"][1]
        note = next(n for n in snap["notes"] if n["id"] == "note-future-spoiler")
        self.assertAlmostEqual(pragya_cli.effective_note_norm(note, book), 250 / 300)
        self.assertTrue(pragya_cli.is_note_spoiler(note, book))
        # No scale on the book → stored value / pos fallback unchanged.
        unscaled = dict(book, totalPos=0, posUnit="page")
        self.assertEqual(pragya_cli.effective_note_norm(note, unscaled), 0.0)
        self.assertTrue(pragya_cli.is_note_spoiler(note, unscaled))  # pos 250 > currentPos 100
        self.assertFalse(pragya_cli.is_note_spoiler(note, dict(book, status="finished")))

    def test_recall_qa_excludes_stale_norm_spoiler(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(_spoiler_state()), encoding="utf-8")
            rc, res, err = _run_cli_json(
                ["--state-file", str(path), "recall", "--mode", "qa", "--query", "QUANTUM_SPOILER_SECRET_77"]
            )
            self.assertEqual(rc, 0, err)
            self.assertEqual(res["matches"], [])
            self.assertGreaterEqual(res["excludedSpoilersCount"], 1)
            self.assertNotIn("QUANTUM_SPOILER_SECRET_77", json.dumps(res["matches"]))

    def test_reflect_stage1_on_spoiler_omits_position_and_title(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(_spoiler_state()), encoding="utf-8")
            rc, res, err = _run_cli_json(
                ["--state-file", str(path), "reflect", "--note", "future-ending-twist", "--stage", "1"]
            )
            self.assertEqual(rc, 0, err)
            self.assertTrue(res.get("spoilerGuarded"))
            # Fix-up (QA-8): assert over the WHOLE JSON output, not just the questions.
            blob = json.dumps(res)
            self.assertNotIn("p. 250", blob)
            self.assertNotIn("Future Ending Twist", blob)
            self.assertNotIn("future-ending-twist", blob)
            self.assertNotIn("slug", res)
            self.assertEqual(res["noteId"], "note-future-spoiler")
            self.assertIn("p. 100", json.dumps(res["socraticQuestions"]))  # bookmark ceiling is fine

    def test_reflect_stage1_spoiler_still_honors_overrides(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(_spoiler_state()), encoding="utf-8")
            rc, res, err = _run_cli_json(
                [
                    "--state-file", str(path), "reflect", "--note", "future-ending-twist",
                    "--stage", "1", "--q1", "Custom Q1?", "--q2", "Custom Q2?",
                ]
            )
            self.assertEqual(rc, 0, err)
            self.assertEqual(res["socraticQuestions"], ["Custom Q1?", "Custom Q2?"])
            self.assertTrue(res.get("spoilerGuarded"))

    def test_reflect_stage1_non_spoiler_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(_spoiler_state()), encoding="utf-8")
            rc, res, err = _run_cli_json(
                ["--state-file", str(path), "reflect", "--note", "memory-prism-digital-remembrance", "--stage", "1"]
            )
            self.assertEqual(rc, 0, err)
            self.assertNotIn("spoilerGuarded", res)
            self.assertEqual(res["slug"], "memory-prism-digital-remembrance")
            self.assertIn("p. 85", json.dumps(res["socraticQuestions"]))


class TestCarryForwards(unittest.TestCase):
    def test_qa6_numeric_fields_coerced_not_dropped(self):
        book = dict(_make_sample_snapshot()["books"][0], totalPos=float("nan"), currentPos=float("inf"))
        out = pragya_cli.normalize_book_dict(book)
        self.assertEqual(out["totalPos"], 0)
        self.assertEqual(out["currentPos"], 0)
        note = dict(_make_sample_snapshot()["notes"][0], pos="garbage")
        self.assertEqual(pragya_cli.normalize_note_dict(note)["pos"], 0)

    def test_non_string_spar_stage_parity_through_state_file(self):
        snap = _make_sample_snapshot()
        snap["notes"][0]["meta"]["sparStage"] = {"stage": 2, "asked": ["q1"]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(snap), encoding="utf-8")
            backend = pragya_cli.StateFileBackend(path)
            note = next(n for n in backend.load_workspace()["notes"] if n["id"] == snap["notes"][0]["id"])
            self.assertEqual(note["meta"]["sparStage"], {"stage": 2, "asked": ["q1"]})
            backend.save_note(note)
            stored = json.loads(path.read_text(encoding="utf-8"))
            snote = next(n for n in stored["notes"] if n["id"] == note["id"])
            self.assertEqual(snote["meta"]["sparStage"], {"stage": 2, "asked": ["q1"]})
            # Sheets row path too (parity with TS sparStage pass-through).
            row_note = pragya_cli.row_to_note(pragya_cli.note_to_row(note))
            self.assertEqual(row_note["meta"]["sparStage"], {"stage": 2, "asked": ["q1"]})


class TestFixUpRateLimitClassifier(unittest.TestCase):
    def test_positive_cases(self):
        for text in (
            "HTTP 429 Too Many Requests",
            "HTTP/1.1 429",
            "HTTP Error 429: quota",
            "status=429",
            "status code: 429",
            '{"error": {"code": 429, "message": "x"}}',
            "429",
            "429 Too Many Requests",
            "429: slow down",
            "RESOURCE_EXHAUSTED",
            '{"status":"RESOURCE_EXHAUSTED"}',
            "rateLimitExceeded",
            "userRateLimitExceeded",
            "quotaExceeded",
            "Quota exceeded for quota metric 'Write requests'",
            "RATE_LIMIT_EXCEEDED",
            "<HttpError 429 when requesting https://sheets.googleapis.com/v4/... returned \"x\">",
            "Resource has been exhausted (e.g. check quota).",
            "User rate limit exceeded.",
            '{"reason": "dailyLimitExceeded"}',
            '{"reason": "sharingRateLimitExceeded"}',
        ):
            with self.subTest(text=text):
                self.assertTrue(pragya_cli.is_rate_limited_output(text))

    def test_false_positive_cases(self):
        for text in (
            "PERMISSION_DENIED on doc 1a429bc0-1234-4429-8429-000000004290",
            "NOT_FOUND: Requested entity sheet-4291 was not found",
            "Unable to parse range: Notes!A1429",
            'Traceback (most recent call last):\n  File "x.py", line 429, in main',
            "INVALID_ARGUMENT: row 429 is out of range",
            "wrote 4290 bytes",
            "error 4291",
            "HTTP 4290",
            "429.5 seconds",
            # Batch 3 fix-up (R1#5): Drive full is not a rate limit.
            '{"reason": "storageQuotaExceeded"}',
            "storageQuotaExceeded",
        ):
            with self.subTest(text=text):
                self.assertFalse(pragya_cli.is_rate_limited_output(text))

    def test_false_positive_is_not_retried(self):
        calls = []

        def runner(cmd):
            calls.append(cmd)
            return 1, "", "PERMISSION_DENIED: no access to Notes!A1429 (request 7f429aa)"

        sleeps: list = []
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=sleeps.append)
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend._read_range("s", "Books!A:A")
        self.assertEqual(len(calls), 1)
        self.assertEqual(sleeps, [])
        self.assertNotIn("Paste Card", str(ctx.exception))

    def test_run_json_persistent_rate_limit_and_calm_wording(self):
        calls = []

        def runner(cmd):
            calls.append(cmd)
            return 1, "", "HTTP 429 Too Many Requests"

        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=lambda s: None)
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend._read_range("s", "Books!A:A")  # _run_json path
        msg = str(ctx.exception)
        self.assertEqual(len(calls), 3)
        first_line = msg.splitlines()[0]
        self.assertEqual(first_line, "Google is limiting requests right now. Try again in a minute.")
        self.assertNotIn("nothing was lost", msg)
        self.assertIn("may already be saved", msg)
        self.assertIn("duplicate note", msg)
        self.assertIn("Paste Card", msg)
        # Technical detail comes last.
        self.assertTrue(msg.splitlines()[-1].startswith("Details:"))
        self.assertIn("HTTP 429", msg.splitlines()[-1])

    def test_pattern_is_exported_for_ts_mirroring(self):
        import re as _re

        self.assertIsInstance(pragya_cli.RATE_LIMIT_PATTERN, str)
        self.assertEqual(pragya_cli.RATE_LIMIT_RE.flags & _re.IGNORECASE, _re.IGNORECASE)
        self.assertEqual(pragya_cli.RATE_LIMIT_RE.flags & _re.MULTILINE, _re.MULTILINE)
        # No Python-only syntax (lookbehind / named groups / inline flags) so JS can reuse it.
        for token in ("(?<", "(?P", "(?i", "(?m"):
            self.assertNotIn(token, pragya_cli.RATE_LIMIT_PATTERN)


class TestFixUpDocTextFallback(unittest.TestCase):
    MARKER_ID = "note-old-atomic"

    def _sync(self, doc_payload):
        snap = _make_sample_snapshot()
        snap["books"][0]["docUrl"] = "https://docs.google.com/document/d/doc-existing-1/edit"
        fake = FakeWorkspace(
            rows={
                "Books": [pragya_cli.BOOKS_HEADERS] + [pragya_cli.book_to_row(b) for b in snap["books"]],
                "Notes": [pragya_cli.NOTES_HEADERS] + [pragya_cli.note_to_row(n) for n in snap["notes"]],
                "Sessions": [pragya_cli.SESSIONS_HEADERS],
                "DeltaLogs": [pragya_cli.DELTA_LOGS_HEADERS],
            }
        )
        fake.doc_read_payload = doc_payload
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = pragya_cli.main(
                ["--spreadsheet-id", "sid-m6", "book-doc-sync", "--book", "book-systems"], runner=fake
            )
        self.assertEqual(rc, 0)
        return fake, json.loads(out.getvalue())

    def test_unknown_ast_shape_keeps_marker_dedup_and_no_second_header(self):
        payload = {
            "document": {
                "body": {"content": [{"weird": {"text": f"## Delays [note:{self.MARKER_ID}]"}}]}
            }
        }
        fake = FakeWorkspace()
        fake.doc_read_payload = payload
        read = _backend(fake).read_doc_text("doc-existing-1")
        self.assertIn(f"[note:{self.MARKER_ID}]", read)
        fake, res = self._sync(payload)
        # The marker-bearing note is deduped; only the genuinely missing atomic note is added.
        self.assertNotIn(self.MARKER_ID, res["syncedNoteIds"])
        self.assertEqual(res["syncedNoteIds"], ["note-old-eligible"])
        ops = [op for batch in fake.doc_batches for op in batch]
        self.assertFalse(any(op.get("op") == "heading" and op.get("level") == "1" for op in ops))
        self.assertNotIn(f"[note:{self.MARKER_ID}]", json.dumps(ops))

    def test_table_only_doc_emits_no_header(self):
        payload = {
            "documentId": "doc-existing-1",
            "body": {
                "content": [
                    {"sectionBreak": {}},
                    {"table": {"tableRows": [{"tableCells": [{"content": []}]}]}},
                ]
            },
        }
        fake = FakeWorkspace()
        fake.doc_read_payload = payload
        self.assertNotEqual(_backend(fake).read_doc_text("doc-existing-1").strip(), "")
        fake, res = self._sync(payload)
        ops = [op for batch in fake.doc_batches for op in batch]
        self.assertFalse(any(op.get("op") == "heading" and op.get("level") == "1" for op in ops))
        self.assertEqual(
            len([op for op in ops if op.get("op") == "heading" and op.get("level") == "2"]),
            res["syncedNoteCount"],
        )

    def test_metadata_only_response_falls_back_and_never_adds_header(self):
        payload = {"documentId": "doc-existing-1", "title": "Pragya · Thinking in Systems"}
        fake = FakeWorkspace()
        fake.doc_read_payload = payload
        read = _backend(fake).read_doc_text("doc-existing-1")
        self.assertEqual(json.loads(read), payload)
        fake, _res = self._sync(payload)
        ops = [op for batch in fake.doc_batches for op in batch]
        self.assertFalse(any(op.get("op") == "heading" and op.get("level") == "1" for op in ops))

    def test_inline_object_only_paragraph_is_not_empty(self):
        payload = {
            "documentId": "d",
            "body": {"content": [{"paragraph": {"elements": [{"inlineObjectElement": {"inlineObjectId": "i"}}]}}]},
        }
        self.assertFalse(pragya_cli._is_recognizably_empty_gdoc(payload))

    def test_recognizably_empty_shapes(self):
        for payload in (
            {"documentId": "d", "body": {"content": []}},
            {"documentId": "d", "body": {"content": [{"sectionBreak": {}}, {"paragraph": {"elements": [{"textRun": {"content": "\n"}}]}}]}},
            {"documentId": "d", "tabs": [{"documentTab": {"body": {"content": [{"sectionBreak": {}}]}}, "childTabs": []}]},
        ):
            with self.subTest(payload=payload):
                self.assertTrue(pragya_cli._is_recognizably_empty_gdoc(payload))
        for payload in (
            {"document": {"body": {"content": []}}},  # unknown wrapper
            {"body": {"content": []}},  # no documentId
            {"documentId": "d", "tabs": [{"childTabs": []}]},  # tab without documentTab body
            {"documentId": "d"},  # metadata-only: no body found at all (R2-b)
            {"documentId": "d", "title": "T", "tabs": []},  # no bodies found
        ):
            with self.subTest(payload=payload):
                self.assertFalse(pragya_cli._is_recognizably_empty_gdoc(payload))


class TestFixUpSheetIds(unittest.TestCase):
    def test_sheet_id_zero_and_top_level_shape(self):
        payload = json.dumps(
            [
                {"title": "Books", "sheetId": 0},
                {"title": "Notes", "sheetId": 7},
                {"properties": {"title": "Sessions", "sheetId": 0.0}},
                {"properties": {"title": "DeltaLogs", "sheetId": "9"}},
            ]
        )
        fake = FakeWorkspace(list_sheets_payload=payload)
        backend = _backend(fake)
        backend.ensure_schema()
        self.assertEqual(backend._sheet_ids, {"Books": 0, "Notes": 7, "Sessions": 0, "DeltaLogs": 9})
        backend.save_book(dict(_make_sample_snapshot()["books"][0], id="book-new"))
        req = fake.raw_payloads[-1]["requests"][0]["appendCells"]
        self.assertEqual(req["sheetId"], 0)

    def test_bool_sheet_id_is_ignored(self):
        payload = json.dumps([{"title": t, "sheetId": True} for t in ALL_TABS])
        fake = FakeWorkspace(list_sheets_payload=payload)
        with self.assertRaises(pragya_cli.CliError):
            _backend(fake).save_note(_note(id="n-x", slug="n-x"))
        self.assertEqual(fake.raw_payloads, [])


class TestUnguardedRowIdReread(unittest.TestCase):
    """Batch 3 carry-forward R1#6: --force / Sessions / DeltaLogs updates re-read the id cell."""

    def test_force_update_follows_shifted_row(self):
        fake = FakeWorkspace()
        backend = _backend(fake)
        ws = backend.load_workspace()
        target = copy.deepcopy(ws["notes"][2])  # A:A says row 4
        shifted = list(fake.rows["Notes"])
        shifted.insert(1, ["inserted"] + [""] * 17)

        def single(tab):
            if tab == "Notes":
                # The row shifts after the A:A read; the A:A re-scan then sees it too.
                fake.rows["Notes"] = shifted
                return shifted
            return fake.rows[tab]

        fake.single_cell_rows = single
        target["takeaway"] = "forced"
        backend.save_note(target, expected_base_updated_at=target["updatedAt"], force=True)
        req = fake.raw_payloads[-1]["requests"][0]["updateCells"]
        self.assertEqual(req["range"]["startRowIndex"], 4)
        self.assertTrue(any(c[4] == "Notes!A4" for c in fake.calls if c[:3] == ["gsheets", "readonly", "read"]))

    def test_session_update_with_vanished_id_writes_nothing(self):
        fake = FakeWorkspace()
        session = {
            "id": "sess-1",
            "bookId": "book-systems",
            "date": "2026-11-16",
            "startPos": 1,
            "endPos": 2,
            "updatedAt": "2026-11-16T10:00:00.000Z",
            "note": "",
        }
        fake.rows["Sessions"] = [pragya_cli.SESSIONS_HEADERS, pragya_cli.session_to_row(session)]
        backend = _backend(fake)
        state = {"n": 0}
        original_rows = fake.rows["Sessions"]

        def single(tab):
            if tab == "Sessions":
                # Row deleted (PWA deleteSession) between A:A and the write.
                fake.rows["Sessions"] = [pragya_cli.SESSIONS_HEADERS]
                state["n"] += 1
                return fake.rows["Sessions"]
            return fake.rows[tab]

        fake.single_cell_rows = single
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend.save_session(dict(session, endPos=5))
        self.assertIn("moved or was deleted", str(ctx.exception))
        self.assertEqual(fake.raw_payloads, [])
        self.assertEqual(state["n"], 1)
        self.assertIsNot(original_rows, fake.rows["Sessions"])

    def test_session_update_in_place_still_writes(self):
        fake = FakeWorkspace()
        session = {
            "id": "sess-1",
            "bookId": "book-systems",
            "date": "2026-11-16",
            "startPos": 1,
            "endPos": 2,
            "updatedAt": "2026-11-16T10:00:00.000Z",
            "note": "",
        }
        fake.rows["Sessions"] = [pragya_cli.SESSIONS_HEADERS, pragya_cli.session_to_row(session)]
        _backend(fake).save_session(dict(session, endPos=9))
        req = fake.raw_payloads[-1]["requests"][0]["updateCells"]
        self.assertEqual(req["range"]["startRowIndex"], 1)
        self.assertEqual(fake.write_ops[-1]["data"][0][4], 9)


if __name__ == "__main__":
    unittest.main()
