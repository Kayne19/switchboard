"""The switchboard skill module against a fake host-agent skill socket (docs/host-link.md)."""

import base64
import contextlib
import datetime
import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import switchboard  # noqa: E402

SESSION_ID = "0199aa00-test-session"
TOKEN = "call-token-1"


class FakeHostAgent:
    """Serves the skill socket: JSON lines, one reply per request, in order."""

    def __init__(self, home, on_call=True, reply=None):
        self.path = os.path.join(home, ".cache", "switchboard", "host-agent.sock")
        os.makedirs(os.path.dirname(self.path), mode=0o700)
        self.on_call = on_call
        self.reply = reply or (lambda request: {"status": "delivered", "reason": None})
        self.requests = []
        self.connections = 0
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            self.connections += 1
            with conn, conn.makefile("rwb") as stream:
                for line in stream:
                    request = json.loads(line)
                    self.requests.append(request)
                    answer = self._answer(request)
                    if answer is None:
                        break
                    stream.write(answer if isinstance(answer, bytes) else json.dumps(answer).encode() + b"\n")
                    stream.flush()

    def _answer(self, request):
        if request["op"] == "hello":
            if request["depth"] != 0:
                return {"on_call": False, "reason": "subagent"}
            if not self.on_call:
                return {"on_call": False}
            return {"on_call": True, "token": TOKEN, "persona": "Calm.", "speech_deadline_ms": 2000}
        return self.reply(request)

    def calls(self):
        return [request for request in self.requests if request["op"] == "call"]

    def close(self):
        with contextlib.suppress(OSError):
            self.server.shutdown(socket.SHUT_RDWR)  # wakes the blocked accept()
        self.server.close()
        self.thread.join(timeout=5)


class ModuleTestCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="sb-skill-")
        self.addCleanup(lambda: __import__("shutil").rmtree(self.home, ignore_errors=True))
        session_dir = os.path.join(self.home, "session-artifacts", SESSION_ID)
        env = {"HOME": self.home, "RLM_SESSION_DIR": session_dir, "RLM_DEPTH": "0"}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def host(self, **kwargs):
        host = FakeHostAgent(self.home, **kwargs)
        self.addCleanup(host.close)
        return host

    def run_call(self, fn, *args, **kwargs):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = fn(*args, **kwargs)
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 1, f"expected one printed line, got {lines!r}")
        return result, lines[0]


class SurfaceTest(unittest.TestCase):
    def test_module_exposes_exactly_the_foundation_surface(self):
        # Update this assertion in the same commit as any step that changes the surface
        # (req:ext-via-host): Jev removes the routing signals, background adds request_to_speak.
        surface = {"speak", "request_to_speak", "display", "view"}
        public = {name for name in dir(switchboard) if not name.startswith("_")}
        self.assertEqual(public, surface)
        self.assertEqual(set(switchboard.__all__), surface)


class RequestToSpeakContractTest(unittest.TestCase):
    def test_docstring_describes_spoken_answer_contract(self):
        doc = switchboard.request_to_speak.__doc__ or ""
        self.assertIn("real content", doc)
        self.assertIn("not a teaser", doc)
        self.assertIn("question with options", doc)
        self.assertIn("problem and what you need", doc)


class BackgroundSurfaceTest(unittest.TestCase):
    def test_background_step_keeps_the_four_call_surface(self):
        self.assertEqual(set(switchboard.__all__), {"speak", "request_to_speak", "display", "view"})
        self.assertNotIn("transfer_to_project", dir(switchboard))
        self.assertNotIn("return_to_operator", dir(switchboard))

    def test_the_skill_guide_documents_only_the_four_calls(self):
        guide = (Path(__file__).resolve().parents[1] / "SKILL.md").read_text()
        for removed in ("return_to_operator(", "transfer_to_project(", "set_model("):
            self.assertNotIn(removed, guide)


class IdentityTest(ModuleTestCase):
    def test_identity_comes_from_rlm_session_dir_at_depth_zero(self):
        host = self.host()
        result, line = self.run_call(switchboard.speak, "Found it.")
        self.assertEqual(host.requests[0], {"op": "hello", "session_id": SESSION_ID, "depth": 0})
        self.assertEqual(
            host.calls(),
            [{"op": "call", "session_id": SESSION_ID, "depth": 0, "token": TOKEN, "call": "speak", "args": {"text": "Found it."}}],
        )
        self.assertTrue(result.delivered)
        self.assertTrue(result.ok)
        self.assertEqual(line, "switchboard.speak: Spoken.")

    def test_trailing_slash_on_session_dir_is_ignored(self):
        host = self.host()
        os.environ["RLM_SESSION_DIR"] += "/"
        self.run_call(switchboard.speak, "Hi.")
        self.assertEqual(host.requests[0]["session_id"], SESSION_ID)

    def test_subagent_is_refused_without_connecting(self):
        host = self.host()
        os.environ["RLM_DEPTH"] = "1"
        result, line = self.run_call(switchboard.speak, "Hi.")
        self.assertEqual((result.status, result.reason), ("refused", "subagent"))
        self.assertIn("Subagents can't reach the caller", line)
        self.assertEqual(host.connections, 0)

    def test_not_on_call_when_the_host_agent_says_so(self):
        host = self.host(on_call=False)
        result, line = self.run_call(switchboard.speak, "Hi.")
        self.assertEqual((result.status, result.reason), ("refused", "not_on_call"))
        self.assertIn("Not on a call", line)
        self.assertEqual(host.calls(), [])

    def test_not_on_call_outside_a_session(self):
        host = self.host()
        for name in ("RLM_SESSION_DIR", "RLM_DEPTH"):
            with self.subTest(missing=name), mock.patch.dict(os.environ):
                del os.environ[name]
                result, line = self.run_call(switchboard.display, op="clear")
                self.assertEqual((result.status, result.reason), ("refused", "not_on_call"))
        self.assertEqual(host.connections, 0)


