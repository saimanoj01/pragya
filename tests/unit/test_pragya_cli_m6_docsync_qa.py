"""QA (Batch 6) adversarial probes: in-place companion-Doc planner, Docs requests (UTF-16
simulator), timeline shield/epsilon, and the Markdown book index.

Passing tests lock in verified behavior; ``unittest.expectedFailure`` tests document open
findings from team/batch6_qa_report.md.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from test_pragya_cli import pragya_cli
from test_pragya_cli_m6_docsync import DocSim, _cap_book, _gdoc, _systems_book, _tl_note
from test_pragya_cli_m6_recall import RecallBase, T0

DocLine = pragya_cli.DocLine


def plan_text(text, timeline, book=None):
    return pragya_cli.plan_companion_text(text, book or _systems_book(), timeline)


def docs_roundtrip(paragraphs, timeline, book=None):
    """Plan against a Docs AST, replay the requests in the UTF-16 simulator, and return
    (sim_text, planned_text, planned_lines, plan)."""
    book = book or _systems_book()
    lines = pragya_cli.parse_gdoc_lines(_gdoc(paragraphs))
    assert lines is not None
    plan = pragya_cli.plan_companion_doc(lines, book, timeline)
    sim = DocSim(paragraphs)
    sim.apply(pragya_cli.doc_plan_to_requests(lines, plan))
    planned = pragya_cli.apply_doc_plan(lines, plan)
    return sim.text, "\n".join(ln.text for ln in planned) + "\n", planned, plan


HEADER = [(1, "Pragya · Thinking in Systems"), (0, "Author: Donella Meadows · Non-fiction"), (0, "")]


class TestQaUserProseAdjacentToBlocks(unittest.TestCase):
    """OQ-2 override: content outside Pragya blocks must be byte-preserved."""

    def setUp(self):
        self.a = _tl_note("a", 10)
        self.v1, _, _ = plan_text("", [self.a])

    def test_plain_prose_directly_after_block_survives_update(self):
        doc = self.v1.rstrip("\n") + "\nMy own thought right under the block."
        v2, _, updated = plan_text(doc, [_tl_note("a", 10, takeaway="changed")])
        self.assertEqual(updated, ["a"])
        # Batch 6 fix-up (R2#1): a short untitled saved note's heading carries the whole
        # takeaway, so the block has no Takeaway line; the prose still follows unchanged.
        self.assertIn("### [p. 10] changed [note:a]\nMy own thought right under the block.", v2)

    def test_prose_inside_header_and_between_blocks_survives_backfill(self):
        b = _tl_note("b", 30)
        v1, _, _ = plan_text("", [self.a, b])
        doc = v1.replace("Author: Donella Meadows · Non-fiction",
                         "Author: Donella Meadows · Non-fiction\nMy header note") \
                .replace("\n\n### [p. 30]", "\n\nBetween a and b.\n\n### [p. 30]")
        v2, added, _ = plan_text(doc, [_tl_note("early", 1), self.a, _tl_note("mid", 20), b])
        self.assertEqual(added, ["early", "mid"])
        self.assertIn("My header note", v2)
        self.assertIn("Between a and b.", v2)
        order = [v2.index(s) for s in ("[note:early]", "[note:a]", "Between a and b.", "[note:mid]", "[note:b]")]
        self.assertEqual(order, sorted(order))

    def test_qa18_user_line_with_field_prefix_directly_after_block_is_eaten(self):
        """QA-18: a user-typed line that starts with a Pragya prefix and sits directly under a
        block (no blank line) is parsed as part of the block. Even with the note UNCHANGED,
        the block no longer matches its rendering, so the planner 'updates' it and deletes
        the user's line (and every later sync repeats the update)."""
        doc = self.v1.rstrip("\n") + "\nTakeaway: my own extra thought"
        v2, _, updated = plan_text(doc, [self.a])
        self.assertEqual(updated, [])
        self.assertIn("Takeaway: my own extra thought", v2)

    def test_qa18_scope_other_common_prefixes(self):
        """Batch 6 fix-up (R1#2): per-kind block grammar — none of these is consumed any more
        (this test previously documented that all four were eaten)."""
        eaten = []
        for user_line in ("Written by me after book club", "• my own bullet", "WHEN I reread this…", "DO not forget"):
            doc = self.v1.rstrip("\n") + "\n" + user_line
            v2, _, _ = plan_text(doc, [self.a])
            if user_line not in v2:
                eaten.append(user_line)
        self.assertEqual(eaten, [])


