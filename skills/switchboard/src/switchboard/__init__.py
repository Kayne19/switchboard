"""Reach the caller from a prime-agent session during a switchboard call.

Each function connects to the host agent's local Unix socket, says hello with
this session's id, and, when the session is on a call, sends one call with the
call's token. The socket contract is in docs/host-link.md ("Skill socket").

Every function returns a small result object and prints one line. A refusal
or a failure never raises; only a programming error (a bad argument type, an
unknown display type or op, a value JSON cannot carry or the service would
read as another; SKILL.md, "Results") does. The host agent and the service decide
delivery; the checks here only catch malformed arguments early.
"""

import base64 as _base64
import datetime as _datetime
import json as _json
import os as _os
import socket as _socket

__all__ = ["speak", "request_to_speak", "display", "view"]

_STATUSES = ("delivered", "accepted", "refused", "failed")
_HELLO_TIMEOUT_S = 5.0
# The service reads a frame whose arrays and objects nest at most this deep
# (MAX_FRAME_DEPTH in hosts.rs; docs/host-link.md, "Frames the service cannot
# read"). The host agent relays a call's args one level into its frame, as
# they are one level into the request line written here, so the line is held
# to the same depth. scripts/check_hygiene.mjs keeps the two numbers equal.
_MAX_FRAME_DEPTH = 127
# The service and the page read every number as a double, which holds each
# integer exactly only up to 2**53.
_MAX_EXACT_INT = 2**53
# The host agent answers `failed` at its own deadline (the speech deadline for
# speak, 30 s otherwise); wait a little longer than that for its reply.
_RELAY_TIMEOUT_S = 30.0
_MARGIN_S = 5.0

_VIEW_TARGETS = ("visual", "comms", "system", "theater", "auto")
_SPEAK_REASONS = ("finished", "needs_decision", "problem")
_DISPLAY_OPS = ("show", "hide", "focus", "say", "clear")
_ROLES = ("primary", "compare", "secondary", "ambient")
# Required `data` keys per show type, and the shape hint given when one is missing.
_SHAPES = {
    "chart": (("series",), "{series:[{name, values:[n]}]}"),
    "metric": (("label", "value"), "{label, value}"),
    "progress": (("label",), "{label, value (percent, 0-100) and/or steps:[{label}]}"),
    "diagram": (
        ("mode",),
        '{mode:"graph", nodes:[{id, label}], edges:[{from, to}]} or {mode:"sequence", actors:[{id, label}], messages:[{from, to, label}]}',
    ),
    "document": (("subject", "paragraphs"), "{subject, paragraphs:[str]}"),
    "code": (("source",), "{source:{text}}"),
    "table": (("columns", "rows"), "{columns:[{label}], rows:[[cell]]} (cell: str | number | {text})"),
    "note": (("segments",), "{segments:[{text}]}"),
    # The wire shape; `_image_data` makes it from a path or raw bytes first.
    "image": (("format", "bytes", "alt"), '{alt, path:"/tmp/fig.png"} or {alt, bytes:<raw bytes>}'),
    # Times are "YYYY-MM-DD", a wall time "YYYY-MM-DDTHH:MM", or (a timer's
    # only) an instant "YYYY-MM-DDTHH:MM:SS-07:00"; `_wire_times` writes them
    # from date and datetime values.
    "calendar": (
        ("view", "start", "events"),
        '{view:"day"|"week"|"month"|"agenda", start:"YYYY-MM-DD", events:[{id, title, start:"YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"}]}',
    ),
    "tasks": (("items",), '{items:[{id, text, state?, due?:"YYYY-MM-DD"}]}'),
    "timer": (("timers",), '{timers:[{id, label, endsAt:"YYYY-MM-DDTHH:MM:SS-07:00"}]}'),
    "weather": (("location", "units", "current"), '{location, units:"C"|"F", current:{temp, condition}}'),
    "inbox": (("messages",), '{messages:[{id, from, time:"YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"}]}'),
}
# How `view` names a visual kind in a sentence, where the type name does not
# read as a noun: "Showing a to-do list", not "a tasks".
_VISUAL_WORDS = {"tasks": "to-do list", "weather": "forecast"}
# A diagram's other required keys depend on its mode.
_DIAGRAM_MODES = {"graph": ("nodes", "edges"), "sequence": ("actors", "messages")}

