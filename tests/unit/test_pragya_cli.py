from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_PATH = REPO_ROOT / "scripts" / "pragya_cli.py"
SKILL_CLI_PATH = REPO_ROOT / ".agents" / "skills" / "pragya-companion" / "scripts" / "pragya_cli.py"

_SPEC = importlib.util.spec_from_file_location("pragya_cli", CLI_PATH)
assert _SPEC and _SPEC.loader
pragya_cli = importlib.util.module_from_spec(_SPEC)
sys.modules["pragya_cli"] = pragya_cli
_SPEC.loader.exec_module(pragya_cli)


def _iso_days_ago(days: int, hours_offset: int = 0) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days, hours=hours_offset)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _make_sample_snapshot() -> dict:
    now = datetime.now(timezone.utc)
    today = pragya_cli.local_date_str(now.astimezone())
    ten_min_ago = (now - timedelta(minutes=10)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "version": 1,
        "exportedAt": _iso_days_ago(0),
        "books": [
            {
                "id": "book-systems",
                "title": "Thinking in Systems: A Primer",
                "author": "Donella H. Meadows",
                "format": "physical",
                "kind": "nonfiction",
                "status": "reading",
                "currentPos": 142,
                "totalPos": 218,
                "posUnit": "page",
                "normalizedPos": 142 / 218,
                "docUrl": "",
                "meta": {"startedAt": _iso_days_ago(20), "updatedAt": _iso_days_ago(1)},
            },
            {
                "id": "book-exhalation",
                "title": "Exhalation: Stories",
                "author": "Ted Chiang",
                "format": "kindle",
                "kind": "fiction",
                "status": "reading",
                "currentPos": 100,
                "totalPos": 300,
                "posUnit": "page",
                "normalizedPos": 100 / 300,
                "docUrl": "",
                "meta": {"startedAt": _iso_days_ago(10), "updatedAt": _iso_days_ago(0)},
            },
        ],
        "notes": [
            {
                "id": "note-old-atomic",
                "slug": "delays-in-feedback-loops",
                "bookId": "book-systems",
                "createdAt": _iso_days_ago(20),
                "updatedAt": _iso_days_ago(2),
                "pos": 142,
                "normalizedPos": 142 / 218,
                "status": "atomic",
                "source": "app",
                "tags": ["#systems", "#favorite"],
                "quote": "Delays in feedback loops are common causes of oscillations.",
                "takeaway": "Wait out the lag before tuning. Linked to [[playing-with-boundaries]].",
                "contextMechanism": "Delayed corrective signals overshoot targets.",
                "critique": "Fails in exponential runaway crises.",
                "deltaTrigger": "WHEN WHEN deploy latency spikes",
                "deltaAction": "DO DO wait 24h before tuning knobs",
                "deltaStatus": "active",
                "meta": {
                    "title": "Delays in Feedback Loops",
                    "attachments": [],
                    "links": [],
                },
            },
            {
                "id": "note-inbox-memory",
                "slug": "memory-prism-digital-remembrance",
                "bookId": "book-exhalation",
                "createdAt": _iso_days_ago(16),
                "updatedAt": _iso_days_ago(3),
                "pos": 85,
                "normalizedPos": 85 / 300,
                "status": "inbox",
                "source": "app",
                "tags": ["#fiction", "#memory"],
                "quote": "Digital memory freezes what was meant to be reconstructed.",
                "takeaway": "Total archival recall erodes forgiving reinterpretation.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "Memory Prism: Digital Remembrance",
                    "attachments": [],
                    "links": [],
                },
            },
            {
                "id": "note-future-spoiler",
                "slug": "future-ending-twist",
                "bookId": "book-exhalation",
                "createdAt": _iso_days_ago(18),
                "updatedAt": _iso_days_ago(1),
                "pos": 250,
                "normalizedPos": 250 / 300,
                "status": "saved",
                "source": "app",
                "tags": ["#fiction", "#favorite"],
                "quote": "QUANTUM_SPOILER_SECRET_77 hidden ending quote.",
                "takeaway": "QUANTUM_SPOILER_SECRET_77 ending realization.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "Future Ending Twist",
                    "attachments": [],
                    "links": [],
                },
            },
            {
                "id": "note-sealed-prediction",
                "slug": "sealed-ending-bet",
                "bookId": "book-exhalation",
                "createdAt": _iso_days_ago(25),
                "updatedAt": _iso_days_ago(25),
                "pos": 90,
                "normalizedPos": 90 / 300,
                "status": "saved",
                "source": "app",
                "tags": ["#prediction", "#favorites"],
                "quote": "",
                "takeaway": "Prediction: the narrator discovers the prism reverses time.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "Sealed Ending Bet",
                    "isPrediction": True,
                    "attachments": [],
                    "links": [],
                },
            },
            {
                "id": "note-too-new",
                "slug": "brand-new-note",
                "bookId": "book-systems",
                "createdAt": _iso_days_ago(3),
                "updatedAt": _iso_days_ago(3),
                "pos": 50,
                "normalizedPos": 50 / 218,
                "status": "saved",
                "source": "app",
                "tags": ["#systems"],
                "quote": "New quote",
                "takeaway": "Only 3 days old without favorite tag.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {"attachments": [], "links": []},
            },
            {
                "id": "note-old-reviewed-today",
                "slug": "reviewed-today-note",
                "bookId": "book-systems",
                "createdAt": _iso_days_ago(30),
                "updatedAt": _iso_days_ago(1),
                "pos": 40,
                "normalizedPos": 40 / 218,
                "status": "saved",
                "source": "app",
                "tags": ["#systems"],
                "quote": "",
                "takeaway": "Reviewed earlier today.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "lastReviewedAt": today,
                    "attachments": [],
                    "links": [],
                },
            },
            {
                "id": "note-old-eligible",
                "slug": "playing-with-boundaries",
                "bookId": "book-systems",
                "createdAt": _iso_days_ago(19),
                "updatedAt": _iso_days_ago(10),
                "pos": 60,
                "normalizedPos": 60 / 218,
                "status": "atomic",
                "source": "app",
                "tags": ["#strategy"],
                "quote": "Finite players play within boundaries; infinite players play with boundaries.",
                "takeaway": "Negotiate the frame of the game rather than optimizing inside brittle walls.",
                "contextMechanism": "Reshaping conventions sustains participation.",
                "critique": "Safety rules must stay rigid.",
                "deltaTrigger": "defensive zero-sum comparison",
                "deltaAction": "reframe around longevity",
                "deltaStatus": "paused",
                "meta": {"title": "Playing With Boundaries", "attachments": [], "links": []},
            },
        ],
        "sessions": [
            {
                "id": "sess-recent",
                "bookId": "book-systems",
                "date": today,
                "startPos": 130,
                "endPos": 142,
                "updatedAt": ten_min_ago,
                "note": "Initial session",
            }
        ],
        "deltaLogs": [],
    }


# M6 B1.1: Sheet data writes go through `gsheets mutate raw-batch` (Sheets API
# updateCells/appendCells). Fake runners map tab -> sheetId and decode the request
# file back into the legacy {"op", "range", "data"} shape so assertion intent is kept.
FAKE_SHEET_IDS = {"Books": 101, "Notes": 102, "Sessions": 103, "DeltaLogs": 104}
_LAST_COL = {"Books": "L", "Notes": "R", "Sessions": "G", "DeltaLogs": "E"}


def _fake_list_sheets_payload(titles) -> str:
    return json.dumps(
        {"sheets": [{"properties": {"title": t, "sheetId": FAKE_SHEET_IDS[t]}} for t in titles]}
    )


def _single_cell_lookup(rng: str, rows_by_tab: dict):
    """Serves `Tab!A{n}` one-cell reads (CLI R1#6 id re-read) from fake tab rows."""
    m = re.fullmatch(r"(\w+)!A(\d+)", rng)
    if not m or m.group(1) not in rows_by_tab:
        return None
    rows = rows_by_tab[m.group(1)]
    idx = int(m.group(2)) - 1
    return [[rows[idx][0]]] if 0 <= idx < len(rows) else []


def _col_count(tab: str) -> int:
    """Column count of a tab (Books L=12, Notes R=18, Sessions G=7, DeltaLogs E=5)."""
    return ord(_LAST_COL[tab]) - ord("A") + 1


def _cell_value(cell: dict):
    uev = cell.get("userEnteredValue") or {}
    if "numberValue" in uev:
        return uev["numberValue"]
    return uev.get("stringValue", "")


