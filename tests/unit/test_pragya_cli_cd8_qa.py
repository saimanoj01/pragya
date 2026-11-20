"""CD Batch 8 adversarial QA unit tests — CLI subprocess budget, batch write safety,
StateFileBackend normalization, new CLI commands, and skill doc/argparse parity."""

from __future__ import annotations

import contextlib
import io
import json
import math
import re
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


def _run_cli(argv: list[str], runner=None) -> tuple[int, dict, dict]:
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = pragya_cli.main(argv, runner=runner or pragya_cli.default_cmd_runner)
    stdout_obj = json.loads(out.getvalue()) if out.getvalue().strip() else {}
    stderr_obj = json.loads(err.getvalue()) if err.getvalue().strip() else {}
    return rc, stdout_obj, stderr_obj


def _make_qa_snapshot() -> dict:
    return {
        "version": 1,
        "exportedAt": "2026-11-19T10:00:00.000Z",
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
                "meta": {"updatedAt": "2026-11-19T10:00:00.000Z"},
            },
            {
                "id": "book-fic",
                "title": "Dune",
                "author": "Frank Herbert",
                "format": "physical",
                "kind": "fiction",
                "status": "reading",
                "currentPos": 50,
                "totalPos": 400,
                "posUnit": "page",
                "normalizedPos": 0.125,
                "docUrl": "",
                "meta": {"updatedAt": "2026-11-19T10:00:00.000Z"},
            },
        ],
        "notes": [
            {
                "id": "n-1",
                "slug": "note-one",
                "bookId": "book-nf",
                "createdAt": "2026-11-10T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 40,
                "normalizedPos": 0.2,
                "status": "atomic",
                "source": "agent",
                "tags": ["#systems"],
                "quote": "Quote 1",
                "takeaway": "Takeaway 1",
                "contextMechanism": "Mech 1",
                "critique": "Crit 1",
                "deltaTrigger": "deploy finishes",
                "deltaAction": "watch metrics for lag",
                "deltaStatus": "paused",
                "meta": {
                    "title": "Note One",
                    "sparStage": 2,
                    "customKeep": {"nested": True},
                    "attachments": [
                        {"id": "a1", "type": "image", "driveFileId": "drv-1", "fileName": "p1.webp"},
                        {"id": "a2", "type": "link", "url": "https://example.com/2"},
                        {"id": "a3", "type": "link", "url": "https://example.com/3"},
                        {"id": "a4", "type": "custom_unknown", "extra": 42},
                    ],
                    "links": [],
                },
            },
            {
                "id": "n-2",
                "slug": "note-two",
                "bookId": "book-nf",
                "createdAt": "2026-11-11T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 60,
                "normalizedPos": 0.3,
                "status": "atomic",
                "source": "agent",
                "tags": ["#systems"],
                "quote": "Quote 2",
                "takeaway": "Takeaway 2",
                "contextMechanism": "Mech 2",
                "critique": "Crit 2",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "Note Two",
                    "customNoteTwo": "keep-me",
                    "attachments": [
                        {"id": "b1", "type": "image", "driveFileId": "drv-2", "fileName": "p2.webp"}
                    ],
                    "links": [],
                },
            },
            {
                "id": "n-3",
                "slug": "note-three",
                "bookId": "book-nf",
                "createdAt": "2026-11-12T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 80,
                "normalizedPos": 0.4,
                "status": "atomic",
                "source": "agent",
                "tags": ["#leverage"],
                "quote": "Quote 3",
                "takeaway": "Takeaway 3",
                "contextMechanism": "Mech 3",
                "critique": "Crit 3",
                "deltaTrigger": "budget review",
                "deltaAction": "ask about incentives",
                "deltaStatus": "active",
                "meta": {
                    "title": "Note Three",
                    "attachments": [
                        {"id": "c1", "type": "image", "driveFileId": "drv-3", "fileName": "p3.webp"}
                    ],
                    "links": [],
                },
            },
            {
                "id": "n-nf-ahead",
                "slug": "nf-ahead-secret",
                "bookId": "book-nf",
                "createdAt": "2026-11-12T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 175,
                "normalizedPos": 0.875,
                "status": "saved",
                "source": "app",
                "tags": ["#future"],
                "quote": "NF_AHEAD_QUOTE",
                "takeaway": "NF_AHEAD_TAKEAWAY",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "NF_AHEAD_TITLE",
                    "chapter": "Ch. 9: Future Chapter",
                    "attachments": [],
                    "links": [],
                },
            },
            {
                "id": "n-fic-ahead",
                "slug": "dune-ending-secret",
                "bookId": "book-fic",
                "createdAt": "2026-11-12T10:00:00.000Z",
                "updatedAt": "2026-11-15T10:00:00.000Z",
                "pos": 350,
                "normalizedPos": 0.875,
                "status": "saved",
                "source": "app",
                "tags": ["#plot"],
                "quote": "DUNE_SECRET_QUOTE",
                "takeaway": "DUNE_SECRET_TAKEAWAY",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "DUNE_SECRET_TITLE",
                    "chapter": "Ch. 22: Arrakeen",
                    "attachments": [],
                    "links": [],
                },
            },
        ],
        "sessions": [],
        "deltaLogs": [],
    }