class FailureTest(ModuleTestCase):
    def test_missing_socket_fails_without_raising(self):
        result, line = self.run_call(switchboard.speak, "Hi.")
        self.assertEqual(result.status, "failed")
        self.assertFalse(result.ok)
        self.assertIn("not running", line)

    def test_closed_connection_fails_without_raising(self):
        self.host(reply=lambda request: None)
        result, line = self.run_call(switchboard.view)
        self.assertEqual(result.status, "failed")
        self.assertIn("Could not reach the switchboard", line)

    def test_garbage_reply_fails_without_raising(self):
        self.host(reply=lambda request: b"not json\n")
        result, _ = self.run_call(switchboard.speak, "Hi.")
        self.assertEqual(result.status, "failed")

    def test_unknown_status_fails_without_raising(self):
        self.host(reply=lambda request: {"status": "maybe"})
        result, _ = self.run_call(switchboard.speak, "Hi.")
        self.assertEqual(result.status, "failed")

    def test_host_agent_failure_reason_is_reported(self):
        self.host(reply=lambda request: {"status": "failed", "reason": "link_down"})
        result, line = self.run_call(switchboard.speak, "Hi.")
        self.assertEqual((result.status, result.reason), ("failed", "link_down"))
        self.assertIn("link_down", line)

    def test_refusals_never_raise(self):
        for reason in ("caller_away", "not_on_call", "subagent", "unknown_call", "bad_request", None):
            self.host(reply=lambda request, reason=reason: {"status": "refused", "reason": reason})
            calls = [
                (switchboard.speak, ("Hi.",), {}),
                (switchboard.display, (), {"op": "hide", "id": "x"}),
                (switchboard.view, ("comms",), {}),
            ]
            for fn, args, kwargs in calls:
                with self.subTest(reason=reason, call=fn.__name__):
                    result, line = self.run_call(fn, *args, **kwargs)
                    self.assertEqual(result.status, "refused")
                    self.assertFalse(result.ok)
                    self.assertTrue(line.startswith(f"switchboard.{fn.__name__}: "))
            self.doCleanups()
            self.setUp()