class TestQaPlannerEdgeCases(unittest.TestCase):
    def test_duplicate_markers_first_updated_copy_untouched_idempotent(self):
        a = _tl_note("a", 10)
        v1, _, _ = plan_text("", [a])
        block = "### [p. 10] takeaway one [note:a]\nTakeaway: takeaway one"
        doc = v1.rstrip("\n") + "\n\nUser copy below:\n" + block + "\n"
        changed = _tl_note("a", 10, takeaway="new words")
        v2, added, updated = plan_text(doc, [changed])
        self.assertEqual((added, updated), ([], ["a"]))
        self.assertEqual(v2.count("[note:a]"), 2)
        self.assertIn("User copy below:\n" + block, v2)  # second copy untouched
        v3, added, updated = plan_text(v2, [changed])
        self.assertEqual((v3, added, updated), (v2, [], []))

    def test_crlf_document_untouched_lines_byte_preserved_and_noop_rerun(self):
        a = _tl_note("a", 10)
        v1, _, _ = plan_text("", [a])
        crlf = v1.rstrip("\n").replace("\n", "\r\n") + "\r\nUser prose CRLF\r\n"
        v2, added, updated = plan_text(crlf, [a])
        self.assertEqual((added, updated), ([], []))
        self.assertEqual(v2, crlf)
        v3, _, updated = plan_text(crlf, [_tl_note("a", 10, takeaway="changed")])
        self.assertEqual(updated, ["a"])
        self.assertIn("User prose CRLF\r", v3)
        self.assertIn("# Pragya · Thinking in Systems\r", v3)
        v4, added, updated = plan_text(v3, [_tl_note("a", 10, takeaway="changed")])
        self.assertEqual((v4, added, updated), (v3, [], []))

    def test_empty_fields_heading_only_block(self):
        bare = _tl_note("bare", 5, takeaway="", quote="")
        lines = pragya_cli.render_note_block(bare, _systems_book())
        self.assertEqual(len(lines), 1)
        self.assertIn("Quick Note [note:bare]", lines[0].text)
        v1, _, _ = plan_text("", [bare])
        doc = v1.rstrip("\n") + "\nProse directly under a heading-only block"
        v2, _, updated = plan_text(doc, [bare])
        self.assertEqual(updated, [])
        self.assertIn("Prose directly under a heading-only block", v2)

    def test_shielded_note_block_is_never_deleted_while_others_update(self):
        a = _tl_note("a", 10)
        ahead = _tl_note("ahead", 300)
        v1, _, _ = plan_text("", [a, ahead])
        book = _systems_book()  # bookmark p.100 → "ahead" shielded by default
        timeline = pragya_cli.select_book_timeline([_tl_note("a", 10, takeaway="edited"), ahead], book)
        self.assertEqual([n["id"] for n in timeline], ["a"])
        v2, _, updated = plan_text(v1, timeline)
        self.assertEqual(updated, ["a"])
        self.assertIn("[note:ahead]", v2)

    def test_capstone_add_change_remove_with_prose_and_idempotency(self):
        tl = [_tl_note("a", 1, "atomic")]
        v1, _, _ = plan_text("", tl)
        doc = v1.rstrip("\n") + "\n\nClosing prose 🧠"
        cap = _cap_book()
        v2, _, _ = plan_text(doc, tl, cap)
        self.assertEqual(v2.count("[capstone:book-sys]"), 1)
        v3, added, updated = plan_text(v2, tl, cap)
        self.assertEqual((v3, added, updated), (v2, [], []))
        none_book = _systems_book()
        v4, _, _ = plan_text(v3, tl, none_book)
        self.assertNotIn("capstone", v4)
        self.assertTrue(v4.endswith("Closing prose 🧠"))
        self.assertNotIn("\n\n\n", v4)


