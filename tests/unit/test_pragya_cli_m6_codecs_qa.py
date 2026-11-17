"""QA (Batch 1) adversarial probes for the M6 Python drift codecs.

Passing tests lock in verified behavior. The ``test_bug_qa*`` cases were ``unittest.expectedFailure`` regressions for the
open bugs in team/batch1_qa_report.md; all five are fixed in the Batch 1 fix-up.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from test_pragya_cli import _make_sample_snapshot, _run_cli_json, pragya_cli


def _book(**overrides):
    base = {
        "id": "qa-book",
        "title": "QA Book",
        "author": "A",
        "format": "physical",
        "kind": "nonfiction",
        "status": "reading",
        "currentPos": 10,
        "totalPos": 100,
        "posUnit": "page",
        "normalizedPos": 0.1,
        "docUrl": "",
        "meta": {"updatedAt": "2026-11-01T00:00:00.000Z"},
    }
    base.update(overrides)
    return base


def _note_row(meta_cell, *, pos=5, norm=0.05, created="", updated=""):
    return [
        "qa-note", "qa-slug", "qa-book", created, updated, pos, norm,
        "saved", "companion", "", "", "", "", "", "", "", "none", meta_cell,
    ]


def _state_with(books, notes=None):
    snap = _make_sample_snapshot()
    snap["books"] = books
    snap["notes"] = notes or []
    snap["sessions"] = []
    snap["deltaLogs"] = []
    return snap


class TestQaStateFileDrift(unittest.TestCase):
    def _write(self, tmp: str, snap: dict) -> Path:
        path = Path(tmp) / "state.json"
        path.write_text(json.dumps(snap), encoding="utf-8")
        return path

    def test_missing_or_null_meta_loads_and_updates(self):
        books = [_book(id="b-null", meta=None), _book(id="b-missing")]
        del books[1]["meta"]
        notes = [{"id": "n1", "slug": "n1", "bookId": "b-null", "pos": 1, "status": "bogus",
                  "source": "Companion", "tags": [], "updatedAt": ""}]
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, _state_with(books, notes))
            ws = pragya_cli.StateFileBackend(path).load_workspace()
            self.assertEqual(ws["books"][0]["meta"], {"updatedAt": ""})
            self.assertEqual(ws["books"][1]["meta"], {"updatedAt": ""})
            self.assertEqual(ws["notes"][0]["meta"], {"attachments": [], "links": []})
            self.assertEqual(ws["notes"][0]["source"], "agent")
            self.assertEqual(ws["notes"][0]["status"], "saved")
            for bid in ("b-null", "b-missing"):
                rc, res, err = _run_cli_json(
                    ["--state-file", str(path), "book-update", "--book", bid, "--title", "T2"]
                )
                self.assertEqual(rc, 0, err)
            stored = json.loads(path.read_text(encoding="utf-8"))
            for b in stored["books"]:
                self.assertEqual(b["title"], "T2")
                self.assertTrue(b["meta"]["updatedAt"])

    def test_unknown_top_level_and_meta_keys_survive_update_cycle(self):
        book = _book(
            format="Hardcover",
            meta={
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "subgenre": "memoir",
                "chapterNote": "Ch 2",
                "capstone": {"arcOrThesis": "A", "keyLearnings": "k", "v": 3},
                "agentState": {"nested": [1, {"x": None}]},
                "__proto__": {"p": 1},
            },
            customTopLevel={"keep": True},
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, _state_with([book]))
            rc, res, err = _run_cli_json(
                ["--state-file", str(path), "book-update", "--book", "qa-book", "--title", "T3"]
            )
            self.assertEqual(rc, 0, err)
            stored = json.loads(path.read_text(encoding="utf-8"))["books"][0]
            self.assertEqual(stored["format"], "physical")
            self.assertEqual(stored["customTopLevel"], {"keep": True})
            meta = stored["meta"]
            self.assertEqual(meta["subgenre"], "memoir")
            self.assertEqual(meta["currentChapter"], "Ch 2")
            self.assertNotIn("chapterNote", meta)
            # Fix-up decision: capstone is stored verbatim; the typed accessor coerces.
            self.assertEqual(meta["capstone"]["keyLearnings"], "k")
            self.assertEqual(pragya_cli.get_book_capstone(meta)["keyLearnings"], ["k"])
            self.assertEqual(meta["capstone"]["v"], 3)
            self.assertEqual(meta["agentState"], {"nested": [1, {"x": None}]})
            self.assertEqual(meta["__proto__"], {"p": 1})
            self.assertNotEqual(meta["updatedAt"], "2026-11-01T00:00:00.000Z")

    def test_state_file_conflict_guard_still_fires_with_normalized_load(self):
        """Normalization must not disable the conflict guard on a real base."""
        backend_path = None
        with tempfile.TemporaryDirectory() as tmp:
            backend_path = self._write(tmp, _state_with([_book()]))
            backend = pragya_cli.StateFileBackend(backend_path)
            ws = backend.load_workspace()
            b = dict(ws["books"][0])
            # Someone else writes a newer timestamp.
            raw = json.loads(backend_path.read_text(encoding="utf-8"))
            raw["books"][0]["meta"]["updatedAt"] = "2026-11-10T00:00:00.000Z"
            backend_path.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaises(pragya_cli.CliError):
                backend.save_book(b, expected_base_updated_at="2026-11-01T00:00:00.000Z")

    def test_bug_qa1_meta_stored_as_json_string_crashes_book_update(self):
        """QA-1: load normalizes a string meta, but save_book's conflict pre-check
        calls .get() on the raw (string) meta -> AttributeError traceback."""
        book = _book(meta=json.dumps({"updatedAt": "2026-11-01T00:00:00.000Z", "subgenre": "m"}))
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, _state_with([book]))
            rc, res, err = _run_cli_json(["--state-file", str(path), "book-list"])
            self.assertEqual(rc, 0, err)
            self.assertEqual(res["books"][0]["meta"]["subgenre"], "m")
            rc, res, err = _run_cli_json(
                ["--state-file", str(path), "book-update", "--book", "qa-book", "--title", "T4"]
            )
            self.assertEqual(rc, 0, err)
            stored = json.loads(path.read_text(encoding="utf-8"))["books"][0]
            self.assertEqual(stored["meta"]["subgenre"], "m")


class TestQaCodecEdges(unittest.TestCase):
    def test_note_row_numeric_garbage_in_g(self):
        for bad in ("abc", None, [], {}, "", "nan", "NaN", True):
            note = pragya_cli.row_to_note(_note_row("{}", norm=bad))
            self.assertIsNotNone(note)
            self.assertGreaterEqual(note["normalizedPos"], 0.0)
            self.assertLessEqual(note["normalizedPos"], 1.0)

    def test_note_to_row_never_emits_legacy_keys(self):
        note = pragya_cli.row_to_note(_note_row(json.dumps({"q1": "a", "q2": "b", "q3": "c", "x": 1})))
        note["meta"]["q1"] = "stray"
        note["meta"]["chapterNote"] = "kept-unknown-on-notes"
        meta = json.loads(pragya_cli.note_to_row(note)[17])
        self.assertNotIn("q1", meta)
        self.assertNotIn("q2", meta)
        self.assertNotIn("q3", meta)
        self.assertEqual(meta["socraticQuestions"], ["a", "b", "c"])
        self.assertEqual(meta["x"], 1)

    def test_book_to_row_canonicalizes_dirty_meta(self):
        book = _book(meta={"updatedAt": "u", "chapterNote": "Ch 9", "coverUrl": "", "subgenre": "s"})
        meta = json.loads(pragya_cli.book_to_row(book)[11])
        self.assertEqual(meta, {"updatedAt": "u", "currentChapter": "Ch 9", "subgenre": "s"})

    def test_serial_string_and_fractional_timestamps(self):
        self.assertEqual(pragya_cli.decode_sheet_timestamp("46342.75"), "2026-11-16T18:00:00.000Z")
        self.assertEqual(pragya_cli.decode_sheet_timestamp(46342.99999999), "2026-11-16T23:59:59.999Z")
        self.assertEqual(pragya_cli.decode_sheet_timestamp(25568.5), "1969-12-31T12:00:00.000Z")
        self.assertEqual(pragya_cli.decode_sheet_date("46342."), "46342.")
        self.assertEqual(pragya_cli.decode_sheet_date("123456"), "123456")
        self.assertEqual(pragya_cli.decode_sheet_date(True), "true")

    def test_bug_qa2_non_ascii_digits_are_not_serials(self):
        """QA-2: Python `\\d` matches Unicode digits, TS `\\d` does not -> parity drift."""
        self.assertEqual(pragya_cli.decode_sheet_date("४६३४२"), "४६३४२")
        self.assertEqual(pragya_cli.decode_sheet_date("４６３４２"), "４６３４２")

    def test_bug_qa3_timestamp_round_half_parity_with_js(self):
        """QA-3: Python round() is banker's rounding; JS Math.round is half-up (1 ms drift)."""
        # JS: decodeSheetTimestamp(36661.564998894675) === '2000-05-15T13:33:35.905Z'
        self.assertEqual(
            pragya_cli.decode_sheet_timestamp(36661.564998894675), "2000-05-15T13:33:35.905Z"
        )

    def test_bug_qa4_nan_in_meta_written_as_invalid_json(self):
        """QA-4: Python json accepts NaN on read and json.dumps re-emits it; the PWA's
        JSON.parse then rejects the whole metaJson cell and every key is lost."""
        book = pragya_cli.row_to_book(
            ["b", "t", "a", "physical", "nonfiction", "reading", 1, 2, "page", 0.5, "",
             '{"subgenre":"m","x":NaN}']
        )
        cell = pragya_cli.book_to_row(book)[11]

        def _reject(token):
            raise ValueError(token)

        json.loads(cell, parse_constant=_reject)

    def test_bug_qa5_infinite_pos_aborts_note_decode(self):
        """QA-5 (pre-existing, adjacent to B4.6): clean_num('Infinity') raises
        OverflowError, so one corrupt Notes!F/Books!G cell aborts load_workspace.
        TS asNumber falls back to 0."""
        note = pragya_cli.row_to_note(_note_row("{}", pos="Infinity"))
        self.assertEqual(note["pos"], 0)