class CallsTest(ModuleTestCase):
    def test_every_call_returns_a_result_and_prints_one_line(self):
        host = self.host()
        action = {"op": "show", "id": "build", "type": "progress", "role": "primary", "data": {"label": "Build", "value": 40}}
        cases = [
            (switchboard.speak, ("Hi.",), {}, "speak", {"text": "Hi."}),
            (switchboard.display, (action,), {}, "display", {"action": action}),
            (switchboard.display, (), dict(action), "display", {"action": action}),
            (switchboard.view, (), {}, "view", {}),
            (switchboard.request_to_speak, ("Done", "finished"), {}, "request_to_speak", {"message": "Done", "reason": "finished"}),
            (switchboard.view, ("theater",), {}, "view", {"target": "theater"}),
            (switchboard.request_to_speak, ("Need input", "needs_decision"), {}, "request_to_speak", {"message": "Need input", "reason": "needs_decision"}),
        ]
        for fn, args, kwargs, call, sent in cases:
            with self.subTest(call=call, args=args, kwargs=kwargs):
                result, line = self.run_call(fn, *args, **kwargs)
                self.assertTrue(result.delivered)
                self.assertEqual(result.call, call)
                self.assertTrue(line.startswith(f"switchboard.{call}: "))
                last = host.calls()[-1]
                self.assertEqual((last["call"], last["args"], last["token"]), (call, sent, TOKEN))

    def test_view_describes_the_screen(self):
        screen = {"has_visual": True, "visual_kind": "diff", "title": "Code changes", "confirmed": True}
        self.host(reply=lambda request: {"status": "delivered", "reason": None, "result": {"screen": screen}})
        result, line = self.run_call(switchboard.view)
        self.assertEqual(line, "switchboard.view: Showing a diff titled 'Code changes' on the caller's screen.")
        self.assertEqual(result.data, {"screen": screen})

    def test_view_names_every_kind_as_a_noun(self):
        screen = {"has_visual": True, "confirmed": True}
        self.host(reply=lambda request: {"status": "delivered", "reason": None, "result": {"screen": screen}})
        for kind, words in [
            ("image", "an image"), ("inbox", "an inbox"), ("tasks", "a to-do list"),
            ("weather", "a forecast"), ("calendar", "a calendar"), ("timer", "a timer"),
        ]:
            with self.subTest(kind=kind):
                screen["visual_kind"] = kind
                _, line = self.run_call(switchboard.view)
                self.assertEqual(line, f"switchboard.view: Showing {words} on the caller's screen.")

    def test_display_describes_held_and_shown_results(self):
        mode = {"held": True}
        self.host(
            reply=lambda request: {
                "status": "accepted" if mode["held"] else "delivered",
                "reason": None,
                "result": {"held": mode["held"]} if mode["held"] else {"rendered": True},
            }
        )
        _, held_line = self.run_call(switchboard.display, op="clear")
        self.assertIn("Held until the caller comes back to you", held_line)
        self.assertIn("not that it's on screen", held_line)

        mode["held"] = False
        _, shown_line = self.run_call(switchboard.display, op="clear")
        self.assertEqual(shown_line, "switchboard.display: On screen.")

    def test_request_and_caller_away_lines_point_to_the_next_step(self):
        mode = {"reply": {"status": "accepted", "reason": None}}
        self.host(reply=lambda request: mode["reply"])
        _, queued = self.run_call(switchboard.request_to_speak, "Done.", "finished")
        self.assertEqual(queued, "switchboard.request_to_speak: Queued. The caller hears it at a good moment.")

        mode["reply"] = {"status": "refused", "reason": "caller_away"}
        _, away = self.run_call(switchboard.speak, "Hi.")
        self.assertIn("nothing was played", away)
        self.assertIn("request_to_speak", away)

        # A view target from the background is a screen change, not speech:
        # the line says whose screen it is, not what to do with words (#135).
        _, screen = self.run_call(switchboard.view, "theater")
        self.assertIn("isn't yours to change", screen)
        self.assertNotIn("request_to_speak", screen)

    def test_display_rejection_carries_the_service_reason(self):
        self.host(reply=lambda request: {"status": "refused", "reason": "metric value must be a string"})
        result, line = self.run_call(switchboard.display, op="show", id="m", type="metric", data={"label": "L", "value": 3})
        self.assertEqual(result.reason, "metric value must be a string")
        self.assertIn("rejected it: metric value must be a string", line)

    def test_a_request_too_large_for_the_host_agent_names_the_caps(self):
        # The host agent answers a line past its cap `too_large` unread. The
        # line used to read "The switchboard rejected it: too_large. Adjust
        # the payload and try again.", which named no number to aim under.
        self.host(reply=lambda request: {"status": "refused", "reason": "too_large"})
        result, line = self.run_call(switchboard.display, op="show", id="d", type="document", data={"subject": "log", "paragraphs": ["x"]})
        self.assertEqual((result.status, result.reason), ("refused", "too_large"))
        self.assertEqual(
            line,
            "switchboard.display: Too large; nothing was sent. The host agent reads a request of at most 13 MiB, "
            "and a display action is at most 48,000 bytes as JSON (an image's 12 MiB). Send less.",
        )
        # Any call can be too large; only a display's words name the display caps.
        _, spoken = self.run_call(switchboard.speak, "Hi.")
        self.assertEqual(spoken, "switchboard.speak: Too large; nothing was sent. The host agent reads a request of at most 13 MiB. Send less.")

    def test_array_likes_are_sent_as_lists(self):
        host = self.host()

        class ArrayLike:
            def tolist(self):
                return [1, 2, 3]

        data = {"series": [{"name": "load", "values": ArrayLike()}]}
        self.run_call(switchboard.display, op="show", id="c", type="chart", data=data)
        self.assertEqual(host.calls()[-1]["args"]["action"]["data"]["series"][0]["values"], [1, 2, 3])

    def test_dates_and_datetimes_are_sent_as_the_time_forms(self):
        # docs/display-tool.md, "Time values": a date; a wall time on the
        # datetime's own clock, to the minute; and for a timer's endsAt and
        # startedAt only, an instant with its offset.
        host = self.host()
        pacific = datetime.timezone(datetime.timedelta(hours=-7))
        week = {
            "view": "week",
            "start": datetime.date(2026, 10, 5),
            "now": datetime.datetime(2026, 10, 7, 9, 40, 27),
            "events": [
                {"id": "dentist", "title": "Dentist", "start": datetime.datetime(2026, 10, 7, 10, 30)},
                # A calendar API's aware datetime is drawn on its own clock.
                {"id": "standup", "title": "Standup", "start": datetime.datetime(2026, 10, 7, 9, 30, tzinfo=pacific)},
            ],
        }
        timers = {"timers": [
            {"id": "pasta", "label": "Pasta", "endsAt": datetime.datetime(2026, 10, 5, 18, 42, tzinfo=pacific),
             "startedAt": datetime.datetime(2026, 10, 5, 18, 33, tzinfo=pacific)},
            {"id": "tea", "label": "Tea", "endsAt": datetime.datetime(2026, 10, 6, 1, 15, 0, 250000, tzinfo=datetime.timezone.utc)},
            # No instant has an offset with seconds: it is written in UTC.
            {"id": "odd", "label": "Odd zone", "endsAt": datetime.datetime(
                2026, 10, 6, 1, 15, tzinfo=datetime.timezone(datetime.timedelta(hours=5, seconds=30)))},
        ]}
        forecast = {
            "location": "San Francisco", "units": "F", "current": {"temp": 61, "condition": "fog"},
            "today": datetime.date(2026, 10, 7),
            "daily": [{"date": datetime.date(2026, 10, 8), "high": 61, "low": 55, "condition": "rain"}],
        }
        self.run_call(switchboard.display, op="show", id="week", type="calendar", data=week)
        self.run_call(switchboard.display, op="show", id="kitchen", type="timer", data=timers)
        self.run_call(switchboard.display, op="show", id="weather", type="weather", data=forecast)
        sent = [call["args"]["action"]["data"] for call in host.calls()]
        self.assertEqual((sent[2]["today"], sent[2]["daily"][0]["date"]), ("2026-10-07", "2026-10-08"))
        self.assertEqual(sent[0], {
            "view": "week", "start": "2026-10-05", "now": "2026-10-07T09:40",
            "events": [
                {"id": "dentist", "title": "Dentist", "start": "2026-10-07T10:30"},
                {"id": "standup", "title": "Standup", "start": "2026-10-07T09:30"},
            ],
        })
        self.assertEqual(
            [(timer.get("startedAt"), timer["endsAt"]) for timer in sent[1]["timers"]],
            [
                ("2026-10-05T18:33:00-07:00", "2026-10-05T18:42:00-07:00"),
                (None, "2026-10-06T01:15:00.250000+00:00"),
                (None, "2026-10-05T20:14:30+00:00"),
            ],
        )

    def test_a_naive_datetime_is_no_instant(self):
        host = self.host()
        timers = {"timers": [{"id": "pasta", "label": "Pasta", "endsAt": datetime.datetime(2026, 10, 5, 18, 42)}]}
        with self.assertRaises(ValueError) as caught, contextlib.redirect_stdout(io.StringIO()):
            switchboard.display(op="show", id="kitchen", type="timer", data=timers)
        self.assertIn("endsAt is an instant: give an aware datetime", str(caught.exception))
        self.assertEqual(host.connections, 0)


