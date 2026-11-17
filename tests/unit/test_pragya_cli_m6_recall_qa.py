"""QA (Batch 5) adversarial probes for CLI recall primitives (state-file backend).

Passing tests lock in verified behavior; ``unittest.expectedFailure`` tests document
open findings from team/batch5_qa_report.md.
"""

from __future__ import annotations

import json

import unittest

from test_pragya_cli import pragya_cli
from test_pragya_cli_m6_recall import T0, RecallBase, _book, _note

T_NEWER = "2026-06-01T00:00:00.000Z"


def _keys_changed(before: dict, after: dict) -> set:
    out = set()
    for k in set(before) | set(after):
        if before.get(k) != after.get(k):
            out.add(k)
    return out


class TestQaChapterInheritance(RecallBase):
    """capture --chapter inheritance matrix (book currentPos=100, currentChapter '7')."""

    def _capture(self, *extra):
        payload = self.ok("capture", "--book", "book-fic", "--takeaway", "probe", *extra)
        note = payload.get("note") or {}
        return (note.get("meta") or {}).get("chapter")

    def test_matrix(self):
        cases = [
            ((), "7"),  # pos omitted → at bookmark
            (("--pos", "100"), "7"),  # equal
            (("--pos", "100.0"), "7"),  # equal as float
            (("--pos", "60"), None),  # earlier
            (("--pos", "150"), None),  # later (bookmark advances, but not "at" the old bookmark)
            (("--chapter", "Interlude"), "Interlude"),  # explicit wins
            (("--chapter", ""), None),  # explicit none
            (("--pos", "60", "--chapter", "3"), "3"),  # explicit at an earlier pos
        ]
        for extra, expected in cases:
            self.write_state(books=[_book()], notes=[])
            self.assertEqual(self._capture(*extra), expected, extra)

    def test_clamped_to_total_equal_to_bookmark_inherits(self):
        # A finished-length book: --pos beyond totalPos clamps to 400 == currentPos.
        self.write_state(books=[_book(currentPos=400, normalizedPos=1.0)], notes=[])
        self.assertEqual(self._capture("--pos", "999"), "7")

    def test_no_inheritance_when_book_has_no_chapter_or_garbage(self):
        for chapter in (None, "", "   ", {"x": 1}, ["a"]):
            meta = {"updatedAt": T0}
            if chapter is not None:
                meta["currentChapter"] = chapter
            self.write_state(books=[_book(meta=meta)], notes=[])
            self.assertIsNone(self._capture(), repr(chapter))

    def test_numeric_book_chapter_inherits_as_string(self):
        self.write_state(books=[_book(meta={"updatedAt": T0, "currentChapter": 7})], notes=[])
        self.assertEqual(self._capture(), "7")


