"""The skill module against the module replies of the host link fixture (tests/fixtures/host-link.json)."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_switchboard as base  # noqa: E402
import switchboard  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tests", "fixtures", "host-link.json")


def module_replies():
    with open(FIXTURE, encoding="utf-8") as fixture:
        replies = json.load(fixture)["module_replies"]
    assert replies, "the fixture lists module replies"
    return replies


class HostLinkFixtureTest(base.ModuleTestCase):
    def test_the_skill_prints_its_line_for_each_reply_the_service_makes(self):
        mode = {}
        self.host(reply=lambda request: mode["reply"])
        lined = [entry for entry in module_replies() if "skill_line" in entry]
        self.assertTrue(lined, "the fixture pins at least one line")
        for entry in lined:
            with self.subTest(entry["name"]):
                mode["reply"] = entry["reply"]
                _, line = self.run_call(getattr(switchboard, entry["call"]), "Found it.")
                self.assertEqual(line, entry["skill_line"])


if __name__ == "__main__":
    base.unittest.main()
