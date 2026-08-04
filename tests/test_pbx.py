"""Routing: where the caller is, and what it takes to move them.

Agent processes are replaced with scripted fakes, so these tests are about the
switchboard's own decisions — which is the part that must not get this wrong. A
caller stranded on a dead leg cannot ask for help.
"""

# Pyright cannot model the scripted fake sessions and method replacements below.
# pyright: reportAttributeAccessIssue=false

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.models import ModelCatalog  # noqa: E402
from backend.pbx import OPERATOR, Switchboard  # noqa: E402
from backend.piclient import (  # noqa: E402
    RETURN_TOOL,
    SET_MODEL_TOOL,
    SPEAK_TOOL,
    TRANSFER_TOOL,
    PiSessionError,
    Signal,
    Turn,
)
from backend.registry import Project, Registry  # noqa: E402


# What every project host is pretended to offer. Two providers serving one model
# id is not padding: it is the case that puts a caller on the wrong leg.
CATALOG = ModelCatalog.parse(
    """provider   model             context  max-out  thinking  images
anthropic  claude-opus-5     1M       128K     yes       yes
anthropic  claude-sonnet-5   1M       128K     yes       yes
openai     claude-sonnet-5   1M       128K     yes       yes
"""
)


class FakeSession:
    """Stands in for a PiSession, replaying a scripted list of turns."""

    def __init__(self, label, turns=None, alive=True, stderr=""):
        self.label = label
        self.turns = list(turns or [])
        self._alive = alive
        self._stderr = stderr
        self.prompts = []
        self.steers = []
        self.busy = False
        self.closed = False

    @property
    def alive(self):
        return self._alive and not self.closed

    def stderr_tail(self, limit=5):
        return self._stderr

    async def prompt(self, message):
        self.prompts.append(message)
        if not self.turns:
            return Turn(text="(nothing scripted)")
        turn = self.turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        return turn

    async def steer(self, message):
        if not self.alive:
            raise PiSessionError("session closed")
        self.steers.append(message)

    async def close(self):
        self.closed = True


GRAPES = Project(
    id="grape-segmentation",
    aliases=["grapes", "grape segmentation"],
    host="scriptorium",
    cwd="/root/grape-segmentation",
)

HOMELAB = Project(id="homelab", aliases=["the lab"], cwd="/srv/homelab")


def build(
    operator_turns,
    agent_turns=None,
    *,
    agent_error=None,
    prepare_report=None,
    projects=(GRAPES,),
    onward_turns=None,
    on_route_change=None,
    agent_model="anthropic/claude-sonnet-5",
    agent_thinking="",
):
    board = Switchboard(
        Registry(list(projects)),
        pi_binary="pi",
        agent_model=agent_model,
        agent_thinking=agent_thinking,
        operator_model=None,
        operator_system_prompt="/dev/null",
        operator_extension=None,
        agent_extension_file=None,
        on_route_change=on_route_change,
    )
    operator = FakeSession(OPERATOR, operator_turns)
    agent = FakeSession("grape-segmentation", agent_turns)
    legs = []
    started = []

    async def ensure_operator():
        board._operator = operator
        return operator

    async def start_agent(project, *, model="", session_id=""):
        started.append(
            {"project": project.id, "model": model, "session_id": session_id}
        )
        if agent_error is not None:
            raise agent_error
        # Every leg is its own process in production; reusing one fake across a
        # transfer would hide a leg that was closed and then talked to.
        if legs:
            session = FakeSession(project.id, (onward_turns or {}).get(project.id))
        else:
            session = agent
        legs.append(session)
        return session

    async def host_catalog(_project):
        return CATALOG

    board.legs = legs
    board.started = started
    board._host_catalog = host_catalog

    async def run_prepare(project):
        return prepare_report or ""

    board._ensure_operator = ensure_operator
    board._start_agent = start_agent
    board._run_prepare = run_prepare
    return board, operator, agent


class RoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_starts_on_the_operator(self):
        board, _, _ = build([Turn(text="Where to?")])
        self.assertEqual(board.route, OPERATOR)
        self.assertEqual(board.route_label, "Operator")

    async def test_plain_reply_does_not_move_the_caller(self):
        board, _, _ = build([Turn(text="I have one project.")])
        reply = await board.handle("what have you got")
        self.assertEqual(reply.to_speak, ["I have one project."])
        self.assertEqual(board.route, OPERATOR)

    async def test_transfer_switches_the_line_and_only_the_agent_is_heard(self):
        board, _, agent = build(
            [
                Turn(
                    text="Putting you through.",
                    signals=[
                        Signal(
                            TRANSFER_TOOL, {"project": "grapes", "intent": "fix masks"}
                        )
                    ],
                )
            ],
            [Turn(text="Ready on grapes.")],
        )
        reply = await board.handle("put me into the grape project")

        self.assertEqual(board.route, "grape-segmentation")
        self.assertEqual(board.route_label, "grape-segmentation")
        # The caller hears the agent and nobody else; the operator's handoff
        # survives only in the transcript.
        self.assertEqual(reply.to_speak, ["Ready on grapes."])
        self.assertIn("Putting you through.", reply.text)
        # The caller's actual request rides along, so they do not repeat it.
        self.assertIn("fix masks", agent.prompts[0])

    async def test_transfer_without_intent_still_connects(self):
        board, _, agent = build(
            [
                Turn(
                    text="One moment.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Standing by.")],
        )
        await board.handle("grapes please")
        self.assertEqual(board.route, "grape-segmentation")
        self.assertIn("did not say what they want", agent.prompts[0])

    async def test_utterances_go_to_the_agent_once_connected(self):
        board, operator, agent = build(
            [
                Turn(
                    text="Through you go.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready."), Turn(text="Fixed it.")],
        )
        await board.handle("grapes")
        reply = await board.handle("fix the overlap bug")

        self.assertEqual(reply.to_speak, ["Fixed it."])
        self.assertEqual(agent.prompts[-1], "fix the overlap bug")
        # The operator hears nothing while the caller is on another leg.
        self.assertEqual(len(operator.prompts), 1)

    async def test_unknown_project_keeps_the_caller_with_the_operator(self):
        board, _, _ = build(
            [
                Turn(
                    text="Sure.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "tomatoes"})],
                )
            ]
        )
        reply = await board.handle("put me in tomatoes")

        self.assertEqual(board.route, OPERATOR)
        self.assertIsNotNone(reply.error)
        self.assertIn("grape-segmentation", reply.text)
        # A transfer that never happened still owes the caller a reason, and
        # only that reason.
        self.assertEqual(len(reply.to_speak), 1)
        self.assertIn("don't have a project", reply.to_speak[0])

    async def test_failed_connection_hands_the_caller_back(self):
        board, _, _ = build(
            [
                Turn(
                    text="Connecting.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            agent_error=PiSessionError("ssh: permission denied"),
        )
        reply = await board.handle("grapes")

        self.assertEqual(board.route, OPERATOR)
        self.assertIn("permission denied", reply.text)

    async def test_agent_that_never_answers_is_not_left_holding_the_call(self):
        # The process starts (ssh connects) but the far end dies — a wrong cwd or
        # a missing binary. The caller must land back on the operator.
        board, _, _ = build(
            [
                Turn(
                    text="Connecting.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="", failed=True)],
        )
        reply = await board.handle("grapes")

        self.assertEqual(board.route, OPERATOR)
        self.assertIsNotNone(reply.error)
        self.assertIn("didn't pick up", reply.text)


class SteeringTests(unittest.IsolatedAsyncioTestCase):
    async def test_busy_live_agent_is_steered_without_waiting_for_turn_lock(self):
        board, _, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
        )
        await board.handle("grapes")
        agent.busy = True

        self.assertTrue(await board.steer_if_busy("also update the docs"))
        self.assertEqual(agent.steers, ["also update the docs"])
        self.assertEqual(len(agent.prompts), 1)

    async def test_idle_session_is_left_for_the_regular_prompt_queue(self):
        board, operator, _ = build([Turn(text="Ready.")])
        self.assertFalse(await board.steer_if_busy("hello"))
        self.assertEqual(operator.steers, [])

    async def test_session_replaced_during_steer_is_not_reported_delivered(self):
        board, _, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
        )
        await board.handle("grapes")
        agent.busy = True

        async def detached_steer(message):
            agent.steers.append(message)
            board._agent = None

        agent.steer = detached_steer
        self.assertFalse(await board.steer_if_busy("do not lose this"))


class PrepareTests(unittest.IsolatedAsyncioTestCase):
    async def test_workspace_state_is_handed_to_the_agent(self):
        # The agent has to know whether it opened on a fresh tree or someone's
        # half-finished branch — it changes what it is safe to do.
        board, _, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
            prepare_report="clean, on master at abc1234",
        )
        await board.handle("grapes")
        self.assertIn("clean, on master at abc1234", agent.prompts[0])

    async def test_no_prepare_leaves_the_intro_unchanged(self):
        board, _, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
        )
        await board.handle("grapes")
        self.assertNotIn("State of your working copy", agent.prompts[0])

    async def test_a_dirty_checkout_is_reported_not_hidden(self):
        board, _, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
            prepare_report="left on branch wip/foo with uncommitted changes, which were not touched",
        )
        await board.handle("grapes")
        self.assertIn("uncommitted changes", agent.prompts[0])


