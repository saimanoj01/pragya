"""CD Batch 1a: data-safe foundations (Python side, offline, state-file based).

C5.1 timezone-safe Takeaway Shuffle, C5.2 staleness ordering (shared fixture with
tests/unit/cd1Foundations.test.mjs), C5.3 `Do not …` DO-prefix parity table, and C1.1
soft-archive (`meta.archivedAt`) honoured by book-list / recall / timelines / notesSummary,
plus `book-update|note-update --archive|--unarchive` and the capture refusal.
"""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path

from test_pragya_cli import pragya_cli
from test_pragya_cli_m6_recall import RecallBase, _book, _note

FIXTURE = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "cd1_parity.json").read_text(encoding="utf-8")
)


class _PacificTZ:
    """Run a block under TZ=America/Los_Angeles (restored afterwards)."""

    def __enter__(self):
        self._prev = os.environ.get("TZ")
        os.environ["TZ"] = "America/Los_Angeles"
        time.tzset()
        return self

    def __exit__(self, *exc):
        if self._prev is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self._prev
        time.tzset()
        return False


def _shuffle_book():
    return FIXTURE["shuffle"]["books"][0]


class TestShuffleTimezone(unittest.TestCase):
    def test_to_local_date_key(self):
        with _PacificTZ():
            f = pragya_cli.to_local_date_key
            self.assertEqual(f("2026-11-17"), "2026-11-17")
            self.assertEqual(f("2026-11-17T06:30:00Z"), "2026-11-16")
            self.assertEqual(f("2026-11-17T06:30:00.000Z"), "2026-11-16")
            self.assertEqual(f("2026-11-17T06:30:00"), "2026-11-16")  # offset-less = UTC
            self.assertEqual(f("2026-11-17T06:30:00+05:30"), "2026-11-16")
            self.assertIsNone(f(""))
            self.assertIsNone(f(None))
            self.assertIsNone(f("garbage"))

    def test_review_at_0630z_does_not_hide_on_local_today(self):
        with _PacificTZ():
            book = _shuffle_book()
            note = dict(FIXTURE["shuffle"]["notes"][0], meta={"lastReviewedAt": "2026-11-17T06:30:00Z"})
            self.assertTrue(pragya_cli.is_eligible_for_shuffle(note, book, "2026-11-17"))
            self.assertFalse(pragya_cli.is_eligible_for_shuffle(note, book, "2026-11-16"))
            dated = dict(note, meta={"lastReviewedAt": "2026-11-17"})
            self.assertFalse(pragya_cli.is_eligible_for_shuffle(dated, book, "2026-11-17"))
            self.assertTrue(pragya_cli.is_eligible_for_shuffle(dated, book, "2026-11-18"))

    def test_created_at_age_uses_local_date(self):
        with _PacificTZ():
            self.assertEqual(pragya_cli.calendar_days_between("2026-11-03T03:00:00Z", "2026-11-16"), 14)
            book = _shuffle_book()
            base = dict(FIXTURE["shuffle"]["notes"][0], meta={})
            self.assertTrue(
                pragya_cli.is_eligible_for_shuffle(dict(base, createdAt="2026-11-03T03:00:00Z"), book, "2026-11-16")
            )
            self.assertFalse(
                pragya_cli.is_eligible_for_shuffle(dict(base, createdAt="2026-11-03T09:00:00Z"), book, "2026-11-16")
            )


class TestShuffleStaleness(unittest.TestCase):
    def test_shared_fixture_order_and_buckets(self):
        fx = FIXTURE["shuffle"]
        by_id = {n["id"]: n for n in fx["notes"]}
        for note_id, bucket in fx["expectedBuckets"].items():
            self.assertEqual(pragya_cli.shuffle_staleness_bucket(by_id[note_id], fx["today"]), bucket, note_id)
        ids = [n["id"] for n in pragya_cli.select_takeaway_shuffle(fx["notes"], fx["books"], fx["today"], 10)]
        self.assertEqual(ids, fx["expectedOrder"])
        rev = [
            n["id"]
            for n in pragya_cli.select_takeaway_shuffle(list(reversed(fx["notes"])), fx["books"], fx["today"], 10)
        ]
        self.assertEqual(rev, fx["expectedOrder"])