# Keys of which a show type needs at least one, beyond `_SHAPES`: a progress
# bar is filled from `value`, or from the share of `steps` that are done.
_ONE_OF = {
    "progress": ("value", "steps"),
}

# ---- image ------------------------------------------------------------------

# The service and the page take at most this many raw image bytes
# (MAX_IMAGE_BYTES in visual_protocol.rs and validation.ts);
# scripts/check_hygiene.mjs keeps the numbers equal.
_MAX_IMAGE_BYTES = 8 * 1024 * 1024

# ---- size -------------------------------------------------------------------

# The caps a request is held to, named when one is too large: a display
# action as JSON, an image's action (MAX_ACTION_BYTES and
# MAX_IMAGE_ACTION_BYTES in visual_protocol.rs and validation.ts, which
# measure it), and the request line the host agent reads (MAX_LINE_BYTES in
# apps/host-agent/src/skill_socket.ts, which answers a longer one
# `too_large` unread). scripts/check_hygiene.mjs keeps the numbers equal.
_MAX_ACTION_BYTES = 48_000
_MAX_IMAGE_ACTION_BYTES = 12 * 1024 * 1024
_MAX_LINE_BYTES = 13 * 1024 * 1024
_MIB = 1024 * 1024


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
    """One JSON line. A value JSON cannot carry is a programming error and raises:
    a type JSON has not (TypeError), or a NaN, an infinity or a string holding half
    of a surrogate pair (ValueError). Array-likes with `tolist()` (numpy values) are
    converted."""

    def plain(value):
        if hasattr(value, "tolist"):
            return value.tolist()
        raise TypeError(f"{type(value).__name__} cannot be sent to the switchboard")

    # Python writes NaN and Infinity, which no JSON reader takes: the host
    # agent refused the line as a bad request. A lone surrogate it writes as a
    # \ud83d escape, which the service cannot read. Both are caught here, with
    # what is wrong, before anything is sent.
    try:
        text = _json.dumps(request, default=plain, allow_nan=False, ensure_ascii=False)
    except ValueError as err:
        raise ValueError(f"cannot be sent to the switchboard: {err}") from err
    # A pair held as two code points ("\ud83d\ude00") is one character; it
    # is joined first, so only a true lone half is refused.
    text = text.encode("utf-16", "surrogatepass").decode("utf-16", "surrogatepass")
    try:
        return text.encode() + b"\n"
    except UnicodeEncodeError as err:
        half = err.object[err.start]
        raise ValueError(
            f"cannot be sent to the switchboard: a string holds {half!r}, half of a UTF-16 surrogate pair; "
            "send whole characters"
        ) from None


def _field(path):
    """`path`, its steps written `.key` for an object's key and `[n]` for an
    array's index, as a field is written: `action.data.series[0].values[1]`."""
    return "".join(path).lstrip(".")


def _check_values(value, depth, path):
    """Raises ValueError, naming the field, for a value the service would read
    as another: an integer beyond 2**53, or arrays and objects nested deeper
    than it reads. `depth` is the level `value` stands at in the request line.
    Array-likes with `tolist()` are judged as `_encode` sends them."""
    if isinstance(value, (dict, list, tuple)):
        if depth > _MAX_FRAME_DEPTH:
            shown = _field(path[:4]) + ("..." if len(path) > 4 else "")
            raise ValueError(
                f"{shown} nests arrays and objects deeper than the switchboard reads "
                f"({_MAX_FRAME_DEPTH} levels, the call around it included); send it flatter"
            )
        # JSON writes every key as text, so a key is `.3`, never an index.
        if isinstance(value, dict):
            steps = ((f".{key}", item) for key, item in value.items())
        else:
            steps = ((f"[{n}]", item) for n, item in enumerate(value))
        for step, item in steps:
            _check_values(item, depth + 1, (*path, step))
    elif isinstance(value, (bool, str, float, bytes, bytearray, memoryview)) or value is None:
        # Raw image bytes become base64 text before they are sent.
        return
    elif isinstance(value, int):
        if abs(value) > _MAX_EXACT_INT:
            raise ValueError(
                f"{_field(path)} is an integer beyond 2**53, which the switchboard reads as a double "
                "and cannot hold exactly; send it as a float or as text"
            )
    elif hasattr(value, "tolist"):
        # Followed once; what is still array-like after that is `_encode`'s to judge.
        plain = value.tolist()
        if not hasattr(plain, "tolist"):
            _check_values(plain, depth, path)