class ProgrammingErrorTest(ModuleTestCase):
    def test_programming_errors_raise_before_anything_is_sent(self):
        host = self.host()
        cases = [
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "gauge", "data": {}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "table", "data": {"columns": []}}),
            (ValueError, switchboard.display, (), {"op": "explode"}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "metric", "data": {"label": "L"}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "diagram", "data": {"nodes": [], "edges": []}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "diagram", "data": {"mode": "graph", "nodes": []}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "diagram", "data": {"mode": "sequence", "actors": []}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "diagram", "data": {"mode": "timeline", "actors": [], "messages": []}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "diagram", "data": {"mode": ["graph"], "nodes": [], "edges": []}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "progress", "data": {"label": "L"}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "progress", "data": {"steps": [{"label": "S"}]}}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "note", "role": "hero", "data": {"segments": []}}),
            (TypeError, switchboard.display, ("show",), {}),
            (TypeError, switchboard.display, (), {"op": "show", "id": "x", "type": "chart", "data": {"series": [object()]}}),
            (TypeError, switchboard.speak, (42,), {}),
            (ValueError, switchboard.speak, ("  ",), {}),
            (ValueError, switchboard.view, ("everything",), {}),
            (ValueError, switchboard.request_to_speak, ("Done", "unknown"), {}),
            (TypeError, switchboard.request_to_speak, (42, "finished"), {}),
        ]
        for error, fn, args, kwargs in cases:
            with self.subTest(call=fn.__name__, args=args, kwargs=kwargs):
                with self.assertRaises(error), contextlib.redirect_stdout(io.StringIO()):
                    fn(*args, **kwargs)
        self.assertEqual(host.connections, 0)

    def test_values_json_cannot_carry_raise_before_anything_is_sent(self):
        # A NaN used to go out as `NaN` and come back as a bad request; half a
        # surrogate pair went out as an escape the service cannot read.
        host = self.host()
        chart = lambda value: {"op": "show", "id": "c", "type": "chart", "data": {"series": [{"name": "s", "values": [1, value]}]}}  # noqa: E731
        cases = [
            (switchboard.display, chart(float("nan")), "Out of range float values are not JSON compliant"),
            (switchboard.display, chart(float("inf")), "Out of range float values are not JSON compliant"),
            (switchboard.display, {"op": "say", "text": "cut \ud83d"}, "a string holds '\\ud83d', half of a UTF-16 surrogate pair"),
            (switchboard.speak, "\ude00 alone", "a string holds '\\ude00', half of a UTF-16 surrogate pair"),
        ]
        for fn, value, message in cases:
            with self.subTest(call=fn.__name__, value=repr(value)):
                with self.assertRaises(ValueError) as caught, contextlib.redirect_stdout(io.StringIO()):
                    fn(value)
                self.assertTrue(str(caught.exception).startswith("cannot be sent to the switchboard: "), caught.exception)
                self.assertIn(message, str(caught.exception))
        self.assertEqual(host.connections, 0)
        # Whole characters go out as they are, and so does a pair held as two
        # code points, which is one character.
        result, _ = self.run_call(switchboard.speak, "Ship it \U0001F680")
        self.assertTrue(result.delivered)
        self.assertEqual(host.calls()[-1]["args"], {"text": "Ship it \U0001F680"})
        result, _ = self.run_call(switchboard.speak, "Ship it \ud83d\ude80")
        self.assertTrue(result.delivered)
        self.assertEqual(host.calls()[-1]["args"], {"text": "Ship it \U0001F680"})

    def test_an_integer_beyond_two_to_the_53_raises_naming_its_field(self):
        # The service and the page read numbers as doubles: 2**53 + 1 arrived
        # as 2**53, and an integer beyond a double's range as null.
        host = self.host()

        class ArrayLike:
            def tolist(self):
                return [1, 2**60]

        chart = lambda values: {"op": "show", "id": "c", "type": "chart", "data": {"series": [{"name": "s", "values": values}]}}  # noqa: E731
        for values, field in (
            ([1, 2**53 + 1], "action.data.series[0].values[1]"),
            ([-(2**53) - 1], "action.data.series[0].values[0]"),
            ([10**400], "action.data.series[0].values[0]"),
            (ArrayLike(), "action.data.series[0].values[1]"),
            # JSON writes a key as text: the field is `.3`, not `[3]`.
            ([{3: 2**60}], "action.data.series[0].values[0].3"),
        ):
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as caught, contextlib.redirect_stdout(io.StringIO()):
                    switchboard.display(chart(values))
                self.assertEqual(
                    str(caught.exception),
                    f"{field} is an integer beyond 2**53, which the switchboard reads as a double and cannot hold "
                    "exactly; send it as a float or as text",
                )
        self.assertEqual(host.connections, 0)
        # An array-like whose tolist() is itself is followed once and left to
        # the encoder, which finds the loop; a call that is no dict is a
        # TypeError before anything walks it.
        class Itself:
            def tolist(self):
                return self

        with self.assertRaisesRegex(ValueError, "Circular reference"), contextlib.redirect_stdout(io.StringIO()):
            switchboard.display(chart([Itself()]))
        with self.assertRaises(TypeError) as caught, contextlib.redirect_stdout(io.StringIO()):
            switchboard.display([[2**60]])
        self.assertEqual(str(caught.exception), "a display action must be a dict, not list")
        self.assertEqual(host.connections, 0)
        # Every integer a double holds exactly goes out as it is, and a float
        # (already a double) whatever its size.
        values = [2**53, -(2**53), True, 1e300]
        result, _ = self.run_call(switchboard.display, chart(values))
        self.assertTrue(result.delivered)
        self.assertEqual(host.calls()[-1]["args"]["action"]["data"]["series"][0]["values"], values)

    def test_nesting_deeper_than_the_service_reads_raises_before_anything_is_sent(self):
        # The service refused such a call as unreadable, without the action's
        # own error; a call that holds itself made _wire_times recurse.
        host = self.host()

        def depth(value):
            if isinstance(value, dict):
                return 1 + max(map(depth, value.values()), default=0)
            if isinstance(value, list):
                return 1 + max(map(depth, value), default=0)
            return 0

        def note(levels):
            # The request line, its args, the action and its data are 4
            # levels; `segments` and the lists in it are the rest.
            segments = 1
            for _ in range(levels - 4):
                segments = [segments]
            return {"op": "show", "id": "n", "type": "note", "data": {"segments": segments}}

        result, _ = self.run_call(switchboard.display, note(switchboard._MAX_FRAME_DEPTH))
        self.assertTrue(result.delivered)
        self.assertEqual(depth(host.calls()[-1]), switchboard._MAX_FRAME_DEPTH)
        looped = {"op": "show", "id": "n", "type": "note", "data": {"segments": []}}
        looped["data"]["segments"].append(looped)
        calls = len(host.requests)
        for action in (note(switchboard._MAX_FRAME_DEPTH + 1), looped):
            with self.assertRaises(ValueError) as caught, contextlib.redirect_stdout(io.StringIO()):
                switchboard.display(action)
            self.assertTrue(str(caught.exception).startswith(
                "action.data.segments[0]... nests arrays and objects deeper than the switchboard reads (127 levels"
            ), caught.exception)
        self.assertEqual(len(host.requests), calls)

    def test_unknown_display_type_names_the_shapes(self):
        with self.assertRaises(ValueError) as caught:
            switchboard.display(op="show", id="x", type="gauge", data={})
        self.assertTrue(str(caught.exception).startswith(
            "invalid show.type: expected one of chart, metric, progress, diagram, document, code, table, note, image, "
            "calendar, tasks, timer, weather, inbox; each type takes only its own shape: "
        ))
        self.assertIn("chart: {series:[{name, values:[n]}]}", str(caught.exception))
        self.assertIn("table: {columns:[{label}], rows:[[cell]]}", str(caught.exception))
        self.assertIn('calendar: {view:"day"|"week"|"month"|"agenda", start:"YYYY-MM-DD"', str(caught.exception))
        self.assertIn('timer: {timers:[{id, label, endsAt:"YYYY-MM-DDTHH:MM:SS-07:00"}]}', str(caught.exception))

    def test_a_refused_name_lists_the_names_it_takes(self):
        # One wording for every refusal of a name, the service's and the page's.
        for call, args, kwargs, error in (
            (switchboard.request_to_speak, ("Done", "later"), {}, "invalid reason: expected one of finished, needs_decision, problem"),
            (switchboard.view, ("screen",), {}, "invalid target: expected one of visual, comms, system, theater, auto"),
            (switchboard.display, (), {"op": "listen"}, "invalid op: expected one of show, hide, focus, say, clear"),
            (switchboard.display, (), {"op": "show", "id": "x", "type": "metric", "role": "main", "data": {}},
             "invalid show.role: expected one of primary, compare, secondary, ambient"),
        ):
            with self.subTest(error):
                with self.assertRaises(ValueError) as caught:
                    call(*args, **kwargs)
                self.assertEqual(str(caught.exception), error)

    def test_a_diagram_outline_is_judged_by_its_mode(self):
        host = self.host()
        graph = {"mode": "graph", "nodes": [{"id": "a", "label": "A"}], "edges": []}
        sequence = {"mode": "sequence", "actors": [{"id": "a", "label": "A"}], "messages": []}
        for data in (graph, sequence):
            result, _ = self.run_call(switchboard.display, op="show", id="d", type="diagram", data=data)
            self.assertTrue(result.delivered)
        self.assertEqual([call["args"]["action"]["data"] for call in host.calls()], [graph, sequence])
        # Each mode's arrays are required only under that mode; the hint names both shapes.
        with self.assertRaises(ValueError) as caught:
            switchboard.display(op="show", id="d", type="diagram", data={"mode": "sequence", "actors": []})
        self.assertIn("missing messages", str(caught.exception))
        self.assertIn('mode:"sequence", actors:', str(caught.exception))
        for data in ({"mode": "timeline"}, {"nodes": [], "edges": []}):
            with self.assertRaises(ValueError) as caught:
                switchboard.display(op="show", id="d", type="diagram", data=data)
            self.assertTrue(str(caught.exception).startswith("invalid diagram.mode: expected one of graph, sequence; its shape is"))

    def test_a_progress_needs_value_or_steps_and_takes_either(self):
        with self.assertRaises(ValueError) as caught:
            switchboard.display(op="show", id="x", type="progress", data={"label": "L", "text": "working"})
        self.assertIn("progress data needs value or steps", str(caught.exception))
        host = self.host()
        for data in (
            {"label": "L", "value": 40},
            {"label": "L", "steps": [{"label": "Fetch", "state": "done"}, {"label": "Link"}]},
            {"label": "L", "value": 50, "steps": [{"label": "Fetch"}]},
        ):
            with self.subTest(data=data):
                result, _line = self.run_call(switchboard.display, op="show", id="x", type="progress", data=data)
                self.assertTrue(result.ok)
        self.assertEqual([call["args"]["action"]["data"] for call in host.calls()][-3:], [
            {"label": "L", "value": 40},
            {"label": "L", "steps": [{"label": "Fetch", "state": "done"}, {"label": "Link"}]},
            {"label": "L", "value": 50, "steps": [{"label": "Fetch"}]},
        ])


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN48ew+AAVnAq5EDgAUAAAAAElFTkSuQmCC"
)


