"""Unit tests for Pragya Lexicon CLI commands, exclusions, spoiler shield & salon backfill."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import pragya_cli  # noqa: E402


def _run_cli(args: list[str]) -> tuple[int, dict[str, Any], dict[str, Any]]:
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "pragya_cli.py"), *args],
        capture_output=True,
        text=True,
    )
    out = json.loads(proc.stdout) if proc.stdout.strip() else {}
    err = json.loads(proc.stderr) if proc.stderr.strip() else {}
    return proc.returncode, out, err


def _snapshot_fixture() -> dict[str, Any]:
    return {
        "version": 1,
        "exportedAt": "2026-11-20T00:00:00.000Z",
        "books": [
            {
                "id": "b-sys",
                "title": "Thinking in Systems",
                "author": "Donella Meadows",
                "format": "physical",
                "kind": "nonfiction",
                "status": "reading",
                "currentPos": 142,
                "totalPos": 218,
                "posUnit": "page",
                "normalizedPos": round(142 / 218, 6),
                "docUrl": "",
                "meta": {
                    "updatedAt": "2026-11-20T00:00:00.000Z",
                    "currentChapter": "Ch. 3: Run",
                },
            },
            {
                "id": "b-exh",
                "title": "Exhalation",
                "author": "Ted Chiang",
                "format": "physical",
                "kind": "fiction",
                "status": "reading",
                "currentPos": 168,
                "totalPos": 352,
                "posUnit": "page",
                "normalizedPos": round(168 / 352, 6),
                "docUrl": "",
                "meta": {"updatedAt": "2026-11-20T00:00:00.000Z"},
            },
        ],
        "notes": [
            {
                "id": "n-sys-1",
                "slug": "feedback-delays",
                "bookId": "b-sys",
                "createdAt": "2026-10-01T10:00:00.000Z",
                "updatedAt": "2026-10-01T10:00:00.000Z",
                "pos": 55,
                "normalizedPos": round(55 / 218, 6),
                "status": "saved",
                "source": "app",
                "tags": ["#systems", "#delays"],
                "quote": "",
                "takeaway": "Delays in balancing loops cause overshoot.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {"attachments": [], "links": [], "title": "Feedback Delays"},
            },
            {
                "id": "n-exh-1",
                "slug": "memory-inscription",
                "bookId": "b-exh",
                "createdAt": "2026-10-01T10:00:00.000Z",
                "updatedAt": "2026-10-01T10:00:00.000Z",
                "pos": 90,
                "normalizedPos": round(90 / 352, 6),
                "status": "saved",
                "source": "app",
                "tags": ["#systems", "#memory"],
                "quote": "",
                "takeaway": "Air pressure drives cognition like a clockwork system.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {"attachments": [], "links": [], "title": "Memory Inscription"},
            },
        ],
        "sessions": [],
        "deltaLogs": [],
    }


class TestPragyaCliLexicon(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pragya_lexicon_cli_"))
        self.state_path = self.tmp / "state.json"
        self.state_path.write_text(json.dumps(_snapshot_fixture()), encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_word_add_minimal_advance_and_sheet_roundtrip(self) -> None:
        # Word-only add without takeaway/quote, advancing bookmark cleanly
        rc, res, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "Thinking in Systems",
                "--pos",
                "155",
                "--word",
                "Oscillation",
                "--quote",
                "Delays produce oscillation in stock levels.",
                "--tags",
                "#systems",
            ]
        )
        self.assertEqual(rc, 0)
        note = res["note"]
        self.assertEqual(note["status"], "saved")
        self.assertEqual(note["slug"], "oscillation")
        self.assertEqual(note["meta"]["entryKind"], "word")
        self.assertEqual(note["meta"]["title"], "Oscillation")
        self.assertEqual(
            note["meta"]["lexicon"],
            {"word": "Oscillation", "lemma": "oscillation"},
        )
        self.assertIn("#vocabulary", note["tags"])
        self.assertIn("#systems", note["tags"])
        self.assertTrue(res["bookmarkChanged"])
        self.assertEqual(res["book"]["currentPos"], 155)
        self.assertIsNotNone(res["session"])

        # Sheet row round-trip preserves entryKind and lexicon verbatim
        row = pragya_cli.note_to_row(note)
        rt = pragya_cli.row_to_note(row)
        self.assertEqual(rt["meta"]["entryKind"], "word")
        self.assertEqual(rt["meta"]["lexicon"]["lemma"], "oscillation")
        self.assertTrue(pragya_cli.note_has_valid_content(rt))

    def test_word_list_grouping_and_spoiler_shield(self) -> None:
        # Two encounters of "oscillation" + one ahead-of-bookmark word in Exhalation
        _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-sys",
                "--pos",
                "60",
                "--word",
                "Oscillation",
                "--quote",
                "System oscillation slows.",
            ]
        )
        _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-exh",
                "--pos",
                "88",
                "--word",
                "oscillations",
                "--lemma",
                "oscillation",
                "--definition",
                "Repeated back-and-forth movement.",
            ]
        )
        rc_s, res_s, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-exh",
                "--pos",
                "95",
                "--word",
                "Palimpsest",
                "--definition",
                "A manuscript erased and written over again.",
                "--quote",
                "Late-book spoiler passage.",
            ]
        )
        self.assertEqual(rc_s, 0)
        # Simulate user having saved/synced a note at p.290 while reading bookmark stays at p.168
        snap_sp = json.loads(self.state_path.read_text(encoding="utf-8"))
        for n in snap_sp["notes"]:
            if n["id"] == res_s["note"]["id"]:
                n["pos"] = 290
                n["normalizedPos"] = round(290 / 352, 6)
        self.state_path.write_text(json.dumps(snap_sp), encoding="utf-8")

        # Default word-list shields future words completely (no text/word/lemma leak)
        rc, res, _ = _run_cli(["--state-file", str(self.state_path), "word-list"])
        self.assertEqual(rc, 0)
        self.assertEqual(res["count"], 2)
        self.assertEqual(res["shieldedCount"], 1)
        blob = json.dumps(res)
        self.assertNotIn("Palimpsest", blob)
        self.assertNotIn("palimpsest", blob)
        self.assertNotIn("Late-book spoiler passage", blob)

        osc = next(g for g in res["words"] if not g["allShielded"])
        self.assertEqual(osc["lemma"], "oscillation")
        self.assertEqual(len(osc["encounters"]), 2)
        self.assertEqual(osc["definition"], "Repeated back-and-forth movement.")

        # Query never matches hidden future words
        rc_q, res_q, _ = _run_cli(
            ["--state-file", str(self.state_path), "word-list", "--query", "palimpsest"]
        )
        self.assertEqual(rc_q, 0)
        self.assertEqual(res_q["count"], 0)

        # --include-spoilers reveals it
        rc_rev, res_rev, _ = _run_cli(
            ["--state-file", str(self.state_path), "word-list", "--include-spoilers"]
        )
        self.assertEqual(rc_rev, 0)
        self.assertEqual(res_rev["shieldedCount"], 0)
        self.assertIn("Palimpsest", json.dumps(res_rev))

    def test_word_update_preserves_unknown_meta_and_rejects_regular_notes(self) -> None:
        # Unknown meta key survives word-update
        _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-sys",
                "--pos",
                "75",
                "--word",
                "Pandemonium",
                "--quote",
                "Chaos and pandemonium.",
            ]
        )
        snap = json.loads(self.state_path.read_text(encoding="utf-8"))
        for n in snap["notes"]:
            if n["slug"] == "pandemonium":
                n["meta"]["customAgentKey"] = {"keep": True}
        self.state_path.write_text(json.dumps(snap), encoding="utf-8")

        rc, res, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-update",
                "--note",
                "pandemonium",
                "--pronunciation",
                "/ˌpæn.dəˈmoʊ.ni.əm/",
                "--part-of-speech",
                "noun",
                "--definition",
                "Wild and noisy disorder.",
                "--etymology",
                "Coined by Milton in Paradise Lost (pan + daimonion).",
                "--example",
                "Deploying on Friday triggered pandemonium in the pager channel.",
            ]
        )
        self.assertEqual(rc, 0)
        updated = res["note"]
        self.assertEqual(updated["meta"]["customAgentKey"], {"keep": True})
        self.assertEqual(updated["meta"]["lexicon"]["definition"], "Wild and noisy disorder.")
        self.assertEqual(
            updated["takeaway"],
            "Deploying on Friday triggered pandemonium in the pager channel.",
        )

        # Refuses non-word notes
        rc_bad, _, err_bad = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-update",
                "--note",
                "feedback-delays",
                "--definition",
                "Should fail.",
            ]
        )
        self.assertEqual(rc_bad, 1)
        self.assertIn("not a word note", err_bad["error"])

        # note-update on a bare word note keeps working without takeaway/quote
        rc_add2, res_add2, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-sys",
                "--pos",
                "80",
                "--word",
                "Liminal",
            ]
        )
        self.assertEqual(rc_add2, 0)
        rc_nu, res_nu, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "note-update",
                "--note",
                res_add2["note"]["id"],
                "--chapter",
                "Ch. 2",
            ]
        )
        self.assertEqual(rc_nu, 0)
        self.assertEqual(res_nu["note"]["meta"]["chapter"], "Ch. 2")

    def test_d8_exclusions_and_salon_pending_word_note_ids(self) -> None:
        # Add two older unshielded word notes (one without definition, one with) + one shielded without def
        rc1, res1, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-sys",
                "--pos",
                "40",
                "--word",
                "Homeostasis",
                "--tags",
                "#systems, #favorite",
            ]
        )
        self.assertEqual(rc1, 0)
        bare_id = res1["note"]["id"]

        rc2, res2, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-exh",
                "--pos",
                "50",
                "--word",
                "Equilibrium",
                "--definition",
                "State of balance.",
                "--example",
                "Systems seek dynamic equilibrium.",
                "--tags",
                "#systems, #favorite",
            ]
        )
        self.assertEqual(rc2, 0)
        rich_id = res2["note"]["id"]

        rc3, res3, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-exh",
                "--pos",
                "300",
                "--word",
                "FutureLexeme",
            ]
        )
        self.assertEqual(rc3, 0)
        shielded_id = res3["note"]["id"]

        # Backdate createdAt > 30 days and keep FutureLexeme ahead of b-exh bookmark (168/352)
        snap = json.loads(self.state_path.read_text(encoding="utf-8"))
        for n in snap["notes"]:
            n["createdAt"] = "2026-09-01T10:00:00.000Z"
            if n["id"] == shielded_id:
                n["pos"] = 300
                n["normalizedPos"] = round(300 / 352, 6)
        b_sys = next(b for b in snap["books"] if b["id"] == "b-sys")
        b_sys["status"] = "finished"
        b_sys["currentPos"] = 218
        b_sys["normalizedPos"] = 1.0
        b_exh = next(b for b in snap["books"] if b["id"] == "b-exh")
        b_exh["currentPos"] = 168
        b_exh["normalizedPos"] = round(168 / 352, 6)
        self.state_path.write_text(json.dumps(snap), encoding="utf-8")

        loaded = pragya_cli.StateFileBackend(self.state_path).load_workspace()
        word_ids = {bare_id, rich_id, shielded_id}

        # Shuffle excludes all word notes
        shuffled = pragya_cli.select_takeaway_shuffle(
            loaded["notes"], loaded["books"], "2026-11-20", limit=10
        )
        self.assertTrue(all(n["id"] not in word_ids for n in shuffled))

        # Echoes, bridge candidates, collision pair exclude all word notes
        echoes = pragya_cli.find_cross_book_echoes(b_sys, loaded["notes"], loaded["books"], limit=10)
        self.assertEqual([e["note"]["id"] for e in echoes], ["n-exh-1"])

        bridges = pragya_cli.find_bridge_candidates(loaded["notes"], loaded["books"], limit=10)
        self.assertEqual([b["pairKey"] for b in bridges], ["n-exh-1::n-sys-1"])

        collision = pragya_cli.select_daily_collision_pair(
            loaded["notes"], loaded["books"], "2026-11-20"
        )
        self.assertIsNotNone(collision)
        assert collision is not None
        self.assertEqual(collision["pairKey"], "n-exh-1::n-sys-1")

        # Capstone notesSummary excludes word notes
        summary, _ = pragya_cli.build_notes_summary(b_sys, loaded["notes"])
        self.assertEqual([s["id"] for s in summary], ["n-sys-1"])

        # Salon reports ONLY unshielded, non-archived word notes missing definition
        rc_sal, salon, _ = _run_cli(
            ["--state-file", str(self.state_path), "salon", "--today", "2026-11-20"]
        )
        self.assertEqual(rc_sal, 0)
        self.assertEqual(salon["pendingWordNoteIds"], [bare_id])

    def test_lexicon_ts_python_parity(self) -> None:
        rc, res, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-sys",
                "--pos",
                "42",
                "--word",
                "Subtlety",
                "--definition",
                "Fine distinction.",
            ]
        )
        self.assertEqual(rc, 0)
        snap = json.loads(self.state_path.read_text(encoding="utf-8"))
        ts_script = """
        import { groupWordsByLemma, isWordNote } from './src/utils/lexicon.ts';
        const data = JSON.parse(process.argv[1]);
        const groups = groupWordsByLemma(data.notes, data.books);
        console.log(JSON.stringify({
          count: groups.length,
          lemma: groups[0]?.lemma,
          word: groups[0]?.word,
          allWordNotes: data.notes.filter(isWordNote).length
        }));
        """
        proc = subprocess.run(
            ["node", "--experimental-specifier-resolution=node", "-e", ts_script, json.dumps(snap)],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            ts_out = json.loads(proc.stdout)
            py_groups, _ = pragya_cli.group_words_by_lemma(snap["notes"], snap["books"])
            self.assertEqual(len(py_groups), ts_out["count"])
            self.assertEqual(py_groups[0]["lemma"], ts_out["lemma"])
            self.assertEqual(py_groups[0]["word"], ts_out["word"])

    def test_word_list_no_spoiler_by_association_leak(self) -> None:
        # Visible encounter in nonfiction at bookmark (b-sys is at pos 142)
        rc1, _, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-sys",
                "--pos",
                "60",
                "--word",
                "pandemonium",
                "--definition",
                "Wild uproar.",
            ]
        )
        self.assertEqual(rc1, 0)

        # Fiction encounter at p. 300 while b-exh is temporarily at p. 300, then force bookmark back to p. 100
        _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-update",
                "--book",
                "b-exh",
                "--pos",
                "300",
            ]
        )
        rc2, add_exh, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-exh",
                "--pos",
                "300",
                "--word",
                "Pandemonium",
                "--quote",
                "Pandemonium broke across the archive.",
            ]
        )
        self.assertEqual(rc2, 0)
        rc3, _, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "word-add",
                "--book",
                "b-exh",
                "--pos",
                "315",
                "--word",
                "Pandemonium",
            ]
        )
        self.assertEqual(rc3, 0)
        rc_rewind, _, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-update",
                "--book",
                "b-exh",
                "--pos",
                "100",
                "--force-pos",
            ]
        )
        self.assertEqual(rc_rewind, 0)

        # Default word-list must NOT nest shielded fiction encounters under visible pandemonium card,
        # nor group the two shielded fiction encounters together.
        rc_list, res, _ = _run_cli(["--state-file", str(self.state_path), "word-list"])
        self.assertEqual(rc_list, 0)
        self.assertEqual(res["count"], 3)
        self.assertEqual(res["shieldedCount"], 2)

        visible_cards = [g for g in res["words"] if not g["allShielded"]]
        shielded_cards = [g for g in res["words"] if g["allShielded"]]
        self.assertEqual(len(visible_cards), 1)
        self.assertEqual(len(shielded_cards), 2)
        self.assertEqual(visible_cards[0]["lemma"], "pandemonium")
        self.assertEqual(len(visible_cards[0]["encounters"]), 1)
        self.assertEqual(visible_cards[0]["encounters"][0]["bookId"], "b-sys")

        for card in shielded_cards:
            self.assertEqual(card["lemma"], "")
            self.assertEqual(card["word"], "")
            self.assertEqual(len(card["encounters"]), 1)
            self.assertTrue(card["encounters"][0]["shielded"])
            self.assertNotIn("quote", card["encounters"][0])
            self.assertNotIn("lexicon", card["encounters"][0])

        # Querying the lemma matches only the visible encounter
        rc_q, res_q, _ = _run_cli(
            ["--state-file", str(self.state_path), "word-list", "--query", "pandemonium"]
        )
        self.assertEqual(rc_q, 0)
        self.assertEqual(res_q["count"], 1)
        self.assertEqual(len(res_q["words"][0]["encounters"]), 1)
        self.assertEqual(res_q["words"][0]["encounters"][0]["bookId"], "b-sys")

        # --include-spoilers merges all 3 encounters back under pandemonium cleanly
        rc_sp, res_sp, _ = _run_cli(
            ["--state-file", str(self.state_path), "word-list", "--include-spoilers"]
        )
        self.assertEqual(rc_sp, 0)
        self.assertEqual(res_sp["count"], 1)
        self.assertEqual(len(res_sp["words"][0]["encounters"]), 3)
        self.assertIn(add_exh["note"]["id"], [e["noteId"] for e in res_sp["words"][0]["encounters"]])

    def test_load_sheet_ids_accepts_gsheets_cli_id_field(self):
        backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id="sid-test")
        backend._run_json = lambda _cmd: [
            {"id": 0, "title": "Books"},
            {"id": 452503551, "title": "Notes"},
            {"properties": {"sheetId": 774057865, "title": "Sessions"}},
            {"sheetId": 1881551810, "title": "DeltaLogs"},
        ]
        titles = backend._load_sheet_ids("sid-test")
        self.assertEqual(titles, {"Books", "Notes", "Sessions", "DeltaLogs"})
        self.assertEqual(backend._sheet_id("Books"), 0)
        self.assertEqual(backend._sheet_id("Notes"), 452503551)
        self.assertEqual(backend._sheet_id("Sessions"), 774057865)
        self.assertEqual(backend._sheet_id("DeltaLogs"), 1881551810)


if __name__ == "__main__":
    unittest.main()
