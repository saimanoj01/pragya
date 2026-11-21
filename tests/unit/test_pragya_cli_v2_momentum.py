"""Unit and TS <-> Python parity tests for Pragya v2 CLI commands and domain helpers."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(REPO_ROOT / "scripts"))
import pragya_cli  # noqa: E402


def _run_cli(
    argv: list[str], runner: Any = None
) -> tuple[int, dict[str, Any], dict[str, Any]]:
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    with redirect_stdout(out_buf), redirect_stderr(err_buf):
        rc = pragya_cli.main(argv, runner=runner) if runner is not None else pragya_cli.main(argv)
    out_text = out_buf.getvalue().strip()
    err_text = err_buf.getvalue().strip()
    return (
        rc,
        json.loads(out_text) if out_text else {},
        json.loads(err_text) if err_text else {},
    )


def _base_snapshot() -> dict[str, Any]:
    return {
        "version": 1,
        "exportedAt": "2026-11-20T12:00:00.000Z",
        "books": [
            {
                "id": "b-sys",
                "title": "Thinking in Systems",
                "author": "Donella Meadows",
                "format": "physical",
                "kind": "nonfiction",
                "status": "reading",
                "currentPos": 120,
                "totalPos": 240,
                "posUnit": "page",
                "normalizedPos": 0.5,
                "docUrl": "https://docs.google.com/document/d/doc-sys/edit",
                "meta": {
                    "startedAt": "2026-11-10T10:00:00.000Z",
                    "updatedAt": "2026-11-20T10:00:00.000Z",
                    "currentChapter": "Ch. 3: Delays",
                    "nextStop": "Finish Ch. 3 · p. 150",
                },
            },
            {
                "id": "b-dune",
                "title": "Dune",
                "author": "Frank Herbert",
                "format": "kindle",
                "kind": "fiction",
                "status": "reading",
                "currentPos": 50,
                "totalPos": 100,
                "posUnit": "percent",
                "normalizedPos": 0.5,
                "docUrl": "https://docs.google.com/document/d/doc-dune/edit",
                "meta": {
                    "startedAt": "2026-11-12T10:00:00.000Z",
                    "updatedAt": "2026-11-19T10:00:00.000Z",
                },
            },
            {
                "id": "b-queue-short",
                "title": "The Elements of Style",
                "author": "William Strunk",
                "format": "physical",
                "kind": "nonfiction",
                "status": "queued",
                "currentPos": 0,
                "totalPos": 95,
                "posUnit": "page",
                "normalizedPos": 0,
                "docUrl": "",
                "meta": {
                    "updatedAt": "2026-11-01T10:00:00.000Z",
                    "whyQueued": "Crisp writing craft",
                },
            },
            {
                "id": "b-queue-fic",
                "title": "Left Hand of Darkness",
                "author": "Ursula K. Le Guin",
                "format": "physical",
                "kind": "fiction",
                "status": "queued",
                "currentPos": 0,
                "totalPos": 300,
                "posUnit": "page",
                "normalizedPos": 0,
                "docUrl": "",
                "meta": {
                    "updatedAt": "2026-11-02T10:00:00.000Z",
                    "whyQueued": "Recommended by Sam",
                },
            },
            {
                "id": "b-arch",
                "title": "Archived Book",
                "author": "Old Author",
                "format": "physical",
                "kind": "nonfiction",
                "status": "reading",
                "currentPos": 10,
                "totalPos": 100,
                "posUnit": "page",
                "normalizedPos": 0.1,
                "docUrl": "https://docs.google.com/document/d/doc-arch/edit",
                "meta": {
                    "updatedAt": "2026-11-01T00:00:00.000Z",
                    "archivedAt": "2026-11-05T00:00:00.000Z",
                },
            },
        ],
        "notes": [
            {
                "id": "n-sys-1",
                "slug": "feedback-delays",
                "bookId": "b-sys",
                "createdAt": "2026-11-18T10:00:00.000Z",
                "updatedAt": "2026-11-18T10:00:00.000Z",
                "pos": 80,
                "normalizedPos": 0.333333,
                "status": "atomic",
                "source": "app",
                "tags": ["#systems", "#delays", "#favorite"],
                "quote": "Delays in balancing loops cause oscillation.",
                "takeaway": "Wait out natural lag before changing rules.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "Feedback Delays",
                    "aliases": ["old-feedback-lag"],
                    "attachments": [],
                    "links": [],
                },
            },
            {
                "id": "n-dune-1",
                "slug": "ecological-lag",
                "bookId": "b-dune",
                "createdAt": "2026-11-19T10:00:00.000Z",
                "updatedAt": "2026-11-19T10:00:00.000Z",
                "pos": 40,
                "normalizedPos": 0.4,
                "status": "atomic",
                "source": "app",
                "tags": ["#systems", "#ecology", "#favorite"],
                "quote": "Arrakis transformation takes generations.",
                "takeaway": "Long ecological feedback lags resist impatient rulers.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "Ecological Lag",
                    "attachments": [],
                    "links": [],
                },
            },
            {
                "id": "n-dune-pred",
                "slug": "secret-paul-prophecy",
                "bookId": "b-dune",
                "createdAt": "2026-11-19T11:00:00.000Z",
                "updatedAt": "2026-11-19T11:00:00.000Z",
                "pos": 45,
                "normalizedPos": 0.45,
                "status": "saved",
                "source": "app",
                "tags": ["#prediction"],
                "quote": "",
                "takeaway": "SECRET PREDICTION TEXT NEVER LEAK",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "Secret Prediction Title",
                    "isPrediction": True,
                    "attachments": [
                        {
                            "id": "att-pred",
                            "type": "image",
                            "fileName": "pred.webp",
                            "mimeType": "image/webp",
                        }
                    ],
                    "links": [],
                },
            },
            {
                "id": "n-dune-future",
                "slug": "future-spoiler-note",
                "bookId": "b-dune",
                "createdAt": "2026-11-19T12:00:00.000Z",
                "updatedAt": "2026-11-19T12:00:00.000Z",
                "pos": 85,
                "normalizedPos": 0.85,
                "status": "saved",
                "source": "app",
                "tags": ["#systems"],
                "quote": "",
                "takeaway": "FUTURE SPOILER TEXT NEVER LEAK",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "title": "Future Spoiler",
                    "attachments": [
                        {
                            "id": "att-future",
                            "type": "image",
                            "fileName": "future.webp",
                            "mimeType": "image/webp",
                        }
                    ],
                    "links": [],
                },
            },
            {
                "id": "n-sys-img-ok",
                "slug": "sys-diagram-photo",
                "bookId": "b-sys",
                "createdAt": "2026-11-19T15:00:00.000Z",
                "updatedAt": "2026-11-19T15:00:00.000Z",
                "pos": 90,
                "normalizedPos": 0.375,
                "status": "saved",
                "source": "app",
                "tags": [],
                "quote": "",
                "takeaway": "Stock and flow sketch.",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "attachments": [
                        {
                            "id": "att-ok",
                            "type": "image",
                            "fileName": "stock-flow.webp",
                            "mimeType": "image/webp",
                        }
                    ],
                    "links": [],
                },
            },
            {
                "id": "n-arch-img",
                "slug": "archived-img-note",
                "bookId": "b-sys",
                "createdAt": "2026-11-19T16:00:00.000Z",
                "updatedAt": "2026-11-19T16:00:00.000Z",
                "pos": 60,
                "normalizedPos": 0.25,
                "status": "saved",
                "source": "app",
                "tags": ["#systems"],
                "quote": "",
                "takeaway": "Archived note text",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {
                    "archivedAt": "2026-11-19T17:00:00.000Z",
                    "attachments": [
                        {
                            "id": "att-arch",
                            "type": "image",
                            "fileName": "arch.webp",
                            "mimeType": "image/webp",
                        }
                    ],
                    "links": [],
                },
            },
        ],
        "sessions": [
            {
                "id": "s-1",
                "bookId": "b-sys",
                "date": "2026-11-17",
                "startPos": 60,
                "endPos": 90,
                "updatedAt": "2026-11-17T20:00:00.000Z",
                "note": "Chapter 2",
            },
            {
                "id": "s-2",
                "bookId": "b-sys",
                "date": "2026-11-19",
                "startPos": 90,
                "endPos": 120,
                "updatedAt": "2026-11-19T20:00:00.000Z",
                "note": "Delays",
            },
        ],
        "deltaLogs": [],
    }


class TestV2BookContextAndQuestions(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pragya_v2_cli_"))
        self.state_path = self.tmp / "state.json"
        self.state_path.write_text(json.dumps(_base_snapshot()), encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_book_add_and_update_context_fields(self) -> None:
        rc, res, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-add",
                "--title",
                "Seeing Like a State",
                "--author",
                "James C. Scott",
                "--status",
                "queued",
                "--why-queued",
                "  Paired with Meadows on legibility  ",
                "--next-stop",
                "Ch. 1",
            ]
        )
        self.assertEqual(rc, 0)
        book = res["book"]
        self.assertEqual(book["meta"]["whyQueued"], "Paired with Meadows on legibility")
        self.assertEqual(book["meta"]["nextStop"], "Ch. 1")

        # Update pauseNote without wiping whyQueued/nextStop; clear nextStop with empty string.
        rc2, res2, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-update",
                "--book",
                book["id"],
                "--status",
                "paused",
                "--pause-note",
                "Save for summer flight",
                "--next-stop",
                "",
            ]
        )
        self.assertEqual(rc2, 0)
        meta2 = res2["book"]["meta"]
        self.assertEqual(meta2["whyQueued"], "Paired with Meadows on legibility")
        self.assertEqual(meta2["pauseNote"], "Save for summer flight")
        self.assertNotIn("nextStop", meta2)

    def test_book_question_lifecycle_cap_and_finish_payload(self) -> None:
        # Inject an unknown raw entry to verify verbatim pass-through.
        snap = json.loads(self.state_path.read_text(encoding="utf-8"))
        snap["books"][0]["meta"]["readingQuestions"] = [{"futureSchema": 42}]
        self.state_path.write_text(json.dumps(snap), encoding="utf-8")

        added_ids: list[str] = []
        for idx in range(5):
            rc, res, _ = _run_cli(
                [
                    "--state-file",
                    str(self.state_path),
                    "book-question",
                    "--book",
                    "b-sys",
                    "--add",
                    f"Question {idx + 1}?",
                ]
            )
            self.assertEqual(rc, 0)
            self.assertTrue(res["question"]["id"].startswith("q_"))
            added_ids.append(res["question"]["id"])

        # 6th open question must fail with 5-open cap.
        rc_cap, _, err_cap = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-question",
                "--book",
                "b-sys",
                "--add",
                "Too many?",
            ]
        )
        self.assertEqual(rc_cap, 1)
        self.assertIn("limit (5)", err_cap["error"])

        # Answer first question by prefix + link a note from the same book.
        q1_prefix = added_ids[0][:6]
        rc_ans, res_ans, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-question",
                "--book",
                "b-sys",
                "--answer",
                q1_prefix,
                "--text",
                "Delays amplify over-correction.",
                "--note",
                "feedback-delays",
            ]
        )
        self.assertEqual(rc_ans, 0)
        self.assertEqual(res_ans["question"]["status"], "answered")
        self.assertEqual(res_ans["question"]["noteId"], "n-sys-1")
        self.assertEqual(res_ans["openCount"], 4)

        # Cross-book note link must be refused.
        rc_bad, _, err_bad = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-question",
                "--book",
                "b-sys",
                "--answer",
                added_ids[1],
                "--note",
                "ecological-lag",
            ]
        )
        self.assertEqual(rc_bad, 1)
        self.assertIn("different book", err_bad["error"])

        # Unknown raw entry survived verbatim.
        snap_after = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(snap_after["books"][0]["meta"]["readingQuestions"][0], {"futureSchema": 42})

        # Finishing the book includes spoiler-safe answeredQuestions alongside notesSummary.
        rc_fin, res_fin, _ = _run_cli(
            ["--state-file", str(self.state_path), "progress", "--book", "b-sys", "--finish"]
        )
        self.assertEqual(rc_fin, 0)
        self.assertTrue(res_fin["capstonePending"])
        self.assertEqual(len(res_fin["answeredQuestions"]), 1)
        self.assertEqual(res_fin["answeredQuestions"][0]["noteSlug"], "feedback-delays")

        # Export-md renders Reading Questions in books/<slug>.md.
        out_dir = self.tmp / "md_out"
        rc_exp, _, _ = _run_cli(
            ["--state-file", str(self.state_path), "export-md", "--output-dir", str(out_dir)]
        )
        self.assertEqual(rc_exp, 0)
        book_md = (out_dir / "books" / "thinking-in-systems.md").read_text(encoding="utf-8")
        self.assertIn("## Reading Questions", book_md)
        self.assertIn("Delays amplify over-correction.", book_md)
        self.assertIn("[[feedback-delays]]", book_md)


class TestV2NoteLinkAndExport(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pragya_v2_link_"))
        self.state_path = self.tmp / "state.json"
        self.state_path.write_text(json.dumps(_base_snapshot()), encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_note_link_bidirectional_alias_voice_fidelity_and_export(self) -> None:
        # Link using old alias 'old-feedback-lag' -> canonicalizes to 'feedback-delays'.
        rc, res, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "note-link",
                "--note",
                "old-feedback-lag",
                "--to",
                "ecological-lag",
                "--why",
                "Both show system lag punishing impatience.",
            ]
        )
        self.assertEqual(rc, 0)
        self.assertTrue(res["changed"])
        self.assertEqual(set(res["updatedNoteIds"]), {"n-sys-1", "n-dune-1"})

        snap = json.loads(self.state_path.read_text(encoding="utf-8"))
        by_id = {n["id"]: n for n in snap["notes"]}
        self.assertEqual(by_id["n-sys-1"]["takeaway"], "Wait out natural lag before changing rules.")
        self.assertEqual(by_id["n-sys-1"]["meta"]["relatedSlugs"], ["ecological-lag"])
        self.assertEqual(
            by_id["n-sys-1"]["meta"]["bridgeNotes"]["ecological-lag"],
            "Both show system lag punishing impatience.",
        )
        self.assertEqual(by_id["n-dune-1"]["meta"]["relatedSlugs"], ["feedback-delays"])

        # export-md includes relatedSlugs in frontmatter and bridge reason in Related Concepts.
        out_dir = self.tmp / "md_out"
        rc_exp, _, _ = _run_cli(
            ["--state-file", str(self.state_path), "export-md", "--output-dir", str(out_dir)]
        )
        self.assertEqual(rc_exp, 0)
        md_text = (out_dir / "feedback-delays.md").read_text(encoding="utf-8")
        self.assertIn('relatedSlugs: ["ecological-lag"]', md_text)
        self.assertIn("[[ecological-lag]]: Both show system lag punishing impatience.", md_text)

        # Unlink symmetrically cleans both rows and omits empty keys.
        rc_un, res_un, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "note-link",
                "--note",
                "feedback-delays",
                "--to",
                "ecological-lag",
                "--unlink",
            ]
        )
        self.assertEqual(rc_un, 0)
        self.assertTrue(res_un["changed"])
        snap2 = json.loads(self.state_path.read_text(encoding="utf-8"))
        by_id2 = {n["id"]: n for n in snap2["notes"]}
        self.assertNotIn("relatedSlugs", by_id2["n-sys-1"]["meta"])
        self.assertNotIn("bridgeNotes", by_id2["n-sys-1"]["meta"])
        self.assertNotIn("relatedSlugs", by_id2["n-dune-1"]["meta"])

    def test_note_link_refuses_self_archived_and_shielded(self) -> None:
        rc_self, _, err_self = _run_cli(
            ["--state-file", str(self.state_path), "note-link", "--note", "n-sys-1", "--to", "old-feedback-lag"]
        )
        self.assertEqual(rc_self, 1)
        self.assertIn("itself", err_self["error"])

        rc_arch, _, err_arch = _run_cli(
            ["--state-file", str(self.state_path), "note-link", "--note", "n-sys-1", "--to", "n-arch-img"]
        )
        self.assertEqual(rc_arch, 1)
        self.assertIn("archived", err_arch["error"])

        rc_sp, _, err_sp = _run_cli(
            ["--state-file", str(self.state_path), "note-link", "--note", "n-sys-1", "--to", "n-dune-future"]
        )
        self.assertEqual(rc_sp, 1)
        self.assertIn("spoiler-shielded", err_sp["error"])

        # Opting in with --include-spoilers succeeds.
        rc_ok, res_ok, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "note-link",
                "--note",
                "n-sys-1",
                "--to",
                "n-dune-future",
                "--include-spoilers",
            ]
        )
        self.assertEqual(rc_ok, 0)
        self.assertTrue(res_ok["changed"])


class TestV2RecapSalonAndOcrHardening(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pragya_v2_recap_"))
        self.state_path = self.tmp / "state.json"
        self.state_path.write_text(json.dumps(_base_snapshot()), encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_recap_is_spoiler_safe_and_redacts_sealed_predictions(self) -> None:
        rc, res, _ = _run_cli(
            ["--state-file", str(self.state_path), "recap", "--book", "Dune", "--today", "2026-11-20"]
        )
        self.assertEqual(rc, 0)
        self.assertFalse(res["readToday"])
        self.assertEqual(res["allActiveBooksCount"], 2)
        self.assertEqual(res["selectedBook"]["id"], "b-dune")

        # Strict redaction check across entire serialized JSON payload.
        blob = json.dumps(res)
        self.assertNotIn("SECRET PREDICTION TEXT", blob)
        self.assertNotIn("secret-paul-prophecy", blob)
        self.assertNotIn("Secret Prediction Title", blob)
        self.assertNotIn("FUTURE SPOILER TEXT", blob)
        self.assertNotIn("future-spoiler-note", blob)

        self.assertEqual(res["openPredictions"]["count"], 1)
        self.assertEqual(
            res["openPredictions"]["items"],
            [{"id": "n-dune-pred", "pos": 45, "posDisplay": "45%"}],
        )
        self.assertEqual(len(res["crossBookEchoes"]), 1)
        self.assertEqual(res["crossBookEchoes"][0]["note"]["id"], "n-sys-1")

    def test_recap_default_book_and_read_today(self) -> None:
        rc, res, _ = _run_cli(
            ["--state-file", str(self.state_path), "recap", "--today", "2026-11-19"]
        )
        self.assertEqual(rc, 0)
        self.assertTrue(res["readToday"])
        self.assertEqual(res["selectedBook"]["id"], "b-sys")
        self.assertIsNotNone(res["sittingPace"])
        self.assertIn("~30 pages a sitting", res["sittingPace"]["label"])
        self.assertEqual(res["nextStop"], "Finish Ch. 3 · p. 150")

    def test_ocr_backfill_and_salon_exclude_archived_and_shielded_images(self) -> None:
        rc_s, salon, _ = _run_cli(
            ["--state-file", str(self.state_path), "salon", "--days", "7", "--today", "2026-11-20"]
        )
        self.assertEqual(rc_s, 0)
        # Only n-sys-img-ok is eligible (excludes n-dune-pred, n-dune-future, n-arch-img).
        self.assertEqual(salon["pendingOcrNoteIds"], ["n-sys-img-ok"])
        self.assertEqual(len(salon["bridgeCandidates"]), 1)
        self.assertEqual(salon["bridgeCandidates"][0]["sharedTags"], ["#systems"])
        self.assertIsNotNone(salon["collisionPair"])
        self.assertFalse(salon["maintenance"]["applied"])

        ocr_map = self.tmp / "ocr.json"
        ocr_map.write_text(
            json.dumps(
                {
                    "n-sys-img-ok": "Safe OCR text",
                    "n-dune-pred": "Prediction OCR text",
                    "n-dune-future": "Future OCR text",
                    "n-arch-img": "Archived OCR text",
                }
            ),
            encoding="utf-8",
        )
        rc_o, res_o, _ = _run_cli(
            ["--state-file", str(self.state_path), "ocr-backfill", "--ocr-map-json", str(ocr_map)]
        )
        self.assertEqual(rc_o, 0)
        self.assertEqual(res_o["updatedSlugs"], ["sys-diagram-photo"])
        self.assertEqual(res_o["shieldedCount"], 2)
        self.assertNotIn("secret-paul-prophecy", res_o["skippedSlugs"])
        self.assertNotIn("future-spoiler-note", res_o["skippedSlugs"])

    def test_salon_apply_maintenance_single_load_cap_and_partial_error_tolerance(self) -> None:
        snap = _base_snapshot()
        # Add a third book with no docUrl (must never be auto-created) and a fourth with docUrl.
        snap["books"].append(
            {
                "id": "b-nodoc",
                "title": "No Doc Book",
                "author": "Author",
                "format": "physical",
                "kind": "nonfiction",
                "status": "reading",
                "currentPos": 10,
                "totalPos": 100,
                "posUnit": "page",
                "normalizedPos": 0.1,
                "docUrl": "",
                "meta": {"updatedAt": "2026-11-20T11:00:00.000Z"},
            }
        )
        snap["books"].append(
            {
                "id": "b-third",
                "title": "Third Doc Book",
                "author": "Author",
                "format": "physical",
                "kind": "nonfiction",
                "status": "reading",
                "currentPos": 10,
                "totalPos": 100,
                "posUnit": "page",
                "normalizedPos": 0.1,
                "docUrl": "https://docs.google.com/document/d/doc-third/edit",
                "meta": {"updatedAt": "2026-11-18T00:00:00.000Z"},
            }
        )
        snap["notes"].append(
            {
                "id": "n-third-1",
                "slug": "third-note",
                "bookId": "b-third",
                "createdAt": "2026-11-18T00:00:00.000Z",
                "updatedAt": "2026-11-18T00:00:00.000Z",
                "pos": 5,
                "normalizedPos": 0.05,
                "status": "saved",
                "source": "app",
                "tags": [],
                "quote": "",
                "takeaway": "Third takeaway",
                "contextMechanism": "",
                "critique": "",
                "deltaTrigger": "",
                "deltaAction": "",
                "deltaStatus": "none",
                "meta": {"attachments": [], "links": []},
            }
        )

        class CountingStubBackend(pragya_cli.StateFileBackend):
            def __init__(self, path: Path) -> None:
                super().__init__(path)
                self.load_count = 0
                self.create_count = 0
                self.synced_doc_ids: list[str] = []

            def load_workspace(self) -> dict[str, Any]:
                self.load_count += 1
                return super().load_workspace()

            def create_companion_doc(self, title: str, initial_text: str, *, book_id: str | None = None) -> tuple[str, str]:
                self.create_count += 1
                raise AssertionError("salon --apply-maintenance must never auto-create Docs")

            def read_doc_text(self, doc_id: str) -> str:
                if doc_id == "doc-dune":
                    raise pragya_cli.CliError("429 RESOURCE_EXHAUSTED on doc-dune")
                return ""

            def read_doc_snapshot(self, doc_id: str) -> pragya_cli.DocSnapshot:
                if doc_id == "doc-dune":
                    raise pragya_cli.CliError("429 RESOURCE_EXHAUSTED on doc-dune")
                return pragya_cli.DocSnapshot(lines=[], revision_id="rev-1", end_index=1)

            def append_doc_text(self, doc_id: str, text: str) -> None:
                if doc_id == "doc-dune":
                    raise pragya_cli.CliError("429 RESOURCE_EXHAUSTED on doc-dune")
                self.synced_doc_ids.append(doc_id)

        self.state_path.write_text(json.dumps(snap), encoding="utf-8")
        backend = CountingStubBackend(self.state_path)
        parser = pragya_cli.build_parser()
        args = parser.parse_args(
            ["salon", "--today", "2026-11-20", "--apply-maintenance", "--max-doc-syncs", "2"]
        )
        res = pragya_cli.cmd_salon(args, backend)

        self.assertEqual(backend.load_count, 1)
        self.assertEqual(backend.create_count, 0)
        self.assertTrue(res["maintenance"]["applied"])
        self.assertEqual(res["maintenance"]["updatedDocCount"], 1)
        self.assertEqual(len(res["maintenance"]["syncedDocs"]), 1)
        self.assertEqual(res["maintenance"]["syncedDocs"][0]["bookId"], "b-sys")
        self.assertEqual(len(res["maintenance"]["failedDocs"]), 1)
        self.assertEqual(res["maintenance"]["failedDocs"][0]["bookId"], "b-dune")
        self.assertIn("429", res["maintenance"]["failedDocs"][0]["error"])

    def test_v2_edge_cases_reopen_remove_shielded_question_note_archived_recap_and_export_shield(self) -> None:
        # 1. book-question: --add, --list, --answer with shielded note rejected, --reopen, --remove last omits key
        rc_a, res_a, _ = _run_cli(
            ["--state-file", str(self.state_path), "book-question", "--book", "b-dune", "--add", "Who controls Arrakis?"]
        )
        self.assertEqual(rc_a, 0)
        qid = res_a["question"]["id"]

        rc_list, res_list, _ = _run_cli(
            ["--state-file", str(self.state_path), "book-question", "--book", "b-dune", "--list"]
        )
        self.assertEqual(rc_list, 0)
        self.assertEqual(len(res_list["questions"]), 1)

        # Answering with a sealed prediction or future spoiler note must be refused.
        rc_pred, _, err_pred = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-question",
                "--book",
                "b-dune",
                "--answer",
                qid,
                "--note",
                "n-dune-pred",
            ]
        )
        self.assertEqual(rc_pred, 1)
        self.assertIn("spoiler-shielded", err_pred["error"])

        rc_fut, _, err_fut = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-question",
                "--book",
                "b-dune",
                "--answer",
                qid,
                "--note",
                "n-dune-future",
            ]
        )
        self.assertEqual(rc_fut, 1)
        self.assertIn("spoiler-shielded", err_fut["error"])

        # Answer with safe note, clear text & note with empty strings, reopen, then remove last.
        rc_ok, _, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-question",
                "--book",
                "b-dune",
                "--answer",
                qid,
                "--text",
                "Ecology controls Arrakis.",
                "--note",
                "ecological-lag",
            ]
        )
        self.assertEqual(rc_ok, 0)
        rc_clr, res_clr, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "book-question",
                "--book",
                "b-dune",
                "--answer",
                qid,
                "--text",
                "",
                "--note",
                "",
            ]
        )
        self.assertEqual(rc_clr, 0)
        self.assertNotIn("answer", res_clr["question"])
        self.assertNotIn("noteId", res_clr["question"])

        rc_re, res_re, _ = _run_cli(
            ["--state-file", str(self.state_path), "book-question", "--book", "b-dune", "--reopen", qid]
        )
        self.assertEqual(rc_re, 0)
        self.assertEqual(res_re["question"]["status"], "open")

        rc_rm, _, _ = _run_cli(
            ["--state-file", str(self.state_path), "book-question", "--book", "b-dune", "--remove", qid]
        )
        self.assertEqual(rc_rm, 0)
        snap = json.loads(self.state_path.read_text(encoding="utf-8"))
        dune = next(b for b in snap["books"] if b["id"] == "b-dune")
        self.assertNotIn("readingQuestions", dune["meta"])

        # Archived book refused on mutating book-question and recap --book
        rc_abq, _, err_abq = _run_cli(
            ["--state-file", str(self.state_path), "book-question", "--book", "b-arch", "--add", "Hi?"]
        )
        self.assertEqual(rc_abq, 1)
        self.assertIn("archived", err_abq["error"])

        rc_arec, _, err_arec = _run_cli(
            ["--state-file", str(self.state_path), "recap", "--book", "b-arch", "--today", "2026-11-20"]
        )
        self.assertEqual(rc_arec, 1)
        self.assertIn("archived", err_arec["error"])

        # Invalid --today and --days rejected cleanly
        rc_bad_date, _, _ = _run_cli(["--state-file", str(self.state_path), "recap", "--today", "2026-13-45"])
        self.assertEqual(rc_bad_date, 1)
        rc_bad_days, _, _ = _run_cli(["--state-file", str(self.state_path), "salon", "--days", "0"])
        self.assertEqual(rc_bad_days, 1)

        # 2. note-link --one-way, --why "" clear, no-op re-link, and export-md hiding shielded bridge targets
        rc_1w, res_1w, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "note-link",
                "--note",
                "n-sys-1",
                "--to",
                "n-dune-future",
                "--why",
                "SPOILER BRIDGE REASON",
                "--one-way",
                "--include-spoilers",
            ]
        )
        self.assertEqual(rc_1w, 0)
        self.assertEqual(res_1w["updatedNoteIds"], ["n-sys-1"])

        # Re-linking same pair with same why is a no-op (changed=False).
        rc_noop, res_noop, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "note-link",
                "--note",
                "n-sys-1",
                "--to",
                "n-dune-future",
                "--one-way",
                "--include-spoilers",
            ]
        )
        self.assertEqual(rc_noop, 0)
        self.assertFalse(res_noop["changed"])

        # export-md WITHOUT --include-spoilers must NOT leak future-spoiler-note or its bridge reason in feedback-delays.md!
        out_dir = self.tmp / "md_shield"
        rc_ex1, _, _ = _run_cli(
            ["--state-file", str(self.state_path), "export-md", "--output-dir", str(out_dir)]
        )
        self.assertEqual(rc_ex1, 0)
        md_safe = (out_dir / "feedback-delays.md").read_text(encoding="utf-8")
        self.assertNotIn("future-spoiler-note", md_safe)
        self.assertNotIn("SPOILER BRIDGE REASON", md_safe)

        # Clearing --why with "" keeps link while removing bridgeNotes entry.
        rc_cw, _, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "note-link",
                "--note",
                "n-sys-1",
                "--to",
                "n-dune-future",
                "--why",
                "",
                "--one-way",
                "--include-spoilers",
            ]
        )
        self.assertEqual(rc_cw, 0)
        snap2 = json.loads(self.state_path.read_text(encoding="utf-8"))
        n_sys_after = next(n for n in snap2["notes"] if n["id"] == "n-sys-1")
        self.assertEqual(n_sys_after["meta"]["relatedSlugs"], ["future-spoiler-note"])
        self.assertNotIn("bridgeNotes", n_sys_after["meta"])

        # Targeted ocr-backfill on a shielded note without --include-spoilers must NOT leak slug in skippedSlugs.
        rc_os, res_os, _ = _run_cli(
            [
                "--state-file",
                str(self.state_path),
                "ocr-backfill",
                "--note",
                "n-dune-future",
                "--ocr-text",
                "Nope",
            ]
        )
        self.assertEqual(rc_os, 0)
        self.assertEqual(res_os["updatedCount"], 0)
        self.assertEqual(res_os["shieldedCount"], 1)
        self.assertEqual(res_os["skippedSlugs"], [])

    def test_note_link_and_book_question_enforce_atomic_conflict_guard(self) -> None:
        snap = _base_snapshot()

        class ConflictSheetsRunner:
            def __init__(self, bump_note_id: str | None = None, bump_book_id: str | None = None) -> None:
                self.bump_note_id = bump_note_id
                self.bump_book_id = bump_book_id
                self.notes_reads = 0
                self.books_reads = 0
                self.raw_batches: list[dict[str, Any]] = []
                self.rows = {
                    "Books": [pragya_cli.BOOKS_HEADERS] + [pragya_cli.book_to_row(b) for b in snap["books"]],
                    "Notes": [pragya_cli.NOTES_HEADERS] + [pragya_cli.note_to_row(n) for n in snap["notes"]],
                    "Sessions": [pragya_cli.SESSIONS_HEADERS],
                    "DeltaLogs": [pragya_cli.DELTA_LOGS_HEADERS],
                }

            def __call__(self, cmd: list[str]) -> tuple[int, str, str]:
                if cmd[:3] == ["gsheets", "readonly", "list-sheets"]:
                    sheets = [
                        {"properties": {"sheetId": idx + 1, "title": title}}
                        for idx, title in enumerate(("Books", "Notes", "Sessions", "DeltaLogs"))
                    ]
                    return 0, json.dumps({"sheets": sheets}), ""
                if cmd[:3] == ["gsheets", "readonly", "read"]:
                    tab = cmd[4].split("!")[0]
                    if tab == "Notes":
                        self.notes_reads += 1
                        if self.notes_reads == 2 and self.bump_note_id:
                            for row in self.rows["Notes"][1:]:
                                if row[0] == self.bump_note_id:
                                    row[4] = "2099-01-01T00:00:00.000Z"
                    if tab == "Books":
                        self.books_reads += 1
                        if self.books_reads == 2 and self.bump_book_id:
                            for row in self.rows["Books"][1:]:
                                if row[0] == self.bump_book_id:
                                    meta = json.loads(row[11])
                                    meta["updatedAt"] = "2099-01-01T00:00:00.000Z"
                                    row[11] = json.dumps(meta)
                    return 0, json.dumps({"values": self.rows[tab]}), ""
                if cmd[:3] == ["gsheets", "mutate", "raw-batch"]:
                    body = json.loads(Path(cmd[cmd.index("-f") + 1]).read_text(encoding="utf-8"))
                    self.raw_batches.append(body)
                    return 0, json.dumps({"ok": True}), ""
                return 1, "", f"Unexpected cmd: {cmd}"

        # Conflict on second note (n-dune-1) aborts atomic batch with ZERO writes.
        runner_n = ConflictSheetsRunner(bump_note_id="n-dune-1")
        rc_nc, _, err_nc = _run_cli(
            [
                "--spreadsheet-id",
                "sid-v2",
                "note-link",
                "--note",
                "n-sys-1",
                "--to",
                "n-dune-1",
                "--why",
                "Lag",
            ],
            runner=runner_n,
        )
        self.assertEqual(rc_nc, 1)
        self.assertIn("Row conflict", err_nc.get("error", ""))
        self.assertEqual(len(runner_n.raw_batches), 0)

        # Conflict on Books row aborts book-question with ZERO writes.
        runner_b = ConflictSheetsRunner(bump_book_id="b-sys")
        rc_bc, _, err_bc = _run_cli(
            [
                "--spreadsheet-id",
                "sid-v2",
                "book-question",
                "--book",
                "b-sys",
                "--add",
                "Why do loops oscillate?",
            ],
            runner=runner_b,
        )
        self.assertEqual(rc_bc, 1)
        self.assertIn("Row conflict", err_bc.get("error", ""))
        self.assertEqual(len(runner_b.raw_batches), 0)


class TestV2TsPythonParity(unittest.TestCase):
    def test_v2_domain_helpers_match_ts_exactly(self) -> None:
        node_bin = shutil.which("node")
        if not node_bin:
            self.skipTest("node not available for TS <-> Python parity check")

        snap = _base_snapshot()
        snap["books"][0]["meta"]["readingQuestions"] = [
            {"id": "q_11111111", "question": "Why lag?", "status": "open", "createdAt": "2026-11-18T00:00:00Z"},
            {"bad": True},
        ]
        snap["books"].append(
            {
                "id": "b-craft",
                "title": "The Timeless Way of Building",
                "author": "Christopher Alexander",
                "format": "physical",
                "kind": "nonfiction",
                "status": "reading",
                "currentPos": 40,
                "totalPos": 200,
                "posUnit": "page",
                "normalizedPos": 0.2,
                "docUrl": "",
                "meta": {"updatedAt": "2026-11-18T00:00:00.000Z"},
            }
        )
        snap["books"].append(
            {
                "id": "b-queue-tag",
                "title": "Delays in Systems Design",
                "author": "Jane Doe",
                "format": "physical",
                "kind": "nonfiction",
                "status": "queued",
                "currentPos": 0,
                "totalPos": 250,
                "posUnit": "page",
                "normalizedPos": 0,
                "docUrl": "",
                "meta": {"updatedAt": "2026-11-03T10:00:00.000Z"},
            }
        )
        snap["notes"].extend(
            [
                {
                    "id": "n-craft-1",
                    "slug": "pattern-languages",
                    "bookId": "b-craft",
                    "createdAt": "2026-11-15T10:00:00.000Z",
                    "updatedAt": "2026-11-15T10:00:00.000Z",
                    "pos": 20,
                    "normalizedPos": 0.1,
                    "status": "atomic",
                    "source": "app",
                    "tags": ["#systems", "#patterns"],
                    "quote": "",
                    "takeaway": "Living patterns emerge from recurring local forces.",
                    "contextMechanism": "",
                    "critique": "",
                    "deltaTrigger": "",
                    "deltaAction": "",
                    "deltaStatus": "none",
                    "meta": {
                        "relatedSlugs": ["feedback-delays"],
                        "bridgeNotes": {"feedback-delays": "Recurring local feedback"},
                        "attachments": [],
                        "links": [],
                    },
                },
                {
                    "id": "n-sys-2",
                    "slug": "leverage-points",
                    "bookId": "b-sys",
                    "createdAt": "2026-11-16T10:00:00.000Z",
                    "updatedAt": "2026-11-16T10:00:00.000Z",
                    "pos": 100,
                    "normalizedPos": 0.416667,
                    "status": "atomic",
                    "source": "app",
                    "tags": ["#delays", "#systems"],
                    "quote": "",
                    "takeaway": "Changing goals beats tweaking constants.",
                    "contextMechanism": "",
                    "critique": "",
                    "deltaTrigger": "",
                    "deltaAction": "",
                    "deltaStatus": "none",
                    "meta": {"attachments": [], "links": []},
                },
            ]
        )

        dates = [f"2026-11-{day:02d}" for day in range(11, 21)]
        py_pairs = {
            d: (
                lambda p: None
                if p is None
                else {
                    "pairKey": p["pairKey"],
                    "a": p["noteA"]["id"],
                    "b": p["noteB"]["id"],
                    "total": p["totalCandidates"],
                }
            )(pragya_cli.select_daily_collision_pair(snap["notes"], snap["books"], d))
            for d in dates
        }
        py_echo_ids = [
            e["note"]["id"]
            for e in pragya_cli.find_cross_book_echoes(snap["books"][0], snap["notes"], snap["books"], 3)
        ]
        py_pace = pragya_cli.compute_sitting_pace(snap["books"][0], snap["sessions"])
        py_next = [
            {"id": c["book"]["id"], "role": c["role"], "reason": c["reason"]}
            for c in pragya_cli.pick_next_read_candidates(snap["books"], snap["notes"], snap["books"][0])
        ]
        py_bridge_ops = pragya_cli.plan_note_bridge_ops(
            snap["notes"][0],
            snap["notes"][1],
            snap["notes"],
            snap["books"],
            mode="link",
            why="Shared lag dynamics",
            now_iso="2026-11-20T18:00:00.000Z",
        )
        py_bridge_summary = [
            {
                "id": n["id"],
                "relatedSlugs": n["meta"].get("relatedSlugs"),
                "bridgeNotes": n["meta"].get("bridgeNotes"),
            }
            for n, _ in py_bridge_ops
        ]
        craft_note = next(n for n in snap["notes"] if n["id"] == "n-craft-1")
        py_wikis = pragya_cli.extract_note_wikilinks(craft_note)
        py_wiki_keys = sorted(pragya_cli.extract_note_wikilink_keys(craft_note))
        py_qs = pragya_cli.get_book_reading_questions(snap["books"][0]["meta"])

        ts_script = """
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pragya_parity_'));
const bundle = (entry, out) => {
  buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out });
  return import(pathToFileURL(out).href);
};
const synth = await bundle('src/utils/crossBookSynthesis.ts', path.join(tmp, 'synth.mjs'));
const mom = await bundle('src/utils/readingMomentum.ts', path.join(tmp, 'mom.mjs'));
const wiki = await bundle('src/utils/wikilinks.ts', path.join(tmp, 'wiki.mjs'));
const codecs = await bundle('src/utils/metaCodecs.ts', path.join(tmp, 'codecs.mjs'));

