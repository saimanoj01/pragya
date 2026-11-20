"""CD Batch 8 unit tests — CLI subprocess reduction (D3.5) and CLI completeness (D3.6)."""

from __future__ import annotations

import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import pragya_cli  # noqa: E402


ALL_TABS = ("Books", "Notes", "Sessions", "DeltaLogs")
FAKE_SHEET_IDS = {"Books": 10, "Notes": 20, "Sessions": 30, "DeltaLogs": 40}
HEADERS = {
    "Books": pragya_cli.BOOKS_HEADERS,
    "Notes": pragya_cli.NOTES_HEADERS,
    "Sessions": pragya_cli.SESSIONS_HEADERS,
    "DeltaLogs": pragya_cli.DELTA_LOGS_HEADERS,
}
LAST_COL = {"Books": "L", "Notes": "R", "Sessions": "G", "DeltaLogs": "E"}


def _make_sample_snapshot() -> dict:
    return {
        "version": 1,
        "exportedAt": "2026-11-18T10:00:00.000Z",
        "books": [
            {
                "id": "book-nf",
                "title": "Thinking in Systems",
                "author": "Donella Meadows",
                "format": "physical",
                "kind": "nonfiction",
                "status": "reading",
                "currentPos": 100,
                "totalPos": 200,
                "posUnit": "page",
                "normalizedPos": 0.5,
                "docUrl": "",
                "meta": {"updatedAt": "2026-11-18T10:00:00.000Z"},
            },
            {
                "id": "book-fic",
                "title": "The Lathe of Heaven",
                "author": "Ursula K. Le Guin",
                "format": "kindle",
                "kind": "fiction",
                "status": "reading",
                "currentPos": 40,
                "totalPos": 200,
                "posUnit": "page",
                "normalizedPos": 0.2,
                "docUrl": "",
                "meta": {"updatedAt": "2026-11-18T10:00:00.000Z"},
            },
            {
                "id": "book-reread",
                "title": "Exhalation",
                "author": "Ted Chiang",
                "format": "physical",
                "kind": "fiction",
                "status": "reading",
                "currentPos": 10,
                "totalPos": 200,
                "posUnit": "page",
                "normalizedPos": 0.05,
                "docUrl": "",
                "meta": {"updatedAt": "2026-11-18T10:00:00.000Z", "everFinished": True},
            },
        ],
        "notes": [
            {
                "id": "n-atomic-active",
                "slug": "feedback-delays",
                "bookId": "book-nf",
                "createdAt": "2026-11-10T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 50,
                "normalizedPos": 0.25,
                "status": "atomic",
                "source": "agent",
                "tags": ["#systems", "#delays"],
                "quote": "Delays cause oscillations.",
                "takeaway": "Wait one cycle before tuning.",
                "contextMechanism": "Feedback lag.",
                "critique": "Not in emergencies.",
                "deltaTrigger": "metrics dip after deploy",
                "deltaAction": "wait one full cycle",
                "deltaStatus": "active",
                "meta": {"title": "Feedback Delays", "aliases": ["old-feedback-slug"], "attachments": [], "links": []},
            },
            {
                "id": "n-atomic-paused",
                "slug": "stock-buffer",
                "bookId": "book-nf",
                "createdAt": "2026-11-11T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 80,
                "normalizedPos": 0.4,
                "status": "atomic",
                "source": "agent",
                "tags": ["#systems"],
                "quote": "Stocks act as shock absorbers.",
                "takeaway": "Buffer volatile flows.",
                "contextMechanism": "Buffers stabilize variance.",
                "critique": "Big buffers slow adaptation.",
                "deltaTrigger": "queue spikes unexpectedly",
                "deltaAction": "check buffer depth before scaling",
                "deltaStatus": "paused",
                "meta": {"title": "Stock Buffer", "attachments": [], "links": []},
            },
            {
                "id": "n-saved-plain",
                "slug": "plain-saved",
                "bookId": "book-nf",
                "createdAt": "2026-11-12T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 90,
                "normalizedPos": 0.45,
                "status": "saved",
                "source": "app",
                "tags": ["#leverage"],
                "quote": "",
                "takeaway": "Rules beat parameters.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {"title": "Rules vs Params", "attachments": [], "links": []},
            },
            {
                "id": "n-spoiler",
                "slug": "ending-twist-secret",
                "bookId": "book-fic",
                "createdAt": "2026-11-12T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 180,
                "normalizedPos": 0.9,
                "status": "atomic",
                "source": "app",
                "tags": ["#craft"],
                "quote": "SECRET ENDING QUOTE",
                "takeaway": "SECRET ENDING TAKEAWAY",
                "contextMechanism": "SECRET MECHANISM",
                "critique": "",
                "deltaTrigger": "SECRET TRIGGER",
                "deltaAction": "SECRET ACTION",
                "deltaStatus": "active",
                "meta": {"title": "SECRET TWIST TITLE", "chapter": "Ch. 11: Finale", "attachments": [], "links": []},
            },
            {
                "id": "n-prediction",
                "slug": "sealed-dream-guess",
                "bookId": "book-fic",
                "createdAt": "2026-11-12T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 30,
                "normalizedPos": 0.15,
                "status": "saved",
                "source": "app",
                "tags": ["#prediction"],
                "quote": "",
                "takeaway": "SEALED PREDICTION GUESS",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {"title": "Dream Prediction", "isPrediction": True, "attachments": [], "links": []},
            },
            {
                "id": "n-reread-ahead",
                "slug": "reread-visible",
                "bookId": "book-reread",
                "createdAt": "2026-11-12T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 190,
                "normalizedPos": 0.95,
                "status": "saved",
                "source": "app",
                "tags": ["#memory"],
                "quote": "Visible during re-read.",
                "takeaway": "everFinished keeps notes unshielded.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {"attachments": [], "links": []},
            },
            {
                "id": "n-archived",
                "slug": "archived-note",
                "bookId": "book-nf",
                "createdAt": "2026-11-12T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 20,
                "normalizedPos": 0.1,
                "status": "atomic",
                "source": "app",
                "tags": ["#systems"],
                "quote": "Old archived quote",
                "takeaway": "Old archived takeaway",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "old archived trigger",
                "deltaAction": "old archived action",
                "deltaStatus": "active",
                "meta": {"title": "Archived Delta", "archivedAt": "2026-11-16T00:00:00.000Z", "attachments": [], "links": []},
            },
        ],
        "sessions": [],
        "deltaLogs": [],
    }