if __name__ == "__main__":
    unittest.main()


class TestQaReverifyStrictJson(unittest.TestCase):
    """QA re-verify (fix-up): json_dumps_strict / NaN handling."""

    def test_json_dumps_strict_nested_and_kwargs(self):
        out = pragya_cli.json_dumps_strict(
            {"a": [float("inf"), {"b": float("nan"), "k": "पढ़ना"}], "c": (1, float("-inf"))},
            ensure_ascii=False,
        )
        self.assertEqual(json.loads(out), {"a": [None, {"k": "पढ़ना"}], "c": [1, None]})
        self.assertIn("पढ़ना", out)
        self.assertEqual(pragya_cli.json_dumps_strict(float("nan")), "null")
        self.assertEqual(pragya_cli.json_dumps_strict({"ok": 1.5}), '{"ok": 1.5}')

    def test_row_writers_and_state_file_never_emit_non_finite(self):
        def _reject(token):
            raise ValueError(token)

        book = _book(meta={"updatedAt": "u", "score": float("inf"), "arr": [1, float("nan")]})
        cell = pragya_cli.book_to_row(book)[11]
        self.assertEqual(json.loads(cell, parse_constant=_reject)["arr"], [1, None])
        note = pragya_cli.row_to_note(_note_row("{}"))
        note["meta"]["x"] = float("nan")
        json.loads(pragya_cli.note_to_row(note)[17], parse_constant=_reject)

        snap = _state_with([_book(meta={"updatedAt": "2026-11-01T00:00:00.000Z", "s": float("nan")})])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(snap), encoding="utf-8")  # contains NaN token
            rc, _res, err = _run_cli_json(
                ["--state-file", str(path), "book-update", "--book", "qa-book", "--title", "N"]
            )
            self.assertEqual(rc, 0, err)
            json.loads(path.read_text(encoding="utf-8"), parse_constant=_reject)

    def test_meta_cell_with_nan_is_rejected_whole_like_js(self):
        meta = pragya_cli.normalize_book_meta('{"subgenre":"m","x":NaN}')
        self.assertEqual(meta, {"updatedAt": ""})

    def test_bug_qa6_nan_top_level_field_is_silently_deleted_from_state_file(self):
        """QA-6: a non-finite *required* top-level field (e.g. totalPos: NaN in a
        hand-edited state file) is dropped from the book on the next write instead of
        being coerced (e.g. to 0 via clean_num). CLI stays tolerant, but the key vanishes."""
        snap = _state_with([_book(totalPos=float("nan"))])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text(json.dumps(snap), encoding="utf-8")
            rc, _res, err = _run_cli_json(
                ["--state-file", str(path), "book-update", "--book", "qa-book", "--title", "N"]
            )
            self.assertEqual(rc, 0, err)
            stored = json.loads(path.read_text(encoding="utf-8"))["books"][0]
            self.assertIn("totalPos", stored)