const pairs = {};
for (const d of payload.dates) {
  const p = synth.selectDailyCollisionPair(payload.snap.notes, payload.snap.books, d);
  pairs[d] = p ? { pairKey: p.pairKey, a: p.noteA.id, b: p.noteB.id, total: p.totalCandidates } : null;
}
const echoIds = synth.findCrossBookEchoes(payload.snap.books[0], payload.snap.notes, payload.snap.books, 3).map(e => e.note.id);
const pace = mom.computeSittingPace(payload.snap.books[0], payload.snap.sessions);
const nextReads = mom.pickNextReadCandidates(payload.snap.books, payload.snap.notes, payload.snap.books[0]).map(c => ({
  id: c.book.id, role: c.role, reason: c.reason,
}));
const bridgePlan = synth.planNoteBridgeOps(
  payload.snap.notes[0],
  payload.snap.notes[1],
  payload.snap.notes,
  payload.snap.books,
  { mode: 'link', why: 'Shared lag dynamics', nowIso: '2026-11-20T18:00:00.000Z' }
);
const bridgeSummary = bridgePlan.nextNotes.map(n => ({
  id: n.id,
  relatedSlugs: n.meta.relatedSlugs,
  bridgeNotes: n.meta.bridgeNotes,
}));
const craftNote = payload.snap.notes.find(n => n.id === 'n-craft-1');
const wikis = wiki.extractNoteWikilinks(craftNote);
const wikiKeys = Array.from(wiki.extractNoteWikilinkKeys(craftNote)).sort();
const qs = codecs.getBookReadingQuestions(payload.snap.books[0].meta);
process.stdout.write(JSON.stringify({ pairs, echoIds, pace, nextReads, bridgeSummary, wikis, wikiKeys, qs }));
fs.rmSync(tmp, { recursive: true, force: true });
"""
        proc = subprocess.run(
            [node_bin, "--input-type=module", "-e", ts_script],
            input=json.dumps({"snap": snap, "dates": dates}),
            text=True,
            capture_output=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        ts_out = json.loads(proc.stdout)
        self.assertEqual(py_pairs, ts_out["pairs"])
        self.assertEqual(py_echo_ids, ts_out["echoIds"])
        self.assertEqual(py_pace["label"], ts_out["pace"]["label"])
        self.assertEqual(py_next, ts_out["nextReads"])
        self.assertEqual(py_bridge_summary, ts_out["bridgeSummary"])
        self.assertEqual(py_wikis, ts_out["wikis"])
        self.assertEqual(py_wiki_keys, ts_out["wikiKeys"])
        self.assertEqual(py_qs, ts_out["qs"])


if __name__ == "__main__":
    unittest.main()