class ReturnTests(unittest.IsolatedAsyncioTestCase):
    async def _connected(self, agent_turns):
        board, operator, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                ),
                Turn(text="Welcome back."),
            ],
            [Turn(text="Ready."), *agent_turns],
        )
        await board.handle("grapes")
        return board, operator, agent

    async def test_return_tool_ends_the_session_and_restores_the_operator(self):
        board, _, agent = await self._connected(
            [
                Turn(
                    text="Talk later.",
                    signals=[Signal(RETURN_TOOL, {"summary": "masks fixed"})],
                )
            ]
        )
        reply = await board.handle("send me back")

        self.assertEqual(board.route, OPERATOR)
        # Sessions do not survive a transfer, by design.
        self.assertTrue(agent.closed)
        self.assertIn("Talk later.", reply.text)
        # The operator takes its turn there and then, so its greeting is what
        # closes the handoff.
        self.assertIn("Welcome back.", reply.text)

    async def test_the_operator_is_told_what_happened_immediately(self):
        board, operator, _ = await self._connected(
            [
                Turn(
                    text="Bye.",
                    signals=[Signal(RETURN_TOOL, {"summary": "masks fixed"})],
                )
            ]
        )
        await board.handle("send me back")

        note = operator.prompts[-1]
        self.assertIn("masks fixed", note)
        self.assertIn("grape-segmentation", note)

    async def test_the_note_is_not_repeated_on_the_next_utterance(self):
        board, operator, _ = await self._connected(
            [Turn(text="Bye.", signals=[Signal(RETURN_TOOL, {})])]
        )
        await board.handle("send me back")
        await board.handle("first")

        self.assertIn("handed back", operator.prompts[-2])
        self.assertEqual(operator.prompts[-1], "first")

    async def test_a_dead_agent_leg_returns_the_caller_instead_of_hanging(self):
        board, _, agent = await self._connected([])
        agent._alive = False
        reply = await board.handle("are you there")

        self.assertEqual(board.route, OPERATOR)
        self.assertIn("dropped", reply.text)

    async def test_a_self_spoken_farewell_is_not_read_out_again(self):
        board, _, _ = await self._connected(
            [
                Turn(
                    text="Talk later.",
                    signals=[
                        Signal(SPEAK_TOOL, {"text": "Talk later."}),
                        Signal(RETURN_TOOL, {}),
                    ],
                )
            ]
        )
        reply = await board.handle("send me back")
        # The agent already said its goodbye; only the operator's line is still
        # owed a voice.
        self.assertEqual(reply.to_speak, ["Welcome back."])
        self.assertIn("Talk later.", reply.text)

    async def test_shutdown_closes_both_legs(self):
        board, operator, agent = await self._connected([])
        await board.shutdown()
        self.assertTrue(agent.closed)
        self.assertTrue(operator.closed)