class TestQaDocsSimulator(unittest.TestCase):
    def test_astral_emoji_in_fields_titles_and_prose_round_trip(self):
        a = _tl_note("a", 10, takeaway="old 📚")
        paragraphs = HEADER + [
            (3, "[p. 10] old 📚 [note:a]"), (0, "Takeaway: old 📚"),
            (0, "👩‍👩‍👧 family emoji prose (ZWJ) keep"), (0, ""),
            (3, "[p. 30] takeaway one [note:c]"), (0, "Takeaway: takeaway one"),
        ]
        timeline = [
            _tl_note("a", 10, takeaway="new 🐉 dragon", meta={"attachments": [], "links": [], "title": "𝔉𝔯𝔞𝔨𝔱𝔲𝔯"}),
            _tl_note("new", 20, takeaway="inserted 🦄"),
            _tl_note("c", 30),
        ]
        sim, planned, _lines, plan = docs_roundtrip(paragraphs, timeline)
        self.assertEqual(sim, planned)
        self.assertIn("👩‍👩‍👧 family emoji prose (ZWJ) keep\n", sim)
        self.assertEqual(plan.added_ids, ["new"])

    def test_second_run_after_simulated_writes_is_zero_edits(self):
        paragraphs = HEADER + [
            (3, "[p. 10] takeaway one [note:a]"), (0, "Takeaway: takeaway one"), (0, "prose 🧠"),
        ]
        timeline = [
            _tl_note("early", 1),
            _tl_note("a", 10, "atomic", critique="crit"),
            _tl_note("late", 50),
        ]
        cap_book = _cap_book()
        sim, planned, planned_lines, _ = docs_roundtrip(paragraphs, timeline, cap_book)
        self.assertEqual(sim, planned)
        # Re-read the simulated Doc (levels from the plan, text from the simulator) and re-plan.
        sim_texts = sim[:-1].split("\n")
        self.assertEqual(len(sim_texts), len(planned_lines))
        again = [(ln.level, t) for ln, t in zip(planned_lines, sim_texts)]
        lines2 = pragya_cli.parse_gdoc_lines(_gdoc(again))
        plan2 = pragya_cli.plan_companion_doc(lines2, cap_book, timeline)
        self.assertEqual(plan2.edits, [])
        self.assertEqual(pragya_cli.doc_plan_to_requests(lines2, plan2), [])

    def test_shielded_block_untouched_in_docs_mode(self):
        paragraphs = HEADER + [
            (3, "[p. 300] takeaway one [note:ahead]"), (0, "Takeaway: takeaway one"),
            (0, "my prose"),
        ]
        book = _systems_book()
        timeline = pragya_cli.select_book_timeline([_tl_note("ahead", 300)], book)
        self.assertEqual(timeline, [])
        lines = pragya_cli.parse_gdoc_lines(_gdoc(paragraphs))
        plan = pragya_cli.plan_companion_doc(lines, book, timeline)
        self.assertEqual(plan.edits, [])

    def test_only_planned_ranges_are_touched(self):
        """Every delete range lies inside a managed block's span."""
        paragraphs = HEADER + [
            (0, "prose 1"), (3, "[p. 10] takeaway one [note:a]"), (0, "Takeaway: takeaway one"),
            (0, "prose 2"), (0, ""), (2, "[p. 20] Old [note:b]"), (0, "Takeaway: x"), (0, "prose 3"),
        ]
        lines = pragya_cli.parse_gdoc_lines(_gdoc(paragraphs))
        timeline = [_tl_note("a", 10, takeaway="A2"), _tl_note("b", 20, "atomic", takeaway="B2")]
        plan = pragya_cli.plan_companion_doc(lines, _systems_book(), timeline)
        blocks = pragya_cli.parse_doc_blocks(lines)
        spans = [(lines[b.start].start, lines[b.end - 1].end) for b in blocks]
        for req in pragya_cli.doc_plan_to_requests(lines, plan):
            if "deleteContentRange" in req:
                r = req["deleteContentRange"]["range"]
                self.assertTrue(any(s <= r["startIndex"] and r["endIndex"] <= e for s, e in spans), r)
        sim, planned, _l, _p = docs_roundtrip(paragraphs, timeline)
        for p in ("prose 1\n", "prose 2\n", "prose 3\n"):
            self.assertIn(p, sim)