class TestQaProgressChapterOnly(RecallBase):
    def test_chapter_only_no_session_no_move_and_idempotent(self):
        p = self.ok("progress", "--book", "book-fic", "--chapter", "8")
        self.assertTrue(p["chapterChanged"])
        self.assertFalse(p["bookmarkChanged"])
        self.assertIsNone(p["session"])
        st = self.read_state()
        self.assertEqual(st["sessions"], [])
        b = self.book_in_state()
        self.assertEqual(b["currentPos"], 100)
        self.assertEqual(b["meta"]["currentChapter"], "8")
        self.assertEqual(b["meta"]["subgenre"], "space opera")
        self.assertEqual(b["meta"]["customKey"], {"x": 1})
        stamp = b["meta"]["updatedAt"]
        self.assertNotEqual(stamp, T0)
        before = self.state.read_text(encoding="utf-8")
        p2 = self.ok("progress", "--book", "book-fic", "--chapter", " 8 ")
        self.assertFalse(p2["chapterChanged"])
        self.assertEqual(self.state.read_text(encoding="utf-8"), before, "no-op repeat must not write")

    def test_chapter_only_respects_conflict_guard_and_force(self):
        # Base read from the state file is the stored updatedAt; simulate a concurrent writer by
        # making the backend's pre-write check see a newer row.
        backend = pragya_cli.StateFileBackend(self.state)
        ws = backend.load_workspace()
        book = json.loads(json.dumps(ws["books"][0]))
        raw = json.loads(self.state.read_text(encoding="utf-8"))
        raw["books"][0]["meta"]["updatedAt"] = T_NEWER
        self.state.write_text(json.dumps(raw), encoding="utf-8")
        book["meta"]["currentChapter"] = "9"
        with self.assertRaises(pragya_cli.CliError):
            backend.save_book(book, expected_base_updated_at=T0)
        # Through the CLI the base is re-read, so a fresh call succeeds.
        self.ok("progress", "--book", "book-fic", "--chapter", "9")
        self.assertEqual(self.book_in_state()["meta"]["currentChapter"], "9")

    def test_chapter_only_on_finished_book_and_with_force_pos(self):
        self.write_state(books=[_book(status="finished", currentPos=400, normalizedPos=1.0)], notes=[])
        p = self.ok("progress", "--book", "book-fic", "--chapter", "Epilogue", "--force-pos")
        self.assertTrue(p["chapterChanged"])
        b = self.book_in_state()
        self.assertEqual((b["status"], b["currentPos"]), ("finished", 400))
        self.assertNotIn("notesSummary", p)

    def test_pos_plus_chapter_moves_and_sets(self):
        p = self.ok("progress", "--book", "book-fic", "--pos", "120", "--chapter", "")
        self.assertTrue(p["bookmarkChanged"])
        self.assertTrue(p["chapterChanged"])
        self.assertNotIn("currentChapter", self.book_in_state()["meta"])
        self.assertEqual(len(self.read_state()["sessions"]), 1)


class TestQaCapstone(RecallBase):
    def _finished(self, **meta_extra):
        meta = {"updatedAt": T0, "subgenre": "space opera"}
        meta.update(meta_extra)
        self.write_state(books=[_book(status="finished", currentPos=400, normalizedPos=1.0, meta=meta)], notes=[])

    def test_raw_pass_through_and_completed_at_rules(self):
        self._finished(capstone={"arcOrThesis": "old", "keyLearnings": "x", "mood": "wistful", "completedAt": "2026-02-02T00:00:00Z"})
        p = self.ok("book-capstone", "--book", "book-fic", "--arc", " A ", "--learnings", " L1 ", "--learnings", "  ", "--shift", "S")
        cap = self.book_in_state()["meta"]["capstone"]
        self.assertEqual(cap["mood"], "wistful")
        self.assertEqual(cap["arcOrThesis"], "A")
        self.assertEqual(cap["keyLearnings"], ["L1"])
        self.assertEqual(cap["completedAt"], "2026-02-02T00:00:00Z")
        self.assertEqual(p["capstone"], cap)
        self.assertEqual(self.book_in_state()["meta"]["subgenre"], "space opera")
        self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S", "--completed-at", "2026-03-03T10:00:00Z")
        self.assertEqual(self.book_in_state()["meta"]["capstone"]["completedAt"], "2026-03-03T10:00:00Z")

    def test_garbage_existing_capstone_is_replaced_cleanly(self):
        for garbage in ("a string", 42, ["x"], None):
            self._finished(capstone=garbage)
            self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S")
            cap = self.book_in_state()["meta"]["capstone"]
            self.assertEqual(set(cap), {"arcOrThesis", "keyLearnings", "perspectiveShift", "completedAt"}, repr(garbage))
            self.assertIsNotNone(pragya_cli.parse_iso_utc(cap["completedAt"]))

    def test_validation_writes_nothing(self):
        self._finished()
        before = self.state.read_text(encoding="utf-8")
        bad_calls = [
            ("--arc", "   ", "--learnings", "L", "--shift", "S"),
            ("--arc", "A", "--learnings", "  ", "--shift", "S"),
            ("--arc", "A", "--shift", "S"),
            ("--arc", "A", "--learnings", "L", "--shift", ""),
            ("--arc", "A", *sum((("--learnings", f"L{i}") for i in range(8)), ()), "--shift", "S"),
            ("--arc", "A", "--learnings", "L", "--shift", "S", "--completed-at", "yesterday"),
        ]
        for argv in bad_calls:
            self.fails("book-capstone", "--book", "book-fic", *argv)
            self.assertEqual(self.state.read_text(encoding="utf-8"), before, argv)
        # Exactly 7 is allowed.
        self.ok("book-capstone", "--book", "book-fic", "--arc", "A", *sum((("--learnings", f"L{i}") for i in range(7)), ()), "--shift", "S")

    def test_unfinished_refused_then_allowed(self):
        before = self.state.read_text(encoding="utf-8")
        self.fails("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S", pattern="not finished")
        self.assertEqual(self.state.read_text(encoding="utf-8"), before)
        self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S", "--allow-unfinished")
        self.assertEqual(self.book_in_state()["status"], "reading")

    def test_qa15_preserved_completed_at_must_be_a_timestamp(self):
        """QA-15: a stored non-ISO completedAt (e.g. 123 or 'soon') is preserved verbatim on
        re-run instead of being treated as absent (only --completed-at is validated)."""
        self._finished(capstone={"arcOrThesis": "a", "keyLearnings": ["l"], "perspectiveShift": "s", "completedAt": "soon"})
        self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S")
        self.assertIsNotNone(pragya_cli.parse_iso_utc(self.book_in_state()["meta"]["capstone"]["completedAt"]))


