"""CD Batch 2: CLI parity for same-day delta check-in coalescing (decisions OQ-5).

Mirror of `planDeltaCheckIn` (src/utils/deltaCheckIn.ts, tests/unit/cd2PracticeCapture.test.mjs):
one DeltaLogs row per note per local day; a later same-day `recall --mode checkin` updates it.
Offline, state-file based.
"""

from __future__ import annotations

import json
import unittest

from test_pragya_cli import pragya_cli
from test_pragya_cli_m6_recall import RecallBase, _book, _note


class TestPlanDeltaCheckin(unittest.TestCase):
    T = "2026-11-18"

    def test_append_update_unchanged(self):
        plan = pragya_cli.plan_delta_checkin
        a = plan([{"id": "o", "noteId": "n1", "date": "2026-11-17", "outcome": "missed", "reflection": ""}],
                 "n1", self.T, "applied", "new", None)
        self.assertEqual(a["kind"], "append")
        self.assertEqual(a["log"], {"id": "new", "noteId": "n1", "date": self.T, "outcome": "applied", "reflection": ""})

        logs = [
            {"id": "d1", "noteId": "n1", "date": self.T, "outcome": "applied", "reflection": "first"},
            {"id": "d2", "noteId": "n1", "date": self.T, "outcome": "applied", "reflection": "kept"},
        ]
        u = plan(logs, "n1", self.T, "no-trigger", "x", None)
        self.assertEqual(u["kind"], "update")
        self.assertEqual(u["log"]["id"], "d2", "legacy duplicates: the LAST row is updated")
        self.assertEqual(u["log"]["reflection"], "kept")
        self.assertEqual(plan(logs, "n1", self.T, "applied", "x", "  ")["kind"], "unchanged")
        r = plan(logs, "n1", self.T, "applied", "x", "new words")
        self.assertEqual((r["kind"], r["log"]["reflection"]), ("update", "new words"))

    def test_timestamp_dates_use_the_local_day_key(self):
        # CD 2 fix-up R1#4: same rule as toLocalDateKey (06:30Z is the previous day in Pacific).
        from test_pragya_cli_cd1 import _PacificTZ

        logs = [{"id": "t", "noteId": "n1", "date": "2026-11-18T06:30:00Z", "outcome": "applied", "reflection": ""}]
        with _PacificTZ():
            plan = pragya_cli.plan_delta_checkin
            self.assertEqual(plan(logs, "n1", "2026-11-17", "missed", "x")["kind"], "update")
            self.assertEqual(plan(logs, "n1", "2026-11-18", "missed", "x")["kind"], "append")


class TestCheckinCoalescingCli(RecallBase):
    def setUp(self):
        super().setUp()
        self.write_state(
            books=[_book(kind="nonfiction")],
            notes=[_note(status="atomic", deltaStatus="active", deltaTrigger="x", deltaAction="y")],
        )

    def logs(self):
        return self.read_state()["deltaLogs"]

    def test_second_same_day_checkin_updates_the_row(self):
        first = self.ok("recall", "--mode", "checkin", "--note", "note-1", "--outcome", "applied",
                        "--reflection", "worked")
        self.assertEqual(first["checkin"], "append")
        second = self.ok("recall", "--mode", "checkin", "--note", "note-1", "--outcome", "missed")
        self.assertEqual(second["checkin"], "update")
        logs = self.logs()
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["outcome"], "missed")
        self.assertEqual(logs[0]["reflection"], "worked")
        self.assertEqual(logs[0]["id"], first["logged"]["id"])
        same = self.ok("recall", "--mode", "checkin", "--note", "note-1", "--outcome", "missed")
        self.assertEqual(same["checkin"], "unchanged")
        self.assertEqual(len(self.logs()), 1)

    def test_previous_day_row_is_never_touched(self):
        state = self.read_state()
        state["deltaLogs"] = [{"id": "old", "noteId": "note-1", "date": "2000-01-01", "outcome": "applied", "reflection": ""}]
        self.state.write_text(json.dumps(state), encoding="utf-8")
        res = self.ok("recall", "--mode", "checkin", "--note", "note-1", "--outcome", "no-trigger")
        self.assertEqual(res["checkin"], "append")
        logs = self.logs()
        self.assertEqual(len(logs), 2)
        self.assertEqual(next(l for l in logs if l["id"] == "old")["outcome"], "applied")


if __name__ == "__main__":
    unittest.main()