class TestQaSpoilerEpsilon(unittest.TestCase):
    def test_at_bookmark_vs_one_ahead_with_rounded_book_norm(self):
        for total, current in ((218, 142), (352, 168), (192, 1), (7, 3), (100000, 54321)):
            book = _systems_book(totalPos=total, currentPos=current, normalizedPos=round(current / total, 6))
            at = _tl_note("at", current, normalizedPos=round(current / total, 6))
            ahead = _tl_note("ahead", current + 1)
            self.assertFalse(pragya_cli.is_note_spoiler(at, book), (total, current))
            self.assertTrue(pragya_cli.is_note_spoiler(ahead, book), (total, current))

    def test_percent_unit(self):
        book = _systems_book(posUnit="percent", totalPos=0, currentPos=33.3, normalizedPos=0.333)
        self.assertFalse(pragya_cli.is_note_spoiler(_tl_note("at", 33.3), book))
        self.assertTrue(pragya_cli.is_note_spoiler(_tl_note("ahead", 33.4), book))

    def test_sealed_prediction_shielded_until_finished(self):
        book = _systems_book(kind="fiction")
        pred = _tl_note("pred", 50, meta={"attachments": [], "links": [], "isPrediction": True})
        tl, shielded = pragya_cli.select_book_timeline_with_shield([pred], book)
        self.assertEqual((tl, shielded), ([], 1))
        tl, shielded = pragya_cli.select_book_timeline_with_shield([pred], dict(book, status="finished", normalizedPos=1.0))
        self.assertEqual(([n["id"] for n in tl], shielded), (["pred"], 0))


class TestQaBookIndex(RecallBase):
    def _export(self, *extra):
        out = Path(self._tmp.name) / "md"
        payload = self.ok("export-md", "--output-dir", str(out), *extra)
        return out, payload

    def _write(self, books, notes):
        self.write_state(books=books, notes=notes)

    def test_non_latin_and_hostile_titles_stay_inside_books_dir(self):
        books = [
            _systems_book(id="b-hindi-0001", title="पढ़ना"),
            _systems_book(id="b-dots-0002", title="../../../etc/passwd"),
            _systems_book(id="b-tamil-0003", title="வாசிப்பு"),
        ]
        notes = [_tl_note(f"n{i}", 10, bookId=b["id"]) for i, b in enumerate(books)]
        self._write(books, notes)
        out, payload = self._export()
        files = sorted(Path(p).name for p in payload["bookIndexFiles"])
        self.assertEqual(len(files), 3)
        self.assertEqual(len(set(files)), 3)
        for p in payload["bookIndexFiles"]:
            self.assertTrue(Path(p).resolve().is_relative_to((out / "books").resolve()))
        _, again = self._export()
        self.assertEqual((again["bookIndexWritten"], again["bookIndexUnchanged"]), (0, 3))

    def test_qa19_id_prefix_collision_overwrites_another_books_index(self):
        """QA-19: collision suffix = first 8 slug chars of the id and is not re-checked, so
        three same-titled books whose ids share an 8-char prefix (e.g. 'book-sys1',
        'book-sys2') map two books to the same file; one index silently overwrites the other."""
        books = [_systems_book(id=f"book-sys{i}", title="Dune") for i in (1, 2, 3)]
        notes = [_tl_note(f"n{i}", 10, bookId=b["id"]) for i, b in enumerate(books)]
        self._write(books, notes)
        _, payload = self._export()
        self.assertEqual(len(set(payload["bookIndexFiles"])), 3)

    def test_qa20_very_long_title_does_not_crash_export(self):
        """QA-20: slugify has no length cap; a ~300-char title yields a >255-byte filename and
        export-md dies with an uncaught OSError (traceback, no JSON error)."""
        self._write([_systems_book(title="A" * 300)], [_tl_note("n", 10)])
        code, payload, err = self.run_cli("export-md", "--output-dir", str(Path(self._tmp.name) / "md"))
        self.assertEqual(code, 0, err)

    def test_index_drops_shielded_note_and_reports_count(self):
        self._write([_systems_book()], [_tl_note("ok", 10), _tl_note("ahead", 300, takeaway="SECRET_AHEAD")])
        out, payload = self._export()
        content = Path(payload["bookIndexFiles"][0]).read_text(encoding="utf-8")
        self.assertNotIn("SECRET_AHEAD", content)
        self.assertEqual(payload["shieldedCount"], 1)
        _, opted = self._export("--include-spoilers")
        content = (out / "books" / Path(payload["bookIndexFiles"][0]).name).read_text(encoding="utf-8")
        self.assertIn("SECRET_AHEAD", content)
        self.assertEqual(opted["shieldedCount"], 0)


