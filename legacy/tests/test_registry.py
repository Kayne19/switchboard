"""Project resolution — the operator is matching against speech, not typing."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.registry import Project, Registry  # noqa: E402


def build(projects):
    return Registry([Project(**p) for p in projects])


GRAPES = {
    "id": "grape-segmentation",
    "aliases": ["grape segmentation", "grapes", "the grape project"],
    "host": "scriptorium",
    "cwd": "/root/grape-segmentation",
}
LEDGER = {"id": "ledger", "aliases": ["the ledger", "accounts"], "cwd": "/srv/ledger"}


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.registry = build([GRAPES, LEDGER])

    def test_exact_id(self):
        project = self.registry.resolve("grape-segmentation")
        assert project is not None
        self.assertEqual(project.id, "grape-segmentation")

    def test_alias(self):
        project = self.registry.resolve("grapes")
        assert project is not None
        self.assertEqual(project.id, "grape-segmentation")

    def test_punctuation_and_case_are_ignored(self):
        # Whisper punctuates and capitalizes; the registry does not care.
        project = self.registry.resolve("Grape Segmentation.")
        assert project is not None
        self.assertEqual(project.id, "grape-segmentation")

    def test_caller_said_more_than_the_alias(self):
        project = self.registry.resolve("put me into the grape segmentation project")
        assert project is not None
        self.assertEqual(project.id, "grape-segmentation")

    def test_caller_said_less_than_the_alias(self):
        project = self.registry.resolve("grape")
        assert project is not None
        self.assertEqual(project.id, "grape-segmentation")

    def test_unknown_project(self):
        self.assertIsNone(self.registry.resolve("the tomato thing"))

    def test_empty_input(self):
        self.assertIsNone(self.registry.resolve(""))
        self.assertIsNone(self.registry.resolve("   "))

    def test_ambiguous_match_refuses_to_guess(self):
        # Both projects contain "the", so a bare "the" must not silently pick one.
        registry = build(
            [
                {"id": "alpha", "aliases": ["the thing"]},
                {"id": "beta", "aliases": ["the other"]},
            ]
        )
        self.assertIsNone(registry.resolve("the"))

    def test_duplicate_alias_keeps_the_first_project(self):
        registry = build(
            [
                {"id": "alpha", "aliases": ["shared"]},
                {"id": "beta", "aliases": ["shared"]},
            ]
        )
        project = registry.resolve("shared")
        assert project is not None
        self.assertEqual(project.id, "alpha")


class LoadTests(unittest.TestCase):
    def _write(self, payload):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            json.dump(payload, tmp)
            return tmp.name

    def test_loads_the_rendered_shape(self):
        path = self._write({"projects": [GRAPES]})
        registry = Registry.load(path)
        self.assertEqual([p.id for p in registry.projects], ["grape-segmentation"])
        self.assertTrue(registry.projects[0].is_remote)

    def test_missing_file_is_survivable(self):
        # An operator with no registry should still answer the phone and say so,
        # not crash the service at import time.
        registry = Registry.load("/nonexistent/projects.json")
        self.assertEqual(registry.projects, [])
        self.assertIsNone(registry.resolve("anything"))

    def test_malformed_entries_are_skipped_not_fatal(self):
        path = self._write({"projects": [GRAPES, {"no_id": True}, "nonsense"]})
        registry = Registry.load(path)
        self.assertEqual([p.id for p in registry.projects], ["grape-segmentation"])

    def test_unknown_keys_are_ignored(self):
        # A future field in defaults must not take the switchboard down.
        path = self._write({"projects": [{**GRAPES, "future_option": 3}]})
        registry = Registry.load(path)
        self.assertEqual(len(registry.projects), 1)

    def test_broken_json_is_survivable(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            tmp.write("{not json")
            path = tmp.name
        self.assertEqual(Registry.load(path).projects, [])

    def test_local_project_is_not_remote(self):
        path = self._write({"projects": [LEDGER]})
        self.assertFalse(Registry.load(path).projects[0].is_remote)


if __name__ == "__main__":
    unittest.main()
