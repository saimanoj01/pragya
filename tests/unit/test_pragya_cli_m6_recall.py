"""M6 Batch 5: CLI long-term recall primitives (Python only, state-file based).

Covers A3.1 `--chapter` on progress / capture / reflect --stage commit / book-update with
currentChapter inheritance, A2.1 `book-capstone`, A2.2 finish summaries (`notesSummary`,
`capstonePending`, `unlockedPredictionsCount`) and A4.2 `note-update`. Offline only.
"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from test_pragya_cli import pragya_cli

T0 = "2026-01-01T00:00:00.000Z"


def _book(**overrides):
    book = {
        "id": "book-fic",
        "title": "Dune",
        "author": "Frank Herbert",
        "format": "physical",
        "kind": "fiction",
        "status": "reading",
        "currentPos": 100,
        "totalPos": 400,
        "posUnit": "page",
        "normalizedPos": 0.25,
        "docUrl": "",
        "meta": {"updatedAt": T0, "currentChapter": "7", "subgenre": "space opera", "customKey": {"x": 1}},
    }
    book.update(overrides)
    return book


def _note(**overrides):
    note = {
        "id": "note-1",
        "slug": "note-one",
        "bookId": "book-fic",
        "createdAt": T0,
        "updatedAt": T0,
        "pos": 50,
        "normalizedPos": 0.125,
        "status": "saved",
        "source": "app",
        "tags": ["#a"],
        "quote": "",
        "takeaway": "takeaway one",
        "contextMechanism": "",
        "critique": "",
        "deltaTrigger": "",
        "deltaAction": "",
        "deltaStatus": "none",
        "meta": {"attachments": [], "links": []},
    }
    note.update(overrides)
    return note


class RecallBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name) / "state.json"
        self.write_state(books=[_book()], notes=[_note()])

    def tearDown(self):
        self._tmp.cleanup()

    def write_state(self, *, books, notes, sessions=None):
        self.state.write_text(
            json.dumps(
                {
                    "version": 1,
                    "exportedAt": T0,
                    "books": books,
                    "notes": notes,
                    "sessions": sessions or [],
                    "deltaLogs": [],
                }
            ),
            encoding="utf-8",
        )

    def read_state(self):
        return json.loads(self.state.read_text(encoding="utf-8"))

    def book_in_state(self, book_id="book-fic"):
        return next(b for b in self.read_state()["books"] if b["id"] == book_id)

    def note_in_state(self, note_id):
        return next(n for n in self.read_state()["notes"] if n["id"] == note_id)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pragya_cli.main([argv[0], "--state-file", str(self.state), *argv[1:]])
        payload = json.loads(out.getvalue()) if out.getvalue().strip() else {}
        return code, payload, err.getvalue()

    def ok(self, *argv):
        code, payload, err = self.run_cli(*argv)
        self.assertEqual(code, 0, err)
        return payload

    def fails(self, *argv, pattern=None):
        code, _payload, err = self.run_cli(*argv)
        self.assertNotEqual(code, 0)
        if pattern:
            self.assertRegex(err, pattern)
        return err


class TestChapterFormatting(unittest.TestCase):
    def test_format_chapter_pos_unbracketed(self):
        f = pragya_cli.format_chapter_pos
        self.assertEqual(f("3", 42, "page"), "Ch. 3 · p. 42")
        self.assertEqual(f("Run", 10, "percent"), "Run · 10%")
        self.assertEqual(f("  ", 10, "percent"), "10%")
        self.assertEqual(pragya_cli.format_chapter_label("３"), "３")  # QA-17: ASCII digits only

    def test_format_chapter_badge(self):
        f = pragya_cli.format_chapter_badge
        self.assertEqual(f("3", 42, "page"), "[Ch. 3 · p. 42]")
        self.assertEqual(f("Run", 10, "percent"), "[Run · 10%]")
        self.assertEqual(f("", 10, "percent"), "[10%]")
        self.assertEqual(f(None, 12.5, "loc"), "[loc 12.5]")
        self.assertEqual(f(" 12 ", 1, "page"), "[Ch. 12 · p. 1]")
        self.assertEqual(f("3b", 1, "page"), "[3b · p. 1]")
        self.assertEqual(pragya_cli.format_chapter_label("Part One"), "Part One")


class TestChapterFlags(RecallBase):
    def test_book_update_sets_and_clears_current_chapter(self):
        res = self.ok("book-update", "--book", "book-fic", "--chapter", "  Part Two ")
        self.assertEqual(res["book"]["meta"]["currentChapter"], "Part Two")
        meta = self.book_in_state()["meta"]
        self.assertEqual(meta["currentChapter"], "Part Two")
        self.assertEqual(meta["subgenre"], "space opera")
        self.assertEqual(meta["customKey"], {"x": 1})
        self.ok("book-update", "--book", "book-fic", "--chapter", "")
        meta = self.book_in_state()["meta"]
        self.assertNotIn("currentChapter", meta)
        self.assertEqual(meta["subgenre"], "space opera")

    def test_progress_chapter_only_saves_without_session_or_bookmark_move(self):
        res = self.ok("progress", "--book", "book-fic", "--chapter", "8")
        self.assertTrue(res["chapterChanged"])
        self.assertFalse(res["bookmarkChanged"])
        self.assertIsNone(res["session"])
        book = self.book_in_state()
        self.assertEqual(book["meta"]["currentChapter"], "8")
        self.assertEqual(book["currentPos"], 100)
        self.assertNotEqual(book["meta"]["updatedAt"], T0)
        self.assertEqual(book["meta"]["subgenre"], "space opera")
        self.assertEqual(self.read_state()["sessions"], [])
        # Same value again: nothing to write.
        again = self.ok("progress", "--book", "book-fic", "--chapter", "8")
        self.assertFalse(again["chapterChanged"])
        # Clear.
        self.ok("progress", "--book", "book-fic", "--chapter", "")
        self.assertNotIn("currentChapter", self.book_in_state()["meta"])

    def test_progress_with_pos_and_chapter(self):
        res = self.ok("progress", "--book", "book-fic", "--pos", "120", "--chapter", "9")
        self.assertTrue(res["bookmarkChanged"])
        self.assertTrue(res["chapterChanged"])
        book = self.book_in_state()
        self.assertEqual(book["currentPos"], 120)
        self.assertEqual(book["meta"]["currentChapter"], "9")
        self.assertEqual(len(self.read_state()["sessions"]), 1)

    def test_progress_requires_some_flag(self):
        self.fails("progress", "--book", "book-fic", pattern="--chapter")

    def test_capture_inherits_current_chapter_at_bookmark_only(self):
        no_pos = self.ok("capture", "--book", "book-fic", "--takeaway", "at bookmark")
        self.assertEqual(no_pos["note"]["meta"]["chapter"], "7")
        same_pos = self.ok("capture", "--book", "book-fic", "--pos", "100", "--takeaway", "same pos")
        self.assertEqual(same_pos["note"]["meta"]["chapter"], "7")
        earlier = self.ok("capture", "--book", "book-fic", "--pos", "40", "--takeaway", "earlier")
        self.assertNotIn("chapter", earlier["note"]["meta"])
        later = self.ok("capture", "--book", "book-fic", "--pos", "150", "--takeaway", "later")
        self.assertNotIn("chapter", later["note"]["meta"])
        explicit = self.ok("capture", "--book", "book-fic", "--pos", "40", "--chapter", "3", "--takeaway", "x")
        self.assertEqual(explicit["note"]["meta"]["chapter"], "3")
        none = self.ok("capture", "--book", "book-fic", "--chapter", "", "--takeaway", "no chapter")
        self.assertNotIn("chapter", none["note"]["meta"])
        self.assertEqual(self.book_in_state()["meta"]["subgenre"], "space opera")

    def test_capture_inherits_when_pos_clamps_to_current_pos(self):
        self.write_state(books=[_book(currentPos=400, normalizedPos=1.0)], notes=[_note()])
        res = self.ok("capture", "--book", "book-fic", "--pos", "999", "--takeaway", "clamped")
        self.assertEqual(res["note"]["pos"], 400)
        self.assertEqual(res["note"]["meta"]["chapter"], "7")

    def test_reflect_commit_sets_and_clears_note_chapter(self):
        self.ok("reflect", "--note", "note-1", "--stage", "commit", "--chapter", "Prologue")
        self.assertEqual(self.note_in_state("note-1")["meta"]["chapter"], "Prologue")
        self.ok("reflect", "--note", "note-1", "--stage", "commit", "--chapter", "")
        self.assertNotIn("chapter", self.note_in_state("note-1")["meta"])
        # Omitted flag keeps whatever is there.
        self.ok("reflect", "--note", "note-1", "--stage", "commit", "--chapter", "2")
        self.ok("reflect", "--note", "note-1", "--stage", "commit", "--takeaway", "edited")
        self.assertEqual(self.note_in_state("note-1")["meta"]["chapter"], "2")


class TestBookCapstone(RecallBase):
    def setUp(self):
        super().setUp()
        self.write_state(books=[_book(status="finished", currentPos=400, normalizedPos=1.0)], notes=[_note()])

    def capstone_args(self, *extra):
        return (
            "book-capstone", "--book", "Dune", "--arc", "  Power corrupts prophecy ",
            "--learnings", "Ecology is destiny", "--learnings", "  ", "--learnings", "Beware heroes",
            "--shift", "I distrust saviours now", *extra,
        )

    def test_valid_call_persists_capstone_and_preserves_meta(self):
        res = self.ok(*self.capstone_args())
        cap = self.book_in_state()["meta"]["capstone"]
        self.assertEqual(cap["arcOrThesis"], "Power corrupts prophecy")
        self.assertEqual(cap["keyLearnings"], ["Ecology is destiny", "Beware heroes"])
        self.assertEqual(cap["perspectiveShift"], "I distrust saviours now")
        self.assertTrue(cap["completedAt"])
        self.assertEqual(res["capstone"], cap)
        meta = self.book_in_state()["meta"]
        self.assertEqual(meta["subgenre"], "space opera")
        self.assertEqual(meta["customKey"], {"x": 1})
        self.assertNotEqual(meta["updatedAt"], T0)

    def test_completed_at_preserved_on_rerun_unless_overridden(self):
        self.ok(*self.capstone_args("--completed-at", "2025-05-05T10:00:00.000Z"))
        self.ok(*self.capstone_args())
        self.assertEqual(self.book_in_state()["meta"]["capstone"]["completedAt"], "2025-05-05T10:00:00.000Z")
        self.ok(*self.capstone_args("--completed-at", "2025-06-06T10:00:00.000Z"))
        self.assertEqual(self.book_in_state()["meta"]["capstone"]["completedAt"], "2025-06-06T10:00:00.000Z")
        self.fails(*self.capstone_args("--completed-at", "not-a-date"), pattern="completed-at")

    def test_unknown_capstone_keys_pass_through(self):
        book = _book(status="finished", currentPos=400, normalizedPos=1.0)
        book["meta"]["capstone"] = {"arcOrThesis": "old", "keyLearnings": ["a"], "perspectiveShift": "s", "completedAt": T0, "mood": "wistful"}
        self.write_state(books=[book], notes=[_note()])
        self.ok(*self.capstone_args())
        cap = self.book_in_state()["meta"]["capstone"]
        self.assertEqual(cap["mood"], "wistful")
        self.assertEqual(cap["completedAt"], T0)
        self.assertEqual(cap["arcOrThesis"], "Power corrupts prophecy")

    def test_validation_errors(self):
        self.fails("book-capstone", "--book", "Dune", "--arc", "  ", "--learnings", "x", "--shift", "y", pattern="--arc")
        self.fails("book-capstone", "--book", "Dune", "--arc", "a", "--shift", "y", pattern="learnings")
        self.fails("book-capstone", "--book", "Dune", "--arc", "a", "--learnings", "x", "--shift", " ", pattern="--shift")
        eight = []
        for i in range(8):
            eight += ["--learnings", f"l{i}"]
        self.fails("book-capstone", "--book", "Dune", "--arc", "a", *eight, "--shift", "y", pattern="At most 7")
        self.assertNotIn("capstone", self.book_in_state()["meta"])

    def test_unfinished_book_requires_flag(self):
        self.write_state(books=[_book()], notes=[_note()])
        self.fails(*self.capstone_args(), pattern="not finished")
        self.assertNotIn("capstone", self.book_in_state()["meta"])
        self.ok(*self.capstone_args("--allow-unfinished"))
        self.assertIn("capstone", self.book_in_state()["meta"])


class TestFinishSummaries(RecallBase):
    def seed(self, *, kind="fiction", capstone=None):
        book = _book(kind=kind, totalPos=400)
        if capstone is not None:
            book["meta"]["capstone"] = capstone
        notes = [
            _note(id="n-late", slug="late", pos=300, normalizedPos=0.0, status="atomic", createdAt="2026-01-03T00:00:00.000Z", meta={"attachments": [], "links": [], "title": "Late", "chapter": "20"}),
            _note(id="n-early", slug="early", pos=10, normalizedPos=0.9, status="saved", quote="q", meta={"attachments": [], "links": []}),
            _note(id="n-tie-b", slug="tie-b", pos=150, status="saved", createdAt="2026-01-02T00:00:00.000Z"),
            _note(id="n-tie-a", slug="tie-a", pos=150, status="saved", createdAt="2026-01-01T00:00:00.000Z"),
            _note(id="n-inbox", slug="inbox", pos=20, status="inbox"),
            _note(id="n-refl", slug="refl", pos=30, status="in-reflection"),
            _note(id="n-pred", slug="pred", pos=200, status="saved", meta={"attachments": [], "links": [], "isPrediction": True}),
            _note(id="n-other", slug="other", bookId="other-book", pos=5, status="saved"),
        ]
        other = _book(id="other-book", title="Other", kind="nonfiction")
        self.write_state(books=[book, other], notes=notes)

    EXPECTED_ORDER = ["n-early", "n-tie-a", "n-tie-b", "n-pred", "n-late"]

    def test_progress_finish_and_book_update_return_same_summary(self):
        self.seed()
        prog = self.ok("progress", "--book", "book-fic", "--finish")
        self.assertTrue(prog["capstonePending"])
        self.assertEqual([e["id"] for e in prog["notesSummary"]], self.EXPECTED_ORDER)
        self.assertEqual(prog["unlockedPredictionsCount"], 1)
        late = prog["notesSummary"][-1]
        self.assertEqual(
            late,
            {
                "id": "n-late", "slug": "late", "status": "atomic", "pos": 300, "posDisplay": "p. 300",
                "label": "Ch. 20 · p. 300", "chapter": "20", "title": "Late", "quote": "",
                "takeaway": "takeaway one", "delta": None,
            },
        )

        self.seed()
        upd = self.ok("book-update", "--book", "book-fic", "--status", "finished")
        self.assertTrue(upd["capstonePending"])
        self.assertEqual(upd["notesSummary"], prog["notesSummary"])
        self.assertEqual(upd["unlockedPredictionsCount"], 1)

    def test_summary_omitted_when_capstone_exists(self):
        cap = {"arcOrThesis": "arc", "keyLearnings": ["k"], "perspectiveShift": "s", "completedAt": T0}
        self.seed(capstone=cap)
        prog = self.ok("progress", "--book", "book-fic", "--finish")
        self.assertNotIn("notesSummary", prog)
        self.assertNotIn("notesSummaryOmittedCount", prog)
        self.assertIs(prog["capstonePending"], False)  # fix-up: always emitted on transitions
        self.assertEqual(prog["unlockedPredictionsCount"], 1)
        self.seed(capstone=cap)
        upd = self.ok("book-update", "--book", "book-fic", "--status", "finished")
        self.assertNotIn("notesSummary", upd)

    def test_empty_capstone_object_still_pending(self):
        self.seed(capstone={"arcOrThesis": "", "keyLearnings": [], "perspectiveShift": ""})
        self.assertTrue(self.ok("progress", "--book", "book-fic", "--finish")["capstonePending"])

    def test_nonfiction_unlocked_zero_and_no_repeat_on_already_finished(self):
        self.seed(kind="nonfiction")
        prog = self.ok("progress", "--book", "book-fic", "--finish")
        self.assertEqual(prog["unlockedPredictionsCount"], 0)
        self.assertEqual(len(prog["notesSummary"]), 5)
        again = self.ok("progress", "--book", "book-fic", "--finish")
        self.assertNotIn("notesSummary", again)
        self.assertEqual(again["unlockedPredictionsCount"], 0)
        upd = self.ok("book-update", "--book", "book-fic", "--status", "finished")
        self.assertNotIn("notesSummary", upd)

    def test_no_summary_without_finish(self):
        self.seed()
        self.assertNotIn("notesSummary", self.ok("progress", "--book", "book-fic", "--pos", "120"))
        self.assertNotIn("notesSummary", self.ok("book-update", "--book", "book-fic", "--title", "Dune!"))


class TestNoteUpdate(RecallBase):
    def test_just_save_it_changes_only_status_and_updated_at(self):
        inbox = _note(status="inbox", meta={"attachments": [], "links": [], "socraticQuestions": ["Why?", "So what?"], "sparStage": 1, "mystery": "keep"})
        self.write_state(books=[_book()], notes=[inbox])
        before = self.note_in_state("note-1")
        self.ok("note-update", "--note", "note-one", "--status", "saved")
        after = self.note_in_state("note-1")
        self.assertEqual(after["status"], "saved")
        self.assertNotEqual(after["updatedAt"], before["updatedAt"])
        diff = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
        self.assertEqual(diff, {"status", "updatedAt"})
        self.assertEqual(after["meta"]["socraticQuestions"], ["Why?", "So what?"])
        self.assertEqual(after["meta"]["sparStage"], 1)
        self.assertEqual(after["meta"]["mystery"], "keep")

    def test_in_reflection_to_saved_keeps_questions(self):
        refl = _note(status="in-reflection", meta={"attachments": [], "links": [], "socraticQuestions": ["Q1"]})
        self.write_state(books=[_book()], notes=[refl])
        self.ok("note-update", "--note", "note-1", "--status", "saved")
        self.assertEqual(self.note_in_state("note-1")["meta"]["socraticQuestions"], ["Q1"])

    def test_field_edits_and_prefix_normalization(self):
        self.ok(
            "note-update", "--note", "note-1", "--status", "atomic", "--title", " Fresh ", "--quote", " q ",
            "--takeaway", " t ", "--context", " c ", "--critique", " k ", "--trigger", "WHEN tired",
            "--action", "DO: walk", "--delta-status", "active", "--chapter", "4", "--tags", "#x, y",
        )
        n = self.note_in_state("note-1")
        self.assertEqual(n["meta"]["title"], "Fresh")
        self.assertEqual((n["quote"], n["takeaway"], n["contextMechanism"], n["critique"]), ("q", "t", "c", "k"))
        self.assertEqual(n["deltaTrigger"], "tired")
        self.assertEqual(n["deltaAction"], "walk")
        self.assertEqual(n["deltaStatus"], "active")
        self.assertEqual(n["meta"]["chapter"], "4")
        self.assertEqual(n["tags"], ["#x", "#y"])
        self.ok("note-update", "--note", "note-1", "--title", "", "--chapter", "")
        n = self.note_in_state("note-1")
        self.assertNotIn("title", n["meta"])
        self.assertNotIn("chapter", n["meta"])

    def test_delta_paused_and_cap(self):
        notes = [
            _note(id=f"a{i}", slug=f"a{i}", status="atomic", deltaStatus="active", deltaTrigger="t")
            for i in range(5)
        ]
        notes.append(_note(id="six", slug="six", status="atomic", deltaTrigger="t"))
        self.write_state(books=[_book()], notes=notes)
        self.fails("note-update", "--note", "six", "--delta-status", "active", pattern="cap")
        self.assertEqual(self.note_in_state("six")["deltaStatus"], "none")
        self.ok("note-update", "--note", "a0", "--delta-status", "paused")
        self.assertEqual(self.note_in_state("a0")["deltaStatus"], "paused")
        self.ok("note-update", "--note", "six", "--delta-status", "active")
        self.assertEqual(self.note_in_state("six")["deltaStatus"], "active")

    def test_validation(self):
        self.fails("note-update", "--note", "note-1", pattern="at least one field")
        self.fails("note-update", "--note", "note-1", "--delta-status", "active", pattern="atomic")
        self.write_state(books=[_book()], notes=[_note(status="atomic")])
        self.fails("note-update", "--note", "note-1", "--delta-status", "active", pattern="WHEN trigger or DO action")
        self.fails("note-update", "--note", "note-1", "--takeaway", "", pattern="takeaway, a quote, or an attachment")
        active = _note(status="atomic", deltaStatus="active", deltaTrigger="t")
        self.write_state(books=[_book()], notes=[active])
        self.fails("note-update", "--note", "note-1", "--status", "saved", pattern="atomic")
        self.ok("note-update", "--note", "note-1", "--status", "saved", "--delta-status", "none")
        self.assertEqual(self.note_in_state("note-1")["status"], "saved")

    def test_conflict_guard(self):
        backend = pragya_cli.StateFileBackend(self.state)
        stale = dict(self.note_in_state("note-1"))
        newer = dict(stale, updatedAt="2026-02-01T00:00:00.000Z", takeaway="remote edit")
        backend.save_note(newer, force=True)
        with self.assertRaises(pragya_cli.CliError):
            backend.save_note(dict(stale, takeaway="local"), expected_base_updated_at=stale["updatedAt"])


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# Batch 5 fix-up
# ---------------------------------------------------------------------------

ENTRY_KEYS = {
    "id", "slug", "status", "pos", "posDisplay", "label", "chapter", "title", "quote", "takeaway", "delta",
}


class TestFixupNotesSummaryContract(RecallBase):
    def test_entry_key_set_label_delta_and_truncation(self):
        long_quote = "q" * 300
        exact = "t" * 280
        notes = [
            _note(id="atom", slug="atom", pos=10, status="atomic", quote=long_quote, takeaway=exact,
                  deltaStatus="graduated", deltaTrigger="WHEN tired", deltaAction="DO: walk",
                  meta={"attachments": [], "links": [], "chapter": "3"}),
            _note(id="saved-delta", slug="sd", pos=20, status="saved", deltaStatus="paused", deltaTrigger="t2"),
            _note(id="atom-empty", slug="ae", pos=30, status="atomic"),
            _note(id="plain", slug="plain", pos=40, status="saved", meta={"attachments": [], "links": [], "chapter": "Run"}),
        ]
        self.write_state(books=[_book()], notes=notes)
        res = self.ok("progress", "--book", "book-fic", "--finish")
        self.assertIsInstance(res["notesSummary"], list)
        self.assertEqual(tuple(sorted(ENTRY_KEYS)), tuple(sorted(pragya_cli.NOTES_SUMMARY_ENTRY_KEYS)))
        for entry in res["notesSummary"]:
            self.assertEqual(set(entry), ENTRY_KEYS)
        by_id = {e["id"]: e for e in res["notesSummary"]}
        atom = by_id["atom"]
        self.assertEqual(len(atom["quote"]), 280)
        self.assertTrue(atom["quote"].endswith("…"))
        self.assertEqual(atom["quote"][:279], "q" * 279)
        self.assertEqual(atom["takeaway"], exact)  # exactly 280 → untouched
        self.assertEqual(atom["label"], "Ch. 3 · p. 10")
        self.assertEqual(atom["delta"], {"trigger": "tired", "action": "walk"})
        self.assertEqual(by_id["saved-delta"]["delta"], {"trigger": "t2", "action": ""})
        self.assertIsNone(by_id["atom-empty"]["delta"])
        self.assertIsNone(by_id["plain"]["delta"])
        self.assertEqual(by_id["plain"]["label"], "Run · p. 40")
        self.assertEqual(res["notesSummaryOmittedCount"], 0)
        self.assertIs(res["capstonePending"], True)
        # The stored notes keep their full text.
        self.assertEqual(self.note_in_state("atom")["quote"], long_quote)

    def test_cap_keeps_all_atomic_then_recent_saved_in_reading_order(self):
        notes = []
        for i in range(10):
            notes.append(_note(id=f"a{i}", slug=f"a{i}", pos=300 + i, status="atomic",
                               createdAt=f"2026-01-01T00:00:{i:02d}.000Z"))
        for i in range(70):
            notes.append(_note(id=f"s{i:02d}", slug=f"s{i:02d}", pos=i, status="saved",
                               createdAt=f"2026-02-01T00:{i:02d}:00.000Z"))
        self.write_state(books=[_book()], notes=notes)
        res = self.ok("book-update", "--book", "book-fic", "--status", "finished")
        ids = [e["id"] for e in res["notesSummary"]]
        self.assertEqual(len(ids), 60)
        self.assertEqual(res["notesSummaryOmittedCount"], 20)
        self.assertTrue(all(f"a{i}" in ids for i in range(10)))  # all atomic kept
        kept_saved = [i for i in ids if i.startswith("s")]
        self.assertEqual(kept_saved, [f"s{i:02d}" for i in range(20, 70)])  # 50 most recent saved
        # Reading order: saved (pos 20..69) then atomic (pos 300+).
        self.assertEqual(ids, [f"s{i:02d}" for i in range(20, 70)] + [f"a{i}" for i in range(10)])

    def test_atomic_overflow_keeps_most_recent_atomic(self):
        notes = [
            _note(id=f"a{i:02d}", slug=f"a{i:02d}", pos=i, status="atomic", createdAt=f"2026-01-01T00:{i:02d}:00.000Z")
            for i in range(62)
        ] + [_note(id="s", slug="s", pos=1, status="saved")]
        self.write_state(books=[_book()], notes=notes)
        res = self.ok("progress", "--book", "book-fic", "--finish")
        ids = [e["id"] for e in res["notesSummary"]]
        self.assertEqual(len(ids), 60)
        self.assertEqual(res["notesSummaryOmittedCount"], 3)
        self.assertNotIn("s", ids)
        self.assertNotIn("a00", ids)
        self.assertNotIn("a01", ids)

    def test_finish_result_keys_always_present(self):
        cap = {"arcOrThesis": "arc", "keyLearnings": ["k"], "perspectiveShift": "s", "completedAt": T0}
        book = _book()
        book["meta"]["capstone"] = cap
        self.write_state(books=[book], notes=[_note()])
        res = self.ok("book-update", "--book", "book-fic", "--status", "finished")
        for key in pragya_cli.FINISH_RESULT_KEYS:
            self.assertIn(key, res)
        self.assertIs(res["capstonePending"], False)
        # progress always emits unlockedPredictionsCount, even without --finish.
        self.write_state(books=[_book()], notes=[_note()])
        plain = self.ok("progress", "--book", "book-fic", "--pos", "120")
        self.assertEqual(plain["unlockedPredictionsCount"], 0)
        self.assertNotIn("capstonePending", plain)
        chapter_only = self.ok("progress", "--book", "book-fic", "--chapter", "9")
        self.assertEqual(chapter_only["unlockedPredictionsCount"], 0)


class TestFixupDeltaRules(RecallBase):
    def test_escape_hatch_keeps_paused_graduated_and_legacy_deltas(self):
        for status, delta in (("inbox", "paused"), ("in-reflection", "graduated"), ("atomic", "graduated")):
            self.write_state(books=[_book()], notes=[_note(status=status, deltaStatus=delta, deltaTrigger="WHEN x")])
            before = self.note_in_state("note-1")
            self.ok("note-update", "--note", "note-1", "--status", "saved")
            after = self.note_in_state("note-1")
            self.assertEqual(after["deltaStatus"], delta, (status, delta))
            self.assertEqual(after["deltaTrigger"], before["deltaTrigger"])
            diff = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
            self.assertEqual(diff, {"status", "updatedAt"})

    def test_unrelated_edits_on_legacy_active_without_when_do(self):
        self.write_state(books=[_book()], notes=[_note(status="atomic", deltaStatus="active")])
        self.ok("note-update", "--note", "note-1", "--tags", "#new")
        self.assertEqual(self.note_in_state("note-1")["tags"], ["#new"])
        self.ok("note-update", "--note", "note-1", "--takeaway", "edited")
        # Editing the delta itself still requires WHEN or DO.
        self.fails("note-update", "--note", "note-1", "--delta-status", "active", pattern="WHEN trigger or DO action")
        self.fails("note-update", "--note", "note-1", "--trigger", "", pattern="WHEN trigger or DO action")

    def test_active_delta_error_copy_never_suggests_discarding(self):
        self.write_state(books=[_book()], notes=[_note(status="atomic", deltaStatus="active", deltaTrigger="t")])
        err = self.fails("note-update", "--note", "note-1", "--status", "saved", pattern="atomic")
        self.assertNotIn("--delta-status none", err)
        self.assertIn("--delta-status paused", err)
        # Following the advice works and keeps the delta's content.
        self.ok("note-update", "--note", "note-1", "--status", "saved", "--delta-status", "paused")
        n = self.note_in_state("note-1")
        self.assertEqual((n["status"], n["deltaStatus"], n["deltaTrigger"]), ("saved", "paused", "t"))
        # An active delta can't be (re)activated on a non-atomic note.
        self.fails("note-update", "--note", "note-1", "--delta-status", "active", pattern="atomic")


class TestFixupCapstoneRepairAndArgs(RecallBase):
    def _finished(self, capstone):
        book = _book(status="finished", currentPos=400, normalizedPos=1.0)
        book["meta"]["capstone"] = capstone
        self.write_state(books=[book], notes=[_note()])

    def test_non_iso_completed_at_is_repaired_and_reported(self):
        for bad in ("soon", 123, "", "   "):
            self._finished({"arcOrThesis": "a", "keyLearnings": ["l"], "perspectiveShift": "s", "completedAt": bad})
            res = self.ok("book-capstone", "--book", "book-fic", "--thesis", "A", "--learning", "L", "--shift", "S")
            stored = self.book_in_state()["meta"]["capstone"]["completedAt"]
            self.assertIsNotNone(pragya_cli.parse_iso_utc(stored), repr(bad))
            self.assertIs(res.get("completedAtRepaired"), True, repr(bad))
        # A valid stored value is kept and not flagged.
        self._finished({"arcOrThesis": "a", "keyLearnings": ["l"], "perspectiveShift": "s", "completedAt": T0})
        res = self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S")
        self.assertNotIn("completedAtRepaired", res)
        self.assertEqual(self.book_in_state()["meta"]["capstone"]["completedAt"], T0)
        # An explicit --completed-at overrides a bad stored value without a repair flag.
        self._finished({"completedAt": "soon"})
        res = self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S",
                      "--completed-at", "2025-01-01T00:00:00.000Z")
        self.assertNotIn("completedAtRepaired", res)

    def test_non_object_capstone_replacement_is_reported(self):
        self._finished("legacy string capstone")
        res = self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S")
        self.assertIs(res["replacedNonObjectCapstone"], True)
        self.assertEqual(self.book_in_state()["meta"]["capstone"]["arcOrThesis"], "A")
        self._finished({"arcOrThesis": "a"})
        self.assertNotIn("replacedNonObjectCapstone", self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S"))

    def test_argparse_errors_use_json_envelope(self):
        code, _payload, err = self.run_cli("book-capstone", "--arc", "A")
        self.assertEqual(code, 2)
        body = json.loads(err)
        self.assertIn("--book", body["error"])
        self.assertIn("usage:", body["usage"])
        code, _payload, err = self.run_cli("note-update", "--status", "bogus")
        self.assertEqual(code, 2)
        self.assertIn("error", json.loads(err))


class TestFixupSheetsBackend(unittest.TestCase):
    """R1#4: book-capstone and note-update through the Sheets backend (fake runner)."""

    def _fake(self):
        from test_pragya_cli_m6_integrity import FakeWorkspace

        book = _book(status="finished", currentPos=400, normalizedPos=1.0)
        book["meta"]["capstone"] = {"arcOrThesis": "old", "keyLearnings": ["x"], "perspectiveShift": "y",
                                    "completedAt": T0, "mood": "wistful"}
        other = _book(id="book-2", title="Other")
        inbox = _note(status="inbox", meta={"attachments": [], "links": [], "socraticQuestions": ["Q1?"],
                                            "sparStage": {"stage": 2}})
        rows = {
            "Books": [pragya_cli.BOOKS_HEADERS, pragya_cli.book_to_row(other), pragya_cli.book_to_row(book)],
            "Notes": [pragya_cli.NOTES_HEADERS, pragya_cli.note_to_row(_note(id="n0", slug="n0")),
                      pragya_cli.note_to_row(inbox)],
            "Sessions": [pragya_cli.SESSIONS_HEADERS],
            "DeltaLogs": [pragya_cli.DELTA_LOGS_HEADERS],
        }
        return FakeWorkspace(rows=rows)

    def _main(self, fake, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pragya_cli.main([argv[0], "--spreadsheet-id", "sid-m6", *argv[1:]], runner=fake)
        return code, out.getvalue(), err.getvalue()

    def _guard_read_index(self, fake, tab, last_col):
        reads = [i for i, c in enumerate(fake.calls) if c[:3] == ["gsheets", "readonly", "read"] and c[4] == f"{tab}!A:{last_col}"]
        return reads

    def test_book_capstone_updates_the_right_row_after_guard_read(self):
        fake = self._fake()
        code, _out, err = self._main(fake, "book-capstone", "--book", "book-fic", "--arc", "A",
                                     "--learnings", "L1", "--learnings", "L2", "--shift", "S")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(fake.raw_payloads), 1)
        req = fake.raw_payloads[0]["requests"][0]["updateCells"]
        self.assertEqual((req["range"]["startRowIndex"], req["range"]["endRowIndex"]), (2, 3))  # Books row 3
        meta = json.loads(fake.write_ops[-1]["data"][0][11])
        self.assertEqual(meta["capstone"]["arcOrThesis"], "A")
        self.assertEqual(meta["capstone"]["keyLearnings"], ["L1", "L2"])
        self.assertEqual(meta["capstone"]["mood"], "wistful")
        self.assertEqual(meta["capstone"]["completedAt"], T0)
        self.assertEqual(meta["subgenre"], "space opera")
        # Guarded write: the full-row guard read (load + guard) precedes the raw-batch write.
        write_idx = next(i for i, c in enumerate(fake.calls) if c[:3] == ["gsheets", "mutate", "raw-batch"])
        guard_reads = self._guard_read_index(fake, "Books", "L")
        self.assertGreaterEqual(len(guard_reads), 2)
        self.assertLess(guard_reads[-1], write_idx)

    def test_book_capstone_conflict_writes_nothing(self):
        fake = self._fake()
        newer = _book(status="finished", currentPos=400, normalizedPos=1.0)
        newer["meta"]["updatedAt"] = "2026-09-09T00:00:00.000Z"

        def override(tab, count):
            if tab == "Books" and count >= 2:  # the guard read sees a newer remote edit
                rows = [list(r) for r in fake.rows["Books"]]
                rows[2] = pragya_cli.book_to_row(newer)
                return rows
            return None

        fake.full_read_override = override
        code, _out, err = self._main(fake, "book-capstone", "--book", "book-fic", "--arc", "A",
                                     "--learnings", "L", "--shift", "S")
        self.assertEqual(code, 1)
        self.assertIn("Row conflict", err)
        self.assertEqual(fake.raw_payloads, [])

    def test_note_update_just_save_it_on_sheets(self):
        fake = self._fake()
        code, _out, err = self._main(fake, "note-update", "--note", "note-one", "--status", "saved")
        self.assertEqual(code, 0, err)
        req = fake.raw_payloads[0]["requests"][0]["updateCells"]
        self.assertEqual((req["range"]["startRowIndex"], req["range"]["endRowIndex"]), (2, 3))  # Notes row 3
        row = fake.write_ops[-1]["data"][0]
        self.assertEqual(row[7], "saved")  # status column H
        meta = json.loads(row[17])
        self.assertEqual(meta["socraticQuestions"], ["Q1?"])
        self.assertEqual(meta["sparStage"], {"stage": 2})
        write_idx = next(i for i, c in enumerate(fake.calls) if c[:3] == ["gsheets", "mutate", "raw-batch"])
        guard_reads = self._guard_read_index(fake, "Notes", "R")
        self.assertLess(guard_reads[-1], write_idx)
