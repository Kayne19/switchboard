"""Drive a `pi --mode rpc` agent process over its JSONL stdin/stdout protocol.

One `PiSession` is one live call leg: a single agent process, either local (the
operator, on this box) or remote (a project agent, over ssh on the host that
holds the code). The switchboard writes `prompt` commands in and reads the event
stream back out, harvesting two things per turn:

  * the assistant's text, which becomes the spoken reply, and
  * *signals* — switchboard tool calls (`transfer_to_project`,
    `return_to_operator`) seen in the `tool_execution_start` stream.

Signals are how an agent moves the caller. The tools themselves (see
files/pi-extensions/) do nothing but acknowledge; the routing decision is made
here, by the process that actually owns the phone line.

Protocol notes that bite if ignored (docs/rpc.md in the pi package):
  * Strict JSONL, LF-delimited. Split on "\\n" only.
  * Event lines embed whole message objects and routinely exceed asyncio's
    default 64 KiB StreamReader limit, so the limit is raised explicitly below.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shlex
from dataclasses import dataclass, field

log = logging.getLogger("switchboard.pi")

# Event lines carry full message history; 64 KiB (asyncio's default) overflows
# on any non-trivial turn and raises LimitOverrunError mid-conversation.
STREAM_LIMIT = 16 * 1024 * 1024

# Tools the switchboard interprets as signals rather than ordinary work.
TRANSFER_TOOL = "transfer_to_project"
RETURN_TOOL = "return_to_operator"
# Restarts the current leg on a different model. Like the routing tools it only
# raises a signal: an agent cannot re-launch itself, because the process it
# would have to replace is the one making the call.
SET_MODEL_TOOL = "set_model"
# Not a routing signal — the agent's extension already delivered this audio to
# the caller by the time we see it. It is watched so the switchboard knows the
# agent handled its own voice this turn and does not read the written reply out
# on top of what was already said.
SPEAK_TOOL = "speak"
SIGNAL_TOOLS = {TRANSFER_TOOL, RETURN_TOOL, SET_MODEL_TOOL, SPEAK_TOOL}

# Text fallback for runtimes that cannot load the pi extension (a project host
# without pi, a claude/codex session). Agents are told to emit this exact line;
# it means the same thing as calling RETURN_TOOL.
RETURN_SENTINEL = "[[SWITCHBOARD:RETURN]]"

# An agent whose model call failed still ends its turn cleanly: pi emits an
# assistant message with `stopReason: "error"`, empty content and zero tokens,
# then settles. Read only as "text plus signals" that is indistinguishable from
# an agent that had nothing to say, which is how an expired token on a project
# host turned into silence on the line instead of a handoff back to the
# operator.
ERROR_STOP_REASON = "error"

# `errorMessage` carries a full stack trace. This is spoken aloud, so keep the
# first line and cut it to something a person can listen to.
ERROR_DETAIL_CHARS = 160


@dataclass
class Signal:
    """A routing request an agent made during a turn."""

    name: str
    args: dict = field(default_factory=dict)


@dataclass
class Turn:
    """What one prompt produced: something to say, and possibly somewhere to go."""

    text: str
    signals: list[Signal] = field(default_factory=list)
    failed: bool = False
    # Why it failed, in a form fit to say out loud. Empty when nothing went
    # wrong, or when the failure left no explanation behind.
    error: str = ""

    @property
    def agent_spoke(self) -> bool:
        """Whether the agent said its piece itself during this turn."""
        return any(s.name == SPEAK_TOOL for s in self.signals)


class PiSessionError(RuntimeError):
    pass


def _spoken_error(detail: object) -> str:
    """Reduce a model-call error to a line that can be read out on a call.

    Always returns something: a failure the caller cannot be told the reason
    for is still a failure they need handing back to the operator for.
    """
    if not isinstance(detail, str) or not detail.strip():
        return "the model call failed"
    first = detail.strip().splitlines()[0].strip()
    # Everything from the first "; details=" or " url=" on is diagnostics for a
    # log, not for a person listening to it.
    for cut in ("; details=", " url=", "; stack="):
        head, sep, _ = first.partition(cut)
        if sep:
            first = head.strip()
    if len(first) > ERROR_DETAIL_CHARS:
        first = first[:ERROR_DETAIL_CHARS].rstrip() + "…"
    return first or "the model call failed"


class PiSession:
    """A single agent process, prompted one turn at a time."""

    def __init__(
        self,
        argv: list[str],
        *,
        label: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        turn_timeout: float = 600.0,
    ) -> None:
        self.argv = argv
        self.label = label
        self.cwd = cwd
        self.env = env
        self.turn_timeout = turn_timeout
        self._proc: asyncio.subprocess.Process | None = None
        self._stderr_tail: list[str] = []
        self._stderr_task: asyncio.Task | None = None
        # One turn at a time: the RPC protocol rejects a second `prompt` while
        # the agent is streaming unless a streamingBehavior is given, and a
        # phone call is strictly turn-taking anyway.
        self._lock = asyncio.Lock()

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        log.info("[%s] starting: %s", self.label, " ".join(self.argv))
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self.argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd,
                env=self.env,
                limit=STREAM_LIMIT,
            )
        except OSError as exc:
            raise PiSessionError(f"could not start {self.argv[0]}: {exc}") from exc
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        """Keep stderr flowing (a full pipe deadlocks the child) and keep a tail.

        The tail is what turns "the agent said nothing" into a diagnosable
        message — ssh auth failures and missing binaries only ever show up here.
        """
        assert self._proc is not None and self._proc.stderr is not None
        try:
            while True:
                line = await self._proc.stderr.readline()
                if not line:
                    return
                text = line.decode("utf-8", "replace").rstrip()
                if text:
                    log.debug("[%s] stderr: %s", self.label, text)
                    self._stderr_tail.append(text)
                    del self._stderr_tail[:-20]
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("[%s] stderr drain failed", self.label)

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def stderr_tail(self, limit: int = 5) -> str:
        return " | ".join(self._stderr_tail[-limit:])

    async def close(self) -> None:
        """Hang up this leg. Best-effort and always safe to call twice."""
        proc, self._proc = self._proc, None
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            self._stderr_task = None
        if proc is None or proc.returncode is not None:
            return
        log.info("[%s] closing", self.label)
        try:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        except Exception:  # noqa: BLE001
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass

    # -- one turn ----------------------------------------------------------

    async def prompt(self, message: str) -> Turn:
        """Send one user message and collect the reply plus any routing signals."""
        async with self._lock:
            if not self.alive:
                raise PiSessionError(
                    f"agent process is not running ({self.stderr_tail() or 'no output'})"
                )
            assert self._proc is not None
            assert self._proc.stdin is not None

            payload = json.dumps({"type": "prompt", "message": message}) + "\n"
            try:
                self._proc.stdin.write(payload.encode())
                await self._proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise PiSessionError(f"agent process closed its input: {exc}") from exc

            try:
                return await asyncio.wait_for(self._collect(), timeout=self.turn_timeout)
            except asyncio.TimeoutError:
                log.warning("[%s] turn timed out after %ss", self.label, self.turn_timeout)
                return Turn(
                    text="That is taking longer than a phone call should. I have stopped waiting.",
                    failed=True,
                )

    async def _collect(self) -> Turn:
        """Read events until the agent settles, harvesting text and signals."""
        assert self._proc is not None and self._proc.stdout is not None
        stdout = self._proc.stdout

        chunks: list[str] = []
        signals: list[Signal] = []
        error = ""

        while True:
            try:
                raw = await stdout.readline()
            except (asyncio.LimitOverrunError, ValueError) as exc:
                # A single event exceeded STREAM_LIMIT. The line is unusable and
                # the stream is mid-record, so this leg is finished.
                log.error("[%s] oversized RPC event: %s", self.label, exc)
                return Turn(text="", signals=signals, failed=True)

            if not raw:
                log.warning("[%s] agent stream ended mid-turn", self.label)
                return Turn(text="".join(chunks), signals=signals, failed=True)

            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                log.debug("[%s] non-JSON line: %.200s", self.label, line)
                continue

            kind = event.get("type")

            if kind == "message_update":
                # Take completed text blocks rather than accumulating deltas —
                # `text_end` carries the whole block, so there is nothing to
                # reassemble and no risk of double-counting a retried stream.
                delta = event.get("assistantMessageEvent") or {}
                if delta.get("type") == "text_end":
                    content = delta.get("content")
                    if isinstance(content, str) and content.strip():
                        chunks.append(content.strip())

            elif kind == "message_end":
                # The only place a failed model call is reported. It is not an
                # `extension_error` and it does not break the stream: the turn
                # settles normally with an empty assistant message, so without
                # this the caller just hears nothing.
                message = event.get("message") or {}
                if (
                    message.get("role") == "assistant"
                    and message.get("stopReason") == ERROR_STOP_REASON
                ):
                    error = _spoken_error(message.get("errorMessage"))
                    log.error("[%s] model call failed: %s", self.label, message.get("errorMessage"))

            elif kind == "tool_execution_start":
                name = event.get("toolName")
                if name in SIGNAL_TOOLS:
                    args = event.get("args")
                    signals.append(Signal(name=name, args=args if isinstance(args, dict) else {}))
                    log.info("[%s] signal: %s %s", self.label, name, args)

            elif kind == "agent_settled":
                break

            elif kind == "extension_error":
                log.error("[%s] extension error: %s", self.label, event.get("error"))

        text = "\n".join(chunks).strip()

        # Sentinel fallback for runtimes without the switchboard extension.
        if RETURN_SENTINEL in text:
            text = text.replace(RETURN_SENTINEL, "").strip()
            if not any(s.name == RETURN_TOOL for s in signals):
                signals.append(Signal(name=RETURN_TOOL, args={"via": "sentinel"}))

        # A turn that errored but still produced something — a partial answer, a
        # tool call that landed before the failure — is worth keeping. It is the
        # error with nothing to show for it that has to be surfaced as a
        # failure, so the caller is put back with the operator.
        return Turn(text=text, signals=signals, failed=bool(error), error=error)


def list_models_argv(binary: str, ssh_host: str = "") -> list[str]:
    """Build the argv that prints a host's model catalog.

    Which host matters: a project agent runs where its code is, and that box has
    its own providers configured, so asking damocles what exists would answer
    for the wrong machine.
    """
    if not ssh_host:
        return [binary, "--list-models"]
    return [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        ssh_host,
        f"{shlex.quote(binary)} --list-models",
    ]


def local_argv(
    binary: str,
    *,
    model: str | None,
    system_prompt_file: str | None,
    extension: str | None,
    extra_args: list[str] | None = None,
) -> list[str]:
    """Build the argv for an agent running on this box (the operator)."""
    argv = [binary, "--mode", "rpc"]
    if model:
        argv += ["--model", model]
    if system_prompt_file:
        argv += ["--system-prompt", _read_text(system_prompt_file)]
    if extension:
        argv += ["-e", extension]
    argv += extra_args or []
    return argv


def remote_argv(
    ssh_host: str,
    cwd: str,
    *,
    binary: str,
    model: str | None,
    extension: str | None,
    append_system_prompt: str | None,
    session_id: str | None = None,
    extra_args: list[str] | None = None,
    env: dict[str, str] | None = None,
) -> list[str]:
    """Build the argv for an agent running on the host that holds the project.

    `-T` because there is no terminal on either end, and BatchMode so a missing
    key fails fast and loudly on stderr instead of hanging on a password prompt.

    `env` is set inside the remote shell rather than passed through ssh, because
    sshd only accepts environment variables its config explicitly permits and
    silently drops the rest — which would leave the agent unable to speak with
    no indication why.
    """
    remote: list[str] = [binary, "--mode", "rpc"]
    if model:
        remote += ["--model", model]
    # A fixed id is what lets a leg be restarted on another model without losing
    # the conversation: the replacement process reopens the same session file.
    if session_id:
        remote += ["--session-id", session_id]
    if extension:
        remote += ["-e", extension]
    if append_system_prompt:
        remote += ["--append-system-prompt", append_system_prompt]
    remote += extra_args or []

    # `export NAME=value;` rather than the `NAME=value cmd` prefix form, because
    # the prefix form is not valid in front of `exec` — the shell would take the
    # assignment itself as the command to run.
    exports = "".join(
        f"export {name}={shlex.quote(value)}; " for name, value in sorted((env or {}).items())
    )
    # `set -e` so a bad cwd aborts instead of quietly starting the agent in the
    # ssh user's home directory — an agent in the wrong repo is worse than one
    # that never came up, because it looks like it worked.
    command = (
        f"set -e; cd {shlex.quote(cwd)}; {exports}"
        f"exec {' '.join(shlex.quote(a) for a in remote)}"
    )
    return [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        ssh_host,
        command,
    ]


def _read_text(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()