def _check_call_args(args):
    """Raises for a value in a call's `args`, which stand one level into the
    request line, that the service would read as another (`_check_values`)."""
    _check_values(args, 2, ())


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
        return "Subagents can't reach the caller; nothing was sent. Put it in your report to your parent."
    if result.status == "failed":
        detail = result.data.get("error") if isinstance(result.data, dict) else None
        if not detail and result.reason not in (None, "failed"):
            detail = result.reason
        return f"Could not reach the switchboard{f': {detail}' if detail else ''}. Nothing was sent."
    if result.reason == "caller_away":
        return "The caller is on other work; nothing was played. If it matters to them, send it with request_to_speak."
    if result.reason == "too_large":
        return f"Too large; nothing was sent. The host agent reads a request of at most {_MAX_LINE_BYTES // _MIB} MiB. Send less."
    return None


def _refused(result, what):
    reason = f": {result.reason}" if result.reason else ""
    return f"The switchboard refused that {what}{reason}."


# Unicode White_Space, the one whitespace set the service and the page judge a
# blank id by (docs/display-tool.md, "How the two validators agree"). Not
# str.strip, which also strips U+001C to U+001F.
_WHITE_SPACE = frozenset(
    "\t\n\x0b\x0c\r \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
    "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
)


def _invalid_name(field, allowed):
    """The refusal of a name outside its set, as the service and the page
    word it (docs/display-tool.md, "How the two validators agree"): the
    field and every name it takes."""
    return f"invalid {field}: expected one of {', '.join(allowed)}"


def _require_str(name, value, optional=False, blank_ok=False):
    """A string, and unless `blank_ok` one with something besides White_Space;
    with `blank_ok` it need only be non-empty, as a display `say` text is."""
    if value is None and optional:
        return
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string, not {type(value).__name__}")
    if not optional and (not value if blank_ok else all(ch in _WHITE_SPACE for ch in value)):
        raise ValueError(f"{name} must not be empty")


def _optional_args(**values):
    return {key: value for key, value in values.items() if value is not None}


def speak(text):
    """Say `text` out loud to the caller, in plain spoken words. Detail goes on the screen."""
    _require_str("text", text)

    def describe(result):
        if result.delivered or result.accepted:
            return "Spoken."
        return _common(result) or (
            f"Nothing was played: {result.reason or 'no reason given'}. The caller cannot hear you right now."
        )

    return _send("speak", {"text": text}, describe)


def request_to_speak(message, reason):
    """Queue what the caller should hear while they are on other work.

    ``message`` is the real content (the result, the question with options, or
    the problem and what you need), not a teaser. ``reason`` is ``finished``,
    ``needs_decision`` or ``problem``.
    """
    _require_str("message", message)
    _require_str("reason", reason)
    if reason not in _SPEAK_REASONS:
        raise ValueError(_invalid_name("reason", _SPEAK_REASONS))

    def describe(result):
        if result.accepted or result.delivered:
            return "Queued. The caller hears it at a good moment."
        return _common(result) or _refused(result, "request to speak")

    return _send("request_to_speak", {"message": message, "reason": reason}, describe)