if __name__ == "__main__":
    unittest.main()


# --- QA re-verify of the Batch 6 fix-up -------------------------------------------------

from test_pragya_cli_m6_docsync import _FakeDocsRunner, _doc_paras_for  # noqa: E402

USER_FIELD_LINES = ("Quote: my quote", "Takeaway: my thought", "Mechanism: mine",
                    "WHEN I reread", "DO not forget", "Critique: my view")


def _eaten_on_change(old, new):
    v1, _, _ = plan_text("", [old])
    eaten = []
    for user in USER_FIELD_LINES:
        doc = v1.rstrip("\n") + "\n" + user + "\nafter"
        unchanged, _, upd = plan_text(doc, [old])
        assert user in unchanged and upd == [], (user, "unchanged note must never eat")
        changed, _, _ = plan_text(doc, [new])
        if user not in changed:
            eaten.append(user.split(":")[0].split(" ")[0])
    return eaten


class TestQaResidualGrammarSlot(unittest.TestCase):
    """The RESIDUAL the dev documented: on a CHANGED note, a user line typed directly under
    the block that fits a free later grammar slot is treated as managed and deleted."""

    def test_residual_matrix_quantified(self):
        n = _tl_note
        matrix = {
            # block shape when the user typed           → user prefixes deleted on next change
            # Batch 6 follow-up (decision R1 R2-a / QA-21): a grammar line is managed only if
            # its field is present in the fresh render, so every row now deletes nothing.
            "saved, short takeaway (heading-only)": (n("a", 10, takeaway="short one"), n("a", 10, takeaway="short two"), []),
            "saved, long takeaway (has Takeaway:)": (n("a", 10, takeaway="w " * 12), n("a", 10, takeaway="x " * 12), []),
            "saved→atomic upgrade, heading-only": (n("a", 10, takeaway="short one"), n("a", 10, "atomic", takeaway="short one", contextMechanism="m"), []),
            "atomic, takeaway only": (n("a", 10, "atomic", takeaway="t"), n("a", 10, "atomic", takeaway="t2"), []),
            "atomic, all fields": (
                n("a", 10, "atomic", quote="q", takeaway="t", contextMechanism="m", deltaTrigger="x", deltaAction="y", critique="c"),
                n("a", 10, "atomic", quote="q", takeaway="t2", contextMechanism="m", deltaTrigger="x", deltaAction="y", critique="c"),
                [],
            ),
        }
        for label, (old, new, expected) in matrix.items():
            self.assertEqual(_eaten_on_change(old, new), expected, label)

    def test_qa21_user_quote_under_heading_only_saved_block_survives_upgrade(self):
        """QA-21 (Low, residual): user typed `Quote: …` under a heading-only saved block; the
        note is later deepened to atomic → the user's line is deleted. Mitigation: only treat a
        grammar line as managed when that field is non-empty in the fresh render (absent-field
        lines stay prose). Cleared fields already leave stale lines today (see next test), so
        this costs nothing new."""
        old = _tl_note("a", 10, takeaway="short one")
        v1, _, _ = plan_text("", [old])
        doc = v1.rstrip("\n") + "\nQuote: something my friend said"
        upgraded = _tl_note("a", 10, "atomic", takeaway="short one", contextMechanism="m")
        v2, _, updated = plan_text(doc, [upgraded])
        self.assertEqual(updated, ["a"])
        self.assertIn("Quote: something my friend said", v2)

    def test_cleared_field_line_stays_stale_when_nothing_else_changed(self):
        """Documents the flip side: clearing a field alone leaves its old line (no edit)."""
        old = _tl_note("a", 10, "atomic", takeaway="t", critique="c")
        v1, _, _ = plan_text("", [old])
        v2, _, updated = plan_text(v1, [_tl_note("a", 10, "atomic", takeaway="t")])
        self.assertEqual(updated, [])
        self.assertIn("Critique: c", v2)
        # Batch 6 follow-up (decision R1 R2-a / QA-21): even when another field changes, a
        # cleared field's line is no longer managed, so it stays as a stale line (fail-safe).
        v3, _, updated = plan_text(v1, [_tl_note("a", 10, "atomic", takeaway="t2")])
        self.assertEqual(updated, ["a"])
        self.assertIn("Takeaway: t2\nCritique: c", v3)