def _decode_raw_batch(payload: dict) -> list[dict]:
    """Decodes a raw-batch request file into [{"op", "range", "data"}] for assertions."""
    id_to_tab = {v: k for k, v in FAKE_SHEET_IDS.items()}
    ops: list[dict] = []
    for req in payload["requests"]:
        if "updateCells" in req:
            uc = req["updateCells"]
            assert uc["fields"] == "userEnteredValue"
            rng = uc["range"]
            tab = id_to_tab[rng["sheetId"]]
            row = rng["startRowIndex"] + 1
            assert rng["endRowIndex"] == row and rng["startColumnIndex"] == 0
            # Column half of the legacy "Tab!A{r}:{last}{r}" range: the full row is written.
            assert rng["endColumnIndex"] == _col_count(tab), (tab, rng)
            assert all(len(r["values"]) == rng["endColumnIndex"] for r in uc["rows"]), uc
            data = [[_cell_value(c) for c in r["values"]] for r in uc["rows"]]
            ops.append({"op": "write", "range": f"{tab}!A{row}:{_LAST_COL[tab]}{row}", "data": data, "raw": req})
        elif "appendCells" in req:
            ac = req["appendCells"]
            assert ac["fields"] == "userEnteredValue"
            tab = id_to_tab[ac["sheetId"]]
            assert all(len(r["values"]) == _col_count(tab) for r in ac["rows"]), ac
            data = [[_cell_value(c) for c in r["values"]] for r in ac["rows"]]
            ops.append({"op": "append", "range": f"{tab}!A1", "data": data, "raw": req})
        else:
            raise AssertionError(f"Unexpected raw-batch request: {req}")
    return ops


def _run_cli_json(argv: list[str], *, cwd: Path | None = None, executable: Path = CLI_PATH) -> tuple[int, dict, str]:
    proc = subprocess.run(
        [sys.executable, str(executable), *argv],
        cwd=str(cwd or REPO_ROOT),
        capture_output=True,
        text=True,
    )
    payload = {}
    if proc.stdout.strip():
        payload = json.loads(proc.stdout)
    elif proc.stderr.strip():
        try:
            payload = json.loads(proc.stderr)
        except json.JSONDecodeError:
            payload = {"rawError": proc.stderr}
    return proc.returncode, payload, proc.stderr


