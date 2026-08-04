import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.history import AGENT, CALLER, TranscriptLog  # noqa: E402


class TranscriptLogTest(unittest.TestCase):
    def test_records_in_order_with_role_and_route(self):
        log = TranscriptLog()
        log.add(CALLER, "what is on fire")
        log.add(AGENT, "nothing", route="homelab")

        entries = log.entries()
        self.assertEqual([e["role"] for e in entries], [CALLER, AGENT])
        self.assertEqual(entries[1]["route"], "homelab")
        self.assertGreater(entries[0]["ts"], 0)

    def test_blank_text_is_not_recorded(self):
        log = TranscriptLog()
        self.assertIsNone(log.add(CALLER, "   "))
        self.assertIsNone(log.add(CALLER, ""))
        self.assertEqual(log.entries(), [])

    def test_text_is_stripped(self):
        log = TranscriptLog()
        entry = log.add(CALLER, "  hello  ")
        assert entry is not None
        self.assertEqual(entry["text"], "hello")

    def test_oldest_entries_fall_off_at_the_limit(self):
        log = TranscriptLog(limit=3)
        for i in range(5):
            log.add(CALLER, str(i))

        self.assertEqual([e["text"] for e in log.entries()], ["2", "3", "4"])
        self.assertEqual(log.limit, 3)

    def test_payload_is_the_websocket_message(self):
        log = TranscriptLog()
        log.add(CALLER, "hi")

        payload = log.payload()
        self.assertEqual(payload["type"], "history")
        self.assertEqual(len(payload["entries"]), 1)

    def test_entries_are_a_copy(self):
        log = TranscriptLog()
        log.add(CALLER, "hi")
        log.entries().clear()
        self.assertEqual(len(log.entries()), 1)


if __name__ == "__main__":
    unittest.main()
