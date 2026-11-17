"""M6 Batch 6: Companion Doc & Markdown timelines (Python only, offline).

A1.1 timeline selection/order, A1.2 two-tier rendering + `### ` ops, A1.3 capstone block,
A1.4 the pure in-place planner (decisions OQ-2 override: only Pragya marker blocks are
touched, prose is byte-preserved) incl. the Docs batchUpdate request builder checked
against a UTF-16 Docs simulator, and A1.5 the per-book Markdown index.
"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from test_pragya_cli import pragya_cli
from test_pragya_cli_m6_recall import T0, RecallBase, _book, _note

DocLine = pragya_cli.DocLine


def _tl_note(nid, pos, status="saved", created=T0, **kw):
    fields = {"id": nid, "slug": nid, "pos": pos, "status": status, "createdAt": created,
              "bookId": "book-sys", "meta": {"attachments": [], "links": []}}
    fields.update(kw)
    return _note(**fields)


def _systems_book(**kw):
    fields = {"id": "book-sys", "title": "Thinking in Systems", "author": "Donella Meadows",
              "kind": "nonfiction", "currentPos": 100, "totalPos": 400, "meta": {"updatedAt": T0}}
    fields.update(kw)
    return _book(**fields)


def _cap_book(**kw):
    meta = {
        "updatedAt": T0,
        "finishedAt": "2026-11-10T12:00:00.000Z",
        "capstone": {
            "arcOrThesis": "Structure drives behaviour.",
            "keyLearnings": ["Delays cause oscillation.", "Look for the loop."],
            "perspectiveShift": "I look for the loop before blaming the person.",
            "completedAt": "2026-11-12T08:00:00.000Z",
        },
    }
    return _systems_book(status="finished", currentPos=400, normalizedPos=1.0, meta=meta, **kw)


class TestTimelineSelection(unittest.TestCase):
    def test_order_drafts_and_backfill(self):
        book = _systems_book()
        notes = [
            _tl_note("late", 300, "atomic"),
            _tl_note("tie-b", 100, created="2026-01-02T00:00:00.000Z"),
            _tl_note("tie-a", 100, created="2026-01-01T00:00:00.000Z"),
            _tl_note("stale-norm", 10, normalizedPos=0.99),
            _tl_note("inbox", 20, "inbox"),
            _tl_note("refl", 30, "in-reflection"),
            _tl_note("other", 5, bookId="other-book"),
        ]
        # "late" (p. 300) is ahead of the bookmark (p. 100) -> shielded by default.
        ids = [n["id"] for n in pragya_cli.select_book_timeline(notes, book, include_spoilers=True)]
        self.assertEqual(ids, ["stale-norm", "tie-a", "tie-b", "late"])
        with_drafts = [n["id"] for n in pragya_cli.select_book_timeline(notes, book, True, True)]
        self.assertEqual(with_drafts, ["stale-norm", "inbox", "refl", "tie-a", "tie-b", "late"])
        # A backfilled earlier note sorts first even if created last.
        notes.append(_tl_note("backfill", 1, created="2027-01-01T00:00:00.000Z"))
        self.assertEqual(pragya_cli.select_book_timeline(notes, book)[0]["id"], "backfill")


class TestRendering(unittest.TestCase):
    def test_atomic_block_full_fields_and_badge(self):
        book = _systems_book()
        note = _tl_note(
            "stocks", 12, "atomic", quote="A stock is\nmemory.", takeaway="Flows change stocks.",
            contextMechanism="Inflows minus outflows.", critique="Ignores delays.",
            deltaTrigger="WHEN metrics dip", deltaAction="DO: wait one cycle",
            meta={"attachments": [], "links": [], "title": "Stocks and Flows", "chapter": "1"},
        )
        lines = pragya_cli.render_note_block(note, book)
        self.assertEqual(lines[0].level, 2)
        self.assertEqual([ln.text for ln in lines], [
            "[Ch. 1 · p. 12] Stocks and Flows [note:stocks]",
            'Quote: "A stock is memory."',
            "Takeaway: Flows change stocks.",
            "Mechanism: Inflows minus outflows.",
            "WHEN metrics dip",
            "DO wait one cycle",
            "Critique: Ignores delays.",
        ])
        text = pragya_cli._format_companion_entry(note, book)
        self.assertNotIn("WHEN WHEN", text)
        self.assertNotIn("DO DO", text)
        self.assertTrue(text.startswith("## [Ch. 1 · p. 12] Stocks and Flows [note:stocks]"))

    def test_atomic_omits_empty_lines(self):
        lines = pragya_cli.render_note_block(_tl_note("a", 5, "atomic", takeaway="only"), _systems_book())
        self.assertEqual([ln.text for ln in lines[1:]], ["Takeaway: only"])

    def test_saved_block_has_no_layer2_and_title_fallbacks(self):
        book = _systems_book()
        saved = _tl_note("s1", 19, quote="q", takeaway="one two three four five six seven eight nine ten",
                         contextMechanism="HIDDEN", critique="HIDDEN", deltaTrigger="HIDDEN", deltaStatus="paused")
        lines = pragya_cli.render_note_block(saved, book)
        self.assertEqual(lines[0].level, 3)
        self.assertEqual(lines[0].text, "[p. 19] one two three four five six seven eight… [note:s1]")
        self.assertEqual([ln.text for ln in lines[1:]],
                         ['Quote: "q"', "Takeaway: one two three four five six seven eight nine ten"])
        self.assertNotIn("HIDDEN", pragya_cli.lines_to_text(lines))
        short = _tl_note("s2", 1, takeaway="exactly three words")
        self.assertIn("] exactly three words [note:s2]", pragya_cli.render_note_block(short, book)[0].text)
        empty = _tl_note("s3", 1, takeaway="", quote="quote only")
        self.assertIn("] Quick Note [note:s3]", pragya_cli.render_note_block(empty, book)[0].text)
        titled = _tl_note("s4", 1, meta={"attachments": [], "links": [], "title": "Mine"})
        self.assertIn("] Mine [note:s4]", pragya_cli.render_note_block(titled, book)[0].text)

    def test_level3_op_and_header(self):
        ops = pragya_cli._companion_text_to_gdocs_ops("# H1\nline\n## Two\n### Three\nbody")
        self.assertEqual(
            [(o["op"], o.get("level")) for o in ops],
            [("heading", "1"), ("append", None), ("heading", "2"), ("heading", "3"), ("append", None)],
        )
        self.assertEqual(ops[3]["text"], "Three")
        # decisions Batch 6 (3): no "Now in:" line even while reading with a chapter set.
        reading = _systems_book(meta={"updatedAt": T0, "currentChapter": "6"})
        self.assertEqual([ln.text for ln in pragya_cli.render_doc_header(reading)],
                         ["Pragya · Thinking in Systems", "Author: Donella Meadows · Non-fiction"])
        header = [ln.text for ln in pragya_cli.render_doc_header(_cap_book())]
        self.assertEqual(header[1], "Author: Donella Meadows · Non-fiction · Finished 2026-11-10")
        self.assertEqual(len(header), 2)

    def test_capstone_block(self):
        lines = pragya_cli.render_capstone_block(_cap_book())
        self.assertEqual([ln.text for ln in lines], [
            "Whole-Book Picture [capstone:book-sys]",
            "Thesis: Structure drives behaviour.",
            "Key Learnings:",
            "• Delays cause oscillation.",
            "• Look for the loop.",
            "How My Thinking Shifted: I look for the loop before blaming the person.",
            "Written 2026-11-12",
        ])
        self.assertEqual(lines[0].level, 2)
        fiction = _cap_book(kind="fiction")
        self.assertTrue(pragya_cli.render_capstone_block(fiction)[1].text.startswith("Arc: "))
        self.assertEqual(pragya_cli.render_capstone_block(_systems_book()), [])

    def test_full_doc_capstone_before_every_note(self):
        text = pragya_cli.lines_to_text(
            pragya_cli.render_full_companion_doc(_cap_book(), [_tl_note("a", 1, "atomic"), _tl_note("b", 2)])
        )
        self.assertLess(text.index("[capstone:book-sys]"), text.index("[note:"))
        self.assertTrue(text.startswith("# Pragya · Thinking in Systems\nAuthor: "))
        self.assertIn("\n## [p. 1] a [note:a]", text)
        self.assertIn("\n### [p. 2] takeaway one [note:b]", text)
        no_cap = pragya_cli.lines_to_text(pragya_cli.render_full_companion_doc(_systems_book(), []))
        self.assertNotIn("capstone", no_cap)


class TestPlanner(unittest.TestCase):
    def setUp(self):
        self.book = _systems_book()

    def plan(self, text, timeline, book=None):
        return pragya_cli.plan_companion_text(text, book or self.book, timeline)

    def test_saved_to_atomic_upgrade_in_place_preserves_prose(self):
        a = _tl_note("a", 10)
        b = _tl_note("b", 20)
        v1, added, updated = self.plan("", [a, b])
        self.assertEqual((added, updated), (["a", "b"], []))
        prose = "My own thought,   with  odd   spacing\t\nand a second line."
        doc = v1.rstrip("\n").replace("\n\n### [p. 20]", f"\n{prose}\n\n### [p. 20]")
        self.assertIn(prose, doc)
        deep = dict(a, status="atomic", contextMechanism="mech", deltaTrigger="t", deltaStatus="active")
        v2, added, updated = self.plan(doc, [deep, b])
        self.assertEqual((added, updated), ([], ["a"]))
        self.assertEqual(v2.count("[note:a]"), 1)
        self.assertIn("## [p. 10] a [note:a]\nTakeaway: takeaway one\nMechanism: mech\nWHEN t", v2)
        self.assertNotIn("### [p. 10]", v2)
        self.assertIn(prose, v2)  # byte-preserved
        v3, added, updated = self.plan(v2, [deep, b])
        self.assertEqual((v3, added, updated), (v2, [], []))

    def test_no_change_means_no_edits(self):
        tl = [_tl_note("a", 1, "atomic"), _tl_note("b", 2)]
        v1, _, _ = self.plan("", tl)
        lines = pragya_cli.text_to_doc_lines(v1)
        self.assertEqual(pragya_cli.plan_companion_doc(lines, self.book, tl).edits, [])

    def test_backfill_inserts_in_reading_order_before_successor(self):
        b = _tl_note("b", 20)
        c = _tl_note("c", 30)
        v1, _, _ = self.plan("", [b, c])
        doc = v1.rstrip("\n") + "\nTrailing prose after c."
        early = _tl_note("early", 5)
        mid = _tl_note("mid", 25)
        v2, added, _ = self.plan(doc, [early, b, mid, c])
        self.assertEqual(added, ["early", "mid"])
        order = [v2.index(f"[note:{i}]") for i in ("early", "b", "mid", "c")]
        self.assertEqual(order, sorted(order))
        self.assertTrue(v2.endswith("Trailing prose after c."))
        self.assertLess(v2.index("Pragya · Thinking"), v2.index("[note:early]"))

    def test_legacy_format_upgraded_unknown_markers_and_duplicates_kept(self):
        legacy = (
            "# Pragya · Thinking in Systems\nAuthor: Donella Meadows\n\n"
            "## Old Title (p. 10) [note:a]\nTakeaway: old text\n\n"
            "My prose stays.\n\n"
            "## Someone else [note:not-in-timeline]\nTakeaway: keep me\n"
        )
        a = _tl_note("a", 10, "atomic", takeaway="new text", meta={"attachments": [], "links": [], "title": "New"})
        v2, added, updated = self.plan(legacy, [a])
        self.assertEqual((added, updated), ([], ["a"]))
        self.assertIn("## [p. 10] New [note:a]\nTakeaway: new text\n\nMy prose stays.", v2)
        self.assertIn("## Someone else [note:not-in-timeline]\nTakeaway: keep me", v2)
        self.assertTrue(v2.startswith("# Pragya · Thinking in Systems\nAuthor: Donella Meadows\n"))
        self.assertEqual(v2.count("[note:a]"), 1)

    def test_capstone_added_under_header_replaced_then_removed(self):
        tl = [_tl_note("a", 1, "atomic")]
        v1, _, _ = self.plan("", tl)  # no capstone yet
        doc = v1.rstrip("\n").replace("\n\n## [p. 1]", "\nMy note right under the header.\n\n## [p. 1]")
        cap_book = _cap_book()
        v2, _, _ = self.plan(doc, tl, cap_book)
        self.assertLess(v2.index("[capstone:book-sys]"), v2.index("[note:a]"))
        self.assertLess(v2.index("Author: "), v2.index("[capstone:"))
        self.assertIn("My note right under the header.", v2)
        # Edited capstone -> replaced in place, still exactly one block.
        edited = json.loads(json.dumps(cap_book))
        edited["meta"]["capstone"]["perspectiveShift"] = "Changed my mind."
        lines = pragya_cli.text_to_doc_lines(v2)
        plan = pragya_cli.plan_companion_doc(lines, edited, tl)
        self.assertEqual(plan.capstone, "updated")
        v3 = pragya_cli.lines_to_text(pragya_cli.apply_doc_plan(lines, plan))
        self.assertEqual(v3.count("[capstone:book-sys]"), 1)
        self.assertIn("How My Thinking Shifted: Changed my mind.", v3)
        self.assertIn("My note right under the header.", v3)
        # Capstone cleared -> block removed, prose untouched.
        plan = pragya_cli.plan_companion_doc(pragya_cli.text_to_doc_lines(v3), self.book, tl)
        self.assertEqual(plan.capstone, "removed")
        v4 = pragya_cli.lines_to_text(pragya_cli.apply_doc_plan(pragya_cli.text_to_doc_lines(v3), plan))
        self.assertNotIn("capstone", v4)
        self.assertIn("My note right under the header.", v4)

    def test_prose_starting_like_a_field_after_blank_line_is_not_consumed(self):
        v1, _, _ = self.plan("", [_tl_note("a", 1, "atomic")])
        doc = v1.rstrip("\n") + "\n\nQuote: my own quote of the day"
        v2, _, updated = self.plan(doc, [_tl_note("a", 1, "atomic", takeaway="changed")])
        self.assertEqual(updated, ["a"])
        self.assertTrue(v2.endswith("\n\nQuote: my own quote of the day"))


# --- Docs API simulator (UTF-16 indexes, body starts at index 1) -----------------------


def _gdoc(paragraphs):
    """[(level, text)] -> documents.get JSON with contiguous UTF-16 indexes."""
    styles = {0: "NORMAL_TEXT", 1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3"}
    content = [{"endIndex": 1, "sectionBreak": {}}]
    idx = 1
    for level, text in paragraphs:
        run = text + "\n"
        end = idx + pragya_cli._utf16_len(run)
        content.append({
            "startIndex": idx, "endIndex": end,
            "paragraph": {"elements": [{"startIndex": idx, "endIndex": end, "textRun": {"content": run}}],
                          "paragraphStyle": {"namedStyleType": styles[level]}},
        })
        idx = end
    return {"documentId": "doc-1", "title": "Pragya · Thinking in Systems", "revisionId": "rev-1",
            "body": {"content": content}}


class DocSim:
    """Applies insertText / deleteContentRange to a UTF-16 body (index 1 = first char)."""

    def __init__(self, paragraphs):
        text = "".join(t + "\n" for _l, t in paragraphs)
        self.units = list(text.encode("utf-16-le"))
        self.styled = []

    def _to_bytes(self, index):
        return (index - 1) * 2

    def apply(self, requests):
        for req in requests:
            if "deleteContentRange" in req:
                r = req["deleteContentRange"]["range"]
                a, b = self._to_bytes(r["startIndex"]), self._to_bytes(r["endIndex"])
                assert 0 <= a <= b <= len(self.units) - 2, (a, b, len(self.units))  # never the final \n
                del self.units[a:b]
            elif "insertText" in req:
                at = self._to_bytes(req["insertText"]["location"]["index"])
                assert 0 <= at <= len(self.units) - 2
                self.units[at:at] = list(req["insertText"]["text"].encode("utf-16-le"))
            elif "updateParagraphStyle" in req or "updateTextStyle" in req or "deleteParagraphBullets" in req:
                body = req.get("updateParagraphStyle") or req.get("updateTextStyle") or req.get("deleteParagraphBullets")
                r = body["range"]
                assert 0 <= self._to_bytes(r["startIndex"]) < self._to_bytes(r["endIndex"]) <= len(self.units)
                self.styled.append((list(req)[0], r["startIndex"], r["endIndex"]))
            else:
                raise AssertionError(f"unexpected request {req}")

    @property
    def text(self):
        return bytes(self.units).decode("utf-16-le")


class TestDocsRequests(unittest.TestCase):
    def test_requests_reproduce_planner_text_and_preserve_prose(self):
        book = _systems_book()
        a = _tl_note("a", 10)
        c = _tl_note("c", 30)
        paragraphs = [
            (1, "Pragya · Thinking in Systems"),
            (0, "Author: Donella Meadows · Non-fiction"),
            (0, ""),
            (3, f"[p. 10] takeaway one [note:a]"),
            (0, "🧠 prose with an emoji (astral, 2 UTF-16 units) — keep me"),
            (0, ""),
            (3, f"[p. 30] takeaway one [note:c]"),
            (0, "tail prose"),
        ]
        lines = pragya_cli.parse_gdoc_lines(_gdoc(paragraphs))
        self.assertIsNotNone(lines)
        deep = dict(a, status="atomic", critique="crit")
        early = _tl_note("early", 1)
        mid = _tl_note("mid", 20)
        timeline = [early, deep, mid, c]
        plan = pragya_cli.plan_companion_doc(lines, book, timeline)
        self.assertEqual(plan.added_ids, ["early", "mid"])
        self.assertEqual(plan.updated_ids, ["a"])
        requests = pragya_cli.doc_plan_to_requests(lines, plan)
        sim = DocSim(paragraphs)
        sim.apply(requests)
        expected = "\n".join(ln.text for ln in pragya_cli.apply_doc_plan(lines, plan)) + "\n"
        self.assertEqual(sim.text, expected)
        self.assertIn("🧠 prose with an emoji (astral, 2 UTF-16 units) — keep me\n", sim.text)
        self.assertTrue(sim.text.endswith("tail prose\n"))
        # Upgraded heading styled HEADING_2, saved inserts HEADING_3.
        styles = [r["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"] for r in requests if "updateParagraphStyle" in r]
        self.assertIn("HEADING_2", styles)
        self.assertIn("HEADING_3", styles)

    def test_block_at_end_of_doc_and_capstone_removal(self):
        book = _systems_book()
        paragraphs = [
            (1, "Pragya · Thinking in Systems"),
            (0, "Author: Donella Meadows · Non-fiction"),
            (0, ""),
            (2, "Whole-Book Picture [capstone:book-sys]"),
            (0, "Thesis: old"),
            (0, ""),
            (2, "[p. 10] a [note:a]"),
            (0, "Takeaway: old"),
        ]
        lines = pragya_cli.parse_gdoc_lines(_gdoc(paragraphs))
        note = _tl_note("a", 10, "atomic", takeaway="new")
        plan = pragya_cli.plan_companion_doc(lines, book, [note])
        self.assertEqual(plan.capstone, "removed")
        sim = DocSim(paragraphs)
        sim.apply(pragya_cli.doc_plan_to_requests(lines, plan))
        expected = "\n".join(ln.text for ln in pragya_cli.apply_doc_plan(lines, plan)) + "\n"
        self.assertEqual(sim.text, expected)
        self.assertTrue(sim.text.endswith("[p. 10] a [note:a]\nTakeaway: new\n"))
        self.assertNotIn("capstone", sim.text)

    def test_unsafe_structures_return_none(self):
        self.assertIsNone(pragya_cli.parse_gdoc_lines({"document": {"body": {"content": []}}}))
        no_index = {"documentId": "d", "body": {"content": [{"paragraph": {"elements": []}}]}}
        self.assertIsNone(pragya_cli.parse_gdoc_lines(no_index))
        two_tabs = {"documentId": "d", "tabs": [{"documentTab": {"body": {"content": []}}}] * 2}
        self.assertIsNone(pragya_cli.parse_gdoc_lines(two_tabs))
        gap = _gdoc([(0, "a"), (0, "b")])
        gap["body"]["content"][2]["startIndex"] += 1
        self.assertIsNone(pragya_cli.parse_gdoc_lines(gap))
        table = _gdoc([(0, "a")])
        table["body"]["content"].append({"startIndex": 3, "endIndex": 10, "table": {}})
        lines = pragya_cli.parse_gdoc_lines(table)
        self.assertEqual(lines[-1].text, "\ufffc")


class _FakeDocsRunner:
    def __init__(self, book, notes, doc_payload, raw_batch_ok=True):
        from test_pragya_cli_m6_integrity import FakeWorkspace

        rows = {
            "Books": [pragya_cli.BOOKS_HEADERS, pragya_cli.book_to_row(book)],
            "Notes": [pragya_cli.NOTES_HEADERS] + [pragya_cli.note_to_row(n) for n in notes],
            "Sessions": [pragya_cli.SESSIONS_HEADERS],
            "DeltaLogs": [pragya_cli.DELTA_LOGS_HEADERS],
        }
        self.fake = FakeWorkspace(rows=rows)
        self.fake.doc_read_payload = doc_payload
        self.raw_batches = []
        self.raw_attempts = []
        self.read_sequence = []
        self.raw_batch_ok = raw_batch_ok

    def __call__(self, cmd):
        if cmd[:3] == ["gdocs", "mutate", "raw-batch"]:
            self.fake.calls.append(list(cmd))
            payload = json.loads(Path(cmd[cmd.index("-f") + 1]).read_text(encoding="utf-8"))
            self.raw_attempts.append(payload)
            ok = self.raw_batch_ok(payload) if callable(self.raw_batch_ok) else self.raw_batch_ok
            if not ok:
                return 1, "", "raw-batch rejected"
            self.raw_batches.append(payload)
            return 0, json.dumps({"ok": True}), ""
        if cmd[:3] == ["gdocs", "readonly", "read"] and self.read_sequence:
            self.fake.doc_read_payload = self.read_sequence.pop(0)
        return self.fake(cmd)

    def sync(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pragya_cli.main(["book-doc-sync", "--spreadsheet-id", "sid-m6", "--book", "book-sys", *extra], runner=self)
        assert code == 0, err.getvalue()
        return json.loads(out.getvalue())


class TestGoogleDocSync(unittest.TestCase):
    def _book(self):
        return _systems_book(docUrl="https://docs.google.com/document/d/doc-1/edit")

    def _paragraphs(self):
        return [
            (1, "Pragya · Thinking in Systems"),
            (0, "Author: Donella Meadows · Non-fiction"),
            (0, ""),
            (3, "[p. 10] takeaway one [note:a]"),
            (0, "My prose."),
        ]

    def test_changed_block_sends_single_raw_batch_without_clear(self):
        notes = [_tl_note("a", 10, "atomic", critique="crit")]
        runner = _FakeDocsRunner(self._book(), notes, _gdoc(self._paragraphs()))
        res = runner.sync()
        self.assertEqual(res["mode"], "in-place")
        self.assertEqual(res["updatedNoteIds"], ["a"])
        self.assertEqual(res["syncedNoteIds"], ["a"])
        self.assertEqual(len(runner.raw_batches), 1)
        reqs = runner.raw_batches[0]["requests"]
        self.assertFalse(any("clear" in json.dumps(r) for r in reqs))
        self.assertEqual(runner.fake.doc_batches, [])
        sim = DocSim(self._paragraphs())
        sim.apply(reqs)
        self.assertIn("[p. 10] a [note:a]\nTakeaway: takeaway one\nCritique: crit\nMy prose.\n", sim.text)

    def test_unchanged_doc_means_zero_writes(self):
        notes = [_tl_note("a", 10)]
        runner = _FakeDocsRunner(self._book(), notes, _gdoc(self._paragraphs()))
        res = runner.sync()
        self.assertEqual(res["mode"], "unchanged")
        self.assertEqual((res["syncedNoteCount"], runner.raw_batches, runner.fake.doc_batches), (0, [], []))

    def test_tail_only_additions_use_append_ops(self):
        notes = [_tl_note("a", 10), _tl_note("z", 99, "atomic")]
        runner = _FakeDocsRunner(self._book(), notes, _gdoc(self._paragraphs()))
        res = runner.sync()
        self.assertEqual(res["mode"], "append")
        self.assertEqual(res["addedNoteIds"], ["z"])
        self.assertEqual(runner.raw_batches, [])
        ops = runner.fake.doc_batches[0]
        self.assertEqual([o.get("level") for o in ops if o["op"] == "heading"], ["2"])

    def test_raw_batch_failure_falls_back_to_append_only_with_warning(self):
        notes = [_tl_note("early", 1), _tl_note("a", 10, "atomic")]
        runner = _FakeDocsRunner(self._book(), notes, _gdoc(self._paragraphs()), raw_batch_ok=False)
        res = runner.sync()
        self.assertEqual(res["mode"], "append-fallback")
        self.assertEqual(res["addedNoteIds"], ["early"])
        self.assertEqual(res["updatedNoteIds"], [])
        self.assertTrue(res["warnings"])
        blob = json.dumps(runner.fake.doc_batches)
        self.assertIn("[note:early]", blob)
        self.assertNotIn("[note:a]", blob)

    def test_unparseable_structure_falls_back(self):
        notes = [_tl_note("a", 10), _tl_note("new", 50)]
        payload = {"text": "# Pragya · Thinking in Systems\n### [p. 10] x [note:a]\n"}
        runner = _FakeDocsRunner(self._book(), notes, payload)
        res = runner.sync()
        self.assertEqual(res["mode"], "append-fallback")
        self.assertEqual(res["addedNoteIds"], ["new"])
        self.assertIn("could not be parsed safely", res["warnings"][0])


class TestDocOutIntegration(RecallBase):
    def test_sync_deepen_sync_then_noop(self):
        self.write_state(
            books=[_systems_book()],
            notes=[_tl_note("a", 10, bookId="book-sys"), _tl_note("b", 20, "atomic", bookId="book-sys"),
                   _tl_note("draft", 15, "inbox", bookId="book-sys")],
        )
        doc_out = Path(self._tmp.name) / "doc.txt"
        r1 = self.ok("book-doc-sync", "--book", "book-sys", "--doc-out", str(doc_out))
        self.assertTrue(r1["createdDoc"])
        self.assertEqual(r1["syncedNoteIds"], ["a", "b"])
        t1 = doc_out.read_text(encoding="utf-8")
        self.assertNotIn("[note:draft]", t1)
        doc_out.write_text(t1.rstrip("\n") + "\nA paragraph I wrote myself.\n", encoding="utf-8")

        self.ok("note-update", "--note", "a", "--status", "atomic", "--context", "why it works")
        r2 = self.ok("book-doc-sync", "--book", "book-sys", "--doc-out", str(doc_out))
        self.assertEqual((r2["addedNoteIds"], r2["updatedNoteIds"], r2["mode"]), ([], ["a"], "in-place"))
        t2 = doc_out.read_text(encoding="utf-8")
        self.assertEqual(t2.count("[note:a]"), 1)
        self.assertIn("## [p. 10] a [note:a]\nTakeaway: takeaway one\nMechanism: why it works", t2)
        self.assertIn("A paragraph I wrote myself.", t2)

        r3 = self.ok("book-doc-sync", "--book", "book-sys", "--doc-out", str(doc_out))
        self.assertEqual((r3["syncedNoteCount"], r3["mode"]), (0, "unchanged"))
        self.assertEqual(doc_out.read_text(encoding="utf-8"), t2)

        r4 = self.ok("book-doc-sync", "--book", "book-sys", "--doc-out", str(doc_out), "--include-drafts")
        self.assertEqual(r4["addedNoteIds"], ["draft"])
        t4 = doc_out.read_text(encoding="utf-8")
        self.assertLess(t4.index("[note:a]"), t4.index("[note:draft]"))
        self.assertLess(t4.index("[note:draft]"), t4.index("[note:b]"))


class TestBookIndexMarkdown(RecallBase):
    def _state(self):
        book = _cap_book()
        book["meta"]["currentChapter"] = "6"
        notes = [
            _tl_note("saved-1", 19, quote="line one\nline two", takeaway="saved takeaway", bookId="book-sys",
                     meta={"attachments": [], "links": [], "chapter": "1"}),
            _tl_note("atom-1", 12, "atomic", slug="stocks-and-flows", quote="A stock is memory.",
                     takeaway="Flows.", deltaTrigger="WHEN dip", deltaAction="DO wait", critique="NOT IN INDEX",
                     bookId="book-sys"),
            _tl_note("draft-1", 15, "inbox", bookId="book-sys"),
        ]
        self.write_state(books=[book, _book(id="empty-book", title="Nothing Here", meta={"updatedAt": T0})], notes=notes)

    def test_index_content_order_and_idempotency(self):
        self._state()
        out_dir = Path(self._tmp.name) / "md"
        r1 = self.ok("export-md", "--output-dir", str(out_dir))
        self.assertEqual(r1["bookIndexWritten"], 1)
        index = out_dir / "books" / "thinking-in-systems.md"
        self.assertEqual(r1["bookIndexFiles"], [str(index)])
        self.assertFalse((out_dir / "books" / "nothing-here.md").exists())
        text = index.read_text(encoding="utf-8")
        self.assertTrue(text.startswith(
            '---\ntitle: "Thinking in Systems"\nauthor: "Donella Meadows"\nkind: nonfiction\nstatus: finished\n'
            'currentChapter: "Ch. 6"\npragya_book_id: "book-sys"\n---\n\n# Thinking in Systems\n'
            "*Donella Meadows · Non-fiction · Finished 2026-11-10*\n"
        ))
        self.assertIn(
            "## Whole-Book Picture\n<!-- capstone:book-sys -->\n**Thesis:** Structure drives behaviour.\n\n"
            "**Key Learnings**\n- Delays cause oscillation.\n- Look for the loop.\n\n"
            "**How My Thinking Shifted:** I look for the loop before blaming the person.\n\n*Written 2026-11-12*\n",
            text,
        )
        self.assertIn(
            "## [p. 12] [[stocks-and-flows]]\n<!-- note:atom-1 -->\n> A stock is memory.\n\n"
            "**Takeaway:** Flows.  \n**WHEN** dip → **DO** wait\n",
            text,
        )
        # R2#1: the derived heading carries the whole short takeaway, so no Takeaway line.
        self.assertIn(
            "### [Ch. 1 · p. 19] saved takeaway\n<!-- note:saved-1 -->\n> line one\n> line two\n",
            text,
        )
        self.assertNotIn("**Takeaway:** saved takeaway", text)
        self.assertNotIn("NOT IN INDEX", text)
        self.assertNotIn("draft-1", text)
        self.assertLess(text.index("atom-1"), text.index("saved-1"))
        r2 = self.ok("export-md", "--output-dir", str(out_dir))
        self.assertEqual(r2["bookIndexWritten"], 0)
        self.assertEqual(r2["bookIndexUnchanged"], 1)
        r3 = self.ok("export-md", "--output-dir", str(out_dir), "--include-drafts")
        self.assertEqual(r3["bookIndexWritten"], 1)
        self.assertIn("<!-- note:draft-1 -->", index.read_text(encoding="utf-8"))

    def test_hostile_titles_stay_inside_books_dir_and_collisions_get_suffix(self):
        notes = [_tl_note("n1", 1, bookId="b1"), _tl_note("n2", 1, bookId="b2")]
        self.write_state(
            books=[_book(id="b1", title="../../etc/passwd", meta={"updatedAt": T0}),
                   _book(id="b2", title="etc passwd", meta={"updatedAt": T0})],
            notes=notes,
        )
        out_dir = Path(self._tmp.name) / "md"
        res = self.ok("export-md", "--output-dir", str(out_dir))
        books_dir = (out_dir / "books").resolve()
        self.assertEqual(res["bookIndexWritten"], 2)
        for f in res["bookIndexFiles"]:
            self.assertTrue(Path(f).resolve().is_relative_to(books_dir))
        self.assertEqual(sorted(Path(f).name for f in res["bookIndexFiles"]), ["etc-passwd-b2.md", "etc-passwd.md"])

    def test_per_note_export_stays_atomic_only(self):
        self._state()
        out_dir = Path(self._tmp.name) / "md"
        res = self.ok("export-md", "--output-dir", str(out_dir))
        self.assertEqual([Path(f).name for f in res["exportedFiles"]], ["stocks-and-flows.md"])


class TestSpoilerShield(RecallBase):
    """decisions Batch 6 (1): Doc / MD timelines shield spoilers + sealed predictions."""

    def _state(self, current_pos=100):
        fiction = _book(id="book-fic", title="Dune", kind="fiction", currentPos=current_pos, totalPos=400,
                        normalizedPos=current_pos / 400, meta={"updatedAt": T0})
        notes = [
            _tl_note("past", 50, "atomic", bookId="book-fic", takeaway="past takeaway"),
            _tl_note("at-mark", 100, bookId="book-fic", takeaway="at bookmark"),
            _tl_note("ahead", 300, "atomic", bookId="book-fic", takeaway="SPOILER_SECRET"),
            _tl_note("sealed", 60, bookId="book-fic", takeaway="SEALED_BET",
                     meta={"attachments": [], "links": [], "isPrediction": True}),
        ]
        self.write_state(books=[fiction], notes=notes)

    def test_default_shield_and_opt_in(self):
        self._state()
        tl, shielded = pragya_cli.select_book_timeline_with_shield(
            pragya_cli.StateFileBackend(self.state).load_workspace()["notes"],
            pragya_cli.StateFileBackend(self.state).load_workspace()["books"][0],
        )
        self.assertEqual([n["id"] for n in tl], ["past", "at-mark"])
        self.assertEqual(shielded, 2)
        doc_out = Path(self._tmp.name) / "doc.txt"
        res = self.ok("book-doc-sync", "--book", "book-fic", "--doc-out", str(doc_out))
        self.assertEqual(res["shieldedCount"], 2)
        text = doc_out.read_text(encoding="utf-8")
        self.assertNotIn("SPOILER_SECRET", text)
        self.assertNotIn("SEALED_BET", text)
        self.assertIn("at bookmark", text)  # a note exactly at the bookmark is not a spoiler
        md = Path(self._tmp.name) / "md"
        exp = self.ok("export-md", "--output-dir", str(md))
        self.assertEqual(exp["shieldedCount"], 2)
        index = (md / "books" / "dune.md").read_text(encoding="utf-8")
        self.assertNotIn("SPOILER_SECRET", index)
        self.assertNotIn("SEALED_BET", index)
        res2 = self.ok("book-doc-sync", "--book", "book-fic", "--doc-out", str(doc_out), "--include-spoilers")
        self.assertEqual((res2["shieldedCount"], sorted(res2["addedNoteIds"])), (0, ["ahead", "sealed"]))
        self.assertIn("SPOILER_SECRET", doc_out.read_text(encoding="utf-8"))
        exp2 = self.ok("export-md", "--output-dir", str(md), "--include-spoilers")
        self.assertEqual(exp2["shieldedCount"], 0)
        self.assertIn("SPOILER_SECRET", (md / "books" / "dune.md").read_text(encoding="utf-8"))

    def test_previously_synced_block_is_kept_when_note_becomes_shielded(self):
        self._state(current_pos=400)
        doc_out = Path(self._tmp.name) / "doc.txt"
        first = self.ok("book-doc-sync", "--book", "book-fic", "--doc-out", str(doc_out))
        self.assertIn("ahead", first["addedNoteIds"])
        before = doc_out.read_text(encoding="utf-8")
        # Bookmark moved back to p. 100: "ahead" is now a spoiler, but its block stays.
        self.ok("progress", "--book", "book-fic", "--pos", "100", "--force-pos")
        res = self.ok("book-doc-sync", "--book", "book-fic", "--doc-out", str(doc_out))
        self.assertEqual(res["shieldedCount"], 2)  # "ahead" + the still-sealed prediction
        self.assertEqual(res["mode"], "unchanged")
        self.assertEqual(doc_out.read_text(encoding="utf-8"), before)
        self.assertIn("SPOILER_SECRET", before)

    def test_rounded_book_norm_does_not_shield_note_at_bookmark(self):
        book = _book(currentPos=142, totalPos=218, normalizedPos=round(142 / 218, 6))
        note = _tl_note("n", 142, bookId=book["id"])
        self.assertFalse(pragya_cli.is_note_spoiler(note, book))
        self.assertTrue(pragya_cli.is_note_spoiler(dict(note, pos=143), book))


# ---------------------------------------------------------------------------
# Batch 6 fix-up
# ---------------------------------------------------------------------------


def _doc_paras_for(book, timeline, extra_after=None):
    """Paragraphs of a Doc exactly as Pragya renders it (+ optional user lines at the end)."""
    lines = pragya_cli.render_full_companion_doc(book, timeline)
    paras = [(ln.level, ln.text) for ln in lines]
    return paras + [(0, t) for t in (extra_after or [])]


class TestFixupRevisionGuard(unittest.TestCase):
    def _book(self):
        return _systems_book(docUrl="https://docs.google.com/document/d/doc-1/edit")

    def test_raw_batch_carries_required_revision_id(self):
        book = self._book()
        old = _tl_note("a", 10, "atomic")
        new = _tl_note("a", 10, "atomic", critique="crit")
        runner = _FakeDocsRunner(book, [new], _gdoc(_doc_paras_for(book, [old])))
        res = runner.sync()
        self.assertEqual(res["mode"], "in-place")
        self.assertEqual(runner.raw_batches[0]["writeControl"], {"requiredRevisionId": "rev-1"})

    def test_rejected_on_concurrent_edit_re_reads_and_re_plans_once(self):
        book = self._book()
        old = _tl_note("a", 10, "atomic")
        new = _tl_note("a", 10, "atomic", critique="crit")
        first = _gdoc(_doc_paras_for(book, [old]))
        # The user typed a line at the top meanwhile: new revision, shifted indexes.
        typed = _doc_paras_for(book, [old])
        typed.insert(2, (0, "User typed this while the agent was syncing."))
        second = _gdoc(typed)
        second["revisionId"] = "rev-2"
        runner = _FakeDocsRunner(book, [new], first,
                                 raw_batch_ok=lambda p: p["writeControl"]["requiredRevisionId"] == "rev-2")
        runner.read_sequence = [first, second, second]
        res = runner.sync()
        self.assertEqual(res["mode"], "in-place")
        self.assertEqual(res["updatedNoteIds"], ["a"])
        self.assertEqual([p["writeControl"]["requiredRevisionId"] for p in runner.raw_attempts], ["rev-1", "rev-2"])
        sim = DocSim(typed)
        sim.apply(runner.raw_batches[0]["requests"])
        self.assertIn("User typed this while the agent was syncing.\n", sim.text)
        self.assertIn("Critique: crit\n", sim.text)

    def test_late_success_is_detected_by_fresh_read(self):
        book = self._book()
        early = _tl_note("early", 1)
        a = _tl_note("a", 10, "atomic")
        before = _gdoc(_doc_paras_for(book, [a]))
        after = _gdoc(_doc_paras_for(book, [early, a]))
        after["revisionId"] = "rev-2"
        runner = _FakeDocsRunner(book, [early, a], before, raw_batch_ok=False)
        runner.read_sequence = [before, after]
        res = runner.sync()
        self.assertEqual((res["mode"], res["addedNoteIds"]), ("in-place", ["early"]))
        self.assertEqual(runner.fake.doc_batches, [])  # no duplicate append

    def test_fallback_after_failure_uses_a_fresh_read_no_duplicates(self):
        book = self._book()
        early = _tl_note("early", 1)
        mid = _tl_note("mid", 5)
        a = _tl_note("a", 10, "atomic")
        before = _gdoc(_doc_paras_for(book, [a]))
        # The batch partly landed: "early" is already there in the fresh read (same rev ->
        # no re-plan retry), so the fallback must append only "mid".
        partial = _gdoc(_doc_paras_for(book, [early, a]))
        runner = _FakeDocsRunner(book, [early, mid, a], before, raw_batch_ok=False)
        runner.read_sequence = [before, partial, partial]
        res = runner.sync()
        self.assertEqual(res["mode"], "append-fallback")
        self.assertEqual(res["addedNoteIds"], ["mid"])
        blob = json.dumps(runner.fake.doc_batches)
        self.assertNotIn("[note:early]", blob)
        self.assertIn("[note:mid]", blob)

    def test_missing_revision_id_never_sends_unguarded_index_edits(self):
        book = self._book()
        old = _tl_note("a", 10, "atomic")
        payload = _gdoc(_doc_paras_for(book, [old]))
        del payload["revisionId"]
        runner = _FakeDocsRunner(book, [_tl_note("a", 10, "atomic", critique="crit")], payload)
        res = runner.sync()
        self.assertEqual(res["mode"], "append-fallback")
        self.assertEqual(runner.raw_attempts, [])
        self.assertIn("revisionId", res["warnings"][0])

    def test_inserted_text_style_and_bullets_reset(self):
        book = _systems_book()
        a = _tl_note("a", 10, "atomic")
        paras = _doc_paras_for(book, [a])
        lines = pragya_cli.parse_gdoc_lines(_gdoc(paras))
        plan = pragya_cli.plan_companion_doc(lines, book, [_tl_note("early", 1), a])
        reqs = pragya_cli.doc_plan_to_requests(lines, plan)
        kinds = [list(r)[0] for r in reqs]
        self.assertIn("updateTextStyle", kinds)
        self.assertIn("deleteParagraphBullets", kinds)
        ts = next(r["updateTextStyle"] for r in reqs if "updateTextStyle" in r)
        self.assertEqual(ts["textStyle"], {})
        for f in ("bold", "italic", "underline", "link"):
            self.assertIn(f, ts["fields"].split(","))
        sim = DocSim(paras)
        sim.apply(reqs)  # ranges are valid against the doc at that point


class TestFixupBlockGrammar(unittest.TestCase):
    def setUp(self):
        self.book = _systems_book()

    def plan(self, text, timeline, book=None):
        return pragya_cli.plan_companion_text(text, book or self.book, timeline)

    def test_unchanged_note_plus_user_field_like_line_is_zero_edits(self):
        a = _tl_note("a", 10, "atomic", critique="c")
        v1, _, _ = self.plan("", [a])
        for user in ("Takeaway: my own thought", "Written on the train", "• my own aside", "DO not forget",
                     "Quote: something I heard", "Critique: mine"):
            doc = v1.rstrip("\n") + "\n" + user
            v2, added, updated = self.plan(doc, [a])
            self.assertEqual((v2, added, updated), (doc, [], []), user)

    def test_changed_note_keeps_non_grammar_user_lines(self):
        a = _tl_note("a", 10, "atomic", critique="c")
        v1, _, _ = self.plan("", [a])
        for user in ("Takeaway: second takeaway of mine", "Written on the train", "• my own aside", "WHEN I reread"):
            doc = v1.rstrip("\n") + "\n" + user
            v2, _, updated = self.plan(doc, [_tl_note("a", 10, "atomic", critique="changed")])
            self.assertEqual(updated, ["a"])
            self.assertTrue(v2.endswith("Critique: changed\n" + user), user)

    def test_capstone_grammar(self):
        book = _cap_book()
        v1, _, _ = self.plan("", [], book)
        for user in ("Thesis: my own", "• a bullet of mine", "Written by me", "Key Learnings: again"):
            doc = v1.rstrip("\n") + "\n" + user
            v2, _, _ = self.plan(doc, [], book)
            self.assertEqual(v2, doc, user)
        edited = json.loads(json.dumps(book))
        edited["meta"]["capstone"]["keyLearnings"].append("Third learning.")
        doc = v1.rstrip("\n") + "\n• a bullet of mine"
        v3, _, _ = self.plan(doc, [], edited)
        self.assertIn("• Third learning.\nHow My Thinking Shifted:", v3)
        self.assertTrue(v3.endswith("Written 2026-11-12\n• a bullet of mine"))
        # Bullets are only part of the capstone after Key Learnings:.
        lines = pragya_cli.text_to_doc_lines("## Whole-Book Picture [capstone:x]\n• stray\nThesis: t")
        self.assertEqual(pragya_cli.parse_doc_blocks(lines)[0].end, 1)

    def test_saved_blocks_only_take_quote_and_takeaway(self):
        lines = pragya_cli.text_to_doc_lines("### [p. 1] t [note:s]\nQuote: \"q\"\nTakeaway: t\nMechanism: mine")
        self.assertEqual(pragya_cli.parse_doc_blocks(lines)[0].end, 3)
        lines = pragya_cli.text_to_doc_lines("## [p. 1] t [note:s]\nTakeaway: t\nQuote: \"q\"")
        self.assertEqual(pragya_cli.parse_doc_blocks(lines)[0].end, 2)  # out of order stops

    def test_marker_with_user_suffix_is_known_and_suffix_kept(self):
        a = _tl_note("a", 10, "atomic")
        v1, _, _ = self.plan("", [a])
        doc = v1.replace("[note:a]", "[note:a] ⭐ reread")
        v2, added, updated = self.plan(doc, [a])
        self.assertEqual((v2, added, updated), (doc, [], []))
        v3, added, updated = self.plan(doc, [_tl_note("a", 10, "atomic", critique="new")])
        self.assertEqual((added, updated), ([], ["a"]))
        self.assertIn("[note:a] ⭐ reread\n", v3)
        self.assertEqual(v3.count("[note:a]"), 1)

    def test_capstone_goes_directly_under_header_above_user_prose(self):
        a = _tl_note("a", 10, "atomic")
        v1, _, _ = self.plan("", [a])
        doc = v1.replace("Author: Donella Meadows · Non-fiction\n", "Author: Donella Meadows · Non-fiction\nMy prose under the header\n")
        v2, _, _ = self.plan(doc, [a], _cap_book())
        self.assertLess(v2.index("[capstone:book-sys]"), v2.index("My prose under the header"))
        self.assertIn("Author: Donella Meadows · Non-fiction · Finished 2026-11-10", _cap_book_header())


def _cap_book_header():
    return pragya_cli.lines_to_text(pragya_cli.render_doc_header(_cap_book()))


class TestFollowupRenderAwareExtent(unittest.TestCase):
    """R1 R2-a / QA-21: on a changed block only fields present in the fresh render are managed."""

    def plan(self, text, timeline):
        return pragya_cli.plan_companion_text(text, _systems_book(), timeline)

    def test_user_takeaway_under_heading_only_saved_block_survives_upgrade(self):
        old = _tl_note("a", 10, takeaway="short one")
        v1, _, _ = self.plan("", [old])
        doc = v1.rstrip("\n") + "\nTakeaway: what I really think"
        upgraded = _tl_note("a", 10, "atomic", takeaway="short one", critique="c")
        v2, _, updated = self.plan(doc, [upgraded])
        self.assertEqual(updated, ["a"])
        self.assertIn("Takeaway: what I really think", v2)
        self.assertIn("## [p. 10] a [note:a]\nTakeaway: short one\nCritique: c\nTakeaway: what I really think", v2)

    def test_pragya_takeaway_lines_are_still_replaced(self):
        long_old = _tl_note("a", 10, takeaway="w " * 12)
        v1, _, _ = self.plan("", [long_old])
        v2, _, updated = self.plan(v1, [_tl_note("a", 10, takeaway="x " * 12)])
        self.assertEqual(updated, ["a"])
        self.assertNotIn("Takeaway: w w", v2)
        titled = _tl_note("t", 10, takeaway="short", meta={"attachments": [], "links": [], "title": "Mine"})
        v1, _, _ = self.plan("", [titled])
        v2, _, _ = self.plan(v1, [dict(titled, status="atomic", critique="c")])
        self.assertEqual(v2.count("Takeaway: short"), 1)

    def test_cleared_field_stays_as_stale_line(self):
        old = _tl_note("a", 10, "atomic", takeaway="t", critique="c")
        v1, _, _ = self.plan("", [old])
        v2, _, updated = self.plan(v1, [_tl_note("a", 10, "atomic", takeaway="t2")])
        self.assertEqual(updated, ["a"])
        self.assertIn("Takeaway: t2\nCritique: c", v2)


class TestFixupSavedTitle(unittest.TestCase):
    def test_redundant_takeaway_omitted_and_trailing_dot_stripped(self):
        book = _systems_book()
        short = _tl_note("s", 1, takeaway="Reviewed earlier today.")
        lines = pragya_cli.render_note_block(short, book)
        self.assertEqual([ln.text for ln in lines], ["[p. 1] Reviewed earlier today [note:s]"])
        long_note = _tl_note("l", 1, takeaway="one two three four five six seven eight. nine")
        lines = pragya_cli.render_note_block(long_note, book)
        self.assertEqual(lines[0].text, "[p. 1] one two three four five six seven eight… [note:l]")
        self.assertEqual(lines[1].text, "Takeaway: one two three four five six seven eight. nine")
        titled = _tl_note("t", 1, takeaway="short", meta={"attachments": [], "links": [], "title": "T."})
        self.assertEqual([ln.text for ln in pragya_cli.render_note_block(titled, book)],
                         ["[p. 1] T. [note:t]", "Takeaway: short"])
        md = pragya_cli.render_book_index_md(book, [short])
        self.assertIn("### [p. 1] Reviewed earlier today\n<!-- note:s -->", md)
        self.assertNotIn("**Takeaway:**", md)


class TestFixupMisc(RecallBase):
    def test_constants_and_empty_doc_mode(self):
        self.assertEqual(pragya_cli.DOC_SYNC_MODES, ("created", "in-place", "append", "append-fallback", "unchanged"))
        self.assertIn("skipped", pragya_cli.CAPSTONE_SYNC_STATES)
        book = _systems_book(docUrl="https://docs.google.com/document/d/doc-1/edit")
        runner = _FakeDocsRunner(book, [_tl_note("a", 10)],
                                 {"documentId": "doc-1", "revisionId": "r", "body": {"content": [{"endIndex": 1, "sectionBreak": {}}]}})
        res = runner.sync()
        self.assertEqual(res["mode"], "append")
        self.assertIn("never touches your own text", " ".join(pragya_cli.build_parser().format_help().split()))

    def test_book_index_slugs_unique_capped_and_order_independent(self):
        books = [{"id": f"book-sys{i}", "title": "Dune"} for i in (3, 1, 2)]
        a = pragya_cli.assign_book_index_slugs(books)
        b = pragya_cli.assign_book_index_slugs(list(reversed(books)))
        self.assertEqual(a, b)
        self.assertEqual(len(set(a.values())), 3)
        self.assertEqual(a["book-sys1"], "dune")
        same_prefix = [{"id": "abcdefgh-1", "title": "X"}, {"id": "abcdefgh-2", "title": "X"}, {"id": "abcdefgh", "title": "X"}]
        names = pragya_cli.assign_book_index_slugs(same_prefix)
        self.assertEqual(len(set(names.values())), 3)
        dupe_ids = [{"id": "Same", "title": "Y"}, {"id": "same", "title": "Y"}]
        self.assertEqual(len(set(pragya_cli.assign_book_index_slugs(dupe_ids).values())), 2)
        long_title = pragya_cli.assign_book_index_slugs([{"id": "x" * 200, "title": "A" * 300}, {"id": "y" * 200, "title": "A" * 300}])
        for name in long_title.values():
            self.assertLessEqual(len((name + ".md").encode("utf-8")), 120)


if __name__ == "__main__":
    unittest.main()
