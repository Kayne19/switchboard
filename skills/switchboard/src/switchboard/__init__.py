"""Reach the caller from a prime-agent session during a switchboard call.

Each function connects to the host agent's local Unix socket, says hello with
this session's id, and, when the session is on a call, sends one call with the
call's token. The socket contract is in docs/host-link.md ("Skill socket").

Every function returns a small result object and prints one line. A refusal
or a failure never raises; only a programming error (a bad argument type, an
unknown display type or op) does. The host agent and the service decide
delivery; the checks here only catch malformed arguments early.
"""

import json as _json
import os as _os
import socket as _socket

__all__ = ["speak", "display", "view"]

_STATUSES = ("delivered", "accepted", "refused", "failed")
_HELLO_TIMEOUT_S = 5.0
# The host agent answers `failed` at its own deadline (the speech deadline for
# speak, 30 s otherwise); wait a little longer than that for its reply.
_RELAY_TIMEOUT_S = 30.0
_MARGIN_S = 5.0

_VIEW_TARGETS = ("visual", "comms", "system", "theater", "auto")
_DISPLAY_OPS = ("show", "hide", "focus", "say", "clear")
_ROLES = ("primary", "compare", "secondary", "ambient")
# Required `data` keys per show type, and the shape hint given when one is missing.
_SHAPES = {
    "chart": (("series",), "{series:[{name, values:[n]}]}"),
    "metric": (("label", "value"), "{label, value}"),
    "progress": (("label", "value"), "{label, value (percent, 0-100)}"),
    "diagram": (("mode", "nodes", "edges"), '{mode:"graph", nodes:[{id, label}], edges:[{from, to}]}'),
    "document": (("subject", "paragraphs"), "{subject, paragraphs:[str]}"),
    "code": (("source",), "{source:{text}}"),
    "note": (("segments",), "{segments:[{text}]}"),
}


class _Result:
    """What happened to one call. `status` is delivered, accepted, refused or failed."""

    __slots__ = ("call", "status", "reason", "message", "data")

    def __init__(self, call, status, reason=None, message="", data=None):
        self.call = call
        self.status = status
        self.reason = reason
        self.message = message
        self.data = data

    @property
    def delivered(self):
        return self.status == "delivered"

    @property
    def accepted(self):
        return self.status == "accepted"

    @property
    def ok(self):
        return self.status in ("delivered", "accepted")

    def __repr__(self):
        return f"Result(call={self.call!r}, status={self.status!r}, reason={self.reason!r})"


def _socket_path():
    return _os.path.join(_os.path.expanduser("~"), ".cache", "switchboard", "host-agent.sock")


def _identity():
    """(session_id, depth) from the kernel's environment, or None outside a session."""
    session_dir = _os.environ.get("RLM_SESSION_DIR", "").rstrip("/")
    try:
        depth = int(_os.environ.get("RLM_DEPTH", ""))
    except ValueError:
        return None
    if not session_dir:
        return None
    return _os.path.basename(session_dir), depth


def _encode(request):
    """One JSON line. Raises TypeError for a value JSON cannot carry (a programming error);
    array-likes with `tolist()` (numpy values) are converted."""

    def plain(value):
        if hasattr(value, "tolist"):
            return value.tolist()
        raise TypeError(f"{type(value).__name__} cannot be sent to the switchboard")

    return _json.dumps(request, default=plain).encode() + b"\n"


def _exchange(stream, line):
    stream.write(line)
    stream.flush()
    line = stream.readline()
    if not line:
        raise ConnectionError("the host agent closed the connection")
    reply = _json.loads(line)
    if not isinstance(reply, dict):
        raise ValueError("the host agent sent a reply that is not an object")
    return reply


def _send(call, args, describe):
    """Send one call and return its result. Never raises."""
    _encode(args)  # a value JSON cannot carry raises here, before anything is sent
    identity = _identity()
    if identity is None:
        result = _Result(call, "refused", "not_on_call")
    elif identity[1] != 0:
        # A subagent never connects: only the session on the call may reach the caller.
        result = _Result(call, "refused", "subagent")
    else:
        result = _call_host_agent(call, args, *identity)
    result.message = " ".join(describe(result).split())
    print(f"switchboard.{call}: {result.message}")
    return result


def _call_host_agent(call, args, session_id, depth):
    try:
        with _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM) as sock:
            sock.settimeout(_HELLO_TIMEOUT_S)
            sock.connect(_socket_path())
            with sock.makefile("rwb") as stream:
                hello = _exchange(stream, _encode({"op": "hello", "session_id": session_id, "depth": depth}))
                if not hello.get("on_call"):
                    return _Result(call, "refused", hello.get("reason") or "not_on_call")
                token = hello.get("token")
                deadline_ms = hello.get("speech_deadline_ms")
                if call == "speak" and isinstance(deadline_ms, (int, float)) and deadline_ms > 0:
                    sock.settimeout(deadline_ms / 1000 + _MARGIN_S)
                else:
                    sock.settimeout(_RELAY_TIMEOUT_S + _MARGIN_S)
                request = {"op": "call", "session_id": session_id, "depth": depth, "token": token, "call": call, "args": args}
                reply = _exchange(stream, _encode(request))
    except (FileNotFoundError, ConnectionRefusedError):
        return _Result(call, "failed", "failed", data={"error": "the switchboard host agent is not running"})
    except (OSError, ValueError) as err:
        return _Result(call, "failed", "failed", data={"error": str(err)})
    status = reply.get("status")
    if status not in _STATUSES:
        return _Result(call, "failed", "failed", data={"error": f"unexpected reply status {status!r}"})
    return _Result(call, status, reply.get("reason"), data=reply.get("result"))


