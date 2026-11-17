"""Opt-in live Google Workspace integration smoke suite for Pragya (M5.7).

Requires connected and authenticated `gsheets`, `gdrive`, and `gdocs` CLIs on PATH,
and must be explicitly enabled via:
  PRAGYA_RUN_LIVE_INTEGRATION=1 python3 -m unittest tests/integration/test_live_workspace.py -v

Creates a temporary scratch Google Spreadsheet, uploads a temporary WebP image to
`Pragya Media`, creates a scratch Google Doc via `book-doc-sync`, verifies
`gsheets mutate batch` handling of formula/operator strings and dates, exercises the
full `pragya_cli.py` roundtrip, and trashes all created scratch artifacts in `finally`.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import pragya_cli  # noqa: E402

# Minimal valid 1x1 lossless WebP (RIFF/WEBP/VP8L), 44 bytes.
TINY_WEBP_BYTES = base64.b64decode(
    "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA="
)


def _run_cli_json(cmd: list[str]) -> Any:
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f"CLI command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
        )
    txt = (proc.stdout or "").strip()
    if not txt:
        return {}
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return {"rawText": txt}


def _extract_values(payload: Any) -> list[list[Any]]:
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, list)]
    if isinstance(payload, dict):
        vals = payload.get("values")
        if isinstance(vals, list):
            return [r for r in vals if isinstance(r, list)]
    return []


def _find_pragya_media_folder() -> str | None:
    res = _run_cli_json(
        [
            "gdrive",
            "readonly",
            "search",
            "--name-exact",
            pragya_cli.MEDIA_FOLDER_NAME,
            "--type",
            "folder",
            "--json",
        ]
    )
    items = res if isinstance(res, list) else res.get("files", [])
    for item in items:
        if isinstance(item, dict) and not item.get("trashed") and item.get("id"):
            return str(item["id"])
    return None


def _rate_limit_safe_runner(cmd: list[str]) -> tuple[int, str, str]:
    import time

    for attempt in range(4):
        rc, out, err = pragya_cli.default_cmd_runner(cmd)
        if rc == 0:
            return rc, out, err
        combined = f"{out}\n{err}"
        if "429" in combined or "RATE_LIMIT_EXCEEDED" in combined or "rateLimitExceeded" in combined:
            if attempt < 3:
                time.sleep(20)
                continue
        return rc, out, err
    return pragya_cli.default_cmd_runner(cmd)


@unittest.skipUnless(
    os.environ.get("PRAGYA_RUN_LIVE_INTEGRATION") == "1",
    "Opt-in live Google Workspace suite (set PRAGYA_RUN_LIVE_INTEGRATION=1 to run).",
)
class LiveWorkspaceIntegrationTests(unittest.TestCase):
    def test_live_gsheets_batch_probe_and_full_cli_roundtrip(self) -> None:
        run_tag = uuid.uuid4().hex[:8]
        scratch_title = f"Pragya Scratch M57 {run_tag}"
        trash_ids: list[str] = []
        media_folder_existed = _find_pragya_media_folder() is not None

        with tempfile.TemporaryDirectory(prefix=f"pragya_live_{run_tag}_") as tmp_str:
            tmp_dir = Path(tmp_str)
            try:
                # 1. Create temporary scratch spreadsheet
                created_sheet = _run_cli_json(
                    ["gsheets", "mutate", "create", "--title", scratch_title, "--json"]
                )
                sid = pragya_cli.GoogleWorkspaceBackend(runner=_rate_limit_safe_runner)._extract_id(
                    created_sheet, "spreadsheetId", "id"
                ) or ""
                self.assertTrue(sid, f"Expected spreadsheetId from create: {created_sheet}")
                trash_ids.append(sid)

                # Discover first sheet title (Sheet1 or Sheet 1) for batch probe
                sheet_list = _run_cli_json(
                    ["gsheets", "readonly", "list-sheets", sid, "--json"]
                )
                sheet_entries = (
                    sheet_list
                    if isinstance(sheet_list, list)
                    else sheet_list.get("sheets", [])
                )
                first_tab = "Sheet1"
                if sheet_entries:
                    props = (
                        sheet_entries[0].get("properties")
                        if isinstance(sheet_entries[0].get("properties"), dict)
                        else sheet_entries[0]
                    )
                    first_tab = str(props.get("title") or props.get("name") or "Sheet1")
                tab_ref = f"'{first_tab}'" if " " in first_tab else first_tab

                # 2. Empirical probe of `gsheets mutate batch` with formula/operator strings & dates
                probe_values = [
                    ["=SUM(1,2)", "+10%", "-5", "@tag", "2026-11-16"],
                ]
                probe_file = tmp_dir / "batch_probe.json"
                probe_file.write_text(
                    json.dumps(
                        [
                            {
                                "op": "write",
                                "range": f"{tab_ref}!A1:E1",
                                "data": probe_values,
                            }
                        ]
                    ),
                    encoding="utf-8",
                )
                _run_cli_json(
                    ["gsheets", "mutate", "batch", sid, "-f", str(probe_file), "--json"]
                )
                unformatted_read = _run_cli_json(
                    [
                        "gsheets",
                        "readonly",
                        "read",
                        sid,
                        f"{tab_ref}!A1:E1",
                        "--value-render-option",
                        "UNFORMATTED_VALUE",
                        "--json",
                    ]
                )
                formula_read = _run_cli_json(
                    [
                        "gsheets",
                        "readonly",
                        "read",
                        sid,
                        f"{tab_ref}!A1:E1",
                        "--value-render-option",
                        "FORMULA",
                        "--json",
                    ]
                )
                unformatted_row = (_extract_values(unformatted_read) or [[]])[0]
                formula_row = (_extract_values(formula_read) or [[]])[0]
                probe_report = {
                    "sent": probe_values[0],
                    "read_unformatted": unformatted_row,
                    "read_unformatted_types": [type(x).__name__ for x in unformatted_row],
                    "read_formula": formula_row,
                    "read_formula_types": [type(x).__name__ for x in formula_row],
                }
                print(
                    "\n[M5.7 LIVE GSHEETS BATCH PROBE]",
                    json.dumps(probe_report, ensure_ascii=False),
                )
                self.assertEqual(len(unformatted_row), 5)

                # 3. Initialize Pragya 4-tab schema and seed a scratch book via GoogleWorkspaceBackend
                backend = pragya_cli.GoogleWorkspaceBackend(
                    spreadsheet_id=sid, runner=_rate_limit_safe_runner
                )
                backend.ensure_schema()

                book_id = str(uuid.uuid4())
                seed_book = {
                    "id": book_id,
                    "title": f"Live Integration Primer {run_tag}",
                    "author": "A. Live Tester",
                    "format": "physical",
                    "kind": "nonfiction",
                    "status": "reading",
                    "currentPos": 10,
                    "totalPos": 200,
                    "posUnit": "page",
                    "normalizedPos": 0.05,
                    "docUrl": "",
                    "meta": {
                        "startedAt": "2026-11-01T10:00:00Z",
                        "updatedAt": "2026-11-16T00:00:00Z",
                    },
                }
                backend.save_book(seed_book)

                # 4. Prepare local WebP image & run `pragya_cli.main` capture entrypoint
                img_path = tmp_dir / f"live_quote_{run_tag}.webp"
                img_path.write_bytes(TINY_WEBP_BYTES)

                rc = pragya_cli.main(
                    [
                        "--spreadsheet-id",
                        sid,
                        "capture",
                        "--book",
                        book_id,
                        "--pos",
                        "42",
                        "--takeaway",
                        "Live integration core takeaway about feedback delays",
                        "--tags",
                        "#live,#favorite",
                        "--spar",
                        "--image",
                        str(img_path),
                    ],
                    runner=_rate_limit_safe_runner,
                )
                self.assertEqual(rc, 0)

                ws_after_cap = backend.load_workspace()
                self.assertEqual(len(ws_after_cap["notes"]), 1)
                note = ws_after_cap["notes"][0]
                note_id = note["id"]
                attachments = (note.get("meta") or {}).get("attachments") or []
                self.assertEqual(len(attachments), 1)
                drive_file_id = str(attachments[0].get("driveFileId") or "")
                self.assertTrue(drive_file_id, f"Expected driveFileId in {attachments}")
                trash_ids.append(drive_file_id)

                # Verify book advanced monotonically from 10 -> 42 and session logged
                self.assertEqual(ws_after_cap["books"][0]["currentPos"], 42)
                self.assertEqual(len(ws_after_cap["sessions"]), 1)

                parser = pragya_cli.build_parser()

                # 5. Reflect stage 1 -> stage commit
                res_s1 = pragya_cli.cmd_reflect(
                    parser.parse_args(
                        ["--spreadsheet-id", sid, "reflect", "--note", note_id, "--stage", "1"]
                    ),
                    backend,
                )
                self.assertEqual(res_s1["stage"], 1)
                ws_stage1 = backend.load_workspace()
                self.assertEqual(ws_stage1["notes"][0]["status"], "in-reflection")

                res_commit = pragya_cli.cmd_reflect(
                    parser.parse_args(
                        [
                            "--spreadsheet-id",
                            sid,
                            "reflect",
                            "--note",
                            note_id,
                            "--stage",
                            "commit",
                            "--title",
                            "Live Feedback Delay",
                            "--context",
                            "Delays between corrective actions and feedback cause oscillation.",
                            "--critique",
                            "Over-damping delays responsiveness in urgent crises.",
                            "--trigger",
                            "WHEN tuning a noisy alert rule",
                            "--action",
                            "DO wait one full cycle before retuning",
                            "--delta-status",
                            "active",
                        ]
                    ),
                    backend,
                )
                committed_note = res_commit["note"]
                self.assertEqual(committed_note["status"], "atomic")
                self.assertEqual(committed_note["deltaStatus"], "active")
                self.assertEqual(committed_note["deltaTrigger"], "tuning a noisy alert rule")
                self.assertEqual(committed_note["deltaAction"], "wait one full cycle before retuning")

                # 6. OCR Backfill (downloads real image from Drive via gdrive readonly download)
                ocr_helper = tmp_dir / "ocr_check.py"
                ocr_helper.write_text(
                    "import pathlib, sys\n"
                    "data = pathlib.Path(sys.argv[1]).read_bytes()\n"
                    "assert data[:4] == b'RIFF', f'Bad WEBP header: {data[:8]!r}'\n"
                    "print(f'OCR_RIFF_BYTES:{len(data)}')\n",
                    encoding="utf-8",
                )
                res_ocr = pragya_cli.cmd_ocr_backfill(
                    parser.parse_args(
                        [
                            "--spreadsheet-id",
                            sid,
                            "ocr-backfill",
                            "--note",
                            note_id,
                            "--ocr-cmd",
                            f"{sys.executable} {ocr_helper} {{path}}",
                        ]
                    ),
                    backend,
                )
                self.assertEqual(res_ocr["updatedCount"], 1)
                ws_ocr = backend.load_workspace()
                self.assertEqual(
                    ws_ocr["notes"][0]["quote"],
                    f"OCR_RIFF_BYTES:{len(TINY_WEBP_BYTES)}",
                )

                # 7. Book Doc Sync (creates real Google Doc and runs idempotent second pass)
                res_doc1 = pragya_cli.cmd_book_doc_sync(
                    parser.parse_args(
                        ["--spreadsheet-id", sid, "book-doc-sync", "--book", book_id]
                    ),
                    backend,
                )
                self.assertTrue(res_doc1["createdDoc"])
                self.assertEqual(res_doc1["syncedNoteCount"], 1)
                doc_id = str(res_doc1["docId"])
                trash_ids.append(doc_id)

                doc_text = backend.read_doc_text(doc_id)
                self.assertIn(f"[note:{note_id}]", doc_text)
                self.assertIn("Live Feedback Delay", doc_text)

                res_sync2 = pragya_cli.cmd_book_doc_sync(
                    parser.parse_args(
                        ["--spreadsheet-id", sid, "book-doc-sync", "--book", book_id]
                    ),
                    backend,
                )
                self.assertFalse(res_sync2["createdDoc"])
                self.assertEqual(res_sync2["syncedNoteCount"], 0)

                # 8. Export Markdown (1st pass writes .md, 2nd pass skips unchanged)
                export_dir = tmp_dir / "md-export"
                res_exp1 = pragya_cli.cmd_export_md(
                    parser.parse_args(
                        [
                            "--spreadsheet-id",
                            sid,
                            "export-md",
                            "--output-dir",
                            str(export_dir),
                        ]
                    ),
                    backend,
                )
                self.assertEqual(res_exp1["exportedCount"], 1)
                md_files = list(export_dir.glob("*.md"))
                self.assertEqual(len(md_files), 1)
                self.assertIn("Live Feedback Delay", md_files[0].read_text(encoding="utf-8"))

                res_exp2 = pragya_cli.cmd_export_md(
                    parser.parse_args(
                        [
                            "--spreadsheet-id",
                            sid,
                            "export-md",
                            "--output-dir",
                            str(export_dir),
                        ]
                    ),
                    backend,
                )
                self.assertEqual(res_exp2["exportedCount"], 0)
                self.assertEqual(res_exp2["skippedCount"], 1)

                # 9. Recall: qa, checkin, shuffle + mark-reviewed
                res_qa = pragya_cli.cmd_recall(
                    parser.parse_args(
                        [
                            "--spreadsheet-id",
                            sid,
                            "recall",
                            "--mode",
                            "qa",
                            "--query",
                            "feedback delays",
                        ]
                    ),
                    backend,
                )
                self.assertEqual(len(res_qa["matches"]), 1)

                res_checkin = pragya_cli.cmd_recall(
                    parser.parse_args(
                        [
                            "--spreadsheet-id",
                            sid,
                            "recall",
                            "--mode",
                            "checkin",
                            "--note",
                            note_id,
                            "--outcome",
                            "applied",
                            "--reflection",
                            "Waited a full window before tuning alert",
                        ]
                    ),
                    backend,
                )
                self.assertEqual(res_checkin["logged"]["outcome"], "applied")

                res_shuffle = pragya_cli.cmd_recall(
                    parser.parse_args(
                        [
                            "--spreadsheet-id",
                            sid,
                            "recall",
                            "--mode",
                            "shuffle",
                            "--date",
                            "2026-11-16",
                        ]
                    ),
                    backend,
                )
                self.assertEqual(len(res_shuffle["candidates"]), 1)

                before_updated_at = backend.load_workspace()["notes"][0]["updatedAt"]
                pragya_cli.cmd_recall(
                    parser.parse_args(
                        [
                            "--spreadsheet-id",
                            sid,
                            "recall",
                            "--mode",
                            "shuffle",
                            "--date",
                            "2026-11-16",
                            "--mark-reviewed",
                            note_id,
                        ]
                    ),
                    backend,
                )
                after_review = backend.load_workspace()["notes"][0]
                self.assertEqual(after_review["updatedAt"], before_updated_at)
                self.assertEqual((after_review.get("meta") or {}).get("lastReviewedAt"), "2026-11-16")
            finally:
                # 10. Cleanup: trash all temporary Drive artifacts created during run
                try:
                    if sid in trash_ids:
                        ws_cleanup = pragya_cli.GoogleWorkspaceBackend(
                            spreadsheet_id=sid, runner=_rate_limit_safe_runner
                        ).load_workspace()
                        for b in ws_cleanup.get("books", []):
                            d_id = pragya_cli.parse_doc_id(b.get("docUrl") or "")
                            if d_id and d_id not in trash_ids:
                                trash_ids.append(d_id)
                except Exception:
                    pass

                if not media_folder_existed:
                    created_folder_id = _find_pragya_media_folder()
                    if created_folder_id and created_folder_id not in trash_ids:
                        trash_ids.append(created_folder_id)

                for file_id in reversed(trash_ids):
                    try:
                        _run_cli_json(["gdrive", "mutate", "trash", file_id, "--json"])
                    except Exception as exc:
                        print(f"[M5.7 CLEANUP WARNING] Failed to trash {file_id}: {exc}")

                # Confirm scratch artifacts are trashed
                for file_id in trash_ids:
                    info = _run_cli_json(["gdrive", "readonly", "info", file_id, "--json"])
                    trashed = info.get("trashed")
                    if trashed is not None:
                        self.assertTrue(
                            bool(trashed),
                            f"Scratch artifact {file_id} should be trashed after cleanup: {info}",
                        )

    def test_live_raw_batch_probe_round_trips_exact_values(self) -> None:
        """M6 B1.1 (OQ-1) RELEASE GATE: `gsheets mutate raw-batch` via the _write_cells seam.

        Runs only on its own scratch spreadsheet (created here, trashed in finally) and
        checks that the UNFORMATTED_VALUE read-back equals what was sent for appendCells,
        updateCells (row-index math) and the raw-batch header repair.
        """
        run_tag = uuid.uuid4().hex[:8]
        scratch_title = f"Pragya Scratch M6 raw {run_tag}"
        sid = ""
        created: Any = None
        try:
            created = _run_cli_json(["gsheets", "mutate", "create", "--title", scratch_title, "--json"])
            sid = (
                pragya_cli.GoogleWorkspaceBackend(runner=_rate_limit_safe_runner)._extract_id(
                    created, "spreadsheetId", "id"
                )
                or ""
            )
            self.assertTrue(sid, f"Expected spreadsheetId from create: {created}")
            backend = pragya_cli.GoogleWorkspaceBackend(spreadsheet_id=sid, runner=_rate_limit_safe_runner)
            backend.ensure_schema()  # header repair goes through raw-batch on a fresh sheet

            headers = backend._read_range(sid, "Sessions!A1:G1")
            self.assertEqual([str(c) for c in headers[0]], pragya_cli.SESSIONS_HEADERS)

            sent = ["probe-id", "=SUM(1,2)", "+10%", "- bullet", "2026-11-16", 42, 0.5]
            backend._write_cells(sid, [{"kind": "append", "tab": "Sessions", "values": sent}])
            rows = backend._read_range(sid, "Sessions!A:G")
            self.assertGreaterEqual(len(rows), 2, rows)
            got = rows[-1]
            row_number = len(rows)
            print("\n[M6 LIVE RAW-BATCH PROBE append]", json.dumps({"sent": sent, "read": got}))
            self.assertEqual(got[:5], sent[:5])
            self.assertEqual(float(got[5]), 42.0)
            self.assertEqual(float(got[6]), 0.5)

            updated = ["probe-id", "=A1", "@tag", "-5", "2026-11-17", 7, 1]
            backend._write_cells(
                sid, [{"kind": "update", "tab": "Sessions", "row": row_number, "values": updated}]
            )
            rows_after = backend._read_range(sid, "Sessions!A:G")
            self.assertEqual(len(rows_after), row_number, "updateCells must not add a row")
            got_u = rows_after[row_number - 1]
            print("[M6 LIVE RAW-BATCH PROBE update]", json.dumps({"sent": updated, "read": got_u}))
            self.assertEqual(got_u[:5], updated[:5])
            self.assertEqual(float(got_u[5]), 7.0)
            self.assertEqual([str(c) for c in rows_after[0]], pragya_cli.SESSIONS_HEADERS)
        finally:
            if sid:
                try:
                    _run_cli_json(["gdrive", "mutate", "trash", sid, "--json"])
                except Exception as exc:
                    print(f"[M6 CLEANUP WARNING] Failed to trash {sid}: {exc}")
            elif created is not None:
                print(
                    f"[M6 CLEANUP WARNING] Could not extract the scratch spreadsheet id; trash "
                    f"'{scratch_title}' manually. create() returned: {created}"
                )

    def test_live_gdocs_raw_batch_in_place_probe(self) -> None:
        """M6 Batch 6 (A1.4 / OQ-2) RELEASE GATE: `gdocs mutate raw-batch` in-place sync.

        Uses only its own scratch Doc (created here, trashed in finally): writes a header,
        a saved block and user prose, then upgrades the block to atomic and inserts a
        backfilled note through doc_plan_to_requests, and checks the read-back text and
        that the prose is byte-preserved.
        """
        run_tag = uuid.uuid4().hex[:8]
        backend = pragya_cli.GoogleWorkspaceBackend(runner=_rate_limit_safe_runner)
        doc_id = ""
        try:
            book = {
                "id": f"probe-book-{run_tag}", "title": f"Pragya Scratch Doc Probe {run_tag}",
                "author": "Probe", "kind": "nonfiction", "status": "reading", "currentPos": 100,
                "totalPos": 200, "posUnit": "page", "normalizedPos": 0.5, "meta": {},
            }
            def note(nid, pos, status, **kw):
                base = {"id": nid, "slug": nid, "bookId": book["id"], "pos": pos, "status": status,
                        "createdAt": "2026-01-01T00:00:00.000Z", "takeaway": f"takeaway {nid}",
                        "quote": "", "contextMechanism": "", "critique": "", "deltaTrigger": "",
                        "deltaAction": "", "deltaStatus": "none", "meta": {}}
                base.update(kw)
                return base
            saved = note("probe-a", 50, "saved")
            doc_id, _url = backend.create_companion_doc(book["title"], "", book_id=book["id"])
            prose = "My own prose 🧠 — must survive byte-for-byte."
            initial = pragya_cli.lines_to_text(pragya_cli.render_full_companion_doc(book, [saved]))
            backend.append_doc_text(doc_id, initial + "\n" + prose + "\n")

            snap = backend.read_doc_snapshot(doc_id)
            self.assertIsNotNone(snap, "documents.get structure should be parseable for a fresh Doc")
            self.assertTrue(snap.revision_id, "documents.get must return a revisionId for writeControl")
            lines = snap.lines
            upgraded = dict(saved, status="atomic", critique="probe critique")
            backfill = note("probe-early", 10, "saved")
            timeline = [backfill, upgraded]
            plan = pragya_cli.plan_companion_doc(lines, book, timeline)
            self.assertEqual((plan.added_ids, plan.updated_ids), (["probe-early"], ["probe-a"]))
            # R1#6: the real sync path must take the in-place route on a real Doc read
            # (revision-guarded raw-batch with writeControl.requiredRevisionId).
            outcome = pragya_cli._sync_existing_doc(backend, doc_id, book, timeline, None)
            self.assertEqual(outcome.mode, "in-place", outcome.warnings)
            self.assertEqual((outcome.added, outcome.updated), (["probe-early"], ["probe-a"]))

            after = backend.read_doc_lines(doc_id)
            self.assertIsNotNone(after)
            expected = [(ln.level, ln.text) for ln in pragya_cli.apply_doc_plan(lines, plan)]
            got = [(ln.level, ln.text) for ln in after]
            print("\n[M6 LIVE GDOCS RAW-BATCH PROBE]", json.dumps({"expected": expected, "got": got}, ensure_ascii=False))
            self.assertEqual(got, expected)
            self.assertIn((0, prose), got)
            # A second plan on the result is a no-op (zero writes).
            self.assertEqual(pragya_cli.plan_companion_doc(after, book, timeline).edits, [])
            # A stale revision must be rejected by the API (writeControl works live).
            stale = pragya_cli.plan_companion_doc(after, book, [backfill, dict(upgraded, critique="again")])
            stale_requests = pragya_cli.doc_plan_to_requests(after, stale)
            self.assertTrue(stale_requests, "the stale-revision probe must actually send requests")
            fresh = backend.read_doc_snapshot(doc_id)
            self.assertNotEqual(fresh.revision_id, snap.revision_id, "the in-place write must bump the revision")
            with self.assertRaises(pragya_cli.CliError):
                backend.batch_update_doc(doc_id, stale_requests, snap.revision_id)
        finally:
            if doc_id:
                try:
                    _run_cli_json(["gdrive", "mutate", "trash", doc_id, "--json"])
                except Exception as exc:
                    print(f"[M6 CLEANUP WARNING] Failed to trash scratch Doc {doc_id}: {exc}")

    def test_live_gdocs_write_control_rejects_stale_revision(self) -> None:
        """M6 Batch 6 RELEASE GATE (mandatory whenever the live suite runs): a raw-batch sent
        with an outdated writeControl.requiredRevisionId must be rejected, so stale indexes
        can never delete text a user typed after our read. Own scratch Doc, trashed in finally."""
        run_tag = uuid.uuid4().hex[:8]
        backend = pragya_cli.GoogleWorkspaceBackend(runner=_rate_limit_safe_runner)
        doc_id = ""
        try:
            doc_id, _url = backend.create_companion_doc(f"Pragya Scratch Rev Probe {run_tag}", "", book_id=run_tag)
            backend.append_doc_text(doc_id, "# Rev probe\nfirst line\n")
            old = backend.read_doc_snapshot(doc_id)
            self.assertIsNotNone(old)
            self.assertTrue(old.revision_id, "documents.get must return a revisionId")
            backend.append_doc_text(doc_id, "\nconcurrent user line\n")  # bumps the revision
            new = backend.read_doc_snapshot(doc_id)
            self.assertNotEqual(new.revision_id, old.revision_id)
            insert = [{"insertText": {"location": {"index": old.lines[-1].end - 1}, "text": " STALE"}}]
            with self.assertRaises(pragya_cli.CliError):
                backend.batch_update_doc(doc_id, insert, old.revision_id)
            self.assertNotIn("STALE", backend.read_doc_text(doc_id))
            # The same request with the current revision is accepted.
            backend.batch_update_doc(doc_id, insert, new.revision_id)
        finally:
            if doc_id:
                try:
                    _run_cli_json(["gdrive", "mutate", "trash", doc_id, "--json"])
                except Exception as exc:
                    print(f"[M6 CLEANUP WARNING] Failed to trash scratch Doc {doc_id}: {exc}")


if __name__ == "__main__":
    unittest.main()
