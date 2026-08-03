"""Resolving a spoken model name. The failure that matters is a wrong answer.

Refusing is cheap: the caller says which one they meant. Landing on the wrong
provider is not — the leg comes up looking healthy and the caller only finds out
by talking to it, on the model they were trying to get away from.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.models import (  # noqa: E402
    ModelCatalog,
    ModelError,
    normalize_thinking,
    parse_spec,
    pin_thinking,
)

TABLE = """provider   model                       context  max-out  thinking  images
anthropic  claude-opus-5               1M       128K     yes       yes
anthropic  claude-sonnet-5             1M       128K     yes       yes
anthropic  claude-sonnet-4-5           1M       64K      yes       yes
openai     gpt-5.5                     400K     128K     yes       yes
openai     claude-sonnet-5             1M       128K     yes       yes
groq       llama-4-fast                128K     8K       no        no
"""


class SpecTests(unittest.TestCase):
    def test_a_full_spec_splits_into_its_three_parts(self):
        self.assertEqual(parse_spec("anthropic/claude-opus-5:high"), ("anthropic", "claude-opus-5", "high"))

    def test_a_bare_model_has_no_provider(self):
        self.assertEqual(parse_spec("claude-opus-5"), ("", "claude-opus-5", ""))

    def test_nothing_in_nothing_out(self):
        self.assertEqual(parse_spec("  "), ("", "", ""))


class ThinkingTests(unittest.TestCase):
    def test_a_level_survives_the_words_around_it(self):
        # What arrives is a transcript, not a flag.
        self.assertEqual(normalize_thinking("reasoning high"), "high")
        self.assertEqual(normalize_thinking("set thinking to medium"), "medium")

    def test_spoken_synonyms_land_on_real_levels(self):
        self.assertEqual(normalize_thinking("maximum"), "max")
        self.assertEqual(normalize_thinking("extra high"), "xhigh")
        self.assertEqual(normalize_thinking("none"), "off")

    def test_an_empty_level_means_leave_it_alone(self):
        self.assertEqual(normalize_thinking(""), "")

    def test_an_invented_level_is_refused_with_the_real_ones(self):
        with self.assertRaises(ModelError) as caught:
            normalize_thinking("ludicrous")
        self.assertIn("xhigh", str(caught.exception))


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.catalog = ModelCatalog.parse(TABLE)

    def test_the_header_row_is_not_a_model(self):
        self.assertEqual(len(self.catalog.entries), 6)

    def test_an_unambiguous_name_resolves_provider_qualified(self):
        # The spec handed to the runtime always names a provider, even when the
        # caller did not: that is what stops a later catalog change from
        # silently moving the leg somewhere else.
        self.assertEqual(self.catalog.resolve("opus 5").spec, "anthropic/claude-opus-5")

    def test_spoken_digits_and_separators_do_not_matter(self):
        self.assertEqual(self.catalog.resolve("claude opus five").spec, "anthropic/claude-opus-5")

    def test_one_model_on_two_providers_is_refused_with_both(self):
        # The exact case that leaves a caller stuck: pick wrong and they are on
        # the thing they asked to leave.
        with self.assertRaises(ModelError) as caught:
            self.catalog.resolve("sonnet 5")
        message = str(caught.exception)
        self.assertIn("anthropic/claude-sonnet-5", message)
        self.assertIn("openai/claude-sonnet-5", message)

    def test_naming_the_provider_settles_it(self):
        self.assertEqual(self.catalog.resolve("openai/sonnet 5").spec, "openai/claude-sonnet-5")

    def test_an_exact_id_beats_the_models_it_is_a_prefix_of(self):
        # "claude-sonnet-4-5" is a substring of nothing else here, but the rule
        # that matters is that an exact hit never widens into a fuzzy one.
        self.assertEqual(
            self.catalog.resolve("anthropic/claude-sonnet-4-5").spec,
            "anthropic/claude-sonnet-4-5",
        )

    def test_a_thinking_level_rides_on_the_spec(self):
        self.assertEqual(
            self.catalog.resolve("opus 5", "high").spec, "anthropic/claude-opus-5:high"
        )

    def test_an_explicit_level_overrides_one_carried_in_the_spec(self):
        self.assertEqual(
            self.catalog.resolve("anthropic/claude-opus-5:low", "max").spec,
            "anthropic/claude-opus-5:max",
        )

    def test_a_model_that_cannot_think_refuses_a_level(self):
        with self.assertRaises(ModelError):
            self.catalog.resolve("llama 4 fast", "high")

    def test_a_model_that_cannot_think_is_still_fine_without_one(self):
        self.assertEqual(self.catalog.resolve("llama 4 fast").spec, "groq/llama-4-fast")

    def test_an_unknown_model_is_refused(self):
        with self.assertRaises(ModelError):
            self.catalog.resolve("gemini")

    def test_an_unknown_provider_is_refused_with_the_real_ones(self):
        with self.assertRaises(ModelError) as caught:
            self.catalog.resolve("bedrock/claude-opus-5")
        self.assertIn("anthropic", str(caught.exception))

    def test_no_model_named_at_all_is_refused(self):
        with self.assertRaises(ModelError):
            self.catalog.resolve("")


class EmptyCatalogTests(unittest.TestCase):
    """The host could not be asked what it runs. Degrade, do not guess."""

    def setUp(self):
        self.catalog = ModelCatalog([])

    def test_a_provider_qualified_spec_is_passed_through(self):
        # Unambiguous by construction; the runtime can reject it itself.
        self.assertEqual(
            self.catalog.resolve("anthropic/claude-opus-5", "high").spec,
            "anthropic/claude-opus-5:high",
        )

    def test_a_bare_name_is_refused_rather_than_guessed(self):
        with self.assertRaises(ModelError):
            self.catalog.resolve("opus 5")


class PinThinkingTests(unittest.TestCase):
    """Nothing runs at an unnamed level, and nothing overrides a named one."""

    def test_a_spec_without_a_level_gets_the_configured_one(self):
        self.assertEqual(
            pin_thinking("anthropic/claude-opus-5", "medium"), "anthropic/claude-opus-5:medium"
        )

    def test_a_level_already_on_the_spec_wins(self):
        self.assertEqual(
            pin_thinking("anthropic/claude-opus-5:max", "medium"), "anthropic/claude-opus-5:max"
        )

    def test_nothing_is_invented_when_there_is_no_model_or_no_level(self):
        self.assertEqual(pin_thinking("", "medium"), "")
        self.assertEqual(pin_thinking("anthropic/claude-opus-5", ""), "anthropic/claude-opus-5")


if __name__ == "__main__":
    unittest.main()