class DirectTransferTests(unittest.IsolatedAsyncioTestCase):
    """An agent can put the caller through without a round trip via the operator."""

    async def _on_grapes(self, agent_turns, onward_turns=None):
        board, operator, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready."), *agent_turns],
            projects=(GRAPES, HOMELAB),
            onward_turns=onward_turns,
        )
        await board.handle("grapes")
        return board, operator, agent

    async def test_an_agent_can_hand_the_caller_straight_to_another_project(self):
        board, operator, agent = await self._on_grapes(
            [
                Turn(
                    text="Sending you over.",
                    signals=[
                        Signal(
                            TRANSFER_TOOL, {"project": "the lab", "intent": "check dns"}
                        )
                    ],
                )
            ],
            onward_turns={"homelab": [Turn(text="Homelab here.")]},
        )
        reply = await board.handle("send me to the lab")

        self.assertEqual(board.route, "homelab")
        self.assertTrue(agent.closed)
        # The operator was never dialled: that is the whole point.
        self.assertEqual(len(operator.prompts), 1)
        self.assertIn("check dns", board.legs[-1].prompts[0])
        # Only the new leg is heard; the farewell survives in the transcript.
        self.assertEqual(reply.to_speak, ["Homelab here."])
        self.assertIn("Sending you over.", reply.text)

    async def test_a_transfer_to_nowhere_leaves_the_caller_on_the_operator(self):
        board, _, _ = await self._on_grapes(
            [
                Turn(
                    text="Off you go.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "tomatoes"})],
                )
            ]
        )
        reply = await board.handle("send me to tomatoes")

        self.assertEqual(board.route, OPERATOR)
        self.assertIn("don't have a project", reply.text)


class ForwardedIntentTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_operator_acts_on_a_handoff_note_without_being_asked_again(self):
        board, operator, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                ),
                Turn(text="", signals=[Signal(TRANSFER_TOOL, {"project": "homelab"})]),
            ],
            [
                Turn(text="Ready."),
                Turn(
                    text="Bye.",
                    signals=[
                        Signal(RETURN_TOOL, {"summary": "they want the homelab next"})
                    ],
                ),
            ],
            projects=(GRAPES, HOMELAB),
            onward_turns={"homelab": [Turn(text="Homelab here.")]},
        )
        await board.handle("grapes")
        reply = await board.handle("send me back and tell them I want the homelab")

        self.assertEqual(board.route, "homelab")
        self.assertIn("they want the homelab next", operator.prompts[-1])
        self.assertEqual(reply.to_speak, ["Homelab here."])
        self.assertIn("Bye.", reply.text)