class TestPragyaCli(unittest.TestCase):
    def test_capture_book_resolution_monotonic_coalescing_attachments_and_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            state_path = tmp_dir / "state.json"
            state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")
            img_file = tmp_dir / "page.webp"
            img_file.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")

            # 1. Partial title resolution, advance > currentPos coalesces within 30 min, <=3 attachments, --spar
            rc, res, err = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "capture",
                    "--book",
                    "Thinking in Systems",
                    "--pos",
                    "160",
                    "--quote",
                    "Stocks are the foundation of any system.",
                    "--takeaway",
                    "Look at buffer sizes before tweaking flow rates.",
                    "--tags",
                    "#systems, #stocks",
                    "--image",
                    str(img_file),
                    "--doc-url",
                    "https://docs.google.com/document/d/doc-abc-123/edit",
                    "--link",
                    "https://example.com/systems",
                    "--spar",
                ]
            )
            self.assertEqual(rc, 0, err)
            self.assertEqual(res["note"]["source"], "agent")
            self.assertEqual(res["note"]["status"], "inbox")
            self.assertEqual(res["book"]["currentPos"], 160)
            self.assertEqual(len(res["note"]["meta"]["attachments"]), 3)
            self.assertEqual(res["note"]["meta"]["attachments"][1]["docId"], "doc-abc-123")

            saved = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(len(saved["sessions"]), 1)
            self.assertEqual(saved["sessions"][0]["id"], "sess-recent")
            self.assertEqual(saved["sessions"][0]["endPos"], 160)

            # 2. Backward capture without --force-pos keeps monotonic bookmark at 160
            rc, res_back, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "capture",
                    "--book",
                    "book-systems",
                    "--pos",
                    "80",
                    "--takeaway",
                    "Earlier page note.",
                ]
            )
            self.assertEqual(rc, 0)
            self.assertTrue(res_back["rejectedBackward"])
            self.assertFalse(res_back["bookmarkChanged"])
            self.assertEqual(res_back["book"]["currentPos"], 160)

            # 3. Backward capture WITH --force-pos overrides monotonic ceiling & --prediction on fiction
            rc, res_force, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "capture",
                    "--book",
                    "Exhalation",
                    "--pos",
                    "75",
                    "--takeaway",
                    "Prediction: time loop closes.",
                    "--prediction",
                    "--force-pos",
                ]
            )
            self.assertEqual(rc, 0)
            self.assertTrue(res_force["bookmarkChanged"])
            self.assertEqual(res_force["book"]["currentPos"], 75)
            self.assertTrue(res_force["note"]["meta"].get("isPrediction"))

            # 4. > 30-min elapsed creates a NEW session rather than coalescing
            state = json.loads(state_path.read_text(encoding="utf-8"))
            state["sessions"][0]["updatedAt"] = (
                (datetime.now(timezone.utc) - timedelta(minutes=45))
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
            state_path.write_text(json.dumps(state), encoding="utf-8")
            rc, _, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "capture",
                    "--book",
                    "book-systems",
                    "--pos",
                    "175",
                    "--takeaway",
                    "New reading block session.",
                ]
            )
            self.assertEqual(rc, 0)
            state_after = json.loads(state_path.read_text(encoding="utf-8"))
            systems_sessions = [s for s in state_after["sessions"] if s["bookId"] == "book-systems"]
            self.assertEqual(len(systems_sessions), 2)

            # 5. Exceeding 3 attachments fails cleanly with non-zero exit
            rc_err, err_payload, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "capture",
                    "--book",
                    "book-systems",
                    "--pos",
                    "180",
                    "--takeaway",
                    "Too many attachments",
                    "--link",
                    "https://a.test",
                    "--link",
                    "https://b.test",
                    "--link",
                    "https://c.test",
                    "--link",
                    "https://d.test",
                ]
            )
            self.assertNotEqual(rc_err, 0)
            self.assertIn("Maximum 3 attachments", err_payload.get("error", ""))

            # 5b. Unsafe link/doc-url schemes (javascript:, data:) fail with CliError without mutating state
            before_count = len(json.loads(state_path.read_text(encoding="utf-8"))["notes"])
            for flag, bad_url in (
                ("--link", "javascript:alert(1)"),
                ("--doc-url", "data:text/html,<script>1</script>"),
            ):
                rc_bad_url, bad_url_err, _ = _run_cli_json(
                    [
                        "--state-file",
                        str(state_path),
                        "capture",
                        "--book",
                        "book-systems",
                        "--pos",
                        "181",
                        "--takeaway",
                        "Unsafe URL check",
                        flag,
                        bad_url,
                    ]
                )
                self.assertNotEqual(rc_bad_url, 0)
                self.assertIn("http/https", bad_url_err.get("error", ""))
            self.assertEqual(
                len(json.loads(state_path.read_text(encoding="utf-8"))["notes"]),
                before_count,
            )

            # 6. WHEN/DO normalization prevents duplicate prefixes
            _, _, when_line, do_line = pragya_cli.format_when_do_lines(
                "WHEN WHEN metric spikes", "DO DO wait 24h"
            )
            self.assertEqual(when_line, "WHEN metric spikes")
            self.assertEqual(do_line, "DO wait 24h")

    def test_reflect_4_stage_fiction_spoiler_clamping_and_5_delta_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")

            # Stage 1 on fiction note must block & NEVER leak future spoiler secret
            rc1, res1, err1 = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "reflect",
                    "--note",
                    "memory-prism-digital-remembrance",
                    "--stage",
                    "1",
                ]
            )
            self.assertEqual(rc1, 0, err1)
            self.assertEqual(res1["status"], "awaiting_user_reply")
            self.assertEqual(len(res1["socraticQuestions"]), 2)
            self.assertNotIn("QUANTUM_SPOILER_SECRET_77", json.dumps(res1))

            state_mid = json.loads(state_path.read_text(encoding="utf-8"))
            reflected = next(n for n in state_mid["notes"] if n["id"] == "note-inbox-memory")
            self.assertEqual(reflected["status"], "in-reflection")
            self.assertEqual(len(reflected["meta"]["socraticQuestions"]), 2)

            # Stage commit upgrades to atomic & strips duplicate WHEN WHEN / DO DO
            rc2, res2, err2 = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "reflect",
                    "--note",
                    "memory-prism-digital-remembrance",
                    "--stage",
                    "commit",
                    "--title",
                    "Reconstructive Memory",
                    "--slug",
                    "reconstructive-memory",
                    "--takeaway",
                    "Forgiveness depends on flexible recall. Related to [[delays-in-feedback-loops]].",
                    "--context",
                    "Chiang contrasts verbatim replay against human reconstruction.",
                    "--critique",
                    "Fails in legal audit scenarios.",
                    "--trigger",
                    "WHEN WHEN revisiting an old conflict",
                    "--action",
                    "DO DO separate emotional intent from transcript",
                    "--delta-status",
                    "active",
                ]
            )
            self.assertEqual(rc2, 0, err2)
            note_out = res2["note"]
            self.assertEqual(note_out["status"], "atomic")
            self.assertEqual(note_out["slug"], "reconstructive-memory")
            self.assertEqual(note_out["deltaTrigger"], "revisiting an old conflict")
            self.assertEqual(note_out["deltaAction"], "separate emotional intent from transcript")
            self.assertEqual(note_out["deltaStatus"], "active")

            # Seed 5 active deltas, verify 6th commit --delta-status active fails without mutating state
            state = json.loads(state_path.read_text(encoding="utf-8"))
            for idx in range(5):
                state["notes"][idx]["deltaStatus"] = "active"
                state["notes"][idx]["deltaTrigger"] = f"trigger {idx}"
                state["notes"][idx]["deltaAction"] = f"action {idx}"
            candidate = state["notes"][5]
            candidate["deltaStatus"] = "none"
            candidate["status"] = "saved"
            state_path.write_text(json.dumps(state), encoding="utf-8")

            rc_cap, cap_err, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "reflect",
                    "--note",
                    candidate["id"],
                    "--stage",
                    "commit",
                    "--trigger",
                    "sixth trigger",
                    "--action",
                    "sixth action",
                    "--delta-status",
                    "active",
                ]
            )
            self.assertNotEqual(rc_cap, 0)
            self.assertIn("5/5", cap_err.get("error", ""))

            after_fail = json.loads(state_path.read_text(encoding="utf-8"))
            cand_after = next(n for n in after_fail["notes"] if n["id"] == candidate["id"])
            self.assertEqual(cand_after["status"], "saved")
            self.assertEqual(cand_after["deltaStatus"], "none")

            # Activating a delta with empty trigger and action must fail cleanly without mutating state
            for n in after_fail["notes"][:5]:
                n["deltaStatus"] = "none"
            state_path.write_text(json.dumps(after_fail), encoding="utf-8")
            rc_empty_delta, empty_delta_err, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "reflect",
                    "--note",
                    candidate["id"],
                    "--stage",
                    "commit",
                    "--trigger",
                    "WHEN   ",
                    "--action",
                    "DO  ",
                    "--delta-status",
                    "active",
                ]
            )
            self.assertNotEqual(rc_empty_delta, 0)
            self.assertIn("WHEN trigger or DO action", empty_delta_err.get("error", ""))
            after_empty_fail = json.loads(state_path.read_text(encoding="utf-8"))
            cand_empty_after = next(n for n in after_empty_fail["notes"] if n["id"] == candidate["id"])
            self.assertEqual(cand_empty_after["status"], "saved")
            self.assertEqual(cand_empty_after["deltaStatus"], "none")

    def test_recall_qa_spoiler_filter_checkin_and_shuffle_determinism(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")

            # QA must NEVER leak future spoiler note on active fiction book
            rc_qa, res_qa, err_qa = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "recall",
                    "--mode",
                    "qa",
                    "--query",
                    "QUANTUM_SPOILER_SECRET_77",
                ]
            )
            self.assertEqual(rc_qa, 0, err_qa)
            self.assertEqual(res_qa["matches"], [])
            self.assertGreaterEqual(res_qa["excludedSpoilersCount"], 1)

            # QA surfaces non-spoiler matches
            rc_ok, res_ok, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "recall",
                    "--mode",
                    "qa",
                    "--query",
                    "feedback",
                ]
            )
            self.assertEqual(rc_ok, 0)
            self.assertEqual(len(res_ok["matches"]), 1)
            self.assertEqual(res_ok["matches"][0]["slug"], "delays-in-feedback-loops")

            # Check-in missed updates deltaTrigger cleanly and appends DeltaLog
            rc_chk, res_chk, err_chk = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "recall",
                    "--mode",
                    "checkin",
                    "--note",
                    "delays-in-feedback-loops",
                    "--outcome",
                    "missed",
                    "--trigger",
                    "WHEN WHEN pager alerts transiently",
                    "--reflection",
                    "Flipped config too fast.",
                ]
            )
            self.assertEqual(rc_chk, 0, err_chk)
            self.assertEqual(res_chk["logged"]["outcome"], "missed")
            self.assertEqual(res_chk["updatedNote"]["deltaTrigger"], "pager alerts transiently")

            # Partial checkin flags (--note without --outcome, or --outcome without --note) fail cleanly
            logs_before = len(json.loads(state_path.read_text(encoding="utf-8"))["deltaLogs"])
            for partial_args in (
                ["--note", "delays-in-feedback-loops"],
                ["--outcome", "applied"],
            ):
                rc_part, part_err, _ = _run_cli_json(
                    ["--state-file", str(state_path), "recall", "--mode", "checkin", *partial_args]
                )
                self.assertNotEqual(rc_part, 0)
                self.assertIn("both --note and --outcome", part_err.get("error", ""))
            self.assertEqual(
                len(json.loads(state_path.read_text(encoding="utf-8"))["deltaLogs"]),
                logs_before,
            )

            # Shuffle determinism & exclusions (no future spoiler, no sealed prediction, no <14d, no reviewed today)
            fixed_date = pragya_cli.local_date_str()
            rc_s1, s1, _ = _run_cli_json(
                ["--state-file", str(state_path), "recall", "--mode", "shuffle", "--date", fixed_date]
            )
            rc_s2, s2, _ = _run_cli_json(
                ["--state-file", str(state_path), "recall", "--mode", "shuffle", "--date", fixed_date]
            )
            self.assertEqual(rc_s1, 0)
            self.assertEqual(rc_s2, 0)
            slugs1 = [c["slug"] for c in s1["candidates"]]
            slugs2 = [c["slug"] for c in s2["candidates"]]
            self.assertEqual(slugs1, slugs2)
            self.assertNotIn("future-ending-twist", slugs1)
            self.assertNotIn("sealed-ending-bet", slugs1)
            self.assertNotIn("brand-new-note", slugs1)
            self.assertNotIn("reviewed-today-note", slugs1)
            self.assertIn("delays-in-feedback-loops", slugs1)
            self.assertIn("playing-with-boundaries", slugs1)

            # Mark reviewed excludes slug for remainder of fixed_date
            rc_mr, _, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "recall",
                    "--mode",
                    "shuffle",
                    "--mark-reviewed",
                    "playing-with-boundaries",
                    "--date",
                    fixed_date,
                ]
            )
            self.assertEqual(rc_mr, 0)
            _, s3, _ = _run_cli_json(
                ["--state-file", str(state_path), "recall", "--mode", "shuffle", "--date", fixed_date]
            )
            self.assertNotIn("playing-with-boundaries", [c["slug"] for c in s3["candidates"]])

    def test_ocr_backfill_map_cmd_and_idempotent_skip(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            state_path = tmp_dir / "state.json"
            img_a = tmp_dir / "scan_a.webp"
            img_b = tmp_dir / "scan_b.webp"
            img_a.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
            img_b.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")

            snap = _make_sample_snapshot()
            snap["notes"].extend(
                [
                    {
                        "id": "note-ocr-map",
                        "slug": "ocr-map-target",
                        "bookId": "book-systems",
                        "createdAt": _iso_days_ago(1),
                        "updatedAt": _iso_days_ago(1),
                        "pos": 150,
                        "normalizedPos": 150 / 218,
                        "status": "saved",
                        "source": "app",
                        "tags": [],
                        "quote": "",
                        "takeaway": "Diagram note A",
                        "contextMechanism": "",
                        "critique": "",
                        "deltaTrigger": "",
                        "deltaAction": "",
                        "deltaStatus": "none",
                        "meta": {
                            "attachments": [
                                {
                                    "id": "att-ocr-a",
                                    "type": "image",
                                    "localPath": str(img_a),
                                    "fileName": "scan_a.webp",
                                    "mimeType": "image/webp",
                                }
                            ],
                            "links": [],
                        },
                    },
                    {
                        "id": "note-ocr-cmd",
                        "slug": "ocr-cmd-target",
                        "bookId": "book-systems",
                        "createdAt": _iso_days_ago(1),
                        "updatedAt": _iso_days_ago(1),
                        "pos": 151,
                        "normalizedPos": 151 / 218,
                        "status": "saved",
                        "source": "app",
                        "tags": [],
                        "quote": "",
                        "takeaway": "Diagram note B",
                        "contextMechanism": "",
                        "critique": "",
                        "deltaTrigger": "",
                        "deltaAction": "",
                        "deltaStatus": "none",
                        "meta": {
                            "attachments": [
                                {
                                    "id": "att-ocr-b",
                                    "type": "image",
                                    "localPath": str(img_b),
                                    "fileName": "scan_b.webp",
                                    "mimeType": "image/webp",
                                }
                            ],
                            "links": [],
                        },
                    },
                ]
            )
            state_path.write_text(json.dumps(snap), encoding="utf-8")

            ocr_map_file = tmp_dir / "ocr_map.json"
            ocr_map_file.write_text(
                json.dumps({"ocr-map-target": "Extracted quote from map JSON."}), encoding="utf-8"
            )

            rc1, r1, err1 = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "ocr-backfill",
                    "--note",
                    "ocr-map-target",
                    "--ocr-map-json",
                    str(ocr_map_file),
                ]
            )
            self.assertEqual(rc1, 0, err1)
            self.assertEqual(r1["updatedCount"], 1)

            # Second note via --ocr-cmd
            ocr_cmd = f"{sys.executable} -c \"import sys; print('OCR_CMD:' + sys.argv[1].split('/')[-1])\" {{path}}"
            rc2, r2, err2 = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "ocr-backfill",
                    "--ocr-cmd",
                    ocr_cmd,
                ]
            )
            self.assertEqual(rc2, 0, err2)
            self.assertEqual(r2["updatedSlugs"], ["ocr-cmd-target"])
            self.assertIn("ocr-map-target", r2["skippedSlugs"])

            # Re-running skips all already-backfilled notes
            rc3, r3, _ = _run_cli_json(
                ["--state-file", str(state_path), "ocr-backfill", "--ocr-cmd", ocr_cmd]
            )
            self.assertEqual(rc3, 0)
            self.assertEqual(r3["updatedCount"], 0)

            after = json.loads(state_path.read_text(encoding="utf-8"))
            note_a = next(n for n in after["notes"] if n["id"] == "note-ocr-map")
            note_b = next(n for n in after["notes"] if n["id"] == "note-ocr-cmd")
            self.assertEqual(note_a["quote"], "Extracted quote from map JSON.")
            self.assertTrue(note_a["meta"]["ocrBackfilled"])
            self.assertEqual(note_b["quote"], "OCR_CMD:scan_b.webp")
            self.assertTrue(note_b["meta"]["ocrBackfilled"])
            # Local StateFileBackend files must NEVER be deleted during OCR backfill
            self.assertTrue(img_a.exists())
            self.assertTrue(img_b.exists())

            # Malformed or non-object --ocr-map-json returns clean non-zero CliError
            bad_json_map = tmp_dir / "bad_map.json"
            bad_json_map.write_text("{not valid json", encoding="utf-8")
            rc_bad_json, bad_json_err, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "ocr-backfill",
                    "--ocr-map-json",
                    str(bad_json_map),
                ]
            )
            self.assertNotEqual(rc_bad_json, 0)
            self.assertIn("Invalid OCR map JSON", bad_json_err.get("error", ""))

            arr_map = tmp_dir / "arr_map.json"
            arr_map.write_text("[]", encoding="utf-8")
            rc_arr_map, arr_err, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "ocr-backfill",
                    "--ocr-map-json",
                    str(arr_map),
                ]
            )
            self.assertNotEqual(rc_arr_map, 0)
            self.assertIn("must be an object", arr_err.get("error", ""))

    def test_export_md_idempotency_clean_when_do_and_incremental_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            state_path = tmp_dir / "state.json"
            out_dir = tmp_dir / "vault"
            state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")

            # Run 1: exports ONLY the 2 atomic notes
            rc1, r1, err1 = _run_cli_json(
                ["--state-file", str(state_path), "export-md", "--output-dir", str(out_dir)]
            )
            self.assertEqual(rc1, 0, err1)
            self.assertEqual(r1["exportedCount"], 2)
            md_path = out_dir / "delays-in-feedback-loops.md"
            self.assertTrue(md_path.exists())
            self.assertFalse((out_dir / "memory-prism-digital-remembrance.md").exists())
            md_text = md_path.read_text(encoding="utf-8")
            self.assertIn("- **WHEN** deploy latency spikes", md_text)
            self.assertIn("- **DO** wait 24h before tuning knobs", md_text)
            self.assertNotIn("WHEN WHEN", md_text)
            self.assertNotIn("DO DO", md_text)
            self.assertIn("[[playing-with-boundaries]]", md_text)

            # exportedAt stamped without updatedAt > exportedAt
            state_after_1 = json.loads(state_path.read_text(encoding="utf-8"))
            exported_note = next(n for n in state_after_1["notes"] if n["id"] == "note-old-atomic")
            self.assertTrue(exported_note["meta"].get("exportedAt"))
            self.assertFalse(pragya_cli._needs_md_export(exported_note))

            # Run 2: completely idempotent (0 files exported)
            rc2, r2, _ = _run_cli_json(
                ["--state-file", str(state_path), "export-md", "--output-dir", str(out_dir)]
            )
            self.assertEqual(rc2, 0)
            self.assertEqual(r2["exportedCount"], 0)

            # Mutate ONLY 1 atomic note so updatedAt > exportedAt -> re-exports ONLY that 1 note
            future_iso = (
                (datetime.now(timezone.utc) + timedelta(minutes=5))
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
            exported_note["updatedAt"] = future_iso
            exported_note["takeaway"] = "Updated takeaway after export."
            state_path.write_text(json.dumps(state_after_1), encoding="utf-8")

            rc3, r3, _ = _run_cli_json(
                ["--state-file", str(state_path), "export-md", "--output-dir", str(out_dir)]
            )
            self.assertEqual(rc3, 0)
            self.assertEqual(r3["exportedCount"], 1)
            self.assertEqual(r3["exportedFiles"], [str(md_path)])
            self.assertIn("Updated takeaway after export.", md_path.read_text(encoding="utf-8"))

            # Path-traversal slugs (../../outside-secret, /tmp/evil) stay strictly inside out_dir
            trav_state = json.loads(state_path.read_text(encoding="utf-8"))
            for idx, bad_slug in enumerate(("../../outside-secret", "/tmp/evil-pragya-test")):
                trav_note = copy.deepcopy(trav_state["notes"][0])
                trav_note["id"] = f"note-traversal-{idx}"
                trav_note["slug"] = bad_slug
                trav_note["status"] = "atomic"
                trav_note["meta"].pop("exportedAt", None)
                trav_state["notes"].append(trav_note)
            state_path.write_text(json.dumps(trav_state), encoding="utf-8")

            rc4, r4, err4 = _run_cli_json(
                ["--state-file", str(state_path), "export-md", "--output-dir", str(out_dir)]
            )
            self.assertEqual(rc4, 0, err4)
            self.assertEqual(r4["exportedCount"], 2)
            out_dir_resolved = out_dir.resolve()
            for exported_file in r4["exportedFiles"]:
                self.assertTrue(Path(exported_file).resolve().is_relative_to(out_dir_resolved))
            self.assertFalse((tmp_dir / "outside-secret.md").exists())
            self.assertFalse(Path("/tmp/evil-pragya-test.md").exists())

    def test_book_doc_sync_preserves_doc_url_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            state_path = tmp_dir / "state.json"
            doc_out = tmp_dir / "systems-doc.md"
            state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")

            rc1, r1, err1 = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "book-doc-sync",
                    "--book",
                    "Thinking in Systems",
                    "--doc-out",
                    str(doc_out),
                ]
            )
            self.assertEqual(rc1, 0, err1)
            self.assertTrue(r1["createdDoc"])
            # Batch 6 (A1.1): saved notes are now synced too — book-systems has 2 atomic +
            # 2 saved notes in _make_sample_snapshot (pm_plan said 5; the fixture has 4).
            self.assertEqual(r1["syncedNoteCount"], 4)
            doc_url = r1["docUrl"]
            self.assertIn("docs.google.com/document/d/", doc_url)
            doc_txt = doc_out.read_text(encoding="utf-8")
            self.assertIn("WHEN deploy latency spikes", doc_txt)
            self.assertNotIn("WHEN WHEN", doc_txt)
            self.assertNotIn("DO DO", doc_txt)

            # Run 2: preserves docUrl, zero duplicate Doc, 0 new synced notes
            rc2, r2, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "book-doc-sync",
                    "--book",
                    "book-systems",
                    "--doc-out",
                    str(doc_out),
                ]
            )
            self.assertEqual(rc2, 0)
            self.assertFalse(r2["createdDoc"])
            self.assertEqual(r2["docUrl"], doc_url)
            self.assertEqual(r2["syncedNoteCount"], 0)

    def test_google_workspace_backend_a1_uuid_lookup_data_payload_and_both_entrypoints(self):
        snap = _make_sample_snapshot()
        book_rows = [pragya_cli.BOOKS_HEADERS] + [pragya_cli.book_to_row(b) for b in snap["books"]]
        # Prepend two unrelated notes so target note is on row 4 in Notes!A:A
        other_a = copy.deepcopy(snap["notes"][0])
        other_a["id"] = "filler-row-2"
        other_a["slug"] = "filler-row-2"
        other_b = copy.deepcopy(snap["notes"][0])
        other_b["id"] = "filler-row-3"
        other_b["slug"] = "filler-row-3"
        target_note = copy.deepcopy(snap["notes"][1])
        notes_rows = [pragya_cli.NOTES_HEADERS] + [
            pragya_cli.note_to_row(n) for n in (other_a, other_b, target_note)
        ]
        sessions_rows = [pragya_cli.SESSIONS_HEADERS] + [
            pragya_cli.session_to_row(s) for s in snap["sessions"]
        ]
        logs_rows = [pragya_cli.DELTA_LOGS_HEADERS]

        batch_ops_seen: list[list[dict]] = []
        created_doc_calls: list[list[str]] = []
        appended_doc_calls: list[list[str]] = []
        added_sheets: list[str] = []
        downloaded_drive_ids: list[str] = []

        downloaded_dests: list[Path] = []
        fail_drive_download = False
        gdoc_read_payload: dict = {"text": ""}

        def fake_runner(cmd: list[str]) -> tuple[int, str, str]:
            if cmd[:3] == ["gsheets", "readonly", "list"]:
                return 0, json.dumps([{"id": "sheet-live-99", "name": "Pragya Commonplace"}]), ""
            if cmd[:3] == ["gsheets", "readonly", "list-sheets"]:
                # Omit DeltaLogs until add-sheet creates it to test schema auto-repair
                titles = ["Books", "Notes", "Sessions"] + (["DeltaLogs"] if "DeltaLogs" in added_sheets else [])
                return 0, _fake_list_sheets_payload(titles), ""
            if cmd[:3] == ["gsheets", "mutate", "add-sheet"]:
                added_sheets.append(cmd[cmd.index("--title") + 1])
                return 0, json.dumps({"ok": True}), ""
            if cmd[:3] == ["gsheets", "readonly", "read"]:
                rng = cmd[4]
                if rng == "Books!A1:L1":
                    return 0, json.dumps({"values": [pragya_cli.BOOKS_HEADERS]}), ""
                if rng == "Notes!A1:R1":
                    return 0, json.dumps({"values": [pragya_cli.NOTES_HEADERS]}), ""
                if rng == "Sessions!A1:G1":
                    return 0, json.dumps({"values": [pragya_cli.SESSIONS_HEADERS]}), ""
                if rng == "DeltaLogs!A1:E1":
                    vals = [pragya_cli.DELTA_LOGS_HEADERS] if len(batch_ops_seen) > 0 else []
                    return 0, json.dumps({"values": vals}), ""
                if rng == "Books!A:L":
                    return 0, json.dumps({"values": book_rows}), ""
                if rng == "Notes!A:R":
                    return 0, json.dumps({"values": notes_rows}), ""
                if rng == "Sessions!A:G":
                    return 0, json.dumps({"values": sessions_rows}), ""
                if rng == "DeltaLogs!A:E":
                    return 0, json.dumps({"values": logs_rows}), ""
                if rng == "Notes!A:A":
                    return 0, json.dumps({"values": [[r[0]] for r in notes_rows]}), ""
                if rng == "Books!A:A":
                    return 0, json.dumps({"values": [[r[0]] for r in book_rows]}), ""
                if rng == "Sessions!A:A":
                    return 0, json.dumps({"values": [[r[0]] for r in sessions_rows]}), ""
                if rng == "DeltaLogs!A:A":
                    return 0, json.dumps({"values": [[r[0]] for r in logs_rows]}), ""
                single = _single_cell_lookup(
                    rng,
                    {"Books": book_rows, "Notes": notes_rows, "Sessions": sessions_rows, "DeltaLogs": logs_rows},
                )
                if single is not None:
                    return 0, json.dumps({"values": single}), ""
            if cmd[:3] == ["gsheets", "mutate", "raw-batch"]:
                batch_file = Path(cmd[cmd.index("-f") + 1])
                ops = _decode_raw_batch(json.loads(batch_file.read_text(encoding="utf-8")))
                batch_ops_seen.append(ops)
                return 0, json.dumps({"replies": []}), ""
            if cmd[:3] == ["gdrive", "readonly", "search"]:
                return 0, json.dumps({"files": [{"id": "media-folder-1", "trashed": False}]}), ""
            if cmd[:3] == ["gdrive", "mutate", "upload"]:
                return 0, json.dumps({"id": "drive-file-777"}), ""
            if cmd[:3] == ["gdrive", "readonly", "download"]:
                downloaded_drive_ids.append(cmd[3])
                dest = Path(cmd[cmd.index("-o") + 1])
                downloaded_dests.append(dest)
                if fail_drive_download:
                    return 1, "", "Simulated download failure"
                dest.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
                return 0, "", ""
            if cmd[:3] == ["gdocs", "mutate", "create"]:
                created_doc_calls.append(cmd)
                return 0, json.dumps({"documentId": "doc-live-555"}), ""
            if cmd[:3] == ["gdocs", "mutate", "batch"]:
                batch_file = Path(cmd[cmd.index("-f") + 1])
                ops = json.loads(batch_file.read_text(encoding="utf-8"))
                appended_doc_calls.append(ops)
                return 0, json.dumps({"ok": True}), ""
            if cmd[:3] == ["gdocs", "readonly", "read"]:
                return 0, json.dumps(gdoc_read_payload), ""
            return 1, "", f"Unexpected command: {cmd}"

        # 1. reflect --stage commit on note at row 4 repairs missing DeltaLogs tab and issues "op": "write" at Notes!A4:R4 with "data"
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc_ref = pragya_cli.main(
                [
                    "reflect",
                    "--note",
                    "memory-prism-digital-remembrance",
                    "--stage",
                    "commit",
                    "--context",
                    "Mock live context",
                    "--trigger",
                    "WHEN WHEN live trigger",
                    "--action",
                    "DO DO live action",
                    "--delta-status",
                    "active",
                ],
                runner=fake_runner,
            )
        self.assertEqual(rc_ref, 0)
        self.assertEqual(added_sheets, ["DeltaLogs"])
        header_repair_op = batch_ops_seen[0][0]
        self.assertEqual(header_repair_op["op"], "write")
        self.assertEqual(header_repair_op["range"], "DeltaLogs!A1:E1")
        self.assertIn("data", header_repair_op)

        write_op = batch_ops_seen[1][0]
        self.assertEqual(write_op["op"], "write")
        self.assertEqual(write_op["range"], "Notes!A4:R4")
        self.assertIn("data", write_op)
        self.assertNotIn("values", write_op)
        self.assertEqual(write_op["data"][0][14], "live trigger")
        self.assertEqual(write_op["data"][0][15], "live action")

        # 2. capture new note must upload image via gdrive and issue "op": "append" with "data"
        with tempfile.TemporaryDirectory() as tmp:
            img_path = Path(tmp) / "live.webp"
            img_path.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
            with contextlib.redirect_stdout(io.StringIO()):
                rc_cap = pragya_cli.main(
                    [
                        "capture",
                        "--book",
                        "book-systems",
                        "--pos",
                        "160",
                        "--takeaway",
                        "Live capture test",
                        "--image",
                        str(img_path),
                    ],
                    runner=fake_runner,
                )
            self.assertEqual(rc_cap, 0)
            note_append_op = batch_ops_seen[2][0]
            self.assertEqual(note_append_op["op"], "append")
            self.assertEqual(note_append_op["range"], "Notes!A1")
            self.assertIn("data", note_append_op)
            self.assertNotIn("values", note_append_op)
            meta_json = json.loads(note_append_op["data"][0][17])
            self.assertEqual(meta_json["attachments"][0]["driveFileId"], "drive-file-777")

            # Add captured image note into Notes!A:R; test temp cleanup on failed download AND successful download
            captured_row = list(note_append_op["data"][0])
            notes_rows.append(captured_row)
            ocr_cmd = f"{sys.executable} -c \"import os,sys; print('DRIVE_OCR:' + str(os.path.exists(sys.argv[1])))\" {{path}}"

            fail_drive_download = True
            with contextlib.redirect_stderr(io.StringIO()):
                rc_ocr_fail = pragya_cli.main(
                    ["ocr-backfill", "--note", str(captured_row[0]), "--ocr-cmd", ocr_cmd],
                    runner=fake_runner,
                )
            self.assertNotEqual(rc_ocr_fail, 0)
            self.assertFalse(downloaded_dests[-1].exists())

            fail_drive_download = False
            ocr_out = io.StringIO()
            with contextlib.redirect_stdout(ocr_out):
                rc_ocr = pragya_cli.main(
                    ["ocr-backfill", "--note", str(captured_row[0]), "--ocr-cmd", ocr_cmd],
                    runner=fake_runner,
                )
            self.assertEqual(rc_ocr, 0)
            self.assertEqual(downloaded_drive_ids, ["drive-file-777", "drive-file-777"])
            self.assertIn("live-capture-test", json.loads(ocr_out.getvalue())["updatedSlugs"])
            self.assertFalse(downloaded_dests[-1].exists())

            # 3. book-doc-sync creates Companion Doc via gdocs and writes docUrl back to Books!A2:L2
            with contextlib.redirect_stdout(io.StringIO()):
                rc_doc = pragya_cli.main(
                    ["book-doc-sync", "--book", "book-systems"],
                    runner=fake_runner,
                )
            self.assertEqual(rc_doc, 0)
            self.assertEqual(len(created_doc_calls), 1)
            self.assertEqual(len(appended_doc_calls), 1)
            gdoc_ops = appended_doc_calls[0]
            self.assertTrue(any(op.get("op") == "heading" and op.get("level") == "1" for op in gdoc_ops))
            self.assertTrue(any(op.get("op") == "heading" and op.get("level") == "2" for op in gdoc_ops))
            self.assertTrue(any(op.get("op") == "append" for op in gdoc_ops))

            # Update Books row with created docUrl and test Google Docs split-run + tabs AST detection
            book_rows[1][10] = "https://docs.google.com/document/d/doc-live-555/edit"
            gdoc_read_payload = {
                "body": {
                    "content": [
                        {
                            "paragraph": {
                                "elements": [
                                    {"textRun": {"content": "## Entry 1 (p. 142) [no"}},
                                    {"textRun": {"content": "te:filler-row-2]\n"}},
                                ]
                            }
                        }
                    ]
                },
                "tabs": [
                    {
                        "documentTab": {
                            "body": {
                                "content": [
                                    {
                                        "paragraph": {
                                            "elements": [
                                                {"textRun": {"content": "## Entry 2 (p. 210) [no"}},
                                                {"textRun": {"content": "te:filler-row-3]\n"}},
                                            ]
                                        }
                                    }
                                ]
                            }
                        }
                    }
                ],
            }
            doc_sync_2_out = io.StringIO()
            with contextlib.redirect_stdout(doc_sync_2_out):
                rc_doc_2 = pragya_cli.main(
                    ["book-doc-sync", "--book", "book-systems"],
                    runner=fake_runner,
                )
            self.assertEqual(rc_doc_2, 0)
            res_doc_2 = json.loads(doc_sync_2_out.getvalue())
            self.assertFalse(res_doc_2["createdDoc"])
            # Batch 6: this AST (body + a differing tab, no indexes) can't be edited in place,
            # so the sync falls back to append-only by marker: the two marker-bearing notes
            # are not re-added, saved notes now in the timeline are appended, no new Doc and
            # no second H1.
            self.assertEqual(res_doc_2["mode"], "append-fallback")
            self.assertTrue(res_doc_2["warnings"])
            # Both book-systems timeline notes (filler-row-2/3) already carry markers and the
            # captured p. 160 note is ahead of the static p. 142 bookmark (shielded), so the
            # fallback appends nothing: exactly zero synced notes and no new gdocs batch.
            self.assertEqual(res_doc_2["syncedNoteIds"], [])
            self.assertEqual(res_doc_2["shieldedCount"], 1)
            self.assertEqual(len(created_doc_calls), 1)
            self.assertEqual(len(appended_doc_calls), 1)

            # 4. Both scripts/pragya_cli.py and .agents/skills/.../pragya_cli.py work from arbitrary CWD
            state_path = Path(tmp) / "cwd_state.json"
            state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")
            rc_a, out_a, err_a = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "recall",
                    "--mode",
                    "shuffle",
                    "--date",
                    "2026-11-15",
                ],
                cwd=Path(tmp),
                executable=CLI_PATH,
            )
            rc_b, out_b, err_b = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "recall",
                    "--mode",
                    "shuffle",
                    "--date",
                    "2026-11-15",
                ],
                cwd=Path(tmp),
                executable=SKILL_CLI_PATH,
            )
            self.assertEqual(rc_a, 0, err_a)
            self.assertEqual(rc_b, 0, err_b)
            self.assertEqual(out_a, out_b)

    def test_m4_mark_reviewed_preserves_updated_at_and_capture_clamps_pos(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            snap = _make_sample_snapshot()
            snap["books"].append(
                {
                    "id": "book-pct",
                    "title": "Percent Reader",
                    "author": "Test Author",
                    "format": "ebook",
                    "kind": "nonfiction",
                    "status": "reading",
                    "currentPos": 15,
                    "totalPos": 100,
                    "posUnit": "percent",
                    "normalizedPos": 0.15,
                    "docUrl": "",
                    "meta": {"updatedAt": "2026-11-10T08:00:00Z"},
                }
            )
            state_path = Path(tmp) / "m4_state.json"
            state_path.write_text(json.dumps(snap, indent=2), encoding="utf-8")

            # Export first so exportedAt >= updatedAt
            md_dir = Path(tmp) / "notes_md"
            rc_exp1, res_exp1, err1 = _run_cli_json(
                ["--state-file", str(state_path), "export-md", "--output-dir", str(md_dir)]
            )
            self.assertEqual(rc_exp1, 0, err1)
            self.assertGreaterEqual(res_exp1["exportedCount"], 1)

            before_data = json.loads(state_path.read_text(encoding="utf-8"))
            before_note = next(
                n for n in before_data["notes"] if n["slug"] == "delays-in-feedback-loops"
            )

            # Mark reviewed: stamps lastReviewedAt WITHOUT bumping updatedAt
            rc_rev, res_rev, err_rev = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "recall",
                    "--mode",
                    "shuffle",
                    "--mark-reviewed",
                    "delays-in-feedback-loops",
                    "--date",
                    "2026-11-16",
                ]
            )
            self.assertEqual(rc_rev, 0, err_rev)
            self.assertEqual(res_rev["markedReviewed"], "delays-in-feedback-loops")

            after_data = json.loads(state_path.read_text(encoding="utf-8"))
            after_note = next(
                n for n in after_data["notes"] if n["slug"] == "delays-in-feedback-loops"
            )
            self.assertEqual(after_note["updatedAt"], before_note["updatedAt"])
            self.assertEqual(after_note["meta"]["lastReviewedAt"], "2026-11-16")

            # Subsequent export-md skips the reviewed note
            rc_exp2, res_exp2, err2 = _run_cli_json(
                ["--state-file", str(state_path), "export-md", "--output-dir", str(md_dir)]
            )
            self.assertEqual(rc_exp2, 0, err2)
            self.assertEqual(res_exp2["exportedCount"], 0)

            # Capture clamps pos into [0, totalPos] and [0, 100] for percent books
            rc_cap_page, res_cap_page, err_cp = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "capture",
                    "--book",
                    "book-systems",
                    "--pos",
                    "9999",
                    "--takeaway",
                    "Over-range page clamp",
                ]
            )
            self.assertEqual(rc_cap_page, 0, err_cp)
            self.assertEqual(res_cap_page["note"]["pos"], 218)
            self.assertEqual(res_cap_page["note"]["normalizedPos"], 1.0)

            rc_cap_pct, res_cap_pct, err_pct = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "capture",
                    "--book",
                    "book-pct",
                    "--pos",
                    "145",
                    "--takeaway",
                    "Over-range percent clamp",
                ]
            )
            self.assertEqual(rc_cap_pct, 0, err_pct)
            self.assertEqual(res_cap_pct["note"]["pos"], 100)
            self.assertEqual(res_cap_pct["note"]["normalizedPos"], 1.0)

    def test_m4_live_unformatted_value_and_row_conflict_guard_with_force(self) -> None:
        snap = _make_sample_snapshot()
        book_rows = [pragya_cli.BOOKS_HEADERS] + [pragya_cli.book_to_row(b) for b in snap["books"]]
        notes_rows = [pragya_cli.NOTES_HEADERS] + [pragya_cli.note_to_row(n) for n in snap["notes"]]
        sessions_rows = [pragya_cli.SESSIONS_HEADERS] + [
            pragya_cli.session_to_row(s) for s in snap["sessions"]
        ]
        logs_rows = [pragya_cli.DELTA_LOGS_HEADERS] + [
            pragya_cli.delta_log_to_row(dl) for dl in snap["deltaLogs"]
        ]

        seen_read_cmds: list[list[str]] = []
        batch_calls: list[list[dict[str, object]]] = []
        bump_remote_on_conflict_read = False

        def fake_runner(cmd: list[str]) -> tuple[int, str, str]:
            if cmd[:3] == ["gsheets", "readonly", "list"]:
                return 0, json.dumps({"files": [{"id": "sid-m4", "name": "Pragya Commonplace"}]}), ""
            if cmd[:3] == ["gsheets", "readonly", "list-sheets"]:
                return (
                    0,
                    json.dumps(
                        {
                            "sheets": [
                                {"properties": {"title": t, "sheetId": FAKE_SHEET_IDS[t]}}
                                for t in ("Books", "Notes", "Sessions", "DeltaLogs")
                            ]
                        }
                    ),
                    "",
                )
            if cmd[:3] == ["gsheets", "readonly", "read"]:
                seen_read_cmds.append(list(cmd))
                rng = cmd[4]
                if rng == "Books!A1:L1":
                    return 0, json.dumps({"values": [pragya_cli.BOOKS_HEADERS]}), ""
                if rng == "Notes!A1:R1":
                    return 0, json.dumps({"values": [pragya_cli.NOTES_HEADERS]}), ""
                if rng == "Sessions!A1:G1":
                    return 0, json.dumps({"values": [pragya_cli.SESSIONS_HEADERS]}), ""
                if rng == "DeltaLogs!A1:E1":
                    return 0, json.dumps({"values": [pragya_cli.DELTA_LOGS_HEADERS]}), ""
                if rng == "Books!A:L":
                    return 0, json.dumps({"values": book_rows}), ""
                if rng == "Notes!A:R":
                    if bump_remote_on_conflict_read:
                        # Simulate another client updating row 2 right before save
                        notes_rows[1][4] = "2099-01-01T00:00:00Z"
                    return 0, json.dumps({"values": notes_rows}), ""
                if rng == "Sessions!A:G":
                    return 0, json.dumps({"values": sessions_rows}), ""
                if rng == "DeltaLogs!A:E":
                    return 0, json.dumps({"values": logs_rows}), ""
                if rng == "Notes!A:A":
                    return 0, json.dumps({"values": [[r[0]] for r in notes_rows]}), ""
                single = _single_cell_lookup(rng, {"Notes": notes_rows, "Books": book_rows})
                if single is not None:
                    return 0, json.dumps({"values": single}), ""
            if cmd[:3] == ["gsheets", "mutate", "raw-batch"]:
                f_idx = cmd.index("-f")
                payload = json.loads(Path(cmd[f_idx + 1]).read_text(encoding="utf-8"))
                batch_calls.append(_decode_raw_batch(payload))
                return 0, json.dumps({"updated": True}), ""
            return 1, "", f"Unexpected command: {cmd}"

        backend = pragya_cli.GoogleWorkspaceBackend(runner=fake_runner)
        ws = backend.load_workspace()
        self.assertTrue(
            all(
                cmd[5:7] == ["--value-render-option", "UNFORMATTED_VALUE"]
                for cmd in seen_read_cmds
            ),
            f"All _read_range calls must request UNFORMATTED_VALUE: {seen_read_cmds}",
        )

        target_note = dict(ws["notes"][0])
        base_ts = target_note["updatedAt"]
        target_note["takeaway"] = "Stale edit"
        target_note["updatedAt"] = "2026-11-16T00:00:00Z"

        # Remote updatedAt becomes newer before save -> abort BEFORE batch write
        bump_remote_on_conflict_read = True
        with self.assertRaises(pragya_cli.CliError) as ctx:
            backend.save_note(target_note, expected_base_updated_at=base_ts, force=False)
        self.assertIn("Row conflict", str(ctx.exception))
        self.assertEqual(len(batch_calls), 0)

        # With force=True (mirrors CLI --force), write proceeds
        backend.save_note(target_note, expected_base_updated_at=base_ts, force=True)
        self.assertEqual(len(batch_calls), 1)
        self.assertEqual(batch_calls[0][0]["op"], "write")

        # Numeric Sheets serial date (46342.5 = 2026-11-16T12:00:00Z) compares accurately
        self.assertTrue(pragya_cli._is_remote_newer(46342.5, "2026-11-15T12:00:00Z"))
        self.assertFalse(pragya_cli._is_remote_newer(46340.5, "2026-11-15T12:00:00Z"))
        self.assertFalse(pragya_cli._is_remote_newer("not-a-date", "2026-11-15T12:00:00Z"))

    def test_paused_book_resumes_to_reading_on_bookmark_advance(self) -> None:
        paused_book = {
            "id": "book-paused",
            "title": "Paused Book",
            "author": "Author",
            "format": "physical",
            "kind": "nonfiction",
            "status": "paused",
            "currentPos": 30,
            "totalPos": 200,
            "posUnit": "page",
            "normalizedPos": 0.15,
            "docUrl": "",
            "meta": {},
        }
        updated, changed, rejected, prev_pos, next_pos = pragya_cli.apply_bookmark_advance(
            paused_book, 45, now_iso="2026-11-16T12:00:00Z"
        )
        self.assertTrue(changed)
        self.assertFalse(rejected)
        self.assertEqual(prev_pos, 30)
        self.assertEqual(next_pos, 45)
        self.assertEqual(updated["status"], "reading")
        self.assertEqual(updated["meta"]["startedAt"], "2026-11-16T12:00:00Z")

    def test_m5_book_list_add_update_and_progress_primitives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            state_path = tmp_dir / "state.json"
            snap = _make_sample_snapshot()
            state_path.write_text(json.dumps(snap), encoding="utf-8")

            # 1. book-list filters & activeDeltaCount
            rc, r_list, err = _run_cli_json(
                ["--state-file", str(state_path), "book-list", "--kind", "nonfiction", "--query", "systems"]
            )
            self.assertEqual(rc, 0, err)
            self.assertEqual(r_list["count"], 1)
            self.assertEqual(r_list["activeDeltaCount"], 1)
            self.assertEqual(r_list["books"][0]["id"], "book-systems")

            # 2. book-add defaults, URL safety, duplicate guard & NO synthetic session
            sessions_before = len(json.loads(state_path.read_text(encoding="utf-8"))["sessions"])
            rc_bad_url, err_url, _ = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "book-add",
                    "--title",
                    "Bad URL Book",
                    "--doc-url",
                    "javascript:alert(1)",
                ]
            )
            self.assertNotEqual(rc_bad_url, 0)
            self.assertIn("unsafe", err_url.get("error", "").lower())

            rc_neg, _, _ = _run_cli_json(
                ["--state-file", str(state_path), "book-add", "--title", "Neg", "--pos", "-5"]
            )
            self.assertNotEqual(rc_neg, 0)

            rc_add, r_add, err_add = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "book-add",
                    "--title",
                    "The Creative Act",
                    "--format",
                    "kindle",
                    "--pos-unit",
                    "percent",
                    "--pos",
                    "25",
                ]
            )
            self.assertEqual(rc_add, 0, err_add)
            new_book = r_add["book"]
            self.assertEqual(new_book["author"], "Unknown Author")
            self.assertEqual(new_book["totalPos"], 100)
            self.assertEqual(new_book["normalizedPos"], 0.25)
            self.assertEqual(
                len(json.loads(state_path.read_text(encoding="utf-8"))["sessions"]),
                sessions_before,
            )

            # Duplicate normalized title rejected unless --allow-duplicate
            rc_dup, _, _ = _run_cli_json(
                ["--state-file", str(state_path), "book-add", "--title", "  the   creative act "]
            )
            self.assertNotEqual(rc_dup, 0)
            rc_dup_ok, _, err_dup_ok = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "book-add",
                    "--title",
                    "The Creative Act",
                    "--status",
                    "finished",
                    "--allow-duplicate",
                ]
            )
            self.assertEqual(rc_dup_ok, 0, err_dup_ok)
            state_after_dup = json.loads(state_path.read_text(encoding="utf-8"))
            fin_copy = state_after_dup["books"][-1]
            self.assertEqual(fin_copy["normalizedPos"], 1.0)
            self.assertTrue(fin_copy["meta"].get("finishedAt"))

            # 3. book-update validation, monotonic guard, fiction prediction unlock & conflict guard
            rc_empty_upd, _, _ = _run_cli_json(
                ["--state-file", str(state_path), "book-update", "--book", "book-systems"]
            )
            self.assertNotEqual(rc_empty_upd, 0)

            rc_back_upd, _, _ = _run_cli_json(
                ["--state-file", str(state_path), "book-update", "--book", "book-systems", "--pos", "10"]
            )
            self.assertNotEqual(rc_back_upd, 0)

            rc_upd, r_upd, err_upd = _run_cli_json(
                ["--state-file", str(state_path), "book-update", "--book", "book-exhalation", "--status", "finished"]
            )
            self.assertEqual(rc_upd, 0, err_upd)
            self.assertEqual(r_upd["book"]["normalizedPos"], 1.0)
            self.assertTrue(r_upd["book"]["meta"].get("finishedAt"))
            self.assertEqual(r_upd["unlockedPredictionsCount"], 1)

            # Pre-write updatedAt row conflict guard on book-update
            stale_backend = pragya_cli.StateFileBackend(state_path)
            loaded_ws = stale_backend.load_workspace()
            stale_book = copy.deepcopy(next(b for b in loaded_ws["books"] if b["id"] == "book-systems"))
            stale_book["meta"]["updatedAt"] = "2020-01-01T00:00:00.000Z"
            with self.assertRaises(pragya_cli.CliError) as ctx_conflict:
                stale_backend.save_book(
                    stale_book,
                    expected_base_updated_at="2020-01-01T00:00:00.000Z",
                    force=False,
                )
            self.assertIn("Row conflict", str(ctx_conflict.exception))

            # 4. progress: queued/paused resume, negative/backward guard without mutation, 30-min coalescing & idempotent no-op
            rc_neg_prog, _, _ = _run_cli_json(
                ["--state-file", str(state_path), "progress", "--book", new_book["id"], "--delta", "-50"]
            )
            self.assertNotEqual(rc_neg_prog, 0)
            rc_back_prog, _, _ = _run_cli_json(
                ["--state-file", str(state_path), "progress", "--book", new_book["id"], "--pos", "10"]
            )
            self.assertNotEqual(rc_back_prog, 0)
            self.assertEqual(
                len(json.loads(state_path.read_text(encoding="utf-8"))["sessions"]),
                sessions_before,
            )

            # First advance creates session
            rc_p1, r_p1, err_p1 = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "progress",
                    "--book",
                    new_book["id"],
                    "--delta",
                    "10",
                    "--session-note",
                    "First read",
                ]
            )
            self.assertEqual(rc_p1, 0, err_p1)
            self.assertTrue(r_p1["bookmarkChanged"])
            self.assertFalse(r_p1["coalesced"])
            self.assertEqual(r_p1["book"]["currentPos"], 35)

            # Second advance within 30 mins coalesces
            rc_p2, r_p2, err_p2 = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "progress",
                    "--book",
                    new_book["id"],
                    "--pos",
                    "50",
                ]
            )
            self.assertEqual(rc_p2, 0, err_p2)
            self.assertTrue(r_p2["bookmarkChanged"])
            self.assertTrue(r_p2["coalesced"])
            self.assertEqual(r_p2["session"]["endPos"], 50)

            # Idempotent no-op when pos == currentPos and not --finish
            rc_noop, r_noop, err_noop = _run_cli_json(
                ["--state-file", str(state_path), "progress", "--book", new_book["id"], "--pos", "50"]
            )
            self.assertEqual(rc_noop, 0, err_noop)
            self.assertFalse(r_noop["bookmarkChanged"])
            self.assertIsNone(r_noop["session"])

            # --finish updates status='finished' and normalizedPos=1.0
            rc_fin, r_fin, err_fin = _run_cli_json(
                ["--state-file", str(state_path), "progress", "--book", new_book["id"], "--finish"]
            )
            self.assertEqual(rc_fin, 0, err_fin)
            self.assertEqual(r_fin["book"]["status"], "finished")
            self.assertEqual(r_fin["book"]["normalizedPos"], 1.0)
            self.assertTrue(r_fin["finished"])

    def test_m5_conversation_first_capture_atomic_reflect_overrides_and_missing_cli_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            state_path = tmp_dir / "state.json"
            img_path = tmp_dir / "page.webp"
            img_path.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
            state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")

            # 1. Optional --pos uses book currentPos without creating synthetic session
            sessions_before = len(json.loads(state_path.read_text(encoding="utf-8"))["sessions"])
            rc_cap, r_cap, err_cap = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "capture",
                    "--book",
                    "book-systems",
                    "--slug",
                    "custom-lag-note",
                    "--title",
                    "Respecting Lag",
                    "--takeaway",
                    "Wait out lag before retuning.",
                    "--context",
                    "Delays destabilize high-gain loops.",
                    "--critique",
                    "Unsafe during exponential cascades.",
                    "--trigger",
                    "WHEN deploy metrics wobble",
                    "--action",
                    "DO wait one full cycle",
                    "--delta-status",
                    "active",
                    "--atomic",
                ]
            )
            self.assertEqual(rc_cap, 0, err_cap)
            note = r_cap["note"]
            self.assertEqual(note["slug"], "custom-lag-note")
            self.assertEqual(note["pos"], 142)
            self.assertEqual(note["status"], "atomic")
            self.assertEqual(note["deltaTrigger"], "deploy metrics wobble")
            self.assertEqual(note["deltaAction"], "wait one full cycle")
            self.assertEqual(note["deltaStatus"], "active")
            self.assertFalse(r_cap["bookmarkChanged"])
            self.assertIsNone(r_cap["session"])
            self.assertEqual(
                len(json.loads(state_path.read_text(encoding="utf-8"))["sessions"]),
                sessions_before,
            )

            # Directly captured atomic note exports & syncs to companion doc cleanly
            out_dir = tmp_dir / "md_out"
            rc_exp, r_exp, err_exp = _run_cli_json(
                ["--state-file", str(state_path), "export-md", "--output-dir", str(out_dir)]
            )
            self.assertEqual(rc_exp, 0, err_exp)
            self.assertTrue((out_dir / "custom-lag-note.md").exists())
            doc_out = tmp_dir / "doc.md"
            rc_doc, r_doc, err_doc = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "book-doc-sync",
                    "--book",
                    "book-systems",
                    "--doc-out",
                    str(doc_out),
                ]
            )
            self.assertEqual(rc_doc, 0, err_doc)
            self.assertIn("Respecting Lag", doc_out.read_text(encoding="utf-8"))

            # 2. Pre-upload validation gate: ALL failures must abort BEFORE upload_image runs
            class GuardedUploadBackend(pragya_cli.StateFileBackend):
                def __init__(self, p: Path) -> None:
                    super().__init__(p)
                    self.upload_calls = 0

                def upload_image(self, local_path: Path) -> dict:
                    self.upload_calls += 1
                    return super().upload_image(local_path)

            guarded = GuardedUploadBackend(state_path)
            parser = pragya_cli.build_parser()
            bad_arg_sets = [
                # --spar + --atomic conflict
                ["capture", "--book", "book-systems", "--takeaway", "X", "--spar", "--atomic", "--image", str(img_path)],
                # --delta-status active without --atomic
                ["capture", "--book", "book-systems", "--takeaway", "X", "--delta-status", "active", "--trigger", "t", "--image", str(img_path)],
                # > 3 attachments
                ["capture", "--book", "book-systems", "--takeaway", "X", "--image", str(img_path), "--link", "https://a.com", "--link", "https://b.com", "--link", "https://c.com"],
                # missing image path alongside valid image path
                ["capture", "--book", "book-systems", "--takeaway", "X", "--image", str(img_path), "--image", str(tmp_dir / "missing.webp")],
            ]
            for bad_args in bad_arg_sets:
                with self.assertRaises(pragya_cli.CliError):
                    pragya_cli.cmd_capture(parser.parse_args(bad_args), guarded)
            self.assertEqual(guarded.upload_calls, 0, "upload_image must NOT run when pre-flight validation fails")

            # 3. reflect --stage 1 --q1/--q2 overrides & softened non-fiction defaults
            rc_ref, r_ref, err_ref = _run_cli_json(
                [
                    "--state-file",
                    str(state_path),
                    "reflect",
                    "--note",
                    "memory-prism-digital-remembrance",
                    "--stage",
                    "1",
                    "--q1",
                    "Custom prompt one?",
                    "--q2",
                    "Custom prompt two?",
                ]
            )
            self.assertEqual(rc_ref, 0, err_ref)
            self.assertEqual(
                r_ref["socraticQuestions"],
                ["Custom prompt one?", "Custom prompt two?"],
            )
            nf_qs = pragya_cli._build_socratic_questions(
                {"slug": "memoir-moment", "pos": 12, "meta": {"title": "Grief & Memory"}},
                {"title": "Memoir", "kind": "nonfiction", "posUnit": "page", "currentPos": 50},
            )
            self.assertNotIn("WHEN trigger -> DO action", nf_qs[0])

            # 4. default_cmd_runner wraps FileNotFoundError cleanly into CliError
            with patch("subprocess.run", side_effect=FileNotFoundError("gsheets")):
                with self.assertRaises(pragya_cli.CliError) as ctx_fnf:
                    pragya_cli.default_cmd_runner(["gsheets", "readonly", "list"])
                self.assertIn("Mode B", str(ctx_fnf.exception))
                self.assertIn("--state-file", str(ctx_fnf.exception))

    def test_m5_skill_cli_is_self_contained_and_byte_synced(self) -> None:
        self.assertEqual(
            CLI_PATH.read_bytes(),
            SKILL_CLI_PATH.read_bytes(),
            ".agents/skills/pragya-companion/scripts/pragya_cli.py must be byte-identical to scripts/pragya_cli.py",
        )
        skill_dir = REPO_ROOT / ".agents" / "skills" / "pragya-companion"
        self.assertTrue((skill_dir / "references" / "schema_and_ops.md").is_file())

        # Copy ONLY the skill folder into an isolated temp directory outside the git repo
        with tempfile.TemporaryDirectory() as tmp:
            isolated_skill = Path(tmp) / "pragya-companion"
            shutil.copytree(skill_dir, isolated_skill)
            isolated_cli = isolated_skill / "scripts" / "pragya_cli.py"
            state_path = Path(tmp) / "isolated_state.json"
            state_path.write_text(json.dumps(_make_sample_snapshot()), encoding="utf-8")

            p_help = subprocess.run(
                [sys.executable, str(isolated_cli), "--help"],
                cwd=str(isolated_skill),
                text=True,
                capture_output=True,
            )
            self.assertEqual(p_help.returncode, 0, p_help.stderr)
            self.assertIn("book-add", p_help.stdout)
            self.assertIn("progress", p_help.stdout)

            p_list = subprocess.run(
                [sys.executable, str(isolated_cli), "--state-file", str(state_path), "book-list"],
                cwd=str(tmp),
                text=True,
                capture_output=True,
            )
            self.assertEqual(p_list.returncode, 0, p_list.stderr)
            parsed = json.loads(p_list.stdout)
            self.assertEqual(parsed["count"], 2)

    def test_m5_when_do_word_boundary_normalization(self) -> None:
        self.assertEqual(pragya_cli.normalize_delta_trigger("WHEN WHEN foo"), "foo")
        self.assertEqual(pragya_cli.normalize_delta_trigger("WHEN: foo"), "foo")
        self.assertEqual(
            pragya_cli.normalize_delta_trigger("whenever latency spikes"),
            "whenever latency spikes",
        )
        self.assertEqual(pragya_cli.normalize_delta_trigger("WHEN"), "")

        self.assertEqual(pragya_cli.normalize_delta_action("DO DO bar"), "bar")
        self.assertEqual(pragya_cli.normalize_delta_action("DO: bar"), "bar")
        self.assertEqual(
            pragya_cli.normalize_delta_action("document the failure"),
            "document the failure",
        )
        self.assertEqual(
            pragya_cli.normalize_delta_action("double-check metrics"),
            "double-check metrics",
        )
        self.assertEqual(
            pragya_cli.normalize_delta_action("don't interrupt"),
            "don't interrupt",
        )
        self.assertEqual(pragya_cli.normalize_delta_action("DO"), "")


if __name__ == "__main__":
    unittest.main()