class TestQaFinishSummaries(RecallBase):
    def _state(self, capstone=None):
        meta = {"updatedAt": T0, "subgenre": "x"}
        if capstone is not None:
            meta["capstone"] = capstone
        books = [
            _book(meta=meta),
            _book(id="book-other", title="Other", meta={"updatedAt": T0}),
        ]
        notes = [
            _note(id="n-late", slug="late", pos=300, normalizedPos=0.0, createdAt="2026-01-03T00:00:00Z"),
            _note(id="n-early-b", slug="early-b", pos=20, createdAt="2026-01-02T00:00:00Z", status="atomic"),
            _note(id="n-early-a", slug="early-a", pos=20, createdAt="2026-01-01T00:00:00Z"),
            _note(id="n-inbox", slug="inbox", pos=10, status="inbox"),
            _note(id="n-refl", slug="refl", pos=11, status="in-reflection"),
            _note(id="n-pred", slug="pred", pos=200, meta={"attachments": [], "links": [], "isPrediction": True, "title": "Twist"}),
            _note(id="n-other", slug="other-book-secret", bookId="book-other", pos=5, takeaway="OTHER_BOOK_SECRET"),
        ]
        self.write_state(books=books, notes=notes)

    def _ids(self, payload):
        return [e["id"] for e in payload["notesSummary"]]

    def test_identical_between_progress_and_book_update(self):
        self._state()
        a = self.ok("progress", "--book", "book-fic", "--finish")
        self._state()
        b = self.ok("book-update", "--book", "book-fic", "--status", "finished")
        self.assertEqual(a["notesSummary"], b["notesSummary"])
        self.assertEqual(self._ids(a), ["n-early-a", "n-early-b", "n-pred", "n-late"])
        self.assertTrue(a["capstonePending"])
        self.assertEqual(a["unlockedPredictionsCount"], b["unlockedPredictionsCount"])
        self.assertEqual(a["unlockedPredictionsCount"], 1)
        blob = json.dumps(a)
        self.assertNotIn("OTHER_BOOK_SECRET", blob)
        entry = a["notesSummary"][0]
        # Batch 5 fix-up (decisions): entries gained `label` and `delta`.
        self.assertEqual(set(entry), {"id", "slug", "status", "pos", "posDisplay", "label", "chapter", "title", "quote", "takeaway", "delta"})
        self.assertEqual(entry["posDisplay"], "p. 20")

    def test_capstone_pending_matrix(self):
        cases = [
            (None, True),
            ({}, True),
            ("garbage", True),
            ({"arcOrThesis": "", "keyLearnings": [], "perspectiveShift": ""}, True),
            ({"arcOrThesis": "   ", "keyLearnings": ["  "], "perspectiveShift": " "}, True),
            ({"arcOrThesis": "A", "keyLearnings": [], "perspectiveShift": ""}, False),
            ({"keyLearnings": "one"}, False),
        ]
        for capstone, pending in cases:
            self._state(capstone=capstone)
            p = self.ok("progress", "--book", "book-fic", "--finish")
            self.assertEqual(bool(p.get("capstonePending")), pending, repr(capstone))
            self.assertEqual("notesSummary" in p, pending, repr(capstone))

    def test_nonfiction_zero_and_no_repeat(self):
        self._state()
        raw = json.loads(self.state.read_text(encoding="utf-8"))
        raw["books"][0]["kind"] = "nonfiction"
        self.state.write_text(json.dumps(raw), encoding="utf-8")
        p = self.ok("book-update", "--book", "book-fic", "--status", "finished")
        self.assertEqual(p["unlockedPredictionsCount"], 0)
        self.assertIn("notesSummary", p)
        again = self.ok("progress", "--book", "book-fic", "--finish")
        self.assertNotIn("notesSummary", again)
        self.assertEqual(again["unlockedPredictionsCount"], 0)
        edit = self.ok("book-update", "--book", "book-fic", "--title", "Renamed")
        self.assertNotIn("notesSummary", edit)


