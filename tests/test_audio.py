"""Shaping a written reply into something worth hearing."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.audio import Speaker  # noqa: E402


def speaker(max_chars=100):
    return Speaker("k", "v", "m", max_chars=max_chars)


class ClipTests(unittest.TestCase):
    def test_short_replies_pass_through_untouched(self):
        self.assertEqual(speaker().clip_for_speech("Ready on grapes."), "Ready on grapes.")

    def test_whitespace_is_collapsed(self):
        # Markdown-shaped replies arrive full of newlines; TTS should not pause
        # on them.
        self.assertEqual(speaker().clip_for_speech("Line one.\n\n  Line two."), "Line one. Line two.")

    def test_none_and_empty_are_safe(self):
        self.assertEqual(speaker().clip_for_speech(""), "")
        self.assertEqual(speaker().clip_for_speech(None), "")

    def test_long_replies_are_cut_and_say_so(self):
        text = "word " * 200
        spoken = speaker().clip_for_speech(text)
        self.assertLess(len(spoken), 160)
        self.assertTrue(spoken.endswith("there's more on screen."))

    def test_cut_prefers_a_sentence_boundary(self):
        text = "First sentence here. " + ("padding " * 40)
        spoken = speaker(max_chars=60).clip_for_speech(text)
        self.assertTrue(spoken.startswith("First sentence here."))
        self.assertIn("more on screen", spoken)

    def test_cut_does_not_end_mid_word(self):
        # No sentence break in range, so it falls back to a word boundary.
        spoken = speaker(max_chars=40).clip_for_speech("supercalifragilistic " * 10)
        head = spoken.replace(" — there's more on screen.", "")
        self.assertFalse(head.endswith("supercalifragilisti"))
        for word in head.split():
            self.assertEqual(word, "supercalifragilistic")

    def test_an_early_sentence_break_is_not_used_to_gut_the_reply(self):
        # "OK." at the start must not reduce a 100-char budget to 3 characters.
        text = "OK. " + ("detail " * 30)
        spoken = speaker(max_chars=100).clip_for_speech(text)
        self.assertGreater(len(spoken), 50)


class ConfiguredTests(unittest.TestCase):
    def test_missing_key_is_reported_not_assumed(self):
        self.assertFalse(Speaker("", "v", "m").configured)
        self.assertTrue(Speaker("k", "v", "m").configured)


if __name__ == "__main__":
    unittest.main()