class AdversarialFakeSheetsRunner:
    def __init__(
        self,
        snap: dict,
        *,
        missing_tabs: tuple[str, ...] = (),
        corrupt_header_tabs: tuple[str, ...] = (),
        on_notes_read=None,
    ):
        self.existing_tabs = [t for t in ALL_TABS if t not in missing_tabs]
        self.rows = {
            "Books": [list(HEADERS["Books"])] + [pragya_cli.book_to_row(b) for b in snap["books"]],
            "Notes": [list(HEADERS["Notes"])] + [pragya_cli.note_to_row(n) for n in snap["notes"]],
            "Sessions": [list(HEADERS["Sessions"])] + [pragya_cli.session_to_row(s) for s in snap["sessions"]],
            "DeltaLogs": [list(HEADERS["DeltaLogs"])] + [pragya_cli.delta_log_to_row(d) for d in snap["deltaLogs"]],
        }
        for tab in missing_tabs:
            self.rows[tab] = []
        for tab in corrupt_header_tabs:
            if self.rows[tab]:
                self.rows[tab][0] = ["id", "CORRUPTED_HEADER"]
        self.on_notes_read = on_notes_read
        self.notes_read_count = 0
        self.calls: list[list[str]] = []
        self.raw_batches: list[dict] = []

    def __call__(self, cmd: list[str]) -> tuple[int, str, str]:
        self.calls.append(list(cmd))
        if cmd[:3] == ["gsheets", "readonly", "list"]:
            return 0, json.dumps([{"id": "sid-qa8", "name": pragya_cli.SPREADSHEET_TITLE}]), ""
        if cmd[:3] == ["gsheets", "readonly", "list-sheets"]:
            payload = {
                "sheets": [
                    {"properties": {"title": t, "sheetId": FAKE_SHEET_IDS[t]}}
                    for t in self.existing_tabs
                ]
            }
            return 0, json.dumps(payload), ""
        if cmd[:3] == ["gsheets", "mutate", "add-sheet"]:
            title = cmd[cmd.index("--title") + 1]
            if title not in self.existing_tabs:
                self.existing_tabs.append(title)
            return 0, json.dumps({"title": title}), ""
        if cmd[:3] == ["gsheets", "readonly", "read"]:
            tab, a1 = cmd[4].split("!")
            if tab == "Notes" and a1 == "A:R":
                self.notes_read_count += 1
                if self.on_notes_read:
                    self.on_notes_read(self.notes_read_count, self)
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