class TestQaNoteUpdate(RecallBase):
    def _note_state(self, **overrides):
        base = _note(
            status="inbox",
            meta={
                "attachments": [{"id": "x", "type": "video"}, "junk"],
                "links": ["https://l"],
                "socraticQuestions": ["Q1?", "Q2?"],
                "sparStage": {"stage": 1},
                "agentKey": [1, {"a": 2}],
                "title": "T",
                "chapter": "3",
            },
        )
        base.update(overrides)
        self.write_state(books=[_book()], notes=[base])
        return base

    def test_just_save_it_changes_only_status_and_updated_at(self):
        before = self._note_state()
        self.ok("note-update", "--note", "note-1", "--status", "saved")
        after = self.note_in_state("note-1")
        self.assertEqual(_keys_changed(before, after), {"status", "updatedAt"})
        self.assertEqual(after["meta"], before["meta"])

    def test_each_flag_changes_only_its_field(self):
        flags = [
            (("--title", "New"), {"meta"}),
            (("--quote", "Q"), {"quote"}),
            (("--takeaway", "tk2"), {"takeaway"}),
            (("--context", "c"), {"contextMechanism"}),
            (("--critique", "k"), {"critique"}),
            (("--trigger", "WHEN x"), {"deltaTrigger"}),
            (("--action", "DO y"), {"deltaAction"}),
            (("--chapter", "4"), {"meta"}),
            (("--tags", "#b, #c"), {"tags"}),
        ]
        for argv, expected in flags:
            before = self._note_state()
            self.ok("note-update", "--note", "note-1", *argv)
            after = self.note_in_state("note-1")
            self.assertEqual(_keys_changed(before, after) - {"updatedAt"}, expected, argv)
            if "meta" in expected:
                changed_meta = _keys_changed(before["meta"], after["meta"])
                self.assertEqual(len(changed_meta), 1, (argv, changed_meta))
        after = self.note_in_state("note-1")
        self.assertEqual(after["tags"], ["#b", "#c"])
        before = self._note_state()
        self.ok("note-update", "--note", "note-1", "--trigger", "WHEN it rains")
        self.assertEqual(self.note_in_state("note-1")["deltaTrigger"], "it rains")

    def test_delta_rules(self):
        self._note_state(status="atomic", deltaTrigger="t")
        self.ok("note-update", "--note", "note-1", "--delta-status", "active")
        self.assertEqual(self.note_in_state("note-1")["deltaStatus"], "active")
        # Changing status away from atomic while a delta is active is refused.
        self.fails("note-update", "--note", "note-1", "--status", "saved", pattern="atomic")
        # Batch 5 fix-up (decisions R1#1): only an ACTIVE delta needs an atomic note;
        # a non-atomic note may not gain an active delta, but paused is harmless history.
        self._note_state(status="saved", deltaTrigger="t")
        self.fails("note-update", "--note", "note-1", "--delta-status", "active", pattern="atomic")
        self.ok("note-update", "--note", "note-1", "--delta-status", "paused")
        self.assertEqual(self.note_in_state("note-1")["deltaStatus"], "paused")
        # Active with neither WHEN nor DO.
        self._note_state(status="atomic")
        self.fails("note-update", "--note", "note-1", "--delta-status", "active", pattern="WHEN")
        # Clearing the trigger of an active delta that has no action is refused.
        self._note_state(status="atomic", deltaStatus="active", deltaTrigger="t")
        self.fails("note-update", "--note", "note-1", "--trigger", "", pattern="WHEN")

    def test_cap_refuses_sixth_active(self):
        notes = [
            _note(id=f"a{i}", slug=f"a{i}", status="atomic", deltaStatus="active", deltaTrigger="t")
            for i in range(5)
        ]
        notes.append(_note(id="six", slug="six", status="atomic", deltaTrigger="t"))
        self.write_state(books=[_book()], notes=notes)
        before = self.state.read_text(encoding="utf-8")
        self.fails("note-update", "--note", "six", "--delta-status", "active")
        self.assertEqual(self.state.read_text(encoding="utf-8"), before)
        # Re-asserting an already-active note's status is not blocked by the cap.
        self.ok("note-update", "--note", "a0", "--delta-status", "active")
        self.ok("note-update", "--note", "six", "--delta-status", "paused")

    def test_content_required_and_attachment_counts(self):
        self._note_state(quote="")
        self.fails("note-update", "--note", "note-1", "--takeaway", "  ", pattern="takeaway, a quote")
        self._note_state(
            quote="",
            meta={"attachments": [{"id": "i", "type": "link", "url": "https://x"}], "links": []},
        )
        self.ok("note-update", "--note", "note-1", "--takeaway", "")

    def test_conflict_guard_and_force(self):
        self._note_state()
        backend = pragya_cli.StateFileBackend(self.state)
        note = json.loads(json.dumps(backend.load_workspace()["notes"][0]))
        raw = json.loads(self.state.read_text(encoding="utf-8"))
        raw["notes"][0]["updatedAt"] = T_NEWER
        self.state.write_text(json.dumps(raw), encoding="utf-8")
        note["takeaway"] = "stale"
        with self.assertRaises(pragya_cli.CliError):
            backend.save_note(note, expected_base_updated_at=T0)
        backend.save_note(note, expected_base_updated_at=T0, force=True)
        self.assertEqual(self.note_in_state("note-1")["takeaway"], "stale")

    def test_no_fields_and_unknown_note(self):
        self._note_state()
        self.fails("note-update", "--note", "note-1", pattern="at least one field")
        self.fails("note-update", "--note", "nope", "--status", "saved")

    def test_qa16_just_save_it_blocked_by_legacy_delta_on_inbox_note(self):
        """QA-16: an inbox/in-reflection note carrying a legacy non-'none' deltaStatus cannot
        use the 'just save it' escape hatch: --status saved is refused (needs atomic) and the
        error suggests --delta-status none, which would silently discard the delta."""
        self._note_state(status="in-reflection", deltaStatus="paused", deltaTrigger="t")
        self.ok("note-update", "--note", "note-1", "--status", "saved")