class ImageTest(ModuleTestCase):
    """An image goes on the wire as format and base64 bytes, made here from a
    path or raw bytes; the path itself never leaves the host."""

    def sent_data(self, host):
        return host.calls()[-1]["args"]["action"]["data"]

    def test_a_path_is_read_sniffed_and_sent_as_base64(self):
        host = self.host()
        path = os.path.join(self.home, "fig.png")
        with open(path, "wb") as fh:
            fh.write(PNG_1X1)
        data = {"path": path, "alt": "One pixel", "title": "FIGURE"}
        result, _ = self.run_call(switchboard.display, op="show", id="fig", type="image", data=data)
        self.assertTrue(result.delivered)
        self.assertEqual(
            self.sent_data(host),
            {"format": "png", "bytes": base64.b64encode(PNG_1X1).decode(), "alt": "One pixel", "title": "FIGURE"},
        )
        self.assertEqual(data, {"path": path, "alt": "One pixel", "title": "FIGURE"}, "the caller's dict is left alone")

    def test_raw_bytes_are_sniffed_for_each_raster_format(self):
        host = self.host()
        for fmt, raw in (
            ("png", PNG_1X1),
            ("jpeg", b"\xff\xd8\xff\xe0" + bytes(32)),
            ("webp", b"RIFF\x00\x00\x00\x00WEBPVP8 " + bytes(32)),
        ):
            for wrapped in (raw, bytearray(raw), memoryview(raw)):
                with self.subTest(format=fmt, kind=type(wrapped).__name__):
                    self.run_call(switchboard.display, {"op": "show", "id": "fig", "type": "image", "data": {"bytes": wrapped, "alt": "a"}})
                    self.assertEqual(self.sent_data(host), {"format": fmt, "bytes": base64.b64encode(raw).decode(), "alt": "a"})

    def test_wire_shaped_data_is_sent_as_it_is(self):
        host = self.host()
        data = {"format": "png", "bytes": base64.b64encode(PNG_1X1).decode(), "alt": "a"}
        self.run_call(switchboard.display, op="show", id="fig", type="image", data=data)
        self.assertEqual(self.sent_data(host), data)
        self.run_call(switchboard.display, op="show", id="fig", type="image", data={**data, "path": None})
        self.assertEqual(self.sent_data(host), data, "a path of None is not sent")

    def test_what_cannot_be_shown_raises_before_anything_is_sent(self):
        host = self.host()
        too_big = os.path.join(self.home, "big.png")
        with open(too_big, "wb") as fh:
            fh.write(PNG_1X1[:8] + bytes(8 * 1024 * 1024))
        cases = [
            ({"bytes": b"<svg xmlns='http://www.w3.org/2000/svg'/>", "alt": "a"}, "not a PNG, JPEG or WebP"),
            ({"bytes": b"GIF89a" + bytes(16), "alt": "a"}, "not a PNG, JPEG or WebP"),
            ({"path": os.path.join(self.home, "missing.png"), "alt": "a"}, "cannot read image path"),
            ({"path": too_big, "alt": "a"}, "over 8388608 bytes"),
            ({"path": too_big, "bytes": PNG_1X1, "alt": "a"}, "a path or bytes, not both"),
            ({"bytes": PNG_1X1, "format": "jpeg", "alt": "a"}, "are a png, not a jpeg"),
            ({"bytes": PNG_1X1}, "image data is missing alt"),
        ]
        for data, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(ValueError) as caught, contextlib.redirect_stdout(io.StringIO()):
                    switchboard.display(op="show", id="fig", type="image", data=data)
                self.assertIn(message, str(caught.exception))
        with self.assertRaises(TypeError):
            switchboard.display(op="show", id="fig", type="image", data={"path": 7, "alt": "a"})
        self.assertEqual(host.connections, 0)