class ModelSwapTests(unittest.IsolatedAsyncioTestCase):
    """Re-dialling the same leg on another model, without losing the call."""

    async def _on_grapes(self, agent_turns, onward_turns=None):
        board, operator, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                ),
                Turn(text="Welcome back."),
            ],
            [Turn(text="Ready."), *agent_turns],
            onward_turns=onward_turns,
        )
        await board.handle("grapes")
        return board, operator, agent

    async def test_a_swap_restarts_the_leg_on_the_new_model(self):
        board, _, agent = await self._on_grapes(
            [Turn(text="", signals=[Signal(SET_MODEL_TOOL, {"model": "opus 5"})])],
            onward_turns={"grape-segmentation": [Turn(text="Back on opus.")]},
        )
        reply = await board.handle("switch to opus")

        self.assertEqual(board.route, "grape-segmentation")
        self.assertTrue(agent.closed)
        self.assertEqual(board.started[-1]["model"], "anthropic/claude-opus-5")
        self.assertEqual(reply.to_speak, ["Back on opus."])

    async def test_the_conversation_survives_the_swap(self):
        # Same session file, new process: that is the whole mechanism.
        board, _, _ = await self._on_grapes(
            [Turn(text="", signals=[Signal(SET_MODEL_TOOL, {"model": "opus 5"})])],
            onward_turns={"grape-segmentation": [Turn(text="Back.")]},
        )
        before = board.started[0]["session_id"]
        await board.handle("switch to opus")

        self.assertTrue(before)
        self.assertEqual(board.started[-1]["session_id"], before)
        self.assertIn("still in front of you", board.legs[-1].prompts[-1])

    async def test_asking_for_a_clean_slate_gets_a_new_session(self):
        board, _, _ = await self._on_grapes(
            [
                Turn(
                    text="",
                    signals=[
                        Signal(
                            SET_MODEL_TOOL, {"model": "opus 5", "keep_context": False}
                        )
                    ],
                )
            ],
            onward_turns={"grape-segmentation": [Turn(text="Fresh start.")]},
        )
        before = board.started[0]["session_id"]
        await board.handle("switch to opus and forget all that")

        self.assertNotEqual(board.started[-1]["session_id"], before)
        self.assertIn("deliberately cleared", board.legs[-1].prompts[-1])

    async def test_an_ambiguous_model_changes_nothing_and_says_why(self):
        # The stuck case. Nothing is torn down, so a wrong guess cannot happen.
        board, _, agent = await self._on_grapes(
            [Turn(text="", signals=[Signal(SET_MODEL_TOOL, {"model": "sonnet 5"})])]
        )
        reply = await board.handle("put me on sonnet 5")

        self.assertEqual(board.route, "grape-segmentation")
        self.assertFalse(agent.closed)
        self.assertEqual(len(board.started), 1)
        self.assertIn("anthropic/claude-sonnet-5", reply.text)
        self.assertIn("openai/claude-sonnet-5", reply.text)

    async def test_a_thinking_level_alone_keeps_the_current_model(self):
        board, _, _ = await self._on_grapes(
            [
                Turn(
                    text="",
                    signals=[Signal(SET_MODEL_TOOL, {"thinking": "reasoning max"})],
                )
            ],
            onward_turns={"grape-segmentation": [Turn(text="Thinking harder.")]},
        )
        await board.handle("think harder")
        self.assertEqual(board.started[-1]["model"], "anthropic/claude-sonnet-5:max")

    async def test_asking_for_the_model_already_running_is_not_a_restart(self):
        board, _, agent = await self._on_grapes(
            [
                Turn(
                    text="",
                    signals=[
                        Signal(SET_MODEL_TOOL, {"model": "anthropic/claude-sonnet-5"})
                    ],
                )
            ]
        )
        reply = await board.handle("put me on sonnet 5")

        self.assertFalse(agent.closed)
        self.assertEqual(len(board.started), 1)
        self.assertIn("Already on", reply.text)

    async def test_a_leg_that_will_not_come_back_up_lands_on_the_operator(self):
        board, operator, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                ),
                Turn(text="Welcome back."),
            ],
            [
                Turn(text="Ready."),
                Turn(text="", signals=[Signal(SET_MODEL_TOOL, {"model": "opus 5"})]),
            ],
            onward_turns={"grape-segmentation": [Turn(text="", failed=True)]},
        )
        await board.handle("grapes")
        reply = await board.handle("switch to opus")

        self.assertEqual(board.route, OPERATOR)
        self.assertIsNotNone(reply.error)
        await board.handle("what happened")
        self.assertIn("did not come back up", operator.prompts[-1])

    async def test_swaps_can_be_turned_off_entirely(self):
        board, _, agent = await self._on_grapes(
            [Turn(text="", signals=[Signal(SET_MODEL_TOOL, {"model": "opus 5"})])]
        )
        board.model_swaps = False
        reply = await board.handle("switch to opus")

        self.assertFalse(agent.closed)
        self.assertIn("turned off", reply.text)

    async def test_a_transfer_can_name_the_model_for_the_new_leg(self):
        board, _, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[
                        Signal(
                            TRANSFER_TOOL,
                            {
                                "project": "grapes",
                                "model": "opus 5",
                                "thinking": "high",
                            },
                        )
                    ],
                )
            ],
            [Turn(text="Ready on opus.")],
        )
        await board.handle("grapes on opus, thinking high")
        self.assertEqual(board.started[-1]["model"], "anthropic/claude-opus-5:high")
        self.assertEqual(board.status()["model"], "anthropic/claude-opus-5:high")

    async def test_an_unusable_model_still_connects_the_caller(self):
        # Being connected on the usual model beats being dumped on the operator
        # over a name that came through a microphone.
        board, _, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[
                        Signal(
                            TRANSFER_TOOL, {"project": "grapes", "model": "sonnet 5"}
                        )
                    ],
                )
            ],
            [Turn(text="Ready.")],
        )
        reply = await board.handle("grapes on sonnet 5")

        self.assertEqual(board.route, "grape-segmentation")
        # The model it falls back to is the project's usual one, named here
        # rather than left to the agent process to fill in.
        self.assertEqual(board.started[-1]["model"], "anthropic/claude-sonnet-5")
        self.assertIn("ambiguous", reply.text)


