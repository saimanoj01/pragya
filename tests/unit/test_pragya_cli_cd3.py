"""CD Batch 3: CLI parity for slug aliases (C3.2, decisions OQ-6 alias-only) and the
`everFinished` re-read spoiler rule (C2.4 / OQ-7). Mirrors tests/unit/cd3GraphSearch.test.mjs.
Offline, state-file based.
"""

from __future__ import annotations

import unittest

from test_pragya_cli import pragya_cli
from test_pragya_cli_m6_recall import RecallBase, _book, _note


class TestAliasHelpers(unittest.TestCase):
    def test_add_slug_alias_matches_ts(self):
        f = pragya_cli.add_slug_alias
        self.assertEqual(f(None, "a", "b"), ["a"])
        self.assertEqual(f(["a"], "b", "c"), ["a", "b"])
        self.assertEqual(f(["a", "b"], "c", "a"), ["b", "c"])
        self.assertEqual(f(["A b", "a-b", 7, ""], "x", "y"), ["a-b", "x"])
        many = [f"s{i}" for i in range(12)]
        out = f(many, "last", "cur")
        self.assertEqual(len(out), pragya_cli.NOTE_ALIAS_CAP)
        self.assertEqual(out[-1], "last")
        self.assertEqual(f(["a"], "same", "same"), ["a"])

    def test_resolve_note_and_taken_slugs(self):
        renamed = _note(id="n-b", slug="new-name", meta={"attachments": [], "links": [], "aliases": ["old-name"]})
        other = _note(id="n-a", slug="other")
        notes = [renamed, other]
        self.assertEqual(pragya_cli.resolve_note(notes, "old-name")["id"], "n-b")
        self.assertEqual(pragya_cli.resolve_note(notes, "Old Name")["id"], "n-b")
        self.assertIn("old-name", pragya_cli.taken_slugs(notes, "n-a"))
        self.assertNotIn("old-name", pragya_cli.taken_slugs(notes, "n-b"))
        self.assertEqual(pragya_cli.generate_unique_slug("Old Name", pragya_cli.taken_slugs(notes)), "old-name-2")


class TestEverFinished(unittest.TestCase):
    def test_reread_turns_shields_off_and_unlocks_predictions(self):
        book = _book(currentPos=10, normalizedPos=10 / 400)
        ahead = _note(pos=300, normalizedPos=0.75, meta={"attachments": [], "links": [], "isPrediction": True})
        self.assertTrue(pragya_cli.is_note_spoiler(ahead, book))
        self.assertTrue(pragya_cli.is_sealed_prediction(ahead, book))
        reread = dict(book, meta=dict(book["meta"], everFinished=True))
        self.assertTrue(pragya_cli.is_ever_finished(reread))
        self.assertFalse(pragya_cli.is_note_spoiler(ahead, reread))
        self.assertFalse(pragya_cli.is_sealed_prediction(ahead, reread))
        self.assertTrue(pragya_cli.is_unlocked_prediction(ahead, reread))
        self.assertFalse(pragya_cli.is_ever_finished(dict(book, meta=dict(book["meta"], everFinished="true"))))


class TestReflectSlugRenameCli(RecallBase):
    def test_slug_rename_keeps_old_slug_as_alias_and_resolves(self):
        self.write_state(books=[_book()], notes=[_note(status="inbox")])
        self.ok("reflect", "--note", "note-one", "--stage", "commit", "--slug", "renamed-note",
                "--takeaway", "t", "--context", "c", "--critique", "k")
        n = self.note_in_state("note-1")
        self.assertEqual(n["slug"], "renamed-note")
        self.assertEqual(n["meta"]["aliases"], ["note-one"])
        # The old slug still resolves for later commands.
        self.ok("note-update", "--note", "note-one", "--title", "Still me")
        self.assertEqual(self.note_in_state("note-1")["meta"]["title"], "Still me")
        self.assertEqual(self.note_in_state("note-1")["meta"]["aliases"], ["note-one"])