if __name__ == "__main__":
    unittest.main()


class DisplaySchemaTests(unittest.TestCase):
    """The skill's display shapes are held to docs/display-action-v1.schema.json,
    the one source for the display protocol, so the three implementations
    (this module, the Rust validator, the browser) cannot drift apart on what
    a show type requires or which ops and roles exist."""

    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[3]
        with open(root / "docs" / "display-action-v1.schema.json", encoding="utf-8") as fh:
            cls.schema = json.load(fh)
        cls.definitions = cls.schema["definitions"]

    def _resolve(self, node):
        return self.definitions[node["$ref"].rsplit("/", 1)[1]] if "$ref" in node else node

    def _show_actions(self):
        """{type: {required data keys, one set per shape}} for every Show*Action the
        schema lists; a diagram has one shape per mode."""
        shapes = {}
        for ref in self.schema["oneOf"]:
            action = self._resolve(ref)
            props = action["properties"]
            if "type" not in props:
                continue
            (kind,) = props["type"].get("enum") or [props["type"]["const"]]
            data = self._resolve(props["data"])
            branches = [self._resolve(branch) for branch in data["oneOf"]] if "oneOf" in data else [data]
            shapes[kind] = {frozenset(branch["required"]) for branch in branches}
        return shapes

    def _one_of_keys(self):
        """{type: keys of which one is needed} for every Show*Action whose data
        carries an `anyOf` of single `required` branches (progress: value or steps)."""
        one_of = {}
        for ref in self.schema["oneOf"]:
            name = ref["$ref"].rsplit("/", 1)[1]
            props = self.definitions[name]["properties"]
            if "type" not in props:
                continue
            (kind,) = props["type"].get("enum") or [props["type"]["const"]]
            data = props["data"]
            if "$ref" in data:
                data = self.definitions[data["$ref"].rsplit("/", 1)[1]]
            branches = data.get("anyOf")
            if branches:
                keys = []
                for branch in branches:
                    (key,) = branch["required"]
                    keys.append(key)
                one_of[kind] = tuple(keys)
        return one_of

    def test_show_types_and_required_data_keys_match_the_schema(self):
        module = {}
        for kind, (required, _hint) in switchboard._SHAPES.items():
            if kind == "diagram":
                module[kind] = {frozenset(required + keys) for keys in switchboard._DIAGRAM_MODES.values()}
            else:
                module[kind] = {frozenset(required)}
        self.assertEqual(module, self._show_actions())

    def test_diagram_modes_match_the_schema(self):
        data = self._resolve(self._resolve(self.definitions["ShowDiagramAction"]["properties"]["data"]))
        modes = {}
        for branch in data["oneOf"]:
            shape = self._resolve(branch)
            (mode,) = shape["properties"]["mode"]["enum"]
            modes[mode] = tuple(key for key in shape["required"] if key != "mode")
        self.assertEqual(switchboard._DIAGRAM_MODES, modes)

    def test_one_of_keys_match_the_schema(self):
        self.assertEqual(switchboard._ONE_OF, self._one_of_keys())

    def test_ops_and_roles_match_the_schema(self):
        ops = set()
        for ref in self.schema["oneOf"]:
            action = self.definitions[ref["$ref"].rsplit("/", 1)[1]]
            op = action["properties"]["op"]
            ops.update(op.get("enum") or [op["const"]])
        self.assertEqual(set(switchboard._DISPLAY_OPS), ops)
        self.assertEqual(list(switchboard._ROLES), self.definitions["Role"]["enum"])


