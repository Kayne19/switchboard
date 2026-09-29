"""The switchboard skill module against a fake host-agent skill socket (docs/host-link.md)."""

import contextlib
import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
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
        self.assertIn("actual result", doc)
        self.assertIn("not a teaser", doc)
        self.assertIn("question and options", doc)
        self.assertIn("what went wrong", doc)


class BackgroundSurfaceTest(unittest.TestCase):
    def test_background_step_keeps_the_four_call_surface(self):
        self.assertEqual(set(switchboard.__all__), {"speak", "request_to_speak", "display", "view"})
        self.assertNotIn("transfer_to_project", dir(switchboard))
        self.assertNotIn("return_to_operator", dir(switchboard))


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
        self.assertIn("subagent", line)
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

    def test_display_rejection_carries_the_service_reason(self):
        self.host(reply=lambda request: {"status": "refused", "reason": "metric value must be a string"})
        result, line = self.run_call(switchboard.display, op="show", id="m", type="metric", data={"label": "L", "value": 3})
        self.assertEqual(result.reason, "metric value must be a string")
        self.assertIn("rejected it: metric value must be a string", line)

    def test_array_likes_are_sent_as_lists(self):
        host = self.host()

        class ArrayLike:
            def tolist(self):
                return [1, 2, 3]

        data = {"series": [{"name": "load", "values": ArrayLike()}]}
        self.run_call(switchboard.display, op="show", id="c", type="chart", data=data)
        self.assertEqual(host.calls()[-1]["args"]["action"]["data"]["series"][0]["values"], [1, 2, 3])


class ProgrammingErrorTest(ModuleTestCase):
    def test_programming_errors_raise_before_anything_is_sent(self):
        host = self.host()
        cases = [
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "table", "data": {}}),
            (ValueError, switchboard.display, (), {"op": "explode"}),
            (ValueError, switchboard.display, (), {"op": "show", "id": "x", "type": "metric", "data": {"label": "L"}}),
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

    def test_unknown_display_type_names_the_shapes(self):
        with self.assertRaises(ValueError) as caught:
            switchboard.display(op="show", id="x", type="table", data={})
        self.assertIn("chart: {series:[{name, values:[n]}]}", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
