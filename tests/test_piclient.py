"""Reading pi's RPC event stream: what gets spoken, and what moves the caller.

No pi process is involved — the tests feed a synthetic event stream through the
same parser the real one goes through.
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.piclient import (  # noqa: E402
    RETURN_SENTINEL,
    RETURN_TOOL,
    SPEAK_TOOL,
    TRANSFER_TOOL,
    PiSession,
    local_argv,
    remote_argv,
)


def text_end(content):
    return {
        "type": "message_update",
        "assistantMessageEvent": {"type": "text_end", "contentIndex": 0, "content": content},
    }


def tool_start(name, args):
    return {"type": "tool_execution_start", "toolCallId": "c1", "toolName": name, "args": args}


def failed_message(error):
    """A model call that failed, shaped as pi actually reports it.

    Taken off a real leg: the assistant message is empty, no tokens were spent,
    and the turn goes on to settle exactly like a healthy one.
    """
    return {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [],
            "provider": "anthropic",
            "model": "claude-opus-5",
            "usage": {"input": 0, "output": 0, "totalTokens": 0},
            "stopReason": "error",
            "errorMessage": error,
        },
    }


async def collect_from(events, *, truncate=False):
    """Run the real _collect over a canned event stream."""
    reader = asyncio.StreamReader()
    payload = "".join(json.dumps(e) + "\n" for e in events)
    reader.feed_data(payload.encode())
    if not truncate:
        pass
    reader.feed_eof()

    session = PiSession(["true"], label="test")
    session._proc = SimpleNamespace(stdout=reader)
    return await session._collect()


class CollectTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_text_blocks_become_the_reply(self):
        turn = await collect_from(
            [
                {"type": "agent_start"},
                text_end("Putting you through."),
                {"type": "agent_settled"},
            ]
        )
        self.assertEqual(turn.text, "Putting you through.")
        self.assertFalse(turn.failed)

    async def test_streaming_deltas_are_not_double_counted(self):
        # Only text_end carries the whole block; the deltas leading up to it must
        # be ignored or the reply is spoken twice.
        turn = await collect_from(
            [
                {
                    "type": "message_update",
                    "assistantMessageEvent": {"type": "text_delta", "delta": "Hel"},
                },
                {
                    "type": "message_update",
                    "assistantMessageEvent": {"type": "text_delta", "delta": "lo"},
                },
                text_end("Hello"),
                {"type": "agent_settled"},
            ]
        )
        self.assertEqual(turn.text, "Hello")

    async def test_a_failed_model_call_fails_the_turn(self):
        # The whole point: an expired token on a project host used to settle
        # cleanly with no text, which is indistinguishable from an agent that
        # had nothing to say — so the caller heard silence and stayed on a leg
        # that could never answer.
        turn = await collect_from(
            [
                {"type": "agent_start"},
                failed_message(
                    'OAuth refresh failed for anthropic: Anthropic token refresh request '
                    'failed. url=https://platform.claude.com/v1/oauth/token; details=Error: '
                    'HTTP request failed. status=400; body={"error": "invalid_grant"}'
                ),
                {"type": "agent_settled"},
            ]
        )
        self.assertTrue(turn.failed)
        self.assertEqual(turn.text, "")
        self.assertIn("OAuth refresh failed for anthropic", turn.error)
        # Diagnostics belong in the log, not read out down the phone.
        self.assertNotIn("status=400", turn.error)
        self.assertNotIn("https://", turn.error)

    async def test_a_healthy_message_end_is_not_a_failure(self):
        turn = await collect_from(
            [
                text_end("All good."),
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "All good."}],
                        "stopReason": "stop",
                    },
                },
                {"type": "agent_settled"},
            ]
        )
        self.assertFalse(turn.failed)
        self.assertEqual(turn.error, "")
        # message_end must not be harvested on top of text_end.
        self.assertEqual(turn.text, "All good.")

    async def test_a_users_own_message_end_is_never_a_failure(self):
        # Every turn echoes the caller's message back as a message_end too.
        turn = await collect_from(
            [
                {
                    "type": "message_end",
                    "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]},
                },
                text_end("Hello."),
                {"type": "agent_settled"},
            ]
        )
        self.assertFalse(turn.failed)
        self.assertEqual(turn.text, "Hello.")

    async def test_an_error_after_partial_work_keeps_what_landed(self):
        turn = await collect_from(
            [
                text_end("Starting on it."),
                tool_start(SPEAK_TOOL, {"text": "Starting on it."}),
                failed_message("Overloaded"),
                {"type": "agent_settled"},
            ]
        )
        self.assertTrue(turn.failed)
        self.assertEqual(turn.text, "Starting on it.")
        self.assertTrue(turn.agent_spoke)
        self.assertEqual(turn.error, "Overloaded")

    async def test_an_error_with_no_message_still_explains_itself(self):
        turn = await collect_from([failed_message(None), {"type": "agent_settled"}])
        self.assertTrue(turn.failed)
        self.assertEqual(turn.error, "the model call failed")

    async def test_transfer_signal_is_captured_with_args(self):
        turn = await collect_from(
            [
                text_end("One moment."),
                tool_start(TRANSFER_TOOL, {"project": "grapes", "intent": "fix the masks"}),
                {"type": "agent_settled"},
            ]
        )
        self.assertEqual([s.name for s in turn.signals], [TRANSFER_TOOL])
        self.assertEqual(turn.signals[0].args["project"], "grapes")
        self.assertEqual(turn.signals[0].args["intent"], "fix the masks")

    async def test_ordinary_tools_are_not_signals(self):
        turn = await collect_from(
            [
                tool_start("bash", {"command": "ls"}),
                text_end("Listed."),
                {"type": "agent_settled"},
            ]
        )
        self.assertEqual(turn.signals, [])

    async def test_sentinel_line_stands_in_for_the_return_tool(self):
        # The fallback for hosts where the pi extension could not be staged.
        turn = await collect_from(
            [text_end(f"All done here. {RETURN_SENTINEL}"), {"type": "agent_settled"}]
        )
        self.assertEqual([s.name for s in turn.signals], [RETURN_TOOL])
        self.assertNotIn(RETURN_SENTINEL, turn.text)
        self.assertEqual(turn.text, "All done here.")

    async def test_sentinel_does_not_double_up_with_the_real_tool(self):
        turn = await collect_from(
            [
                text_end(f"Bye. {RETURN_SENTINEL}"),
                tool_start(RETURN_TOOL, {"summary": "did the thing"}),
                {"type": "agent_settled"},
            ]
        )
        self.assertEqual(len(turn.signals), 1)
        self.assertEqual(turn.signals[0].args["summary"], "did the thing")

    async def test_stream_ending_before_settle_is_a_failed_turn(self):
        turn = await collect_from([text_end("Partial answer")])
        self.assertTrue(turn.failed)
        self.assertEqual(turn.text, "Partial answer")

    async def test_garbage_lines_are_skipped(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"not json at all\n")
        reader.feed_data((json.dumps(text_end("Fine.")) + "\n").encode())
        reader.feed_data((json.dumps({"type": "agent_settled"}) + "\n").encode())
        reader.feed_eof()
        session = PiSession(["true"], label="test")
        session._proc = SimpleNamespace(stdout=reader)
        turn = await session._collect()
        self.assertEqual(turn.text, "Fine.")
        self.assertFalse(turn.failed)


class ArgvTests(unittest.TestCase):
    def test_operator_argv_is_rpc_and_carries_the_extension(self):
        argv = local_argv(
            "pi",
            model="anthropic/claude-sonnet-5",
            system_prompt_file=None,
            extension="/opt/switchboard/pi-extensions/operator-switchboard.ts",
            extra_args=["--no-builtin-tools"],
        )
        self.assertEqual(argv[:3], ["pi", "--mode", "rpc"])
        self.assertIn("--no-builtin-tools", argv)
        self.assertIn("/opt/switchboard/pi-extensions/operator-switchboard.ts", argv)

    def test_remote_argv_cds_into_the_project_directory(self):
        argv = remote_argv(
            "scriptorium",
            "/root/grape-segmentation",
            binary="pi",
            model=None,
            extension=None,
            append_system_prompt="be brief",
        )
        self.assertEqual(argv[0], "ssh")
        self.assertIn("BatchMode=yes", argv)
        self.assertIn("scriptorium", argv)
        # The working directory is the entire point of the transfer.
        self.assertIn("cd /root/grape-segmentation", argv[-1])
        self.assertIn("--mode rpc", argv[-1])

    def test_remote_argv_exports_env_before_exec(self):
        argv = remote_argv(
            "familiar",
            "/home/kayne19/homelab",
            binary="/home/kayne19/.local/bin/pi",
            model=None,
            extension=None,
            append_system_prompt=None,
            env={"SWITCHBOARD_SPEAK_URL": "http://192.168.1.217:8765/speak"},
        )
        command = argv[-1]
        # `export NAME=value;` and not the `NAME=value cmd` prefix form: the
        # prefix form in front of `exec` makes the shell run the assignment.
        self.assertIn("export SWITCHBOARD_SPEAK_URL=", command)
        self.assertLess(command.index("export"), command.index("exec"))
        # A bad cwd must abort rather than start the agent in the wrong repo.
        self.assertTrue(command.startswith("set -e;"))
        self.assertIn("cd /home/kayne19/homelab", command)

    def test_remote_argv_quotes_hostile_paths(self):
        argv = remote_argv(
            "scriptorium",
            "/tmp/a b; rm -rf /",
            binary="pi",
            model=None,
            extension=None,
            append_system_prompt=None,
        )
        # The path must survive as one argument, not become a second command.
        self.assertIn("'/tmp/a b; rm -rf /'", argv[-1])


class SilenceTests(unittest.IsolatedAsyncioTestCase):
    """What happens when an agent stops talking mid-turn.

    This is the failure that used to strand a caller for the rest of the call:
    the deadline was on the whole turn, so a healthy turn that took a while was
    killed; killing it cancelled the reader mid-stream while the agent kept
    writing, so every later prompt read the previous turn's tail; and the timed
    out turn carried a canned line as its text, which is exactly what the
    switchboard's recovery path checks for the absence of. Nothing recovered.
    """

    def _session(self, timeout):
        reader = asyncio.StreamReader()
        session = PiSession(["true"], label="test", turn_timeout=timeout)
        # Enough of a process for close() to run against, since the timeout path
        # now tears the leg down. A bare stub hides whether that path works.
        killed = []

        async def wait():
            proc.returncode = -15

        proc = SimpleNamespace(
            stdout=reader,
            returncode=None,
            stdin=SimpleNamespace(is_closing=lambda: False, close=lambda: None),
            terminate=lambda: killed.append("terminate"),
            kill=lambda: killed.append("kill"),
            wait=wait,
        )
        session._proc = proc
        return session, reader, killed

    async def test_a_turn_that_keeps_talking_is_never_cut_off(self):
        """The deadline measures silence, so slow-but-alive must survive it."""
        session, reader, _ = self._session(0.15)

        async def dribble():
            # Four gaps, each under the deadline, adding to well over it. Under
            # a whole-turn deadline this turn dies; under an idle one it lives.
            for word in ("still", "here", "and", "working"):
                await asyncio.sleep(0.1)
                reader.feed_data((json.dumps(text_end(word)) + "\n").encode())
            reader.feed_data((json.dumps({"type": "agent_settled"}) + "\n").encode())

        feeder = asyncio.create_task(dribble())
        turn = await session._collect()
        await feeder
        self.assertFalse(turn.failed)
        self.assertEqual(turn.text, "still\nhere\nand\nworking")

    async def test_going_quiet_fails_the_turn_with_nothing_said(self):
        """Empty text is the contract: pbx only recovers a failed *silent* turn.

        A canned apology here reads to the switchboard as an ordinary reply, so
        the caller keeps the dead leg. That is the bug, not the wording.
        """
        session, _, _ = self._session(0.05)
        turn = await session._collect()
        self.assertTrue(turn.failed)
        self.assertEqual(turn.text, "")
        self.assertIn("responding", turn.error)

    async def test_the_leg_is_dropped_rather_than_reused(self):
        """A silent agent may still wake up and write.

        Its output would be indistinguishable from the next turn's, so the
        process has to go. Leaving it up is what desynced the pipe.
        """
        session, _, killed = self._session(0.05)
        await session._collect()
        self.assertIsNone(session._proc)
        self.assertFalse(session.alive)
        self.assertIn("terminate", killed)


if __name__ == "__main__":
    unittest.main()