class ForcedHangupTests(unittest.IsolatedAsyncioTestCase):
    """The button on the page. It has to work when the agent is the problem."""

    async def _connected(self, agent_turns=()):
        board, operator, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                ),
                Turn(text="Where to?"),
            ],
            [Turn(text="Ready."), *agent_turns],
        )
        await board.handle("grapes")
        return board, operator, agent

    async def test_hanging_up_drops_the_leg_and_restores_the_operator(self):
        board, _, agent = await self._connected()
        left = await board.force_hangup()

        self.assertEqual(left, "grape-segmentation")
        self.assertEqual(board.route, OPERATOR)
        self.assertTrue(agent.closed)

    async def test_the_operator_is_told_it_was_the_caller_who_pulled_the_plug(self):
        board, operator, _ = await self._connected()
        await board.force_hangup()
        await board.handle("that was going nowhere")
        self.assertIn("dropped the line", operator.prompts[-1])

    async def test_hanging_up_on_the_operator_does_nothing(self):
        # There is nowhere below the operator to land.
        board, _, _ = build([Turn(text="Hello.")])
        self.assertIsNone(await board.force_hangup())
        self.assertEqual(board.route, OPERATOR)

    async def test_a_turn_still_in_flight_cannot_undo_the_rescue(self):
        # The reply from a leg that was hung up mid-turn arrives after the fact.
        # Acting on it would put the caller straight back on the thing they just
        # escaped from.
        board, _, agent = await self._connected()
        gate = asyncio.Event()

        async def wedged(_message):
            await gate.wait()
            return Turn(
                text="Sorry, what?",
                signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
            )

        agent.prompt = wedged
        pending = asyncio.ensure_future(board.handle("are you alright"))
        await asyncio.sleep(0.01)
        await board.force_hangup()
        gate.set()
        reply = await pending

        self.assertEqual(board.route, OPERATOR)
        self.assertEqual(reply.to_speak, [])


class IdleTests(unittest.IsolatedAsyncioTestCase):
    async def _connected(self):
        board, operator, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
        )
        await board.handle("grapes")
        return board, operator, agent

    async def test_a_silent_leg_is_dropped_and_the_operator_told_why(self):
        board, operator, agent = await self._connected()
        await asyncio.sleep(0.01)
        left = await board.return_if_idle(0.005)

        self.assertEqual(left, "grape-segmentation")
        self.assertEqual(board.route, OPERATOR)
        self.assertTrue(agent.closed)
        await board.handle("hello?")
        self.assertIn("went quiet", operator.prompts[-1])

    async def test_a_leg_still_being_used_is_left_alone(self):
        board, _, agent = await self._connected()
        self.assertIsNone(await board.return_if_idle(3600))
        self.assertEqual(board.route, "grape-segmentation")
        self.assertFalse(agent.closed)

    async def test_the_operator_is_never_hung_up_on(self):
        board, _, _ = build([Turn(text="Hello.")])
        await asyncio.sleep(0.01)
        self.assertIsNone(await board.return_if_idle(0.005))
        self.assertEqual(board.route, OPERATOR)

    async def test_a_zero_timeout_disables_the_check(self):
        board, _, _ = await self._connected()
        await asyncio.sleep(0.01)
        self.assertIsNone(await board.return_if_idle(0))
        self.assertEqual(board.route, "grape-segmentation")


class RouteAnnouncementTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_line_is_announced_before_the_new_agent_speaks(self):
        seen = []
        board, _, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
        )

        async def announce():
            seen.append(board.status()["label"])

        board.on_route_change = announce
        await board.handle("grapes")

        # Announced on connect, not after the intro turn settles — that is the
        # window the page used to spend labelled with the previous leg.
        self.assertEqual(seen, ["grape-segmentation"])

    async def test_a_hangup_announces_the_operator(self):
        seen = []
        board, _, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready."), Turn(text="Bye.", signals=[Signal(RETURN_TOOL, {})])],
        )

        async def announce():
            seen.append(board.status()["label"])

        board.on_route_change = announce
        await board.handle("grapes")
        await board.handle("send me back")
        self.assertEqual(seen, ["grape-segmentation", "Operator"])

    async def test_a_broken_announcement_does_not_drop_the_call(self):
        async def announce():
            raise RuntimeError("no browser")

        board, _, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
            on_route_change=announce,
        )
        reply = await board.handle("grapes")
        self.assertEqual(board.route, "grape-segmentation")
        self.assertEqual(reply.to_speak, ["Ready."])


class StatusTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_reports_the_current_leg(self):
        board, _, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
        )
        self.assertEqual(board.status()["label"], "Operator")
        await board.handle("grapes")
        status = board.status()
        self.assertEqual(status["route"], "grape-segmentation")
        self.assertEqual(status["projects"], ["grape-segmentation"])

    async def test_status_splits_the_model_from_the_thinking_level(self):
        board, _, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[
                        Signal(
                            TRANSFER_TOOL,
                            {
                                "project": "grapes",
                                "model": "opus 5",
                                "thinking": "high",
                            },
                        )
                    ],
                )
            ],
            [Turn(text="Ready.")],
        )
        await board.handle("grapes on opus 5 thinking high")
        status = board.status()
        self.assertEqual(status["model"], "anthropic/claude-opus-5:high")
        self.assertEqual(status["model_name"], "anthropic/claude-opus-5")
        self.assertEqual(status["thinking"], "high")


class ThinkingLevelTests(unittest.IsolatedAsyncioTestCase):
    """Every leg runs at a level someone chose, and the page is told which."""

    async def _connected(self, **kwargs):
        board, _, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
            **kwargs,
        )
        await board.handle("grapes")
        return board, agent

    async def test_a_leg_starts_at_the_configured_level(self):
        board, _ = await self._connected(agent_thinking="medium")
        self.assertEqual(board.started[-1]["model"], "anthropic/claude-sonnet-5:medium")
        self.assertEqual(board.status()["thinking"], "medium")
        self.assertFalse(board.status()["thinking_confirmed"])

    async def test_a_level_the_caller_asked_for_beats_the_configured_one(self):
        board, _, _ = build(
            [
                Turn(
                    text="Through.",
                    signals=[
                        Signal(TRANSFER_TOOL, {"project": "grapes", "thinking": "max"})
                    ],
                )
            ],
            [Turn(text="Ready.")],
            agent_thinking="medium",
        )
        await board.handle("grapes, thinking max")
        self.assertEqual(board.started[-1]["model"], "anthropic/claude-sonnet-5:max")

    async def test_the_leg_report_overrides_what_was_asked_for(self):
        # The runtime clamps a level the model does not expose, silently. What
        # the session says it is doing is the only honest answer.
        board, _ = await self._connected(agent_thinking="medium")
        self.assertTrue(board.report_leg_state("high"))
        status = board.status()
        self.assertEqual(status["thinking"], "high")
        self.assertTrue(status["thinking_confirmed"])
        self.assertEqual(status["thinking_requested"], "medium")

    async def test_a_report_is_ignored_on_the_operator_and_when_nonsense(self):
        board, _, _ = build([Turn(text="Hello.")])
        self.assertFalse(board.report_leg_state("high"))
        board, _ = await self._connected()
        self.assertFalse(board.report_leg_state("quite hard"))

    async def test_setting_the_level_on_the_operator_only_arms_the_next_leg(self):
        board, _, _ = build([Turn(text="Hello.")])
        reply = await board.set_thinking("low")
        self.assertEqual(board.agent_thinking, "low")
        self.assertEqual(board.route, OPERATOR)
        self.assertIn("low", reply.text)

    async def test_setting_the_level_on_a_project_redials_that_leg(self):
        board, agent = await self._connected(agent_thinking="medium")
        board.legs[-1].turns.append(Turn(text="Back at low."))
        await board.set_thinking("low")
        self.assertEqual(board.route, "grape-segmentation")
        self.assertEqual(board.started[-1]["model"], "anthropic/claude-sonnet-5:low")
        # Same session file: the conversation survives the restart.
        self.assertEqual(
            board.started[-1]["session_id"], board.started[0]["session_id"]
        )
        self.assertTrue(agent.closed)

    async def test_an_unknown_level_changes_nothing(self):
        board, _ = await self._connected(agent_thinking="medium")
        reply = await board.set_thinking("quite hard")
        self.assertEqual(board.agent_thinking, "medium")
        self.assertEqual(len(board.started), 1)
        self.assertIn("thinking level", reply.text)