class TestQaWriteControlFlows(unittest.TestCase):
    def _book(self):
        return _systems_book(docUrl="https://docs.google.com/document/d/doc-1/edit")

    def test_replan_rejected_again_falls_back_once_without_duplicates(self):
        book = self._book()
        early = _tl_note("early", 1)
        a = _tl_note("a", 10, "atomic")
        new_a = _tl_note("a", 10, "atomic", critique="crit")
        first = _gdoc(_doc_paras_for(book, [a]))
        second = _gdoc(_doc_paras_for(book, [a]))
        second["revisionId"] = "rev-2"
        third = _gdoc(_doc_paras_for(book, [a]))
        third["revisionId"] = "rev-3"
        runner = _FakeDocsRunner(book, [early, new_a], first, raw_batch_ok=False)
        runner.read_sequence = [first, second, third, third, third]
        res = runner.sync()
        self.assertLessEqual(len(runner.raw_attempts), 2)
        self.assertEqual(runner.raw_batches, [])
        self.assertEqual(res["mode"], "append-fallback")
        blob = json.dumps(runner.fake.doc_batches)
        self.assertEqual(blob.count("[note:early]"), 1)
        self.assertNotIn("[note:a]", blob)  # already present → never re-appended
        self.assertTrue(res["warnings"])

    def test_every_raw_batch_attempt_is_guarded(self):
        book = self._book()
        old = _tl_note("a", 10, "atomic")
        first = _gdoc(_doc_paras_for(book, [old]))
        second = _gdoc(_doc_paras_for(book, [old]))
        second["revisionId"] = "rev-9"
        runner = _FakeDocsRunner(book, [_tl_note("a", 10, "atomic", critique="c")], first,
                                 raw_batch_ok=lambda p: p["writeControl"]["requiredRevisionId"] == "rev-9")
        runner.read_sequence = [first, second, second]
        runner.sync()
        self.assertTrue(runner.raw_attempts)
        for p in runner.raw_attempts:
            self.assertTrue(p.get("writeControl", {}).get("requiredRevisionId"))

    def test_style_and_bullet_resets_stay_inside_inserted_text(self):
        book = _systems_book()
        a = _tl_note("a", 10, "atomic")
        paras = _doc_paras_for(book, [a], extra_after=["user prose 🧠", "more prose"])
        lines = pragya_cli.parse_gdoc_lines(_gdoc(paras))
        timeline = [_tl_note("early", 1), _tl_note("a", 10, "atomic", critique="crit"), _tl_note("late", 50)]
        reqs = pragya_cli.doc_plan_to_requests(lines, pragya_cli.plan_companion_doc(lines, book, timeline))
        span = None
        checked = 0
        for r in reqs:
            if "insertText" in r:
                at = r["insertText"]["location"]["index"]
                span = (at, at + pragya_cli._utf16_len(r["insertText"]["text"]))
            elif "deleteContentRange" in r:
                span = None
            else:
                body = next(iter(r.values()))
                rng = body["range"]
                self.assertIsNotNone(span, r)
                self.assertGreaterEqual(rng["startIndex"], span[0], r)
                self.assertLessEqual(rng["endIndex"], span[1] + 1, r)  # paragraph end may include the joining \n
                checked += 1
        self.assertGreater(checked, 0)
        sim = DocSim(paras)
        sim.apply(reqs)
        self.assertIn("user prose 🧠\nmore prose\n", sim.text)
