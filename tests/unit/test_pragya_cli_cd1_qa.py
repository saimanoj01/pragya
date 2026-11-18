"""QA (CD Batch 1a) — soft-archive must be hidden from every CLI surface, yet resolvable.

Passing tests lock in verified behavior. QA-25 was a ``unittest.expectedFailure`` finding from
team/cd_batch1_qa_report.md; fixed in the CD 1a fix-up and now a regular test.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from test_pragya_cli import pragya_cli
from test_pragya_cli_m6_recall import RecallBase, T0, _book, _note

ARCH = "2026-02-01T00:00:00.000Z"
SECRET = "ARCHIVED_SECRET_TAKEAWAY"


def _archived_note(**kw):
    meta = {"attachments": [], "links": [], "archivedAt": ARCH, "title": "Archived Title"}
    fields = dict(id="n-arch", slug="n-arch", status="atomic", pos=50, takeaway=SECRET,
                  createdAt="2025-01-01T00:00:00Z", meta=meta)
    fields.update(kw)
    return _note(**fields)


class TestQaArchiveHiddenEverywhereCli(RecallBase):
    def setUp(self):
        super().setUp()
        finished = _book(status="finished", currentPos=400, normalizedPos=1.0,
                         meta={"updatedAt": T0, "subgenre": "x"})
        visible = _note(id="n-vis", slug="n-vis", status="atomic", pos=40, takeaway="visible one",
                        createdAt="2025-01-01T00:00:00Z")
        self.write_state(books=[finished], notes=[visible, _archived_note()])

    def test_recall_qa_checkin_shuffle_exclude(self):
        qa = self.ok("recall", "--mode", "qa", "--query", SECRET)
        self.assertEqual(qa["matches"], [])
        sh = self.ok("recall", "--mode", "shuffle", "--date", "2026-11-17")
        self.assertNotIn(SECRET, json.dumps(sh))

    def test_book_doc_sync_doc_out_excludes(self):
        out = Path(self._tmp.name) / "doc.md"
        self.ok("book-doc-sync", "--book", "book-fic", "--doc-out", str(out))
        text = out.read_text(encoding="utf-8")
        self.assertIn("visible one", text)
        self.assertNotIn(SECRET, text)

    def test_notes_summary_excludes(self):
        raw = json.loads(self.state.read_text(encoding="utf-8"))
        raw["books"][0]["status"] = "reading"
        self.state.write_text(json.dumps(raw), encoding="utf-8")
        p = self.ok("progress", "--book", "book-fic", "--finish")
        self.assertNotIn(SECRET, json.dumps(p))
        self.assertIn("n-vis", [e["id"] for e in p["notesSummary"]])

    def test_export_md_book_index_excludes(self):
        out = Path(self._tmp.name) / "md"
        p = self.ok("export-md", "--output-dir", str(out))
        for f in p["bookIndexFiles"]:
            self.assertNotIn(SECRET, Path(f).read_text(encoding="utf-8"))

    def test_qa25_export_md_per_note_files_exclude_archived(self):
        """QA-25: export-md's per-note Markdown export (`_needs_md_export`) does not check
        `is_archived`, so an archived atomic note is still written to <output-dir>/<slug>.md
        (and re-exported on every edit). The book index excludes it; per-note files don't."""
        out = Path(self._tmp.name) / "md"
        p = self.ok("export-md", "--output-dir", str(out))
        blob = "".join(Path(f).read_text(encoding="utf-8") for f in p["exportedFiles"])
        self.assertNotIn(SECRET, blob)

    def test_archived_note_still_resolves_and_restores(self):
        self.ok("note-update", "--note", "n-arch", "--unarchive")
        n = self.note_in_state("n-arch")
        self.assertNotIn("archivedAt", n["meta"])
        self.assertEqual(n["meta"]["title"], "Archived Title")
        qa = self.ok("recall", "--mode", "qa", "--query", SECRET)
        self.assertIn(SECRET, json.dumps(qa["matches"]))

    def test_book_list_default_and_include_archived(self):
        raw = json.loads(self.state.read_text(encoding="utf-8"))
        raw["books"].append(_book(id="b-arch", title="Gone", meta={"updatedAt": T0, "archivedAt": ARCH}))
        self.state.write_text(json.dumps(raw), encoding="utf-8")
        p = self.ok("book-list")
        self.assertNotIn("b-arch", [b["id"] for b in p["books"]])
        self.assertEqual(p.get("archivedCount"), 1)
        p2 = self.ok("book-list", "--include-archived")
        self.assertIn("b-arch", [b["id"] for b in p2["books"]])

    def test_capture_onto_archived_book_refused_without_write(self):
        raw = json.loads(self.state.read_text(encoding="utf-8"))
        raw["books"][0]["meta"]["archivedAt"] = ARCH
        self.state.write_text(json.dumps(raw), encoding="utf-8")
        before = self.state.read_text(encoding="utf-8")
        err = self.fails("capture", "--book", "book-fic", "--takeaway", "x")
        self.assertIn("--unarchive", err)
        self.assertEqual(self.state.read_text(encoding="utf-8"), before)


class TestQaArchiveDeltaCap(RecallBase):
    def test_archive_unarchive_round_trip_keeps_meta_and_respects_cap(self):
        notes = [_note(id=f"a{i}", slug=f"a{i}", status="atomic", deltaStatus="active", deltaTrigger="t")
                 for i in range(5)]
        notes[0]["meta"] = {"attachments": [], "links": [], "sparStage": {"s": 1}, "agentKey": [1]}
        notes.append(_note(id="six", slug="six", status="atomic", deltaTrigger="t"))
        self.write_state(books=[_book()], notes=notes)
        p = self.ok("note-update", "--note", "a0", "--archive")
        self.assertTrue(p.get("deltaPaused"))
        a0 = self.note_in_state("a0")
        self.assertEqual(a0["deltaStatus"], "paused")
        self.assertEqual(a0["meta"]["sparStage"], {"s": 1})
        # Freed slot is taken by another note → restore must not exceed 5 active.
        self.ok("note-update", "--note", "six", "--delta-status", "active")
        p = self.ok("note-update", "--note", "a0", "--unarchive")
        self.assertTrue(p.get("deltaCapped"))
        st = self.read_state()
        self.assertEqual(sum(1 for n in st["notes"] if n["deltaStatus"] == "active"), 5)
        a0 = self.note_in_state("a0")
        self.assertEqual(a0["deltaStatus"], "paused")
        self.assertEqual(a0["meta"]["agentKey"], [1])
        self.assertNotIn("archivedAt", a0["meta"])

    def test_archive_flags_mutually_exclusive_and_idempotent(self):
        self.write_state(books=[_book()], notes=[_note()])
        code, _p, err = self.run_cli("note-update", "--note", "note-1", "--archive", "--unarchive")
        self.assertEqual(code, 2, err)
        self.ok("note-update", "--note", "note-1", "--archive")
        first = self.note_in_state("note-1")["meta"]["archivedAt"]
        self.ok("note-update", "--note", "note-1", "--archive")
        self.assertEqual(self.note_in_state("note-1")["meta"]["archivedAt"], first)


if __name__ == "__main__":
    unittest.main()