def _run_cli(argv: list[str], runner=None) -> tuple[int, dict, dict]:
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = pragya_cli.main(argv, runner=runner or pragya_cli.default_cmd_runner)
    stdout_obj = json.loads(out.getvalue()) if out.getvalue().strip() else {}
    stderr_obj = json.loads(err.getvalue()) if err.getvalue().strip() else {}
    return rc, stdout_obj, stderr_obj


class FakeSheetsRunner:
    def __init__(self, snap: dict, *, missing_header_tabs: tuple[str, ...] = ()):
        self.rows = {
            "Books": [HEADERS["Books"]] + [pragya_cli.book_to_row(b) for b in snap["books"]],
            "Notes": [HEADERS["Notes"]] + [pragya_cli.note_to_row(n) for n in snap["notes"]],
            "Sessions": [HEADERS["Sessions"]] + [pragya_cli.session_to_row(s) for s in snap["sessions"]],
            "DeltaLogs": [HEADERS["DeltaLogs"]] + [pragya_cli.delta_log_to_row(d) for d in snap["deltaLogs"]],
        }
        for tab in missing_header_tabs:
            self.rows[tab] = []
        self.calls: list[list[str]] = []
        self.raw_batches: list[dict] = []

    def __call__(self, cmd: list[str]) -> tuple[int, str, str]:
        self.calls.append(list(cmd))
        if cmd[:3] == ["gsheets", "readonly", "list"]:
            return 0, json.dumps([{"id": "sid-cd8", "name": pragya_cli.SPREADSHEET_TITLE}]), ""
        if cmd[:3] == ["gsheets", "readonly", "list-sheets"]:
            payload = {"sheets": [{"properties": {"title": t, "sheetId": FAKE_SHEET_IDS[t]}} for t in ALL_TABS]}
            return 0, json.dumps(payload), ""
        if cmd[:3] == ["gsheets", "readonly", "read"]:
            tab, a1 = cmd[4].split("!")
            if a1 == f"A:{LAST_COL[tab]}":
                return 0, json.dumps({"values": self.rows[tab]}), ""
            if a1 == "A:A":
                return 0, json.dumps({"values": [[r[0]] for r in self.rows[tab]]}), ""
            if a1 == f"A1:{LAST_COL[tab]}1":
                return 0, json.dumps({"values": self.rows[tab][:1]}), ""
        if cmd[:3] == ["gsheets", "mutate", "raw-batch"]:
            payload = json.loads(Path(cmd[cmd.index("-f") + 1]).read_text(encoding="utf-8"))
            self.raw_batches.append(payload)
            return 0, json.dumps({"replies": []}), ""
        return 1, "", f"Unexpected command: {cmd}"