if __name__ == "__main__":
    unittest.main()


class TestFixupParity(unittest.TestCase):
    """CD 3 fix-up: QA-36 Unicode slugs, QA-37 shared regex (same tables as cd3GraphSearch)."""

    def test_unicode_slugify_matches_ts(self):
        f = pragya_cli.slugify_or_none
        self.assertEqual(f("Über Café"), "uber-cafe")
        self.assertEqual(f("日本 の 本"), "日本-の-本")
        self.assertEqual(f("It\u2019s 2²"), "its-22")
        self.assertIsNone(f("🔥"))
        self.assertIsNone(f("!!!"))
        self.assertEqual(pragya_cli.slugify("!!!"), "note")

    def test_wikilink_regex_and_extractor(self):
        self.assertEqual(
            [m.group(1) for m in pragya_cli.WIKILINK_RE.finditer("[[a]] [[b\nc]] [[d[e]] [[f]]")], ["a", "f"]
        )
        self.assertEqual(pragya_cli.extract_wikilinks("[[🔥]] [[日本]] [[Über]]"), ["日本", "uber"])


class TestEverFinishedOnStatusChange(RecallBase):
    def test_book_update_out_of_finished_sets_ever_finished(self):
        self.write_state(books=[_book(status="finished", currentPos=400, normalizedPos=1.0)], notes=[_note()])
        self.ok("book-update", "--book", "book-fic", "--status", "reading", "--pos", "0", "--force-pos")
        b = self.book_in_state()
        self.assertEqual(b["status"], "reading")
        self.assertIs(b["meta"]["everFinished"], True)

    def test_other_transitions_do_not(self):
        self.write_state(books=[_book(status="queued", currentPos=0)], notes=[_note()])
        self.ok("book-update", "--book", "book-fic", "--status", "reading")
        self.assertNotIn("everFinished", self.book_in_state()["meta"])


class TestLegacySlugFallback(RecallBase):
    """CD 3 follow-up R2-a: notes slugged under the old ASCII-only rule keep resolving."""

    def test_legacy_slugify_and_keys(self):
        self.assertEqual(pragya_cli.legacy_slugify("Café culture"), "caf-culture")
        self.assertIsNone(pragya_cli.legacy_slugify("日本"))
        self.assertEqual(pragya_cli.wikilink_keys("Café culture"), ["Café culture", "cafe-culture", "caf-culture"])
        self.assertEqual(
            pragya_cli.extract_wikilink_keys("see [[Café culture]] and [[🔥]]"),
            {"Café culture", "cafe-culture", "caf-culture"},
        )
        # The existing extractor output is unchanged (new-rule slugs only).
        self.assertEqual(pragya_cli.extract_wikilinks("see [[Café culture]]"), ["cafe-culture"])

    def test_resolve_note_order(self):
        legacy = _note(id="n-legacy", slug="caf-culture")
        self.assertIs(pragya_cli.resolve_note([legacy], "Café culture"), legacy)
        # New slug beats legacy slug.
        new = _note(id="n-new", slug="cafe-culture")
        self.assertIs(pragya_cli.resolve_note([legacy, new], "Café culture"), new)
        # Legacy slug beats an alias.
        aliased = _note(id="n-alias", slug="other", meta={"updatedAt": "u", "aliases": ["caf-culture"]})
        self.assertIs(pragya_cli.resolve_note([aliased, legacy], "Café culture"), legacy)
        # Legacy key also matches aliases.
        self.assertIs(pragya_cli.resolve_note([aliased], "Café culture"), aliased)

    def test_cli_note_flag_resolves_legacy_slug(self):
        self.write_state(books=[_book()], notes=[_note(slug="caf-culture")])
        self.ok("note-update", "--note", "Café culture", "--title", "Café culture")
        n = self.note_in_state("note-1")
        self.assertEqual(n["meta"]["title"], "Café culture")
        self.assertEqual(n["slug"], "caf-culture", "stored slug never rewritten")
