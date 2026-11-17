"""QA (Batch 2) adversarial probes for CLI data integrity.

Passing tests lock in verified behavior. The ``test_bug_qa7``/``test_bug_qa8`` cases were
``unittest.expectedFailure`` regressions from team/batch2_qa_report.md; both are fixed in
the Batch 2 fix-up and now run as normal tests.
Offline only: injected fake runners / temp --state-file.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from test_pragya_cli import _make_sample_snapshot, _run_cli_json, pragya_cli
from test_pragya_cli_m6_integrity import (
    ALL_TABS,
    FakeWorkspace,
    _backend,
    _note,
    _spoiler_state,
)


def _cell(value):
    return pragya_cli._raw_cell(value)["userEnteredValue"]


def _raw_requests(fake: FakeWorkspace) -> list[dict]:
    return [r for p in fake.raw_payloads for r in p["requests"]]


class TestQaRawCellTyping(unittest.TestCase):
    def test_value_matrix(self):
        cases = [
            (0, {"numberValue": 0}),
            (42, {"numberValue": 42}),
            (-3.5, {"numberValue": -3.5}),
            (0.333333, {"numberValue": 0.333333}),
            (True, {"stringValue": "true"}),
            (False, {"stringValue": "false"}),
            (None, {"stringValue": ""}),
            (float("nan"), {"stringValue": ""}),
            (float("inf"), {"stringValue": ""}),
            ("", {"stringValue": ""}),
            ("007", {"stringValue": "007"}),
            ("42", {"stringValue": "42"}),
            ("1e3", {"stringValue": "1e3"}),
            ("=SUM(1,2)", {"stringValue": "=SUM(1,2)"}),
            ("+10%", {"stringValue": "+10%"}),
            ("-5", {"stringValue": "-5"}),
            ("- bullet", {"stringValue": "- bullet"}),
            ("@mention", {"stringValue": "@mention"}),
            ("'quoted", {"stringValue": "'quoted"}),
            ("2026-11-16", {"stringValue": "2026-11-16"}),
            ("2026-11-16T08:00:00.000Z", {"stringValue": "2026-11-16T08:00:00.000Z"}),
            ("TRUE", {"stringValue": "TRUE"}),
            ("पढ़ना 📚", {"stringValue": "पढ़ना 📚"}),
        ]
        for value, expected in cases:
            self.assertEqual(_cell(value), expected, repr(value))
            # Exactly one of stringValue/numberValue; never formulaValue/boolValue.
            self.assertEqual(len(_cell(value)), 1)

    def test_payload_is_strict_json_and_numbers_stay_numbers(self):
        fake = FakeWorkspace()
        backend = _backend(fake)
        note = _note(
            id="qa-typing",
            slug="qa-typing",
            quote="=HYPERLINK(\"http://x\")",
            takeaway="@channel 007",
            contextMechanism="+1 -1",
            critique="2026-11-16",
            tags=["#a"],
            pos=12,
            normalizedPos=0.04,
        )
        backend.save_note(note)
        reqs = _raw_requests(fake)
        self.assertEqual(len(reqs), 1)
        self.assertIn("appendCells", reqs[0])
        vals = [v["userEnteredValue"] for v in reqs[0]["appendCells"]["rows"][0]["values"]]
        self.assertEqual(len(vals), len(pragya_cli.NOTES_HEADERS))
        self.assertEqual(vals[5], {"numberValue": 12})
        self.assertEqual(vals[6], {"numberValue": 0.04})
        for idx in (0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17):
            self.assertIn("stringValue", vals[idx], f"col {idx}")
        self.assertEqual(vals[10], {"stringValue": "=HYPERLINK(\"http://x\")"})
        self.assertEqual(vals[11], {"stringValue": "@channel 007"})
        self.assertEqual(vals[13], {"stringValue": "2026-11-16"})
        json.loads(json.dumps(fake.raw_payloads[0]), parse_constant=lambda t: (_ for _ in ()).throw(ValueError(t)))
        self.assertFalse(any(c[:3] == ["gsheets", "mutate", "batch"] for c in fake.calls))

    def test_book_numeric_columns_are_numbers(self):
        fake = FakeWorkspace()
        book = _make_sample_snapshot()["books"][0]
        _backend(fake).save_book(book)
        req = _raw_requests(fake)[0]
        body = req.get("updateCells") or req.get("appendCells")
        vals = [v["userEnteredValue"] for v in body["rows"][0]["values"]]
        for idx in (6, 7, 9):
            self.assertIn("numberValue", vals[idx], f"Books col {idx}")
        self.assertIn("stringValue", vals[11])
        self.assertEqual(json.loads(vals[11]["stringValue"])["updatedAt"], book["meta"]["updatedAt"])


class TestQaSheetIdMapping(unittest.TestCase):
    def _payload(self, sheets):
        return json.dumps({"sheets": [{"properties": p} for p in sheets]})

    def test_sheet_id_zero_is_valid(self):
        sheets = [{"title": t, "sheetId": i} for i, t in enumerate(ALL_TABS)]  # Books == 0
        fake = FakeWorkspace(list_sheets_payload=self._payload(sheets))
        _backend(fake).save_book(_make_sample_snapshot()["books"][0])
        req = _raw_requests(fake)[0]
        body = req.get("updateCells", {}).get("range") or req.get("appendCells")
        self.assertEqual(body["sheetId"], 0)

    def test_string_sheet_id_is_coerced(self):
        sheets = [{"title": t, "sheetId": str(100 + i)} for i, t in enumerate(ALL_TABS)]
        fake = FakeWorkspace(list_sheets_payload=self._payload(sheets))
        _backend(fake).save_note(_note(id="qa-sid", slug="qa-sid"))
        self.assertEqual(_raw_requests(fake)[0]["appendCells"]["sheetId"], 101)

    def test_missing_or_garbage_sheet_id_errors_without_writing(self):
        for bad in (None, "abc", True, {"x": 1}):
            sheets = [{"title": t, "sheetId": (bad if t == "Notes" else i)} for i, t in enumerate(ALL_TABS)]
            if bad is None:
                sheets = [{"title": t} if t == "Notes" else {"title": t, "sheetId": i} for i, t in enumerate(ALL_TABS)]
            fake = FakeWorkspace(list_sheets_payload=self._payload(sheets))
            with self.assertRaises(pragya_cli.CliError) as ctx:
                _backend(fake).save_note(_note(id="qa-x", slug="qa-x"))
            self.assertIn("sheetId", str(ctx.exception))
            self.assertEqual(fake.raw_payloads, [], repr(bad))


class TestQaRowShiftGuard(unittest.TestCase):
    def _fake_with_note_at(self, note_id: str):
        fake = FakeWorkspace()
        ids = [r[0] for r in fake.rows["Notes"]]
        self.assertIn(note_id, ids)
        return fake, ids.index(note_id) + 1

    def test_duplicate_ids_target_first_occurrence(self):
        fake = FakeWorkspace()
        notes = fake.rows["Notes"]
        dup = list(notes[1])
        notes.append(dup)  # same UUID again at the bottom
        note = pragya_cli.row_to_note(notes[1])
        _backend(fake).save_note(note, expected_base_updated_at=note["updatedAt"])
        req = _raw_requests(fake)[0]["updateCells"]["range"]
        self.assertEqual(req["startRowIndex"], 1)  # row 2 (first occurrence), not the duplicate

    def test_shift_and_delete_during_write(self):
        fake = FakeWorkspace()
        target = pragya_cli.row_to_note(fake.rows["Notes"][2])
        shifted = [fake.rows["Notes"][0], ["inserted-row"]] + fake.rows["Notes"][1:]
        fake.full_read_override = lambda tab, n: shifted if tab == "Notes" else None
        _backend(fake).save_note(target, expected_base_updated_at=target["updatedAt"])
        self.assertEqual(_raw_requests(fake)[0]["updateCells"]["range"]["startRowIndex"], 3)

        fake2 = FakeWorkspace()
        target2 = pragya_cli.row_to_note(fake2.rows["Notes"][2])
        gone = [r for r in fake2.rows["Notes"] if r[0] != target2["id"]]
        fake2.full_read_override = lambda tab, n: gone if tab == "Notes" else None
        with self.assertRaises(pragya_cli.CliError):
            _backend(fake2).save_note(target2, expected_base_updated_at=target2["updatedAt"])
        self.assertEqual(fake2.raw_payloads, [])

    def test_id_matching_is_whitespace_tolerant(self):
        fake = FakeWorkspace()
        target = pragya_cli.row_to_note(fake.rows["Notes"][1])
        padded = [list(r) for r in fake.rows["Notes"]]
        padded[1][0] = f"  {padded[1][0]} "
        fake.full_read_override = lambda tab, n: padded if tab == "Notes" else None
        _backend(fake).save_note(target, expected_base_updated_at=target["updatedAt"])
        self.assertEqual(_raw_requests(fake)[0]["updateCells"]["range"]["startRowIndex"], 1)


class TestQaRateLimitRetry(unittest.TestCase):
    def _runner(self, script):
        calls: list = []
        seq = list(script)

        def runner(cmd):
            calls.append(cmd)
            return seq.pop(0) if len(seq) > 1 else seq[0]

        return runner, calls

    def test_quota_markers_in_stdout_or_stderr_are_retried(self):
        for out, err in (("", "RESOURCE_EXHAUSTED"), ('{"error":{"status":"RESOURCE_EXHAUSTED"}}', ""),
                         ("", "userRateLimitExceeded"), ("", "quotaExceeded"), ("", "HTTP 429 Too Many")):
            runner, calls = self._runner([(1, out, err)])
            sleeps: list = []
            backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=sleeps.append)
            with self.assertRaises(pragya_cli.CliError) as ctx:
                backend._read_range("s", "Books!A:A")
            self.assertIn("Paste Card", str(ctx.exception))
            self.assertEqual(len(calls), 3)
            self.assertEqual(sleeps, [1, 2])

    def test_success_output_mentioning_429_is_not_retried(self):
        runner, calls = self._runner([(0, json.dumps({"values": [["id"], ["note-429"]]}), "")])
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=lambda s: None)
        self.assertEqual(backend._read_range("s", "Books!A:A"), [["id"], ["note-429"]])
        self.assertEqual(len(calls), 1)

    def test_rate_limit_then_hard_error_stops_immediately(self):
        runner, calls = self._runner([(1, "", "429"), (1, "", "PERMISSION_DENIED")])
        sleeps: list = []
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=sleeps.append)
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend._read_range("s", "Books!A:A")
        self.assertNotIn("Paste Card", str(ctx.exception))
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [1])

    def test_bug_qa7_bare_429_substring_in_non_quota_error_is_retried(self):
        """QA-7: RATE_LIMIT_RE matches a bare '429' anywhere, e.g. a spreadsheet id, row
        number or range in a PERMISSION_DENIED / NOT_FOUND message -> 3 attempts, 3 s of
        sleeps and a misleading 'rate limit / Paste Card' error."""
        runner, calls = self._runner([(1, "", "NOT_FOUND: Requested entity sheet-4291 was not found")])
        sleeps: list = []
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="s", runner=runner, sleep=sleeps.append)
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend._read_range("s", "Books!A:A")
        self.assertEqual(len(calls), 1)
        self.assertNotIn("Paste Card", str(ctx.exception))


class TestQaOcrGuardAndEmptyDoc(unittest.TestCase):
    def test_ocr_text_guard_variants(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")
            before = path.read_bytes()
            for argv in (["--ocr-text", "X"], ["--ocr-text", "X", "--note", "   "]):
                rc, res, _err = _run_cli_json(["--state-file", str(path), "ocr-backfill", *argv])
                self.assertNotEqual(rc, 0, argv)
                self.assertIn("--note", json.dumps(res))
            # Whitespace-only --ocr-text with no --note: allowed, but must not touch any note.
            rc, _res, err = _run_cli_json(["--state-file", str(path), "ocr-backfill", "--ocr-text", "   "])
            self.assertEqual(rc, 0, err)
            after = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(
                [n.get("quote") for n in after["notes"]],
                [n.get("quote") for n in json.loads(before)["notes"]],
            )

    def test_empty_doc_shapes_read_as_blank(self):
        shapes = [
            {"documentId": "x", "body": {"content": []}},
            {"documentId": "x", "body": {"content": [{"sectionBreak": {}}]}},
        ]
        for payload in shapes:
            fake = FakeWorkspace()
            fake.doc_read_payload = payload
            text = _backend(fake).read_doc_text("x")
            self.assertEqual(text.strip(), "", payload)
            self.assertNotIn("documentId", text)
        # Decision R2-b: metadata-only shapes (no body / empty tabs) are NOT provably
        # empty -> non-empty JSON fallback, so book-doc-sync never writes a second H1.
        for payload in ({"documentId": "x"}, {"documentId": "x", "tabs": []}):
            fake = FakeWorkspace()
            fake.doc_read_payload = payload
            text = _backend(fake).read_doc_text("x")
            self.assertNotEqual(text.strip(), "", payload)
            self.assertEqual(json.loads(text), payload)

    def test_single_newline_paragraph_is_blank(self):
        fake = FakeWorkspace()
        fake.doc_read_payload = {
            "documentId": "x",
            "body": {"content": [{"paragraph": {"elements": [{"textRun": {"content": "\n"}}]}}]},
        }
        self.assertEqual(_backend(fake).read_doc_text("x").strip(), "")


class TestQaReflectSpoilerGuard(unittest.TestCase):
    def _reflect(self, snap, note_ref):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(snap), encoding="utf-8")
            rc, res, err = _run_cli_json(["--state-file", str(path), "reflect", "--note", note_ref, "--stage", "1"])
            self.assertEqual(rc, 0, err)
            stored = json.loads(path.read_text(encoding="utf-8"))
            return res, stored

    def test_questions_and_stored_meta_have_no_position_title_or_secret(self):
        snap = _spoiler_state()
        note = next(n for n in snap["notes"] if n["id"] == "note-future-spoiler")
        note.setdefault("meta", {})["title"] = "The Twist Reveal"
        res, stored = self._reflect(snap, "note-future-spoiler")
        self.assertTrue(res.get("spoilerGuarded"))
        stored_q = next(n for n in stored["notes"] if n["id"] == "note-future-spoiler")["meta"]["socraticQuestions"]
        for blob in (json.dumps(res["socraticQuestions"]), json.dumps(stored_q)):
            for leak in ("250", "Twist Reveal", "future-ending-twist", "QUANTUM_SPOILER_SECRET_77", "83%"):
                self.assertNotIn(leak, blob)

    def test_percent_book_spoiler_is_guarded(self):
        snap = _spoiler_state()
        book = snap["books"][1]
        book.update(posUnit="percent", totalPos=0, currentPos=20, normalizedPos=0.2)
        note = next(n for n in snap["notes"] if n["id"] == "note-future-spoiler")
        note.update(pos=90, normalizedPos=0)
        res, _ = self._reflect(snap, "note-future-spoiler")
        self.assertTrue(res.get("spoilerGuarded"))
        self.assertNotIn("90%", json.dumps(res["socraticQuestions"]))

    def test_bug_qa8_stage1_json_echoes_slug_of_spoiler_note(self):
        """QA-8: the stage-1 result still includes "slug" for a spoiler-guarded note.
        Slugs are derived from titles, so an agent calling by UUID receives the
        title words (e.g. 'future-ending-twist') in the JSON output."""
        res, _ = self._reflect(_spoiler_state(), "note-future-spoiler")
        self.assertTrue(res.get("spoilerGuarded"))
        self.assertNotIn("future-ending-twist", json.dumps(res))


class TestQaCleanNum(unittest.TestCase):
    def test_matrix(self):
        cases = [
            ("12", 12), (" 5 ", 5), ("1e3", 1000), ("12.5", 12.5), (-0.0, 0), (True, 1),
            ("abc", 0), ("", 0), (None, 0), ([], 0), ("0x10", 0), ("inf", 0), ("-Infinity", 0),
            ("nan", 0), (float("nan"), 0), (7, 7), (7.0, 7),
        ]
        for raw, expected in cases:
            got = pragya_cli.clean_num(raw, 0)
            self.assertEqual(got, expected, repr(raw))
            self.assertIsInstance(got, (int, float))
        self.assertIsInstance(pragya_cli.clean_num("7.0", 0), int)

    def test_state_file_dicts_coerce_numeric_fields(self):
        book = dict(_make_sample_snapshot()["books"][0], currentPos="42", totalPos=float("inf"), normalizedPos="x")
        out = pragya_cli.normalize_book_dict(book)
        self.assertEqual((out["currentPos"], out["totalPos"], out["normalizedPos"]), (42, 0, 0.0))
        note = dict(_make_sample_snapshot()["notes"][0], pos="nan")
        self.assertEqual(pragya_cli.normalize_note_dict(note)["pos"], 0)


if __name__ == "__main__":
    unittest.main()


class TestQaReverifyFixUp(unittest.TestCase):
    """QA re-verify of the Batch 2 fix-up (regex, wording, read_doc_text emptiness)."""

    def test_rate_limit_classifier_positive_and_negative(self):
        positives = [
            '{"error":{"code":429,"message":"x","status":"RESOURCE_EXHAUSTED"}}',
            '{"error": {"code": 429, "message": "Rate Limit Exceeded"}}',
            "HTTP/1.1 429", "Error: 429", "status code: 429", "Request failed with status code 429",
            "API Error 429: slow down", "429", "  429 Too Many Requests", "quota exceeded for metric",
            "reason: userRateLimitExceeded",
        ]
        negatives = [
            "NOT_FOUND: sheet-4291", "Notes!A429", "row 429", "note 6f1a4290-aaaa", "error 4291",
            "PERMISSION_DENIED", "Unable to parse range: Notes!A1:R429", "429.5 seconds", "Code: 4290",
        ]
        for s in positives:
            self.assertTrue(pragya_cli.is_rate_limited_output(s), s)
        for s in negatives:
            self.assertFalse(pragya_cli.is_rate_limited_output(s), s)

    def test_bug_qa9_googleapiclient_httperror_429_without_token_is_not_retried(self):
        """QA-9: the googleapiclient form `<HttpError 429 when requesting … returned
        "Resource has been exhausted (e.g. check quota).">` has no status token, and
        `HttpError` gives `\\bHTTP` no word boundary, so it is classified as a hard error."""
        msg = (
            '<HttpError 429 when requesting https://sheets.googleapis.com/v4/spreadsheets/x '
            'returned "Resource has been exhausted (e.g. check quota).". Details: '
            '"Resource has been exhausted (e.g. check quota).">'
        )
        self.assertTrue(pragya_cli.is_rate_limited_output(msg))

    def test_retry_exhausted_wording_order_and_paste_card(self):
        backend = pragya_cli.GoogleWorkspaceBackend(
            spreadsheet_id="s", runner=lambda cmd: (1, "", "RESOURCE_EXHAUSTED"), sleep=lambda s: None
        )
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend._read_range("s", "Books!A:A")
        lines = str(ctx.exception).splitlines()
        self.assertTrue(lines[0].startswith("Google is limiting requests right now."))
        self.assertIn("Paste Card", str(ctx.exception))
        self.assertIn("duplicate", str(ctx.exception))
        self.assertTrue(lines[-1].startswith("Details: "))
        self.assertIn("RESOURCE_EXHAUSTED", lines[-1])

    def test_retry_exhausted_on_write_path_writes_nothing_extra(self):
        fake = FakeWorkspace()
        attempts = {"n": 0}
        base = fake.__call__

        def runner(cmd):
            if cmd[:3] == ["gsheets", "mutate", "raw-batch"]:
                attempts["n"] += 1
                return 1, "", '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'
            return base(cmd)

        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="sid-m6", runner=runner, sleep=lambda s: None)
        with self.assertRaises(pragya_cli.CliError):
            backend.save_note(_note(id="qa-rl", slug="qa-rl"))
        self.assertEqual(attempts["n"], 3)

    def _read(self, payload):
        fake = FakeWorkspace()
        fake.doc_read_payload = payload
        return _backend(fake).read_doc_text("x")

    def test_real_world_empty_doc_shapes_are_blank(self):
        empty_para = {"paragraph": {"elements": [{"textRun": {"content": "   "}}]}}
        shapes = [
            {"documentId": "x", "title": "T", "revisionId": "r", "suggestionsViewMode": "SUGGESTIONS_INLINE",
             "documentStyle": {"pageSize": {}}, "namedStyles": {"styles": []},
             "body": {"content": [{"sectionBreak": {}}, empty_para]}},
            {"documentId": "x", "title": "T", "tabs": [{"tabProperties": {"tabId": "t.0"},
             "documentTab": {"body": {"content": [{"sectionBreak": {}}]}, "documentStyle": {}},
             "childTabs": [{"tabProperties": {}, "documentTab": {"body": {"content": []}}}]}]},
        ]
        for payload in shapes:
            self.assertEqual(self._read(payload).strip(), "", payload)

    def test_unknown_or_non_empty_shapes_fall_back_to_marker_searchable_text(self):
        marker = "[note:11111111-2222-3333-4444-555555555555]"
        wrapped = {"document": {"documentId": "x", "body": {"content": [
            {"paragraph": {"elements": [{"textRun": {"content": marker}}]}}]}}}
        out = self._read(wrapped)
        self.assertIn(marker, out)
        unknown_key = {"documentId": "x", "body": {"content": []}, "url": "https://docs/x"}
        self.assertNotEqual(self._read(unknown_key).strip(), "")
        no_id = {"body": {"content": []}}
        self.assertNotEqual(self._read(no_id).strip(), "")
        table_only = {"documentId": "x", "body": {"content": [{"table": {"tableRows": []}}]}}
        self.assertNotEqual(self._read(table_only).strip(), "")


class TestQaBatch3OneCellReread(unittest.TestCase):
    """QA (Batch 3) R1#6: one-cell id re-read on unguarded paths."""

    def _session(self, sid="sess-q", end=2):
        return {"id": sid, "bookId": "book-systems", "date": "2026-11-16", "startPos": 1,
                "endPos": end, "updatedAt": "2026-11-16T10:00:00.000Z", "note": ""}

    def test_append_never_does_a_one_cell_read(self):
        fake = FakeWorkspace()
        _backend(fake).save_session(self._session("brand-new"))
        reads = [c[4] for c in fake.calls if c[:3] == ["gsheets", "readonly", "read"]]
        self.assertFalse(any(r.startswith("Sessions!A") and r[len("Sessions!A"):].isdigit() for r in reads), reads)
        self.assertIn("appendCells", fake.raw_payloads[-1]["requests"][0])

    def test_trailing_row_deleted_then_reappended_elsewhere_retargets(self):
        fake = FakeWorkspace()
        s = self._session()
        other = self._session("other")
        fake.rows["Sessions"] = [pragya_cli.SESSIONS_HEADERS, pragya_cli.session_to_row(s)]
        moved = [pragya_cli.SESSIONS_HEADERS, pragya_cli.session_to_row(other), pragya_cli.session_to_row(s)]

        def single(tab):
            if tab == "Sessions":
                fake.rows["Sessions"] = moved
                return moved
            return fake.rows[tab]

        fake.single_cell_rows = single
        _backend(fake).save_session(dict(s, endPos=7))
        req = fake.raw_payloads[-1]["requests"][0]["updateCells"]
        self.assertEqual(req["range"]["startRowIndex"], 2)

    def test_deltalog_update_with_blank_id_cell_and_no_match_errors_without_write(self):
        fake = FakeWorkspace()
        log = {"id": "dl-1", "noteId": "n", "date": "2026-11-16", "outcome": "applied", "reflection": ""}
        fake.rows["DeltaLogs"] = [pragya_cli.DELTA_LOGS_HEADERS, pragya_cli.delta_log_to_row(log)]

        def single(tab):
            if tab == "DeltaLogs":
                fake.rows["DeltaLogs"] = [pragya_cli.DELTA_LOGS_HEADERS, ["", "", "", "", ""]]
                return fake.rows["DeltaLogs"]
            return fake.rows[tab]

        fake.single_cell_rows = single
        backend = _backend(fake)
        save = getattr(backend, "save_delta_log", None)
        if save is None:
            self.skipTest("no save_delta_log on backend")
        with self.assertRaises(pragya_cli.CliError):
            save(dict(log, reflection="x"))
        self.assertEqual(fake.raw_payloads, [])