class TestCd8SubprocessReduction(unittest.TestCase):
    def test_load_workspace_cuts_subprocesses_to_5_known_6_discovered_and_4_warm(self):
        snap = _make_sample_snapshot()

        # 1. Known spreadsheet_id: 1 list-sheets + 4 data reads = 5 subprocesses (zero A1:X1 header reads!)
        fake_known = FakeSheetsRunner(snap)
        backend_known = pragya_cli.GoogleWorkspaceBackend(
            spreadsheet_id="sid-cd8", runner=fake_known, sleep=lambda _: None
        )
        ws1 = backend_known.load_workspace()
        self.assertEqual(len(ws1["books"]), 3)
        self.assertEqual(len(fake_known.calls), 5, f"Expected 5 subprocesses, got {fake_known.calls}")
        self.assertFalse(
            any("!A1:" in c[4] for c in fake_known.calls if c[:3] == ["gsheets", "readonly", "read"]),
            "load_workspace must validate headers from data reads without separate A1:X1 reads",
        )

        # 2. Warm 2nd load_workspace: list-sheets is cached -> only 4 data reads!
        fake_known.calls.clear()
        backend_known.load_workspace()
        self.assertEqual(len(fake_known.calls), 4)
        self.assertEqual(sum(1 for c in fake_known.calls if c[:3] == ["gsheets", "readonly", "list-sheets"]), 0)

        # 3. Auto-discovered spreadsheet_id: 1 list + 1 list-sheets + 4 data reads = 6 subprocesses (<= 6)
        fake_disc = FakeSheetsRunner(snap)
        backend_disc = pragya_cli.GoogleWorkspaceBackend(runner=fake_disc, sleep=lambda _: None)
        backend_disc.load_workspace()
        self.assertLessEqual(len(fake_disc.calls), 6)
        self.assertEqual(len(fake_disc.calls), 6)

    def test_load_workspace_repairs_missing_header_from_data_read_in_one_batch(self):
        snap = _make_sample_snapshot()
        fake = FakeSheetsRunner(snap, missing_header_tabs=("DeltaLogs",))
        backend = pragya_cli.GoogleWorkspaceBackend(
            spreadsheet_id="sid-cd8", runner=fake, sleep=lambda _: None
        )
        backend.load_workspace()
        self.assertEqual(len(fake.raw_batches), 1)
        reqs = fake.raw_batches[0]["requests"]
        self.assertEqual(len(reqs), 1)
        self.assertEqual(reqs[0]["updateCells"]["range"]["sheetId"], FAKE_SHEET_IDS["DeltaLogs"])
        self.assertEqual(reqs[0]["updateCells"]["range"]["startRowIndex"], 0)

    def test_export_md_batches_multiple_exportedAt_stamps_into_one_raw_batch(self):
        snap = _make_sample_snapshot()
        # Ensure 3 non-archived atomic notes need export (no exportedAt yet)
        fake = FakeSheetsRunner(snap)
        with tempfile.TemporaryDirectory() as tmp:
            rc, res, err = _run_cli(
                ["--spreadsheet-id", "sid-cd8", "export-md", "--output-dir", tmp],
                runner=fake,
            )
            self.assertEqual(rc, 0, err)
            self.assertEqual(res["exportedCount"], 3)
            # Only ONE raw-batch subprocess for all 3 exportedAt stamps!
            self.assertEqual(len(fake.raw_batches), 1)
            reqs = fake.raw_batches[0]["requests"]
            self.assertEqual(len(reqs), 3)
            self.assertTrue(all("updateCells" in r for r in reqs))
            # Only ONE live Notes!A:R read during batch save (plus 1 in load_workspace = 2 total)
            notes_reads = [
                c for c in fake.calls if c[:3] == ["gsheets", "readonly", "read"] and c[4] == "Notes!A:R"
            ]
            self.assertEqual(len(notes_reads), 2)

    def test_ocr_backfill_batches_multiple_notes_into_one_raw_batch_and_enforces_conflict_guard(self):
        snap = {
            "version": 1,
            "exportedAt": "2026-11-18T10:00:00.000Z",
            "books": [_make_sample_snapshot()["books"][0]],
            "notes": [
                {
                    "id": f"n-img-{i}",
                    "slug": f"img-note-{i}",
                    "bookId": "book-nf",
                    "createdAt": "2026-11-12T10:00:00.000Z",
                    "updatedAt": "2026-11-15T10:00:00.000Z",
                    "pos": 10 * i,
                    "normalizedPos": 0.05 * i,
                    "status": "saved",
                    "source": "app",
                    "tags": [],
                    "quote": "",
                    "takeaway": f"Takeaway {i}",
                    "contextMechanism": "",
                    "critique": "",
                    "deltaTrigger": "",
                    "deltaAction": "",
                    "deltaStatus": "none",
                    "meta": {
                        "attachments": [{"id": f"att-{i}", "type": "image", "driveFileId": f"drv-{i}", "fileName": f"p{i}.webp"}],
                        "links": [],
                    },
                }
                for i in (1, 2, 3)
            ],
            "sessions": [],
            "deltaLogs": [],
        }

        with tempfile.TemporaryDirectory() as tmp:
            map_path = Path(tmp) / "ocr.json"
            map_path.write_text(
                json.dumps({"n-img-1": "Quote One", "n-img-2": "Quote Two", "n-img-3": "Quote Three"}),
                encoding="utf-8",
            )
            # 1. Clean 3-note batch -> ONE raw-batch with 3 updateCells requests
            fake = FakeSheetsRunner(snap)
            rc, res, err = _run_cli(
                ["--spreadsheet-id", "sid-cd8", "ocr-backfill", "--ocr-map-json", str(map_path)],
                runner=fake,
            )
            self.assertEqual(rc, 0, err)
            self.assertEqual(res["updatedCount"], 3)
            self.assertEqual(len(fake.raw_batches), 1)
            self.assertEqual(len(fake.raw_batches[0]["requests"]), 3)

            # 2. Conflict on note #2 between load and batch save -> aborts with ZERO writes!
            fake_conflict = FakeSheetsRunner(snap)
            orig_call = fake_conflict.__call__
            notes_read_count = {"n": 0}

            def conflict_runner(cmd):
                if cmd[:3] == ["gsheets", "readonly", "read"] and cmd[4] == "Notes!A:R":
                    notes_read_count["n"] += 1
                    if notes_read_count["n"] == 2:
                        # Note 2 modified remotely before batch save
                        fake_conflict.rows["Notes"][2][4] = "2099-01-01T00:00:00.000Z"
                return orig_call(cmd)

            rc_c, _, err_c = _run_cli(
                ["--spreadsheet-id", "sid-cd8", "ocr-backfill", "--ocr-map-json", str(map_path)],
                runner=conflict_runner,
            )
            self.assertEqual(rc_c, 1)
            self.assertIn("Row conflict", err_c.get("error", ""))
            self.assertEqual(len(fake_conflict.raw_batches), 0)

    def test_state_file_backend_runs_shared_codecs_for_all_four_entities(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "snap.json"
            snap = {
                "version": 1,
                "exportedAt": "2026-11-18T10:00:00.000Z",
                "books": [
                    {
                        "id": "b1",
                        "title": "Drift Book",
                        "author": "A",
                        "format": "print",
                        "kind": "nonfiction",
                        "status": "reading",
                        "currentPos": "25",
                        "totalPos": 100,
                        "posUnit": "page",
                        "normalizedPos": 0.25,
                        "docUrl": "",
                        "meta": {"chapterNote": "Ch. 2", "customKey": 7},
                    }
                ],
                "notes": [
                    {
                        "id": "n1",
                        "slug": "n1",
                        "bookId": "b1",
                        "createdAt": "2026-11-18T10:00:00.000Z",
                        "updatedAt": "2026-11-18T10:00:00.000Z",
                        "pos": "12",
                        "normalizedPos": 0.12,
                        "status": "saved",
                        "source": "cli",
                        "tags": [],
                        "quote": "",
                        "takeaway": "hi",
                        "contextMechanism": "",
                        "critique": "",
                        "deltaTrigger": "",
                        "deltaAction": "",
                        "deltaStatus": "none",
                        "meta": {"q1": "Why?", "unknownTag": True},
                    }
                ],
                "sessions": [
                    {
                        "id": "s1",
                        "bookId": " b1 ",
                        "date": 46342,  # Excel serial date -> YYYY-MM-DD
                        "startPos": "10",
                        "endPos": "25",
                        "updatedAt": 46342.5,
                        "note": None,
                        "extraSess": "keep",
                    }
                ],
                "deltaLogs": [
                    {
                        "id": "dl1",
                        "noteId": " n1 ",
                        "date": 46342,
                        "outcome": "bogus-value",
                        "reflection": None,
                        "extraLog": 99,
                    }
                ],
            }
            state_path.write_text(json.dumps(snap), encoding="utf-8")
            ws = pragya_cli.StateFileBackend(state_path).load_workspace()
            self.assertEqual(ws["books"][0]["format"], "physical")
            self.assertEqual(ws["books"][0]["meta"]["currentChapter"], "Ch. 2")
            self.assertEqual(ws["books"][0]["meta"]["customKey"], 7)
            self.assertEqual(ws["notes"][0]["source"], "agent")
            self.assertEqual(ws["notes"][0]["meta"]["socraticQuestions"], ["Why?"])
            self.assertEqual(ws["sessions"][0]["bookId"], "b1")
            self.assertRegex(ws["sessions"][0]["date"], r"^\d{4}-\d{2}-\d{2}$")
            self.assertEqual(ws["sessions"][0]["startPos"], 10)
            self.assertEqual(ws["sessions"][0]["note"], "")
            self.assertEqual(ws["sessions"][0]["extraSess"], "keep")
            self.assertEqual(ws["deltaLogs"][0]["noteId"], "n1")
            self.assertEqual(ws["deltaLogs"][0]["outcome"], "no-trigger")
            self.assertEqual(ws["deltaLogs"][0]["reflection"], "")
            self.assertEqual(ws["deltaLogs"][0]["extraLog"], 99)


class TestCd8CliCompleteness(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.state_path = Path(self._tmp.name) / "state.json"
        self.state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, *args: str) -> tuple[int, dict, dict]:
        return _run_cli(["--state-file", str(self.state_path), *args])

    def test_note_list_filters_archive_and_spoiler_shield(self):
        # Default: excludes archived (1) and shields spoiler + sealed prediction (2); keeps everFinished re-read!
        rc, res, err = self._run("note-list")
        self.assertEqual(rc, 0, err)
        self.assertEqual(res["archivedCount"], 1)
        self.assertEqual(res["shieldedCount"], 2)
        ids = {n["id"] for n in res["notes"]}
        self.assertEqual(ids, {"n-atomic-active", "n-atomic-paused", "n-saved-plain", "n-reread-ahead"})

        # --include-spoilers reveals spoiler + sealed prediction
        rc2, res2, _ = self._run("note-list", "--include-spoilers")
        self.assertEqual(rc2, 0)
        self.assertEqual(res2["shieldedCount"], 0)
        self.assertIn("n-spoiler", {n["id"] for n in res2["notes"]})
        self.assertIn("n-prediction", {n["id"] for n in res2["notes"]})

        # --include-archived reveals archived note
        rc3, res3, _ = self._run("note-list", "--include-archived")
        self.assertEqual(rc3, 0)
        self.assertIn("n-archived", {n["id"] for n in res3["notes"]})

        # Filters: --book, --status, --tag (leading # optional), --delta-status
        rc4, res4, _ = self._run(
            "note-list", "--book", "Thinking in Systems", "--status", "atomic", "--tag", "systems", "--delta-status", "paused"
        )
        self.assertEqual(rc4, 0)
        self.assertEqual([n["id"] for n in res4["notes"]], ["n-atomic-paused"])

        # Unknown book -> exit 1
        rc_bad, _, err_bad = self._run("note-list", "--book", "No Such Book")
        self.assertEqual(rc_bad, 1)
        self.assertIn("error", err_bad)

    def test_note_get_resolves_id_slug_alias_and_shields_spoilers_without_leaks(self):
        # Resolve by former slug alias
        rc, res, err = self._run("note-get", "--note", "old-feedback-slug")
        self.assertEqual(rc, 0, err)
        self.assertFalse(res["shielded"])
        self.assertEqual(res["note"]["id"], "n-atomic-active")

        # Spoiler note shielded by default -> ZERO secret fields leaked in serialized JSON!
        rc_s, res_s, _ = self._run("note-get", "--note", "n-spoiler")
        self.assertEqual(rc_s, 0)
        self.assertTrue(res_s["shielded"])
        dumped = json.dumps(res_s)
        for secret in (
            "SECRET ENDING QUOTE",
            "SECRET ENDING TAKEAWAY",
            "SECRET MECHANISM",
            "SECRET TWIST TITLE",
            "SECRET TRIGGER",
            "SECRET ACTION",
            "ending-twist-secret",
            "Ch. 11: Finale",
        ):
            self.assertNotIn(secret, dumped)

        # Sealed prediction also shielded by default, revealed with --reveal or --include-spoilers
        rc_p, res_p, _ = self._run("note-get", "--note", "n-prediction")
        self.assertEqual(rc_p, 0)
        self.assertTrue(res_p["shielded"])
        self.assertNotIn("SEALED PREDICTION GUESS", json.dumps(res_p))

        rc_rev, res_rev, _ = self._run("note-get", "--note", "n-spoiler", "--reveal")
        self.assertEqual(rc_rev, 0)
        self.assertFalse(res_rev["shielded"])
        self.assertEqual(res_rev["note"]["quote"], "SECRET ENDING QUOTE")

        # Missing required --note -> exit 2; unknown note -> exit 1
        rc_u, _, err_u = self._run("note-get")
        self.assertEqual(rc_u, 2)
        self.assertIn("usage", err_u)
        rc_nf, _, _ = self._run("note-get", "--note", "missing-slug")
        self.assertEqual(rc_nf, 1)

    def test_delta_status_view_and_transitions_enforce_5_cap_atomic_and_archive_rules(self):
        # View mode: activeCount counts non-archived active deltas (n-atomic-active + n-spoiler = 2; n-archived excluded!)
        rc, view, err = self._run("delta-status")
        self.assertEqual(rc, 0, err)
        self.assertEqual(view["activeCount"], 2)
        self.assertEqual(view["cap"], 5)
        self.assertEqual(view["remainingSlots"], 3)
        self.assertEqual(len(view["paused"]), 1)
        # Spoiler active delta is redacted in view mode unless --include-spoilers!
        spoiler_entry = next(x for x in view["active"] if x["id"] == "n-spoiler")
        self.assertTrue(spoiler_entry["shielded"])
        self.assertNotIn("SECRET TRIGGER", json.dumps(spoiler_entry))

        # Transition active -> paused -> graduated -> active
        rc_p, res_p, _ = self._run("delta-status", "--note", "feedback-delays", "--status", "paused")
        self.assertEqual(rc_p, 0)
        self.assertEqual(res_p["previousDeltaStatus"], "active")
        self.assertEqual(res_p["deltaStatus"], "paused")
        self.assertEqual(res_p["activeCount"], 1)

        rc_g, res_g, _ = self._run("delta-status", "--note", "old-feedback-slug", "--status", "graduated")
        self.assertEqual(rc_g, 0)
        self.assertEqual(res_g["deltaStatus"], "graduated")

        # Refuses activating a non-atomic (saved) note -> exit 1
        rc_non_atomic, _, err_na = self._run(
            "delta-status", "--note", "plain-saved", "--status", "active", "--trigger", "x", "--action", "y"
        )
        self.assertEqual(rc_non_atomic, 1)
        self.assertIn("atomic", err_na["error"].lower())

        # Refuses activating an archived note -> exit 1
        rc_arch, _, err_arch = self._run("delta-status", "--note", "archived-note", "--status", "active")
        self.assertEqual(rc_arch, 1)
        self.assertIn("archived", err_arch["error"].lower())

        # Paired flag check & bad status choice
        rc_pair, _, _ = self._run("delta-status", "--note", "feedback-delays")
        self.assertEqual(rc_pair, 1)
        rc_usage, _, err_usage = self._run("delta-status", "--note", "feedback-delays", "--status", "bogus")
        self.assertEqual(rc_usage, 2)
        self.assertIn("usage", err_usage)

        # Enforce 5-cap (add 4 more active atomic notes so 5 total non-archived active -> 6th fails!)
        snap = json.loads(self.state_path.read_text(encoding="utf-8"))
        for i in range(4):
            snap["notes"].append(
                {
                    "id": f"n-cap-{i}",
                    "slug": f"cap-delta-{i}",
                    "bookId": "book-nf",
                    "createdAt": "2026-11-12T10:00:00.000Z",
                    "updatedAt": "2026-11-15T10:00:00.000Z",
                    "pos": 10 + i,
                    "normalizedPos": 0.05,
                    "status": "atomic",
                    "source": "agent",
                    "tags": [],
                    "quote": "",
                    "takeaway": f"Cap {i}",
                    "contextMechanism": "",
                    "critique": "",
                    "deltaTrigger": f"trigger {i}",
                    "deltaAction": f"action {i}",
                    "deltaStatus": "active",
                    "meta": {"attachments": [], "links": []},
                }
            )
        self.state_path.write_text(json.dumps(snap), encoding="utf-8")
        # Now 5 active (n-spoiler + 4 n-cap-*), trying to activate stock-buffer must exit 1!
        rc_cap, _, err_cap = self._run("delta-status", "--note", "stock-buffer", "--status", "active")
        self.assertEqual(rc_cap, 1)
        self.assertIn("5/5", err_cap["error"])

    def test_delta_status_transition_redacts_shielded_note_unless_reveal_and_includes_remaining_slots(self):
        # R1#4 + R2-N2: transitioning a shielded ahead-of-bookmark note without --include-spoilers
        # must NEVER leak quote/takeaway/title/slug/chapter/WHEN/DO and must include remainingSlots!
        rc_p, res_p, err_p = self._run("delta-status", "--note", "n-spoiler", "--status", "paused")
        self.assertEqual(rc_p, 0, err_p)
        self.assertTrue(res_p["shielded"])
        self.assertEqual(res_p["previousDeltaStatus"], "active")
        self.assertEqual(res_p["deltaStatus"], "paused")
        self.assertEqual(res_p["activeCount"], 1)
        self.assertEqual(res_p["cap"], 5)
        self.assertEqual(res_p["remainingSlots"], 4)
        serialized = json.dumps(res_p)
        for secret in (
            "SECRET ENDING QUOTE",
            "SECRET ENDING TAKEAWAY",
            "SECRET MECHANISM",
            "SECRET TWIST TITLE",
            "SECRET TRIGGER",
            "SECRET ACTION",
            "ending-twist-secret",
            "Ch. 11: Finale",
        ):
            self.assertNotIn(secret, serialized, f"Shielded transition leaked secret text: {secret}")

        # With --include-spoilers / --reveal: full note is returned with shielded=False and remainingSlots
        rc_rev, res_rev, err_rev = self._run(
            "delta-status", "--note", "n-spoiler", "--status", "active", "--reveal"
        )
        self.assertEqual(rc_rev, 0, err_rev)
        self.assertFalse(res_rev["shielded"])
        self.assertEqual(res_rev["remainingSlots"], 3)
        self.assertEqual(res_rev["note"]["slug"], "ending-twist-secret")
        self.assertIn("SECRET TRIGGER", res_rev["note"]["deltaTrigger"])

    def test_save_notes_batch_update_only_blocks_legacy_empty_updated_at_resurrection(self):
        # R1-N1 / QA low note: a legacy note row with blank updatedAt ("") deleted remotely
        # between load_workspace() and export-md/ocr-backfill must abort with CliError and 0 writes.
        snap = {
            "books": [
                {
                    "id": "b-legacy",
                    "title": "Legacy Book",
                    "author": "Author",
                    "format": "physical",
                    "kind": "nonfiction",
                    "status": "reading",
                    "currentPos": 50,
                    "totalPos": 100,
                    "posUnit": "page",
                    "normalizedPos": 0.5,
                    "docUrl": "",
                    "meta": {},
                }
            ],
            "notes": [
                {
                    "id": "n-legacy-empty-ts",
                    "slug": "legacy-empty-ts",
                    "bookId": "b-legacy",
                    "createdAt": "2026-11-10T10:00:00.000Z",
                    "updatedAt": "",
                    "pos": 20,
                    "normalizedPos": 0.2,
                    "status": "atomic",
                    "source": "app",
                    "tags": [],
                    "quote": "Q",
                    "takeaway": "T",
                    "contextMechanism": "",
                    "critique": "",
                    "deltaTrigger": "",
                    "deltaAction": "",
                    "deltaStatus": "none",
                    "meta": {"title": "Legacy Empty TS", "attachments": [], "links": []},
                }
            ],
            "sessions": [],
            "deltaLogs": [],
        }

        # 1. GoogleWorkspaceBackend via export-md: row vanishes between load and save -> 0 raw-batch writes
        fake = FakeSheetsRunner(snap)
        orig_call = fake.__call__
        notes_reads = {"n": 0}

        def delete_before_save(cmd):
            if cmd[:3] == ["gsheets", "readonly", "read"] and cmd[4] == "Notes!A:R":
                notes_reads["n"] += 1
                if notes_reads["n"] == 2:
                    fake.rows["Notes"] = [fake.rows["Notes"][0]]  # deleted remotely!
            return orig_call(cmd)

        with tempfile.TemporaryDirectory() as tmp:
            rc, _, err = _run_cli(
                ["--spreadsheet-id", "sid-cd8", "export-md", "--output-dir", tmp],
                runner=delete_before_save,
            )
            self.assertEqual(rc, 1)
            self.assertIn("deleted", err.get("error", "").lower())
            self.assertEqual(len(fake.raw_batches), 0, "Must never resurrect deleted legacy row via append")

            # 2. StateFileBackend direct update_only=True guard
            sf_path = Path(tmp) / "sf.json"
            sf_path.write_text(json.dumps({"version": 1, "books": [], "notes": [], "sessions": [], "deltaLogs": []}), encoding="utf-8")
            backend = pragya_cli.StateFileBackend(sf_path)
            with self.assertRaises(pragya_cli.CliError):
                backend.save_notes_batch([(snap["notes"][0], "")], update_only=True)
            after = json.loads(sf_path.read_text(encoding="utf-8"))
            self.assertEqual(after["notes"], [], "StateFileBackend update_only must write nothing when vanished")


if __name__ == "__main__":
    unittest.main()