class TestDoPrefixParity(unittest.TestCase):
    def test_shared_table(self):
        for raw, expected in FIXTURE["doPrefix"]:
            self.assertEqual(pragya_cli.strip_do_prefix(raw), expected, raw)
            self.assertEqual(pragya_cli.normalize_delta_action(raw), expected, raw)
        self.assertEqual(pragya_cli.normalize_delta_trigger("WHEN WHEN tired"), "tired")


class TestArchiveCli(RecallBase):
    def setUp(self):
        super().setUp()
        self.write_state(
            books=[
                _book(status="finished", currentPos=400, normalizedPos=1.0),
                _book(id="book-old", title="Old Book", meta={"updatedAt": "2026-01-01T00:00:00.000Z", "archivedAt": "2026-02-01T00:00:00Z"}),
            ],
            notes=[
                _note(id="note-1", slug="kept", takeaway="loops and delays"),
                _note(
                    id="note-arch",
                    slug="archived-one",
                    takeaway="loops archived",
                    status="atomic",
                    meta={"attachments": [], "links": [], "archivedAt": "2026-02-01T00:00:00Z"},
                ),
                _note(
                    id="note-delta",
                    slug="with-delta",
                    status="atomic",
                    takeaway="delta note",
                    deltaStatus="active",
                    deltaTrigger="tired",
                    deltaAction="walk",
                    meta={"attachments": [], "links": [], "sparStage": {"s": 2}},
                ),
            ],
        )

    def test_is_archived(self):
        self.assertTrue(pragya_cli.is_archived({"meta": {"archivedAt": "x"}}))
        self.assertFalse(pragya_cli.is_archived({"meta": {"archivedAt": "  "}}))
        self.assertFalse(pragya_cli.is_archived({"meta": {}}))
        self.assertFalse(pragya_cli.is_archived(None))

    def test_book_list_excludes_archived_by_default(self):
        res = self.ok("book-list")
        self.assertEqual([b["id"] for b in res["books"]], ["book-fic"])
        self.assertEqual(res["archivedCount"], 1)
        res_all = self.ok("book-list", "--include-archived")
        self.assertEqual(sorted(b["id"] for b in res_all["books"]), ["book-fic", "book-old"])

    def test_recall_qa_and_checkin_skip_archived(self):
        res = self.ok("recall", "--mode", "qa", "--query", "loops")
        self.assertEqual([m["id"] for m in res["matches"]], ["note-1"])
        self.ok("note-update", "--note", "with-delta", "--archive")
        res_ci = self.ok("recall", "--mode", "checkin")
        self.assertEqual(res_ci["activeDeltas"], [])

    def test_timeline_and_notes_summary_skip_archived(self):
        state = self.read_state()
        book = next(b for b in state["books"] if b["id"] == "book-fic")
        ids = [n["id"] for n in pragya_cli.select_book_timeline(state["notes"], book)]
        self.assertNotIn("note-arch", ids)
        self.assertIn("note-1", ids)
        entries, _omitted = pragya_cli.build_notes_summary(book, state["notes"])
        self.assertNotIn("note-arch", [e["id"] for e in entries])

    def test_book_archive_unarchive_round_trip_keeps_unknown_keys(self):
        res = self.ok("book-update", "--book", "book-fic", "--archive")
        meta = res["book"]["meta"]
        self.assertTrue(meta["archivedAt"])
        self.assertEqual(meta["customKey"], {"x": 1})
        self.assertEqual(meta["subgenre"], "space opera")
        self.assertTrue(pragya_cli.is_archived(self.book_in_state("book-fic")))
        res2 = self.ok("book-update", "--book", "book-fic", "--unarchive")
        self.assertNotIn("archivedAt", res2["book"]["meta"])
        self.assertEqual(self.book_in_state("book-fic")["meta"]["customKey"], {"x": 1})
        # Archived books still resolve by id/title (so they can be restored).
        self.ok("book-update", "--book", "Old Book", "--unarchive")
        self.assertFalse(pragya_cli.is_archived(self.book_in_state("book-old")))

    def test_archive_flags_are_mutually_exclusive(self):
        self.fails("book-update", "--book", "book-fic", "--archive", "--unarchive")
        self.fails("note-update", "--note", "kept", "--archive", "--unarchive")

    def test_capture_onto_archived_book_is_refused(self):
        self.fails(
            "capture", "--book", "book-old", "--takeaway", "hello", pattern=r"archived.*--unarchive"
        )

    def test_note_archive_pauses_active_delta_and_unarchive_restores_it(self):
        res = self.ok("note-update", "--note", "with-delta", "--archive")
        self.assertTrue(res.get("deltaPaused"))
        stored = self.note_in_state("note-delta")
        self.assertEqual(stored["deltaStatus"], "paused")
        self.assertEqual(stored["meta"]["archivedDeltaStatus"], "active")
        self.assertEqual(stored["meta"]["sparStage"], {"s": 2})
        res2 = self.ok("note-update", "--note", "with-delta", "--unarchive")
        self.assertTrue(res2.get("deltaReactivated"))
        stored2 = self.note_in_state("note-delta")
        self.assertEqual(stored2["deltaStatus"], "active")
        self.assertNotIn("archivedAt", stored2["meta"])
        self.assertNotIn("archivedDeltaStatus", stored2["meta"])

    def test_note_unarchive_respects_active_delta_cap(self):
        self.ok("note-update", "--note", "with-delta", "--archive")
        state = self.read_state()
        extra = [
            _note(id=f"cap-{i}", slug=f"cap-{i}", status="atomic", deltaStatus="active", deltaTrigger="t", deltaAction="a")
            for i in range(5)
        ]
        self.write_state(books=state["books"], notes=state["notes"] + extra)
        res = self.ok("note-update", "--note", "with-delta", "--unarchive")
        self.assertTrue(res.get("deltaCapped"))
        self.assertEqual(self.note_in_state("note-delta")["deltaStatus"], "paused")

    def test_archived_note_still_resolves_and_shuffle_skips_it(self):
        self.ok("note-update", "--note", "archived-one", "--unarchive")
        self.assertFalse(pragya_cli.is_archived(self.note_in_state("note-arch")))
        state = self.read_state()
        picked = pragya_cli.select_takeaway_shuffle(
            [dict(state["notes"][0], meta={"archivedAt": "x"})], state["books"], "2026-11-17"
        )
        self.assertEqual(picked, [])

    def test_archived_at_survives_codec_round_trip(self):
        meta = pragya_cli.normalize_note_meta(
            {"archivedAt": "2026-01-01", "archivedDeltaStatus": "active", "mystery": {"k": 1}}
        )
        self.assertEqual(meta["archivedAt"], "2026-01-01")
        self.assertEqual(meta["archivedDeltaStatus"], "active")
        self.assertEqual(meta["mystery"], {"k": 1})
        self.assertEqual(
            pragya_cli.normalize_book_meta({"updatedAt": "u", "archivedAt": "2026-01-01T00:00:00Z"})["archivedAt"],
            "2026-01-01T00:00:00Z",
        )
        # End-to-end through the state file: archive → reload keeps every key.
        self.ok("book-update", "--book", "book-fic", "--archive")
        reloaded = self.book_in_state("book-fic")
        self.assertTrue(reloaded["meta"]["archivedAt"])
        self.assertEqual(reloaded["meta"]["customKey"], {"x": 1})