def _common(result):
    """The line for outcomes every call shares, or None."""
    if result.reason == "not_on_call":
        return "Not on a call; nothing was sent. Put anything for the caller in your written reply."
    if result.reason == "subagent":
        return "A subagent cannot reach the caller; nothing was sent. Report back to your parent instead."
    if result.status == "failed":
        detail = result.data.get("error") if isinstance(result.data, dict) else None
        if not detail and result.reason not in (None, "failed"):
            detail = result.reason
        return f"Could not reach the switchboard{f': {detail}' if detail else ''}. Nothing was sent."
    if result.reason == "caller_away":
        return "The caller is not listening to this session right now; nothing was sent."
    return None


def _refused(result, what):
    reason = f": {result.reason}" if result.reason else ""
    return f"The switchboard refused that {what}{reason}."


def _require_str(name, value, optional=False):
    if value is None and optional:
        return
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string, not {type(value).__name__}")
    if not optional and not value.strip():
        raise ValueError(f"{name} must not be empty")


def _optional_args(**values):
    return {key: value for key, value in values.items() if value is not None}


def speak(text):
    """Say `text` out loud to the caller: a sentence or two of plain spoken English."""
    _require_str("text", text)

    def describe(result):
        if result.delivered or result.accepted:
            return "Spoken."
        return _common(result) or (
            f"Nothing was played: {result.reason or 'no reason given'}. The caller cannot hear you right now."
        )

    return _send("speak", {"text": text}, describe)


def _check_display_action(action):
    if not isinstance(action, dict):
        raise TypeError(f"a display action must be a dict, not {type(action).__name__}")
    op = action.get("op")
    if op not in _DISPLAY_OPS:
        raise ValueError(f"unknown display op {op!r}; use one of: {', '.join(_DISPLAY_OPS)}")
    if op in ("show", "hide", "focus"):
        _require_str("id", action.get("id"))
    if op == "say":
        _require_str("text", action.get("text"))
    if op != "show":
        return
    kind = action.get("type")
    if kind not in _SHAPES:
        shapes = " | ".join(f"{name}: {hint}" for name, (_, hint) in _SHAPES.items())
        raise ValueError(f"unknown display type {kind!r}; each type takes only its own shape: {shapes}")
    role = action.get("role")
    if role is not None and role not in _ROLES:
        raise ValueError(f"unknown display role {role!r}; use one of: {', '.join(_ROLES)}")
    data = action.get("data")
    if not isinstance(data, dict):
        raise TypeError(f"data must be a dict, not {type(data).__name__}")
    required, hint = _SHAPES[kind]
    missing = [key for key in required if key not in data]
    if missing:
        raise ValueError(f"{kind} data is missing {', '.join(missing)}; its shape is {hint}")


def display(action=None, **fields):
    """Show, update, hide, focus, anchor speech to, or clear something on the caller's screen.

    Pass one action as a dict, or its fields as keywords:
    display(op="show", id="build", type="progress", data={"label": "Build", "value": 40}).
    """
    if action is None:
        action = fields
    elif fields:
        raise TypeError("pass the display action as a dict or as keywords, not both")
    _check_display_action(action)

    def describe(result):
        data = result.data if isinstance(result.data, dict) else {}
        if result.delivered or result.accepted:
            if data.get("rendered") is False:
                return "Sent, but the caller's screen has not confirmed it; it may not be visible yet."
            return "On screen."
        if result.status == "refused" and result.reason not in ("not_on_call", "subagent", "caller_away"):
            return (
                f"The switchboard rejected it: {result.reason or 'invalid payload'}. "
                "Adjust the payload and try again."
            )
        return _common(result) or _refused(result, "display")

    return _send("display", {"action": action}, describe)


def view(target=None):
    """Inspect the caller's screen (no target), or ask it to focus a target:
    visual, comms, system, theater or auto."""
    if target is not None and target not in _VIEW_TARGETS:
        raise ValueError(f"unknown view target {target!r}; use one of: {', '.join(_VIEW_TARGETS)}")

    def describe(result):
        if not (result.delivered or result.accepted):
            return _common(result) or _refused(result, "view request")
        if target is not None:
            return f"Requested {target} view. The caller's pinned view may take precedence."
        data = result.data if isinstance(result.data, dict) else {}
        screen = data.get("screen", data)
        if not isinstance(screen, dict):
            screen = {}
        kind = screen.get("visual_kind") or "visual"
        titled = f" titled '{screen['title']}'" if screen.get("title") else ""
        if not screen.get("has_visual"):
            text = "Nothing is on the caller's screen right now."
        elif screen.get("confirmed"):
            text = f"Showing a {kind}{titled} on the caller's screen."
        else:
            text = f"Requested a {kind}{titled}, but the caller's screen has not confirmed it yet."
        if screen.get("connected") is False:
            text += " No browser is connected."
        return text

    return _send("view", _optional_args(target=target), describe)
