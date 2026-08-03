"""The switchboard proper: who is the caller connected to, and how do they move.

There is exactly one caller and exactly one active leg at a time. Two kinds of
leg exist:

  operator  a persistent local `pi` session with no working tools. Its whole job
            is to hear what you want and call `transfer_to_project`. It stays up
            between calls, so it remembers the conversation you have been having
            with it.

  project   a `pi` session started on the host that holds the code, in that
            project's directory, with its normal tools. It is created on
            transfer and destroyed when it hands you back — every visit to a
            project starts clean.

Routing is decided here rather than in the agents. The tools an agent calls only
raise a signal (see piclient.Signal); this module is what actually swings the
line over, which means a confused agent cannot strand the caller.
"""

from __future__ import annotations

import asyncio
import logging
import shlex
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from .models import (
    ModelCatalog,
    ModelChoice,
    ModelError,
    THINKING_LEVELS,
    fetch_catalog,
    normalize_thinking,
    parse_spec,
    pin_thinking,
)
from .piclient import (
    RETURN_SENTINEL,
    RETURN_TOOL,
    SET_MODEL_TOOL,
    SPEAK_TOOL,
    TRANSFER_TOOL,
    PiSession,
    PiSessionError,
    Turn,
    list_models_argv,
    local_argv,
    remote_argv,
)
from .registry import Project, Registry

log = logging.getLogger("switchboard.pbx")

OPERATOR = "operator"

# Appended to every project agent's system prompt. It explains the medium (the
# reply is spoken aloud, so length matters) and both ways back to the operator —
# the tool when the extension loaded, the sentinel line when it did not.
AGENT_BRIEF = """
# You are on a voice call

The homelab switchboard has connected a caller to you. You are working in the
`{project_id}` project, in its own directory, with your normal tools.

{speak_instruction}

Your written output is not the call. It goes to a page the caller is probably
not looking at, so it stays useful for code, paths and detail — but anything you
want them to actually hear has to be said out loud. Two different audiences, not
one message in two formats.

Talk like someone on the phone. A sentence or two at a time, plain spoken
English, no markdown, no lists, no reading out file paths or command names.
Before a long stretch of work, say what you are about to do; while it runs, say
something occasionally. Silence on a call reads as a dropped connection.

When the caller is done here, or asks for the operator, or asks to be sent
somewhere else, hand them back: {return_instruction} Do not hand back merely
because you finished a task — they usually have more to say.
{transfer_instruction}{model_instruction}"""

# Only offered when the tool extension loaded. Naming the other extensions here
# is what makes a direct hop possible: the agent host cannot read the registry.
TRANSFER_BRIEF = """
If they name another project they want to be on instead, put them straight
through with the `{transfer_tool}` tool rather than sending them back to the
operator to ask again. Pass what they want done as `intent`. The extensions you
can reach:

{catalog}

If what they asked for is not on that list, hand them to the operator instead of
guessing.
"""

# Only offered when the tool extension loaded and swaps are enabled. The agent
# does not restart itself — the tool raises a signal and the switchboard brings
# the leg back up — but from the caller's side it is "change your model", so
# that is how it is described.
MODEL_BRIEF = """
If they ask you to run on a different model or at a different thinking level,
call `{set_model_tool}`. Your session is restarted on the new model with this
conversation intact, so say nothing alongside the call. Pass the model the way
it is named by the runtime, provider first, and if you are not certain which
provider serves it, pass just the model name — an ambiguous one comes back with
the candidates for the caller to choose from rather than picking one.
"""

SPEAK_VIA_TOOL = (
    f"**Say things with the `{SPEAK_TOOL}` tool.** That is how the caller hears "
    "you — nothing else you produce is spoken."
)
SPEAK_VIA_FALLBACK = (
    "You have no way to speak directly on this host, so the switchboard reads "
    "your written reply aloud once you finish a turn. That means the caller "
    "hears nothing until you stop working, and hears whatever you wrote — so "
    "keep replies short and free of anything that does not survive being read "
    "out loud."
)

RETURN_VIA_TOOL = f"call the `{RETURN_TOOL}` tool."
RETURN_VIA_SENTINEL = (
    f"end your reply with the exact line {RETURN_SENTINEL} (the switchboard "
    "watches for it; the user never hears it)."
)

# Sent to a leg that has just been restarted on a different model with its
# session file intact. It is not a greeting: the caller has been mid-task and
# only needs to know the swap landed.
SWAP_PROMPT = """[switchboard] You are now running on {model}. Everything said
on this call so far is still in front of you, so pick up where the conversation
left off. Say in one short sentence that you are back on the new model, and
nothing else unless they asked for something in the same breath.{intent_line}"""