class TestQaChapterLabelParity(unittest.TestCase):
    """Expectations Batch 7's TS formatChapterPos must mirror (ux_spec B.3)."""

    def test_table(self):
        # Batch 5 fix-up (decisions R2 nit): the bracketed formatter is format_chapter_badge;
        # format_chapter_pos now returns the unbracketed ux_spec B.3 form.
        f = pragya_cli.format_chapter_badge
        table = [
            (("3", 42, "page"), "[Ch. 3 · p. 42]"),
            (("03", 42, "page"), "[Ch. 03 · p. 42]"),
            ((3, 42, "page"), "[Ch. 3 · p. 42]"),
            (("3.5", 1, "page"), "[3.5 · p. 1]"),
            (("Chapter 3", 1, "page"), "[Chapter 3 · p. 1]"),
            (("Run", 10, "percent"), "[Run · 10%]"),
            (("  ", 10, "percent"), "[10%]"),
            ((None, 0, "page"), "[p. 0]"),
            ((True, 5, "page"), "[p. 5]"),
        ]
        for args, expected in table:
            self.assertEqual(f(*args), expected, args)

    def test_qa17_unicode_digits_are_not_numeric_chapters(self):
        """QA-17: Python `\\d` matches Unicode digits, so '३' → 'Ch. ३'; a JS /^\\d+$/ port
        would leave it verbatim. Use [0-9] (or document the TS must use \\p{Nd}+/u)."""
        self.assertEqual(pragya_cli.format_chapter_label("३"), "३")