class TestCd8QaAdversarialCli(unittest.TestCase):
    def test_load_workspace_repairs_corrupted_header_and_missing_tab(self):
        snap = _make_qa_snapshot()
        fake = AdversarialFakeSheetsRunner(
            snap, missing_tabs=("DeltaLogs",), corrupt_header_tabs=("Books",)
        )
        backend = pragya_cli.GoogleWorkspaceBackend(
            spreadsheet_id="sid-qa8", runner=fake, sleep=lambda _: None
        )
        ws = backend.load_workspace()
        self.assertEqual(len(ws["books"]), 2)
        # Missing DeltaLogs tab was created and BOTH Books (corrupted header) & DeltaLogs (new tab) repaired in 1 batch!
        self.assertTrue(any(c[:3] == ["gsheets", "mutate", "add-sheet"] for c in fake.calls))
        self.assertEqual(len(fake.raw_batches), 1)
        repaired_sheet_ids = {
            r["updateCells"]["range"]["sheetId"] for r in fake.raw_batches[0]["requests"]
        }
        self.assertEqual(repaired_sheet_ids, {FAKE_SHEET_IDS["Books"], FAKE_SHEET_IDS["DeltaLogs"]})
        # Warm 2nd load drops straight to 4 data reads (no list-sheets, no header repair)
        fake.calls.clear()
        fake.raw_batches.clear()
        backend.load_workspace()
        self.assertEqual(len(fake.calls), 4)
        self.assertEqual(len(fake.raw_batches), 0)

    def test_save_notes_batch_relocates_shifted_rows_preserves_unknown_meta_and_aborts_on_vanished_or_last_conflict(self):
        snap = _make_qa_snapshot()

        # 1. Shifted row (n-1 moves from row 2 -> row 4 before batch save): relocates cleanly + preserves unknown meta!
        def shift_n1_to_row4(count: int, runner: AdversarialFakeSheetsRunner) -> None:
            if count == 2:
                # Reorder data rows so n-1 sits at 1-based row 4 (index 3)
                header, r1, r2, r3, *rest = runner.rows["Notes"]
                runner.rows["Notes"] = [header, r2, r3, r1, *rest]

        fake_shift = AdversarialFakeSheetsRunner(snap, on_notes_read=shift_n1_to_row4)
        with tempfile.TemporaryDirectory() as tmp:
            rc, res, err = _run_cli(
                ["--spreadsheet-id", "sid-qa8", "export-md", "--output-dir", tmp],
                runner=fake_shift,
            )
            self.assertEqual(rc, 0, err)
            self.assertEqual(res["exportedCount"], 3)
            self.assertEqual(len(fake_shift.raw_batches), 1)
            reqs = fake_shift.raw_batches[0]["requests"]
            self.assertEqual(len(reqs), 3)
            # n-1 is first in batch -> must target 0-based startRowIndex=3 (1-based row 4)!
            n1_req = reqs[0]["updateCells"]
            self.assertEqual(n1_req["range"]["startRowIndex"], 3)
            n1_meta_str = n1_req["rows"][0]["values"][17]["userEnteredValue"]["stringValue"]
            n1_meta = json.loads(n1_meta_str)
            self.assertEqual(n1_meta["sparStage"], 2)
            self.assertEqual(n1_meta["customKeep"], {"nested": True})
            self.assertEqual(len(n1_meta["attachments"]), 4)
            self.assertEqual(n1_meta["attachments"][3]["type"], "custom_unknown")
            self.assertIn("exportedAt", n1_meta)

        # 2. Vanished note (n-2 deleted remotely before batch save) -> ENTIRE batch aborts with ZERO writes!
        def delete_n2(count: int, runner: AdversarialFakeSheetsRunner) -> None:
            if count == 2:
                runner.rows["Notes"] = [r for r in runner.rows["Notes"] if r[0] != "n-2"]

        fake_vanished = AdversarialFakeSheetsRunner(snap, on_notes_read=delete_n2)
        with tempfile.TemporaryDirectory() as tmp:
            rc_v, _, err_v = _run_cli(
                ["--spreadsheet-id", "sid-qa8", "export-md", "--output-dir", tmp],
                runner=fake_vanished,
            )
            self.assertEqual(rc_v, 1)
            self.assertIn("moved or was deleted", err_v.get("error", ""))
            self.assertEqual(len(fake_vanished.raw_batches), 0)

        # 3. Conflict on LAST note (n-3) in batch -> aborts with ZERO writes!
        def conflict_last_note(count: int, runner: AdversarialFakeSheetsRunner) -> None:
            if count == 2:
                for row in runner.rows["Notes"]:
                    if row[0] == "n-3":
                        row[4] = "2099-01-01T00:00:00.000Z"

        fake_last = AdversarialFakeSheetsRunner(snap, on_notes_read=conflict_last_note)
        with tempfile.TemporaryDirectory() as tmp:
            rc_l, _, err_l = _run_cli(
                ["--spreadsheet-id", "sid-qa8", "export-md", "--output-dir", tmp],
                runner=fake_last,
            )
            self.assertEqual(rc_l, 1)
            self.assertIn("Row conflict on Notes n-3", err_l.get("error", ""))
            self.assertEqual(len(fake_last.raw_batches), 0)

    def test_state_file_backend_normalizes_all_4_tabs_on_save_and_atomic_batch_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "snap.json"
            base = _make_qa_snapshot()
            state_path.write_text(json.dumps(base), encoding="utf-8")
            backend = pragya_cli.StateFileBackend(state_path)

            # Save drifted Session & DeltaLog (serial dates, NaN, invalid outcome)
            saved_sess = backend.save_session(
                {
                    "id": "s-drift",
                    "bookId": " book-nf ",
                    "date": 46342,
                    "startPos": float("nan"),
                    "endPos": "42",
                    "updatedAt": 46342.5,
                    "note": None,
                }
            )
            self.assertEqual(saved_sess["bookId"], "book-nf")
            self.assertRegex(saved_sess["date"], r"^\d{4}-\d{2}-\d{2}$")
            self.assertEqual(saved_sess["startPos"], 0)
            self.assertEqual(saved_sess["endPos"], 42)
            self.assertEqual(saved_sess["note"], "")

            saved_log = backend.save_delta_log(
                {
                    "id": "dl-drift",
                    "noteId": " n-1 ",
                    "date": 46342,
                    "outcome": "totally-invalid",
                    "reflection": None,
                }
            )
            self.assertEqual(saved_log["noteId"], "n-1")
            self.assertEqual(saved_log["outcome"], "no-trigger")
            self.assertEqual(saved_log["reflection"], "")

            # Atomic StateFileBackend.save_notes_batch conflict on note #2 leaves file untouched (n-1 NOT written!)
            n1_copy = json.loads(json.dumps(base["notes"][0]))
            n1_copy["takeaway"] = "SHOULD_NOT_PERSIST"
            n2_copy = json.loads(json.dumps(base["notes"][1]))
            n2_copy["takeaway"] = "CONFLICTING_N2"
            with self.assertRaises(pragya_cli.CliError):
                backend.save_notes_batch(
                    [
                        (n1_copy, "2026-11-15T10:00:00.000Z"),
                        (n2_copy, "2020-01-01T00:00:00.000Z"),  # stale base!
                    ]
                )
            reloaded = backend.load_workspace()
            reloaded_n1 = next(n for n in reloaded["notes"] if n["id"] == "n-1")
            self.assertEqual(reloaded_n1["takeaway"], "Takeaway 1")
            self.assertFalse(math.isnan(reloaded["sessions"][0]["startPos"]))

    def test_cli_new_commands_spoiler_safety_meta_preservation_conflict_guard_and_doc_parity(self):
        snap = _make_qa_snapshot()

        # 1. Nonfiction & fiction ahead-of-bookmark notes shielded in note-list and note-get
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            state_path.write_text(json.dumps(snap), encoding="utf-8")

            rc_l, res_l, err_l = _run_cli(["--state-file", str(state_path), "note-list"])
            self.assertEqual(rc_l, 0, err_l)
            self.assertEqual(res_l["shieldedCount"], 2)
            dumped_list = json.dumps(res_l)
            for secret in (
                "NF_AHEAD_QUOTE",
                "NF_AHEAD_TAKEAWAY",
                "NF_AHEAD_TITLE",
                "nf-ahead-secret",
                "Ch. 9: Future Chapter",
                "DUNE_SECRET_QUOTE",
                "DUNE_SECRET_TAKEAWAY",
                "DUNE_SECRET_TITLE",
                "dune-ending-secret",
                "Ch. 22: Arrakeen",
            ):
                self.assertNotIn(secret, dumped_list)

            rc_g, res_g, _ = _run_cli(
                ["--state-file", str(state_path), "note-get", "--note", "nf-ahead-secret"]
            )
            self.assertEqual(rc_g, 0)
            self.assertTrue(res_g["shielded"])
            dumped_get = json.dumps(res_g)
            for secret in ("NF_AHEAD_QUOTE", "NF_AHEAD_TAKEAWAY", "NF_AHEAD_TITLE", "nf-ahead-secret", "Ch. 9"):
                self.assertNotIn(secret, dumped_get)

            # 2. delta-status refuses activating atomic note without WHEN/DO, preserves unknown meta on valid activation
            rc_no_wd, _, err_no_wd = _run_cli(
                ["--state-file", str(state_path), "delta-status", "--note", "note-two", "--status", "active"]
            )
            self.assertEqual(rc_no_wd, 1)
            self.assertIn("WHEN", err_no_wd.get("error", ""))

            rc_act, res_act, err_act = _run_cli(
                ["--state-file", str(state_path), "delta-status", "--note", "note-one", "--status", "active"]
            )
            self.assertEqual(rc_act, 0, err_act)
            self.assertEqual(res_act["note"]["meta"]["sparStage"], 2)
            self.assertEqual(res_act["note"]["meta"]["customKeep"], {"nested": True})
            self.assertEqual(len(res_act["note"]["meta"]["attachments"]), 4)

        # 3. delta-status enforces conflict guard on GoogleWorkspaceBackend (0 writes on conflict; --force overrides)
        def bump_n1(count: int, runner: AdversarialFakeSheetsRunner) -> None:
            if count == 2:
                for row in runner.rows["Notes"]:
                    if row[0] == "n-1":
                        row[4] = "2099-01-01T00:00:00.000Z"

        fake_conflict = AdversarialFakeSheetsRunner(snap, on_notes_read=bump_n1)
        rc_dc, _, err_dc = _run_cli(
            ["--spreadsheet-id", "sid-qa8", "delta-status", "--note", "note-one", "--status", "active"],
            runner=fake_conflict,
        )
        self.assertEqual(rc_dc, 1)
        self.assertIn("Row conflict", err_dc.get("error", ""))
        self.assertEqual(len(fake_conflict.raw_batches), 0)

        # 4. SKILL.md commands & flags match real build_parser() argparse tree verbatim
        parser = pragya_cli.build_parser()
        sub_action = next(
            a for a in parser._actions if hasattr(a, "choices") and isinstance(a.choices, dict)
        )
        cmd_flags = {
            name: {opt for act in sp._actions for opt in act.option_strings}
            for name, sp in sub_action.choices.items()
        }
        for required_cmd in ("note-list", "note-get", "delta-status"):
            self.assertIn(required_cmd, cmd_flags)

        skill_md = (REPO_ROOT / ".agents/skills/pragya-companion/SKILL.md").read_text(encoding="utf-8")
        joined = re.sub(r"\\\n\s*", " ", skill_md)
        for line in joined.splitlines():
            m = re.search(r"pragya_cli\.py\s+(?:--\S+\s+\S+\s+)*([a-z][a-z0-9-]+)(.*)", line)
            if not m:
                continue
            cmd_name, rest = m.group(1), re.sub(r"#.*$", "", m.group(2))
            if cmd_name.startswith("-"):
                continue
            self.assertIn(cmd_name, cmd_flags, f"SKILL.md references unknown command {cmd_name}")
            for flag in re.findall(r"(--[a-z][a-z0-9-]*)", rest):
                self.assertIn(
                    flag,
                    cmd_flags[cmd_name],
                    f"SKILL.md references unknown flag {flag} for {cmd_name}",
                )

        schema_md = (
            REPO_ROOT / ".agents/skills/pragya-companion/references/schema_and_ops.md"
        ).read_text(encoding="utf-8")
        for token in ("note-list", "note-get", "delta-status", "--include-spoilers", "--reveal", "npm run sync:skill", "npm run check:skill"):
            self.assertIn(token, schema_md)


if __name__ == "__main__":
    unittest.main()