# Sent to a project agent the moment it comes up, so it opens the call already
# pointed at whatever the caller asked the operator for.
INTRO_PROMPT = """The switchboard has just connected a caller to you.

{intent_line}
{workspace_line}
Greet them in one short sentence. If the note above contains actual work, start
on it; otherwise just say you are ready and wait."""


@dataclass
class Utterance:
    """One line of the reply, and whether the switchboard still owes it a voice.

    `synthesize=False` means the agent already said this itself through the
    `speak` tool and the audio is on its way to the caller — reading the written
    reply out on top of that would say everything twice.
    """

    text: str
    synthesize: bool = True


@dataclass
class Reply:
    """What the caller hears and sees after one utterance."""

    utterances: list[Utterance] = field(default_factory=list)
    route: str = OPERATOR
    route_label: str = "Operator"
    error: str | None = None

    @property
    def text(self) -> str:
        """Everything said this turn, for the browser transcript."""
        return "\n\n".join(u.text for u in self.utterances if u.text)

    @property
    def to_speak(self) -> list[str]:
        """Only the lines the switchboard itself still has to synthesize."""
        return [u.text for u in self.utterances if u.synthesize and u.text]


class Switchboard:
    def __init__(
        self,
        registry: Registry,
        *,
        pi_binary: str,
        operator_model: str | None,
        operator_system_prompt: str,
        operator_extension: str | None,
        agent_extension_file: str | None,
        agent_model: str | None = None,
        agent_thinking: str = "",
        remote_cache_dir: str = ".cache/switchboard",
        model_swaps: bool = True,
        speak_url: str = "",
        state_url: str = "",
        env: dict[str, str] | None = None,
        on_route_change: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.registry = registry
        self.pi_binary = pi_binary
        self.operator_model = operator_model
        self.operator_system_prompt = operator_system_prompt
        self.operator_extension = operator_extension
        self.agent_extension_file = agent_extension_file
        self.agent_model = agent_model
        # The level every project leg is started at unless the caller named one.
        # Mutable: changing it from the page is meant to stick for the rest of
        # the session, not just for the leg that happens to be up.
        self.agent_thinking = agent_thinking
        self.remote_cache_dir = remote_cache_dir
        # The operator is deliberately not covered by this: it is the one leg
        # that always answers on a known-good model, which is what makes it a
        # safe place to land when a swap goes wrong.
        self.model_swaps = model_swaps
        # Where a project agent POSTs to be heard. It must be an address the
        # project host can reach, not localhost — the agent runs on a different
        # box from this service.
        self.speak_url = speak_url
        # Where a project agent reports what its session actually settled on —
        # the thinking level after the runtime clamped it to what the model has.
        self.state_url = state_url
        self.env = env
        # Fired the moment the line actually swings, so the page can relabel
        # itself then rather than when the whole turn finally settles — a
        # transfer spends most of its time dialling the far end.
        self.on_route_change = on_route_change

        self.route: str = OPERATOR
        self.project: Project | None = None
        self._operator: PiSession | None = None
        self._agent: PiSession | None = None
        # Carries context across a route change, delivered on the next prompt to
        # the operator (e.g. "the caller just came back from grape-segmentation").
        self._operator_note: str | None = None
        # Serializes whole utterances: transferring mid-turn would leave the
        # caller talking to a leg that is being torn down.
        self._lock = asyncio.Lock()
        # The model the live project leg is actually running, and the session
        # file it is writing. Both survive a model swap; the id is what carries
        # the conversation across the restart.
        self._model_spec: str = ""
        self._session_id: str = ""
        # What the live leg reported it is *actually* thinking at, from inside
        # the session. The runtime clamps a level a model does not expose, so
        # the requested level in _model_spec can be a level nobody is running.
        self._effective_thinking: str = ""
        # Cache of hosts whose extension has been staged this process lifetime.
        self._staged: dict[str, str | None] = {}
        # Per-host model catalogs, keyed by host and binary. Read once: a
        # provider list does not change between two sentences of a phone call.
        self._catalogs: dict[str, ModelCatalog] = {}
        self._last_activity = time.monotonic()

    # -- public surface ----------------------------------------------------

    @property
    def route_label(self) -> str:
        if self.route == OPERATOR:
            return "Operator"
        return self.project.id if self.project else self.route

    def status(self) -> dict:
        spec = (self.operator_model if self.route == OPERATOR else self._model_spec) or ""
        provider, model, thinking = parse_spec(spec)
        # What the leg reported beats what it was asked for, because the runtime
        # clamps levels a model does not expose. Never a word like "default":
        # the page states a level someone can act on, or nothing at all.
        effective = self._effective_thinking or thinking
        return {
            "type": "status",
            "route": self.route,
            "label": self.route_label,
            "model": spec,
            "model_name": f"{provider}/{model}" if provider else model,
            "thinking": effective,
            "thinking_requested": thinking,
            # True once the live leg has said so itself; until then the page is
            # showing what was asked for, which may still be clamped.
            "thinking_confirmed": bool(self._effective_thinking),
            "thinking_default": self.agent_thinking,
            "levels": list(THINKING_LEVELS),
            "model_swaps": self.model_swaps,
            "projects": [p["id"] for p in self.registry.catalog()],
        }

    def report_leg_state(self, thinking: str) -> bool:
        """Record what the live project leg says it is actually thinking at.

        Pushed by the agent extension when its session starts and whenever the
        level changes under it. Ignored on the operator: a report can only
        arrive from a project host, and by the time a late one lands the leg it
        described may already be gone.
        """
        level = (thinking or "").strip()
        if self.route == OPERATOR or level not in THINKING_LEVELS:
            return False
        if level == self._effective_thinking:
            return False
        self._effective_thinking = level
        return True

    async def shutdown(self) -> None:
        for session in (self._agent, self._operator):
            if session is not None:
                await session.close()
        self._agent = None
        self._operator = None

    async def handle(self, transcript: str) -> Reply:
        """Route one spoken utterance and produce what the caller hears back."""
        async with self._lock:
            self._last_activity = time.monotonic()
            try:
                if self.route == OPERATOR:
                    return await self._handle_operator(transcript)
                return await self._handle_agent(transcript)
            finally:
                self._last_activity = time.monotonic()

    async def return_if_idle(self, timeout: float) -> str | None:
        """Drop a project leg the caller has walked away from.

        A project session holds an ssh connection and an agent process on
        someone else's box; leaving one up all night because a call was never
        ended is worse than making the caller say where they want to go again.
        Returns the project they were dropped from, or None if nothing changed.
        """
        if timeout <= 0 or self.route == OPERATOR:
            return None
        if time.monotonic() - self._last_activity < timeout:
            return None
        async with self._lock:
            # Re-checked under the lock: the caller may have spoken while we
            # were waiting for it.
            if self.route == OPERATOR or time.monotonic() - self._last_activity < timeout:
                return None
            left = self.project.id if self.project else self.route
            minutes = int(timeout // 60)
            log.info("dropping the idle leg to %s after %s minutes", left, minutes)
            await self._hangup()
            self._operator_note = (
                f"The caller went quiet, so the line to {left} was dropped after "
                f"{minutes} minutes of silence. They may not be there at all."
            )
            self._last_activity = time.monotonic()
            return left

    # -- legs --------------------------------------------------------------

    async def _handle_operator(self, transcript: str) -> Reply:
        try:
            session = await self._ensure_operator()
        except (PiSessionError, OSError) as exc:
            log.exception("operator unavailable")
            return self._reply([f"The operator is not answering: {exc}"], error=str(exc))

        message = transcript
        if self._operator_note:
            message = f"[switchboard] {self._operator_note}\n\n{transcript}"
            self._operator_note = None

        turn = await session.prompt(message)
        if turn.failed and not turn.text:
            detail = turn.error or "operator turn failed"
            await self._reset_operator()
            return self._reply(
                ["The operator dropped the line. Say that again and I'll pick it back up."],
                error=detail,
            )

        transfer = next((s for s in turn.signals if s.name == TRANSFER_TOOL), None)
        if transfer is None:
            return self._reply([turn.text])

        return await self._transfer(
            spoken=str(transfer.args.get("project") or ""),
            intent=str(transfer.args.get("intent") or "").strip(),
            handoff_line=turn.text,
            model=str(transfer.args.get("model") or "").strip(),
            thinking=str(transfer.args.get("thinking") or "").strip(),
        )

    async def _handle_agent(self, transcript: str) -> Reply:
        session = self._agent
        if session is None or not session.alive:
            # The leg died under us — put the caller somewhere real rather than
            # letting them talk into a dead pipe.
            detail = session.stderr_tail() if session else "session gone"
            log.warning("agent leg is dead (%s); returning to operator", detail)
            await self._hangup()
            return self._reply(
                ["That session dropped. You're back with the operator."],
                error=detail,
            )

        turn = await session.prompt(transcript)

        # The leg can be pulled out from under a turn in flight — the caller hit
        # the hang-up button, or the idle watchdog fired. Whatever this turn
        # produced belongs to a call that is already over; swinging the route
        # back on the strength of it would undo the rescue.
        if self._agent is not session:
            log.info("discarding a turn from %s: that leg was already dropped", session.label)
            return self._reply([])

        transfer = next((s for s in turn.signals if s.name == TRANSFER_TOOL), None)
        returning = any(s.name == RETURN_TOOL for s in turn.signals)

        if turn.failed and not turn.text and not returning and transfer is None:
            detail = turn.error or session.stderr_tail() or "agent turn failed"
            name = self.project.id if self.project else "that project"
            await self._hangup()
            self._operator_note = f"The call to {name} ended: {detail}"
            return self._reply(
                [f"{name} stopped responding: {detail}. You're back with the operator."],
                error=detail,
            )

        # If the agent used its own voice this turn, the caller has already
        # heard it; the written text is only for the transcript.
        said = Utterance(turn.text, synthesize=not turn.agent_spoke)

        # A project agent can put the caller through directly. The decision
        # still lands here, so an agent that names something that does not
        # exist drops the caller on the operator rather than nowhere.
        if transfer is not None:
            left = self.project.id if self.project else "that project"
            onward = await self._transfer(
                spoken=str(transfer.args.get("project") or ""),
                intent=str(transfer.args.get("intent") or "").strip(),
                handoff_line="",
                referrer=left,
                model=str(transfer.args.get("model") or "").strip(),
                thinking=str(transfer.args.get("thinking") or "").strip(),
            )
            return self._prepend(said, onward, mute=onward.route != OPERATOR)

        swap = next((s for s in turn.signals if s.name == SET_MODEL_TOOL), None)
        if swap is not None and not returning:
            return self._prepend(said, await self._swap_model(swap), mute=True)

        if not returning:
            return self._reply([said])

        signal = next(s for s in turn.signals if s.name == RETURN_TOOL)
        summary = str(signal.args.get("summary") or "").strip()
        left = self.project.id if self.project else "that project"
        await self._hangup()
        note = f"The caller was just handed back from {left}." + (
            f" Summary from that agent: {summary}" if summary else ""
        )
        return await self._resume_operator(note, said)

    # -- transitions -------------------------------------------------------

    async def _resume_operator(self, note: str, said: Utterance | None = None) -> Reply:
        """Put the caller back on the operator and let it take its turn now.

        The note used to be stapled onto whatever the caller said next, which
        meant an onward destination an agent forwarded ("send me to grapes")
        was read alongside a new request and answered instead of acted on.
        Prompting the operator with it immediately is what lets the transfer
        happen without the caller asking twice.
        """
        lead = [said] if said is not None else []

        try:
            session = await self._ensure_operator()
        except (PiSessionError, OSError) as exc:
            log.exception("operator unavailable on return")
            self._operator_note = note
            return self._reply(lead + ["You're back with the operator."], error=str(exc))

        turn = await session.prompt(f"[switchboard] {note}")
        if turn.failed and not turn.text:
            detail = turn.error or "operator turn failed"
            # Keep the note: the restarted operator should still learn what
            # happened, even if it only hears about it on the next utterance.
            self._operator_note = note
            await self._reset_operator()
            return self._reply(lead + ["You're back with the operator."], error=detail)

        transfer = next((s for s in turn.signals if s.name == TRANSFER_TOOL), None)
        if transfer is None:
            return self._reply(lead + [turn.text])

        onward = await self._transfer(
            spoken=str(transfer.args.get("project") or ""),
            intent=str(transfer.args.get("intent") or "").strip(),
            handoff_line=turn.text,
            model=str(transfer.args.get("model") or "").strip(),
            thinking=str(transfer.args.get("thinking") or "").strip(),
        )
        return self._prepend(said, onward, mute=onward.route != OPERATOR)

    async def _transfer(
        self,
        *,
        spoken: str,
        intent: str,
        handoff_line: str,
        referrer: str = "",
        model: str = "",
        thinking: str = "",
    ) -> Reply:
        # Once the lever has been pulled, whoever pulled it is dead weight on a
        # phone call: the caller is about to hear the agent (or, on a failed
        # transfer, the switchboard saying why not). Keep it in the transcript,
        # never in the queue of clips.
        handoff = Utterance(handoff_line, synthesize=False)

        project = self.registry.resolve(spoken)
        if project is None:
            known = ", ".join(p.id for p in self.registry.projects) or "nothing yet"
            await self._hangup()
            self._operator_note = (
                f"The transfer to {spoken!r} failed: no such project. Known projects: {known}."
                + (f" The caller was on {referrer} when it was attempted." if referrer else "")
            )
            return self._reply(
                [handoff, f"I don't have a project called {spoken}. I know: {known}."],
                error=f"unknown project {spoken!r}",
            )

        # Defensive: never leave an orphaned leg holding a subprocess.
        await self._hangup()

        # A model the caller asked for on the way in. Never fatal: connecting on
        # the project's usual model and saying why beats dropping them on the
        # operator over a name that came through a microphone.
        chosen: ModelChoice | None = None
        model_note = ""
        if (model or thinking) and self.model_swaps:
            try:
                chosen = await self._resolve_model(project, model, thinking)
            except ModelError as exc:
                model_note = f"About the model: {exc}"
                log.info("transfer to %s asked for a model I couldn't use: %s", project.id, exc)

        # Bring the working copy up to date before the agent sees it. Never
        # fatal: a stale checkout is worth far more than a dropped call.
        prepared = await self._run_prepare(project)

        session_id = uuid.uuid4().hex
        spec = self._spec_for(project, chosen)
        try:
            session = await self._start_agent(
                project,
                model=spec,
                session_id=session_id,
            )
        except PiSessionError as exc:
            log.exception("could not connect to %s", project.id)
            self._operator_note = f"The transfer to {project.id} failed: {exc}"
            return self._reply(
                [handoff, f"I couldn't get {project.id} on the line: {exc}"],
                error=str(exc),
            )

        self._agent = session
        self.project = project
        self.route = project.id
        self._session_id = session_id
        self._model_spec = spec
        self._effective_thinking = ""
        await self._announce_route()

        # The first prompt is also the connection test. Starting the process
        # only proves ssh ran; a wrong `cwd`, a missing agent binary or a bad
        # flag all surface here, on the far side of the pipe.
        try:
            intro = await session.prompt(
                INTRO_PROMPT.format(
                    intent_line=(
                        f"They asked for: {intent}"
                        if intent
                        else "They did not say what they want yet."
                    ),
                    workspace_line=(
                        f"\nState of your working copy: {prepared}\n" if prepared else ""
                    ),
                )
            )
        except PiSessionError as exc:
            detail = session.stderr_tail() or str(exc)
            log.warning("intro prompt to %s failed: %s", project.id, detail)
            intro = Turn(text="", failed=True)

        if intro.failed and not intro.text:
            detail = intro.error or session.stderr_tail() or "the agent never answered"
            await self._hangup()
            self._operator_note = f"The transfer to {project.id} failed: {detail}"
            return self._reply(
                [handoff, f"{project.id} didn't pick up: {detail}"],
                error=detail,
            )

        return self._reply(
            [handoff, model_note, Utterance(intro.text, synthesize=not intro.agent_spoke)]
        )

    async def dial(self, spoken: str, intent: str = "") -> Reply:
        """Connect a project because the caller picked it on the page.

        The operator is skipped entirely: the caller has already said where they
        want to be, and making them explain it to a router first is the thing
        the picker exists to avoid. Any live leg is dropped first, without the
        turn lock, so a wedged agent cannot hold the line hostage.
        """
        await self.force_hangup()
        async with self._lock:
            self._last_activity = time.monotonic()
            if spoken.strip().lower() == OPERATOR:
                return self._reply(["You're back with the operator."])
            return await self._transfer(
                spoken=spoken,
                intent=intent,
                handoff_line="",
                referrer="the page",
            )

    async def set_thinking(self, level: str) -> Reply:
        """Change the thinking level from the page.

        Sticks for the rest of this process, so the next leg comes up the same
        way, and takes effect now if a project leg is live — which means a
        restart of that leg, because the level is chosen when the process
        starts. The operator is never re-dialled for this: it is the known-good
        leg and its level is a deployed setting.
        """
        try:
            wanted = normalize_thinking(level)
        except ModelError as exc:
            return self._reply([str(exc)], error=str(exc))
        if not wanted:
            return self._reply(["Name a thinking level and I'll set it."])

        self.agent_thinking = wanted
        if self.route == OPERATOR:
            return self._reply(
                [f"Thinking is set to {wanted} for the next project you connect to."]
            )

        async with self._lock:
            self._last_activity = time.monotonic()
            return await self._redial(thinking=wanted)

    async def _swap_model(self, signal) -> Reply:
        """Restart the live leg on a different model because the agent asked."""
        args = signal.args or {}
        keep = args.get("keep_context")
        return await self._redial(
            model=str(args.get("model") or "").strip(),
            thinking=str(args.get("thinking") or "").strip(),
            intent=str(args.get("intent") or "").strip(),
            keep=True if keep is None else bool(keep),
        )

    async def _redial(
        self, *, model: str = "", thinking: str = "", intent: str = "", keep: bool = True
    ) -> Reply:
        """Restart the live leg on a different model, keeping the conversation.

        The agent asks for this but cannot do it: the process that would have to
        be replaced is the one making the call. Here it is a teardown and a
        rebuild against the same session file, which is what carries the context
        across — the new process reopens the transcript the old one was writing.

        A swap that fails ends on the operator rather than back on the old
        model. The old process is already gone by then, and the operator is the
        one leg whose model was never in question.
        """
        project = self.project
        if project is None:
            return self._reply(["There's no project on the line to re-dial."])
        if not self.model_swaps:
            return self._reply(["Model swapping is turned off on this switchboard."])

        try:
            choice = await self._resolve_model(project, model or self._model_spec, thinking)
        except ModelError as exc:
            # Nothing has been torn down yet, so the caller stays exactly where
            # they are and simply hears why. This is the branch that stops an
            # ambiguous name from stranding them on the wrong provider.
            log.info("refusing a model swap on %s: %s", project.id, exc)
            return self._reply([f"I didn't switch: {exc}"])

        spec = self._spec_for(project, choice)
        if spec == self._model_spec and keep:
            return self._reply([f"Already on {choice.spoken}."])

        log.info(
            "swapping %s from %s to %s (%s context)",
            project.id,
            self._model_spec or "the default",
            choice.spec,
            "keeping" if keep else "clearing",
        )
        if self._agent is not None:
            await self._agent.close()
        session_id = self._session_id if keep else uuid.uuid4().hex

        try:
            session = await self._start_agent(project, model=spec, session_id=session_id)
        except PiSessionError as exc:
            log.exception("could not restart %s on %s", project.id, spec)
            await self._hangup()
            self._operator_note = (
                f"{project.id} could not be restarted on {spec}: {exc}. "
                "The caller is not on that project any more."
            )
            return self._reply(
                [f"I couldn't bring {project.id} back up on {choice.spoken}: {exc}"],
                error=str(exc),
            )

        self._agent = session
        self._session_id = session_id
        self._model_spec = spec
        self._effective_thinking = ""
        await self._announce_route()

        if keep:
            prompt = SWAP_PROMPT.format(
                model=spec,
                intent_line=f"\n\nThey also said: {intent}" if intent else "",
            )
        else:
            prompt = INTRO_PROMPT.format(
                intent_line=(
                    f"They asked for: {intent}"
                    if intent
                    else "They did not say what they want yet."
                ),
                workspace_line=(
                    f"\nYou were just restarted on {spec} and the earlier "
                    "conversation was deliberately cleared — do not try to recall it.\n"
                ),
            )

        try:
            turn = await session.prompt(prompt)
        except PiSessionError as exc:
            turn = Turn(text="", failed=True, error=str(exc))

        if turn.failed and not turn.text:
            detail = turn.error or session.stderr_tail() or "it never answered"
            await self._hangup()
            self._operator_note = f"{project.id} did not come back up on {spec}: {detail}"
            return self._reply(
                [f"{project.id} didn't come back on {choice.spoken}: {detail}"],
                error=detail,
            )

        return self._reply([Utterance(turn.text, synthesize=not turn.agent_spoke)])

    async def _resolve_model(self, project: Project, model: str, thinking: str) -> ModelChoice:
        """Pin a spoken model name to one the target host will actually accept."""
        catalog = await self._host_catalog(project)
        return catalog.resolve(model or project.model or self.agent_model or "", thinking)

    def _spec_for(self, project: Project, chosen: ModelChoice | None) -> str:
        """The `--model` a leg starts on, always carrying a thinking level."""
        spec = chosen.spec if chosen else (project.model or self.agent_model or "")
        return pin_thinking(spec, self.agent_thinking)

    async def _host_catalog(self, project: Project) -> ModelCatalog:
        binary = project.runtime or self.pi_binary
        host = project.host or ""
        key = f"{host}\0{binary}"
        if key not in self._catalogs:
            self._catalogs[key] = await fetch_catalog(list_models_argv(binary, host))
        return self._catalogs[key]

    async def _hangup(self) -> None:
        """End the project leg. Sessions do not survive a transfer, by design."""
        if self._agent is not None:
            await self._agent.close()
        was = self.route
        self._agent = None
        self.project = None
        self.route = OPERATOR
        self._model_spec = ""
        self._session_id = ""
        self._effective_thinking = ""
        if was != OPERATOR:
            await self._announce_route()

    async def force_hangup(self) -> str | None:
        """Drop the current leg on the caller's order, from outside the call.

        Deliberately does NOT take the turn lock. This is the button the caller
        reaches for when the leg is wedged — a bad model, a turn that will not
        settle — and a rescue that waits politely for the thing it is rescuing
        them from is no rescue at all. `_handle_agent` notices its session was
        pulled and does not swing the route back.

        Returns the project they were dropped from, or None if they were already
        on the operator.
        """
        if self.route == OPERATOR:
            return None
        left = self.project.id if self.project else self.route
        log.info("caller hung up the leg to %s from the page", left)
        await self._hangup()
        self._operator_note = (
            f"The caller dropped the line to {left} themselves, from the page. "
            "Assume something was wrong with that leg — ask where they want to go, "
            "do not send them straight back without being told to."
        )
        self._last_activity = time.monotonic()
        return left

    async def _reset_operator(self) -> None:
        if self._operator is not None:
            await self._operator.close()
        self._operator = None

    # -- session construction ---------------------------------------------

    async def _ensure_operator(self) -> PiSession:
        if self._operator is not None and self._operator.alive:
            return self._operator
        if self._operator is not None:
            log.warning("operator process died (%s); restarting", self._operator.stderr_tail())
            await self._operator.close()

        argv = local_argv(
            self.pi_binary,
            model=self.operator_model,
            system_prompt_file=self.operator_system_prompt,
            extension=self.operator_extension,
            # The operator routes calls; it does not read files or run commands.
            # Its only tools are the ones the extension registers.
            extra_args=["--no-builtin-tools", "--no-session"],
        )
        session = PiSession(argv, label=OPERATOR, env=self.env, turn_timeout=180.0)
        await session.start()
        self._operator = session
        return session

    async def _start_agent(
        self, project: Project, *, model: str = "", session_id: str = ""
    ) -> PiSession:
        binary = project.runtime or "pi"
        model = pin_thinking(model or project.model or self.agent_model or "", self.agent_thinking)
        if project.is_remote:
            extension = None
            if project.stage_extension:
                extension = await self._stage_extension(project.host or "")
            argv = remote_argv(
                project.host or "",
                project.cwd,
                binary=binary,
                model=model or None,
                extension=extension,
                append_system_prompt=self._agent_brief(project, bool(extension)),
                session_id=session_id or None,
                extra_args=project.extra_args,
                env=self._agent_env(),
            )
            cwd = None
        else:
            extension = self.agent_extension_file
            argv = [binary, "--mode", "rpc"]
            if model:
                argv += ["--model", model]
            if session_id:
                argv += ["--session-id", session_id]
            if extension:
                argv += ["-e", extension]
            argv += ["--append-system-prompt", self._agent_brief(project, bool(extension))]
            argv += project.extra_args
            cwd = project.cwd or None

        env = dict(self.env or {})
        env.update(self._agent_env())
        session = PiSession(argv, label=project.id, cwd=cwd, env=env)
        await session.start()
        return session

    def _agent_env(self) -> dict[str, str]:
        """Environment a project agent needs beyond whatever its host provides.

        SWITCHBOARD_SESSION marks the process as switchboard-driven. A host may
        also have a `speak` extension installed globally for interactive use;
        that copy checks this variable and stands down, so the tool is not
        registered twice in one session.
        """
        env = {"SWITCHBOARD_SESSION": "1"}
        if self.speak_url:
            env["SWITCHBOARD_SPEAK_URL"] = self.speak_url
        if self.state_url:
            env["SWITCHBOARD_STATE_URL"] = self.state_url
        return env

    def _agent_brief(self, project: Project, has_tool: bool) -> str:
        """The brief depends on whether the tool extension actually loaded.

        Without it the agent has no voice of its own, so it is told the opposite
        thing: write for the switchboard to read out, and expect the caller to
        hear nothing until the turn ends.
        """
        return AGENT_BRIEF.format(
            project_id=project.id,
            speak_instruction=SPEAK_VIA_TOOL if has_tool else SPEAK_VIA_FALLBACK,
            return_instruction=RETURN_VIA_TOOL if has_tool else RETURN_VIA_SENTINEL,
            transfer_instruction=self._transfer_brief(project) if has_tool else "",
            model_instruction=(
                MODEL_BRIEF.format(set_model_tool=SET_MODEL_TOOL)
                if has_tool and self.model_swaps
                else ""
            ),
        ).strip()

    def _transfer_brief(self, current: Project) -> str:
        """The other extensions this agent may hand the caller to, by name."""
        others = [p for p in self.registry.projects if p.id != current.id]
        if not others:
            return ""
        catalog = "\n".join(f"- {p.id} — {p.description or 'no description'}" for p in others)
        return TRANSFER_BRIEF.format(transfer_tool=TRANSFER_TOOL, catalog=catalog)

    async def _run_prepare(self, project: Project) -> str:
        """Run a project's `prepare` shell in its working directory.

        Used to freshen a checkout before the agent starts, so a session never
        opens on a stale tree. Anything it prints becomes the agent's opening
        note about the state of its workspace.
        """
        if not project.prepare:
            return ""

        argv: list[str]
        if project.is_remote:
            argv = [
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                project.host or "",
                f"cd {shlex.quote(project.cwd)} && {project.prepare}",
            ]
        else:
            argv = ["sh", "-c", project.prepare]

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=None if project.is_remote else (project.cwd or None),
                env=self.env,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        except (asyncio.TimeoutError, OSError) as exc:
            log.warning("prepare for %s failed: %s", project.id, exc)
            return ""

        report = stdout.decode("utf-8", "replace").strip()
        if proc.returncode != 0:
            detail = stderr.decode("utf-8", "replace").strip()[:300]
            log.warning("prepare for %s exited %s: %s", project.id, proc.returncode, detail)
            return report or f"could not be refreshed ({detail or 'unknown error'})"
        log.info("prepare for %s: %s", project.id, report)
        return report

    async def _stage_extension(self, host: str) -> str | None:
        """Copy the return-to-operator tool onto a project host.

        The hosts that hold project code are not necessarily Ansible-managed, so
        the switchboard ships its own tool file into a cache directory under the
        ssh user's home rather than expecting one to be installed there. Failure
        is not fatal: without the extension the agent falls back to the sentinel
        line, which needs nothing installed.
        """
        if host in self._staged:
            return self._staged[host]

        result: str | None = None
        source = Path(self.agent_extension_file) if self.agent_extension_file else None
        if source is None or not source.exists():
            log.warning("no agent extension file to stage for %s", host)
            self._staged[host] = None
            return None

        cache = self.remote_cache_dir
        target = f"{cache}/{source.name}"
        # One round trip: make the directory, take the file on stdin, then print
        # the absolute path pi should load it from.
        command = (
            f'set -e; mkdir -p "$HOME"/{shlex.quote(cache)}; '
            f'cat > "$HOME"/{shlex.quote(target)}; '
            f'printf %s "$HOME"/{shlex.quote(target)}'
        )
        try:
            proc = await asyncio.create_subprocess_exec(
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                host,
                command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(source.read_bytes()), timeout=30
            )
            if proc.returncode == 0 and stdout.strip():
                result = stdout.decode("utf-8", "replace").strip()
                log.info("staged switchboard tool on %s at %s", host, result)
            else:
                log.warning(
                    "could not stage the switchboard tool on %s (rc=%s): %s",
                    host,
                    proc.returncode,
                    stderr.decode("utf-8", "replace").strip()[:300],
                )
        except (asyncio.TimeoutError, OSError) as exc:
            log.warning("staging the switchboard tool on %s failed: %s", host, exc)

        self._staged[host] = result
        return result

    # -- helpers -----------------------------------------------------------

    async def _announce_route(self) -> None:
        if self.on_route_change is None:
            return
        try:
            await self.on_route_change()
        except Exception:  # noqa: BLE001
            # Cosmetic: a label that failed to update must not drop a call.
            log.exception("could not announce the route change")

    def _prepend(self, said: Utterance | None, reply: Reply, *, mute: bool = False) -> Reply:
        """Put a departing leg's last words in front of an already-built reply.

        `mute` on a transfer, for the same reason the operator's handoff line is
        never voiced: the caller is about to hear whoever picked up, and a
        farewell queued in front of that is just dead air they have to sit
        through.
        """
        if said is None or not said.text.strip():
            return reply
        lead = Utterance(said.text, synthesize=False) if mute else said
        reply.utterances = [lead, *reply.utterances]
        return reply

    def _reply(
        self, utterances: list[str | Utterance], error: str | None = None
    ) -> Reply:
        """Build a reply. Plain strings are lines the switchboard must voice."""
        lines: list[Utterance] = []
        for item in utterances:
            u = item if isinstance(item, Utterance) else Utterance(item)
            if u.text and u.text.strip():
                lines.append(u)
        return Reply(
            utterances=lines,
            route=self.route,
            route_label=self.route_label,
            error=error,
        )