if __name__ == "__main__":
    unittest.main()


class TestQaBatch5FixUp(RecallBase):
    """QA re-verify of the Batch 5 fix-up: summary cap/truncation, escape hatch, repair, argparse."""

    def _finish_with(self, notes):
        self.write_state(books=[_book(meta={"updatedAt": T0})], notes=notes)
        return self.ok("progress", "--book", "book-fic", "--finish")

    def _n(self, i, status="saved", **kw):
        return _note(id=f"n{i:03d}", slug=f"s{i:03d}", pos=i, status=status,
                     createdAt=f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z", **kw)

    def test_cap_boundaries(self):
        p = self._finish_with([self._n(i) for i in range(60)])
        self.assertEqual((len(p["notesSummary"]), p["notesSummaryOmittedCount"]), (60, 0))
        p = self._finish_with([self._n(i) for i in range(61)])
        self.assertEqual((len(p["notesSummary"]), p["notesSummaryOmittedCount"]), (60, 1))
        ids = [e["id"] for e in p["notesSummary"]]
        self.assertNotIn("n000", ids)  # oldest saved dropped
        self.assertEqual(ids, sorted(ids))  # reading order (pos == index)
        # Atomic notes win over newer saved notes; overflowing atomic keeps the most recent 60.
        notes = [self._n(i, status="atomic") for i in range(10)] + [self._n(i) for i in range(10, 80)]
        p = self._finish_with(notes)
        ids = [e["id"] for e in p["notesSummary"]]
        self.assertTrue(all(f"n{i:03d}" in ids for i in range(10)))
        self.assertEqual(p["notesSummaryOmittedCount"], 20)
        p = self._finish_with([self._n(i, status="atomic") for i in range(65)])
        ids = [e["id"] for e in p["notesSummary"]]
        self.assertEqual(p["notesSummaryOmittedCount"], 5)
        self.assertNotIn("n000", ids)
        self.assertIn("n064", ids)

    def test_truncation_and_delta_shape(self):
        exact = "a" * 280
        long = "b" * 281
        emoji = "📚" * 300
        p = self._finish_with([
            self._n(1, quote=exact, takeaway=long),
            self._n(2, takeaway=emoji),
            self._n(3, status="atomic", deltaStatus="active", deltaTrigger="WHEN it rains", deltaAction="DO read"),
            self._n(4),
        ])
        e1, e2, e3, e4 = p["notesSummary"]
        self.assertEqual(e1["quote"], exact)
        self.assertEqual(len(e1["takeaway"]), 280)
        self.assertTrue(e1["takeaway"].endswith("…"))
        self.assertEqual(len(e2["takeaway"]), 280)
        self.assertEqual(e3["delta"], {"trigger": "it rains", "action": "read"})
        self.assertIsNone(e4["delta"])
        self.assertEqual(e1["label"], "p. 1")
        # Stored notes untouched.
        self.assertEqual(self.note_in_state("n001")["takeaway"], long)

    def test_omitted_count_only_with_pending_summary(self):
        self.write_state(
            books=[_book(meta={"updatedAt": T0, "capstone": {"arcOrThesis": "A", "keyLearnings": ["l"], "perspectiveShift": "s"}})],
            notes=[self._n(1)],
        )
        p = self.ok("progress", "--book", "book-fic", "--finish")
        self.assertIs(p["capstonePending"], False)
        self.assertNotIn("notesSummary", p)
        self.assertNotIn("notesSummaryOmittedCount", p)

    def test_escape_hatch_and_error_copy(self):
        for legacy in ("paused", "graduated"):
            base = _note(status="in-reflection", deltaStatus=legacy, deltaTrigger="t",
                         meta={"attachments": [], "links": [], "socraticQuestions": ["Q?"], "x": 1})
            self.write_state(books=[_book()], notes=[base])
            self.ok("note-update", "--note", "note-1", "--status", "saved")
            after = self.note_in_state("note-1")
            self.assertEqual(_keys_changed(base, after), {"status", "updatedAt"}, legacy)
        self.write_state(books=[_book()], notes=[_note(status="inbox", deltaStatus="active", deltaTrigger="t")])
        err = self.fails("note-update", "--note", "note-1", "--status", "saved")
        self.assertIn("--delta-status paused", err)
        self.assertNotIn("--delta-status none", err)

    def test_completed_at_repair_flags(self):
        def finished(cap):
            self.write_state(books=[_book(status="finished", currentPos=400, normalizedPos=1.0,
                                          meta={"updatedAt": T0, "capstone": cap})], notes=[])
        for bad in ("soon", 123, "", None):
            finished({"arcOrThesis": "a", "keyLearnings": ["l"], "perspectiveShift": "s", "completedAt": bad})
            p = self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learning", "L", "--shift", "S")
            stored = self.book_in_state()["meta"]["capstone"]["completedAt"]
            self.assertIsNotNone(pragya_cli.parse_iso_utc(stored), repr(bad))
            if bad not in ("", None):
                self.assertIs(p.get("completedAtRepaired"), True, repr(bad))
        finished({"completedAt": "2026-02-02T00:00:00Z"})
        p = self.ok("book-capstone", "--book", "book-fic", "--thesis", "A", "--learnings", "L", "--shift", "S")
        self.assertNotIn("completedAtRepaired", p)
        finished({"completedAt": "soon"})
        p = self.ok("book-capstone", "--book", "book-fic", "--arc", "A", "--learnings", "L", "--shift", "S",
                    "--completed-at", "2026-04-04T00:00:00Z")
        self.assertNotIn("completedAtRepaired", p)
        self.assertEqual(self.book_in_state()["meta"]["capstone"]["completedAt"], "2026-04-04T00:00:00Z")

    def test_argparse_json_envelope_exit_codes(self):
        cases = [
            ("note-update", "--note", "x", "--status", "nope"),
            ("book-capstone", "--book", "x"),
            ("progress",),
            ("capture", "--book", "x", "--takeaway", "t", "--pos", "abc"),
            ("definitely-not-a-command",),
        ]
        for argv in cases:
            code, _payload, err = self.run_cli(*argv) if argv[0] != "definitely-not-a-command" else (None, None, None)
            if code is None:
                import contextlib, io
                out, e = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(e):
                    try:
                        code = pragya_cli.main(list(argv))
                    except SystemExit as exc:
                        code = exc.code
                err = e.getvalue()
            self.assertEqual(code, 2, argv)
            body = json.loads(err)
            self.assertIn("error", body)
            self.assertIn("usage", body)
        # Runtime CliError stays exit 1 (distinct from usage errors).
        code, _p, err = self.run_cli("note-update", "--note", "missing-note", "--status", "saved")
        self.assertEqual(code, 1)
        self.assertIn("error", json.loads(err))