class TestArchiveCapFixup(RecallBase):
    """CD 1a fix-up R1#3: archived notes never hold one of the 5 active-delta slots."""

    def setUp(self):
        super().setUp()
        archived_active = [
            _note(
                id=f"arch-{i}",
                slug=f"arch-{i}",
                status="atomic",
                deltaStatus="active",
                deltaTrigger="t",
                deltaAction="a",
                meta={"attachments": [], "links": [], "archivedAt": "2026-02-01T00:00:00Z"},
            )
            for i in range(5)
        ]
        self.write_state(
            books=[_book(status="finished", currentPos=400, normalizedPos=1.0)],
            notes=[_note(id="target", slug="target", status="atomic", deltaTrigger="t", deltaAction="a")]
            + archived_active,
        )

    def test_check_active_delta_cap_ignores_archived(self):
        state = self.read_state()
        pragya_cli.check_active_delta_cap(state["notes"], "target", "active")  # no raise
        res = self.ok("note-update", "--note", "target", "--delta-status", "active")
        self.assertEqual(res["note"]["deltaStatus"], "active")

    def test_book_list_active_delta_count_ignores_archived(self):
        self.assertEqual(self.ok("book-list")["activeDeltaCount"], 0)

    def test_export_md_skips_archived_atomic(self):
        self.assertFalse(pragya_cli._needs_md_export(self.read_state()["notes"][1]))
        self.assertTrue(pragya_cli._needs_md_export(self.read_state()["notes"][0]))


if __name__ == "__main__":
    unittest.main()