def _image_format(raw):
    """The raster format `raw` starts with, by its file signature, or None."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def _image_data(data):
    """An image's `data` as the wire carries it: `path` or raw `bytes` become
    `format` and base64 `bytes`; the path itself is never sent. Data already in
    the wire shape (base64 text) is returned as it is."""
    path = data.get("path")
    raw = data.get("bytes")
    if path is None and not isinstance(raw, (bytes, bytearray, memoryview)):
        # Already the wire shape; an explicit `path=None` is no path at all.
        return {key: value for key, value in data.items() if key != "path"}
    if path is not None and raw is not None:
        raise ValueError("image data takes a path or bytes, not both")
    if path is not None:
        if not isinstance(path, (str, _os.PathLike)):
            raise TypeError(f"image path must be a string, not {type(path).__name__}")
        try:
            with open(path, "rb") as fh:
                raw = fh.read(_MAX_IMAGE_BYTES + 1)
        except OSError as err:
            raise ValueError(f"cannot read image path {_os.fspath(path)!r}: {err.strerror or err}") from err
    raw = bytes(raw)
    if len(raw) > _MAX_IMAGE_BYTES:
        raise ValueError(f"the image is over {_MAX_IMAGE_BYTES} bytes; scale it down or re-encode it")
    found = _image_format(raw)
    if found is None:
        raise ValueError("the image is not a PNG, JPEG or WebP (SVG is not shown); save it as a PNG first")
    named = data.get("format")
    if named is not None and named != found:
        raise ValueError(f"the image's bytes are a {found}, not a {named}")
    wire = {key: value for key, value in data.items() if key != "path"}
    wire["format"] = found
    wire["bytes"] = _base64.b64encode(raw).decode("ascii")
    return wire


def _check_display_action(action):
    if not isinstance(action, dict):
        raise TypeError(f"a display action must be a dict, not {type(action).__name__}")
    op = action.get("op")
    if op not in _DISPLAY_OPS:
        raise ValueError(_invalid_name("op", _DISPLAY_OPS))
    if op in ("show", "hide", "focus"):
        _require_str("id", action.get("id"))
    if op == "say":
        # The service takes any non-empty text here, spaces included.
        _require_str("text", action.get("text"), blank_ok=True)
    if op != "show":
        return
    kind = action.get("type")
    if not isinstance(kind, str) or kind not in _SHAPES:
        shapes = " | ".join(f"{name}: {hint}" for name, (_, hint) in _SHAPES.items())
        raise ValueError(f"{_invalid_name('show.type', _SHAPES)}; each type takes only its own shape: {shapes}")
    # A role, when the action has one, is a known name: `role=None` is sent as
    # null, which the service refuses, so it is caught here like any other.
    if "role" in action and (not isinstance(action["role"], str) or action["role"] not in _ROLES):
        raise ValueError(_invalid_name("show.role", _ROLES))
    data = action.get("data")
    if not isinstance(data, dict):
        raise TypeError(f"data must be a dict, not {type(data).__name__}")
    required, hint = _SHAPES[kind]
    if kind == "diagram":
        # A diagram's other keys follow from its mode, so the mode comes first,
        # missing or not, as the service checks it.
        mode = data.get("mode")
        if not isinstance(mode, str) or mode not in _DIAGRAM_MODES:
            raise ValueError(f"{_invalid_name('diagram.mode', _DIAGRAM_MODES)}; its shape is {hint}")
        required = _DIAGRAM_MODES[mode]
    missing = [key for key in required if key not in data]
    if missing:
        raise ValueError(f"{kind} data is missing {', '.join(missing)}; its shape is {hint}")
    one_of = _ONE_OF.get(kind, ())
    if one_of and not any(key in data for key in one_of):
        raise ValueError(f"{kind} data needs {' or '.join(one_of)}; its shape is {hint}")


# ---- time values ---------------------------------------------------------------

# A timer's two times are instants, measured against the page clock; every
# other time a display takes is a date or the caller's wall time
# (docs/display-tool.md, "Time values").
_INSTANT_KEYS = ("endsAt", "startedAt")


def _wire_instant(value, key):
    """An aware datetime as an instant with its offset. A naive one names no
    moment, so it raises; an offset with seconds (no instant has one) is
    written in UTC instead."""
    offset = value.utcoffset()
    if offset is None:
        raise ValueError(
            f"{key} is an instant: give an aware datetime in the caller's zone, such as "
            "datetime.now(zone) + timedelta(minutes=9) with zone the caller's ZoneInfo, "
            "or text like 2026-10-05T18:42:00-07:00"
        )
    if offset.seconds % 60 or offset.microseconds:
        value = value.astimezone(_datetime.timezone.utc)
    return value.isoformat(timespec="seconds" if value.microsecond == 0 else "microseconds")


def _wire_times(value, key=None):
    """`value` with each date and datetime written as the time text the
    display takes, by the field it is in: a date as "YYYY-MM-DD"; a
    datetime as a wall time on its own clock, "YYYY-MM-DDTHH:MM" (to the
    minute, as the page draws it), except a timer's `endsAt` and
    `startedAt`, which are instants."""
    if isinstance(value, dict):
        return {name: _wire_times(item, name) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_wire_times(item, key) for item in value]
    if isinstance(value, _datetime.datetime):
        if key in _INSTANT_KEYS:
            return _wire_instant(value, key)
        return value.strftime("%Y-%m-%dT%H:%M")
    if isinstance(value, _datetime.date):
        return value.isoformat()
    return value


def _display_wire_action(action):
    """The action as it is sent: dates and datetimes become time text, an
    image's path or raw bytes become its wire fields, then its outline is
    checked (a malformed one raises)."""
    if isinstance(action, dict) and action.get("op") == "show" and isinstance(action.get("data"), dict):
        action = {**action, "data": _wire_times(action["data"])}
    if isinstance(action, dict) and action.get("op") == "show" and action.get("type") == "image" and isinstance(action.get("data"), dict):
        action = {**action, "data": _image_data(action["data"])}
    _check_display_action(action)
    return action


def display(action=None, **fields):
    """Show, update, hide, focus, anchor speech to, or clear something on the caller's screen.

    Pass one action as a dict, or its fields as keywords:
    display(op="show", id="build", type="progress", data={"label": "Build", "value": 40}).
    An image is shown from a file or raw bytes, never a URL:
    display(op="show", id="fig", type="image", data={"path": "/tmp/fig.png", "alt": "Loss curve"}).
    """
    if action is None:
        action = fields
    elif fields:
        raise TypeError("pass the display action as a dict or as keywords, not both")
    if not isinstance(action, dict):
        raise TypeError(f"a display action must be a dict, not {type(action).__name__}")
    # Before anything else walks the action: one that holds itself is caught
    # here, at the depth cap, rather than recursing.
    _check_call_args({"action": action})
    action = _display_wire_action(action)

    def describe(result):
        data = result.data if isinstance(result.data, dict) else {}
        if result.delivered or result.accepted:
            if data.get("held") is True:
                return "Held until the caller comes back to you. Say it's ready, not that it's on screen."
            if data.get("rendered") is False:
                return "Sent, but the caller's screen has not confirmed it; it may not be visible yet."
            return "On screen."
        if result.reason == "too_large":
            return (
                f"Too large; nothing was sent. The host agent reads a request of at most {_MAX_LINE_BYTES // _MIB} MiB, "
                f"and a display action is at most {_MAX_ACTION_BYTES:,} bytes as JSON (an image's "
                f"{_MAX_IMAGE_ACTION_BYTES // _MIB} MiB). Send less."
            )
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
        raise ValueError(_invalid_name("target", _VIEW_TARGETS))

    def describe(result):
        if target is not None and result.reason == "caller_away":
            return "The caller is with another session; their screen isn't yours to change. It follows your display when they bring you forward."
        if not (result.delivered or result.accepted):
            return _common(result) or _refused(result, "view request")
        if target is not None:
            return f"Requested {target} view. The caller's pinned view may take precedence."
        data = result.data if isinstance(result.data, dict) else {}
        screen = data.get("screen", data)
        if not isinstance(screen, dict):
            screen = {}
        kind = _VISUAL_WORDS.get(screen.get("visual_kind"), screen.get("visual_kind") or "visual")
        a_kind = f"{'an' if kind[:1] in 'aeiou' else 'a'} {kind}"
        titled = f" titled '{screen['title']}'" if screen.get("title") else ""
        if not screen.get("has_visual"):
            text = "Nothing is on the caller's screen right now."
        elif screen.get("confirmed"):
            text = f"Showing {a_kind}{titled} on the caller's screen."
        else:
            text = f"Requested {a_kind}{titled}, but the caller's screen has not confirmed it yet."
        if screen.get("connected") is False:
            text += " No browser is connected."
        return text

    return _send("view", _optional_args(target=target), describe)