class PageDialTests(unittest.IsolatedAsyncioTestCase):
    """Connecting from the picker, which never asks the operator first."""

    async def test_dialling_a_project_connects_without_the_operator(self):
        board, operator, _ = build([], [Turn(text="Ready.")])
        reply = await board.dial("grapes")
        self.assertEqual(board.route, "grape-segmentation")
        self.assertEqual(operator.prompts, [])
        self.assertIn("Ready.", reply.text)

    async def test_dialling_the_operator_drops_the_project_leg(self):
        board, _, agent = build(
            [
                Turn(
                    text="Through.",
                    signals=[Signal(TRANSFER_TOOL, {"project": "grapes"})],
                )
            ],
            [Turn(text="Ready.")],
        )
        await board.handle("grapes")
        await board.dial("operator")
        self.assertEqual(board.route, OPERATOR)
        self.assertTrue(agent.closed)

    async def test_dialling_a_project_that_does_not_exist_says_so(self):
        board, _, _ = build([])
        reply = await board.dial("nonsense")
        self.assertEqual(board.route, OPERATOR)
        self.assertIn("nonsense", reply.text)


class AgentEnvTests(unittest.TestCase):
    """The URLs an agent needs to reach back to this service.

    An agent on another box cannot discover them; if one is not in its
    environment the tool it belongs to is dead, and the only symptom is the
    agent quietly telling the caller it cannot do the thing.
    """

    def _board(self, **urls):
        return Switchboard(
            Registry([GRAPES]),
            pi_binary="pi",
            operator_model=None,
            operator_system_prompt="/dev/null",
            operator_extension=None,
            agent_extension_file=None,
            **urls,
        )

    def test_reach_back_urls_are_handed_to_the_agent(self):
        env = self._board(
            speak_url="http://sb:8000/speak",
            state_url="http://sb:8000/leg-state",
            diagram_url="http://sb:8000/diagram",
        )._agent_env()
        self.assertEqual(env["SWITCHBOARD_SPEAK_URL"], "http://sb:8000/speak")
        self.assertEqual(env["SWITCHBOARD_STATE_URL"], "http://sb:8000/leg-state")
        self.assertEqual(env["SWITCHBOARD_DIAGRAM_URL"], "http://sb:8000/diagram")

    def test_an_unset_url_is_left_out_rather_than_passed_empty(self):
        # The extension checks for a falsy value to decide the tool cannot work.
        # An empty string would pass that check and be fetched.
        env = self._board()._agent_env()
        self.assertEqual(env, {"SWITCHBOARD_SESSION": "1"})


if __name__ == "__main__":
    unittest.main()