class DisplayCorpusTests(unittest.TestCase):
    """The module's outline check agrees with the two validators where it
    overlaps them. apps/frontend/tests/fixtures/validator-corpus.json holds
    display actions and what the service and the page make of each: the module
    never raises for an action they accept, and it raises, before sending, for
    each refused one whose fault its outline names (OUTLINE_REFUSES)."""

    # No object, an unknown op, a missing or blank id, an unknown type or role,
    # data that is not a dict, an empty say text, a required data key missing,
    # an unknown diagram mode; and, in the validators' own words
    # (VALUE_RULES), two chart series with one name, a yMin not below yMax,
    # and a timer's remaining (required when paused, refused when running, 0
    # to the cap). Every other refusal is the service's to give.
    VALUE_RULES = (
        "chart_series_name_duplicate", "chart_series_name_duplicate_empty",
        "chart_series_order_name_duplicate_before_values", "chart_y_ends_equal", "chart_y_ends_inverted",
        "chart_order_y_ends_before_marker", "timer_paused_without_remaining", "timer_running_with_remaining",
        "timer_unsaid_state_with_remaining", "timer_entry_order_running_before_remaining_type",
        "timer_remaining_negative", "timer_remaining_string", "timer_remaining_null",
        "timer_remaining_one_second_past_its_cap", "timer_remaining_a_fraction_past_its_cap", "timer_remaining_huge",
    )
    OUTLINE_REFUSES = (
        "action_is_a_string", "action_is_an_array", "action_is_null", "action_is_a_number",
        "action_is_a_huge_string", "op_missing", "op_not_a_string", "op_listen_is_internal", "op_delete",
        "op_case_matters", "op_checked_before_layout_keys", "op_checked_before_unsafe_strings",
        "size_checked_before_op", "show_id_missing", "show_id_empty", "show_id_number", "show_id_null",
        "show_id_blank_U+0009", "show_id_blank_U+000A", "show_id_blank_U+000B", "show_id_blank_U+000C",
        "show_id_blank_U+000D", "show_id_blank_U+0020", "show_id_blank_U+0085", "show_id_blank_U+00A0",
        "show_id_blank_U+1680", "show_id_blank_U+2000", "show_id_blank_U+2005", "show_id_blank_U+200A",
        "show_id_blank_U+2028", "show_id_blank_U+2029", "show_id_blank_U+202F", "show_id_blank_U+205F",
        "show_id_blank_U+3000", "show_type_missing", "show_type_card", "show_type_message_is_internal",
        "show_type_number", "show_type_case_matters", "show_id_checked_before_type", "show_role_unknown",
        "show_role_null", "show_role_number", "show_type_checked_before_role", "show_data_missing",
        "show_data_array", "show_data_null", "show_data_string", "show_role_checked_before_data",
        "hide_id_missing", "hide_id_number", "hide_id_blank", "focus_id_missing", "focus_id_number",
        "focus_id_blank", "say_text_empty", "say_text_missing", "say_text_number",
        "say_text_checked_before_target", "chart_series_missing", "metric_label_missing", "metric_value_missing",
        "metric_order_label_before_value", "progress_label_missing", "progress_neither_value_nor_steps",
        "diagram_mode_missing", "diagram_mode_timeline", "diagram_mode_number",
        "diagram_source_checked_before_mode", "graph_nodes_missing", "graph_edges_missing",
        "sequence_actors_missing", "sequence_messages_missing", "sequence_mode_missing", "document_subject_missing",
        "document_paragraphs_missing", "code_source_missing", "code_order_source_before_title",
        "table_columns_missing", "table_rows_missing", "image_format_svg_before_bytes",
        "image_format_missing", "image_bytes_missing", "image_alt_missing", "note_segments_missing",
        "data___proto___is_a_key", "null_diagram_mode",
        "calendar_view_missing", "calendar_start_missing", "calendar_events_missing", "tasks_items_missing",
        "timer_timers_missing", "weather_location_missing", "weather_units_missing", "weather_current_missing",
        "inbox_messages_missing",
        *VALUE_RULES,
    )

    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[3]
        with open(root / "apps" / "frontend" / "tests" / "fixtures" / "validator-corpus.json", encoding="utf-8") as fh:
            cls.cases = json.load(fh)["cases"]

    @classmethod
    def _expand(cls, value):
        """`{"$repeat": s, "times": n}` in the corpus stands for s repeated n times."""
        if isinstance(value, dict):
            if set(value) == {"$repeat", "times"}:
                return value["$repeat"] * value["times"]
            return {key: cls._expand(item) for key, item in value.items()}
        if isinstance(value, list):
            return [cls._expand(item) for item in value]
        return value

    def test_never_refuses_an_action_the_validators_accept(self):
        accepted = [case for case in self.cases if case.get("accepted")]
        self.assertTrue(accepted)
        for case in accepted:
            with self.subTest(case["name"]):
                action = self._expand(case["action"])
                self.assertEqual(switchboard._display_wire_action(action), action)
                switchboard._check_call_args({"action": action})

    def test_refuses_the_faults_its_outline_names(self):
        by_name = {case["name"]: case for case in self.cases}
        for name in self.OUTLINE_REFUSES:
            with self.subTest(name):
                self.assertIn("error", by_name[name], "the validators refuse it too")
                with self.assertRaises((TypeError, ValueError)):
                    switchboard._display_wire_action(self._expand(by_name[name]["action"]))

    def test_refuses_a_name_in_the_validators_words(self):
        """Where the outline refuses an op, a type, a role or a diagram mode,
        its error starts with the validators' own: the field and every name it
        takes. The type's and the mode's add the shapes."""
        by_name = {case["name"]: case for case in self.cases}
        named = ("invalid op:", "invalid show.type:", "invalid show.role:", "invalid diagram.mode:")
        checked = 0
        for name in self.OUTLINE_REFUSES:
            error = by_name[name]["error"]
            if not error.startswith(named):
                continue
            checked += 1
            with self.subTest(name):
                with self.assertRaises(ValueError) as caught:
                    switchboard._display_wire_action(self._expand(by_name[name]["action"]))
                self.assertTrue(str(caught.exception).startswith(error), str(caught.exception))
        self.assertGreater(checked, 20)

    def test_refuses_a_value_rule_in_the_validators_words(self):
        """Where the outline checks a rule across a chart's or a timer's fields,
        its error is the validators' own, word for word."""
        by_name = {case["name"]: case for case in self.cases}
        for name in self.VALUE_RULES:
            with self.subTest(name):
                with self.assertRaises(ValueError) as caught:
                    switchboard._display_wire_action(self._expand(by_name[name]["action"]))
                self.assertEqual(str(caught.exception), by_name[name]["error"])

    def test_a_value_rule_reads_numbers_as_json_sends_them(self):
        # A numpy scalar is sent as its number; a bool is not a number.
        class Scalar:
            def __init__(self, value):
                self.value = value

            def tolist(self):
                return self.value

        chart = {"op": "show", "id": "c", "type": "chart", "data": {"series": [{"name": "a", "values": [1]}]}}
        switchboard._display_wire_action({**chart, "data": {**chart["data"], "yMin": Scalar(0), "yMax": Scalar(10)}})
        with self.assertRaises(ValueError):
            switchboard._display_wire_action({**chart, "data": {**chart["data"], "yMin": Scalar(10), "yMax": 10.0}})
        timer = {"id": "t", "label": "Tea", "endsAt": "2026-10-05T18:42:00-07:00", "state": "paused"}
        show = lambda remaining: {"op": "show", "id": "k", "type": "timer", "data": {"timers": [{**timer, "remaining": remaining}]}}
        switchboard._display_wire_action(show(Scalar(90)))
        with self.assertRaises(ValueError):
            switchboard._display_wire_action(show(True))

    def test_a_blank_id_is_unicode_white_space(self):
        # str.strip also strips U+001C to U+001F, which are not White_Space.
        self.assertEqual(switchboard._WHITE_SPACE, {chr(c) for c in range(sys.maxunicode + 1) if chr(c).isspace()} - set("\x1c\x1d\x1e\x1f"))
