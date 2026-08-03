"""The homelab switchboard.

    mic (browser) --webm/opus--> /ws --whisper--> transcript
        --> the switchboard routes it to whoever the caller is connected to
            (the operator, or a project agent on the host that holds the code)
        --> reply text --ElevenLabs--> mp3 --> /ws --> browser playback

This replaces the voice-bridge proof of concept and the `jarvis` one-shot
dispatcher. The operator does not do work; it puts you through to something that
does, and that something can hand you back.

`POST /speak` is carried over unchanged from voice-bridge so external processes
(the `speak` MCP tool) can still push a line to the connected page.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .audio import Speaker, Transcriber, TTSError
from .history import AGENT, CALLER, TranscriptLog
from .pbx import Switchboard
from .registry import Registry

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log = logging.getLogger("switchboard")

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(os.getenv("SWITCHBOARD_ENV_FILE", "/etc/switchboard/switchboard.env"))


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        log.warning("%s is not a number; using %s", name, default)
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        log.warning("%s is not a number; using %s", name, default)
        return default


STATE_DIR = Path(_env("SWITCHBOARD_STATE_DIR", "/var/lib/switchboard"))
CONFIG_DIR = Path(_env("SWITCHBOARD_CONFIG_DIR", "/etc/switchboard"))
PROJECTS_FILE = _env("SWITCHBOARD_PROJECTS_FILE", str(CONFIG_DIR / "projects.json"))
OPERATOR_PROMPT = _env(
    "SWITCHBOARD_OPERATOR_PROMPT", str(CONFIG_DIR / "operator.system.md")
)
OPERATOR_EXTENSION = _env("SWITCHBOARD_OPERATOR_EXTENSION") or None
AGENT_EXTENSION = _env("SWITCHBOARD_AGENT_EXTENSION") or None
PI_BINARY = _env("SWITCHBOARD_PI_BINARY", "pi")
OPERATOR_MODEL = _env("SWITCHBOARD_OPERATOR_MODEL") or None
AGENT_MODEL = _env("SWITCHBOARD_AGENT_MODEL") or None
# The thinking level every project leg starts at unless the caller names one.
# Always set to something: the runtime never reports its own default, so an
# unpinned leg is a leg nobody can describe.
AGENT_THINKING = _env("SWITCHBOARD_AGENT_THINKING", "medium")
REMOTE_CACHE_DIR = _env("SWITCHBOARD_REMOTE_CACHE_DIR", ".cache/switchboard")
# Whether a project agent may be re-dialled on a different model mid-call. The
# operator is never covered by this either way.
MODEL_SWAPS = _env("SWITCHBOARD_MODEL_SWAPS", "1") not in ("0", "false", "no")
# Where a project agent reaches this service to be heard. Must be an address the
# project host can resolve — agents run on other boxes, so localhost is wrong.
SELF_URL = _env("SWITCHBOARD_SELF_URL").rstrip("/")
# How long a project leg may sit with nobody talking before the caller is put
# back on the operator. A call nobody ended otherwise keeps an agent process and
# an ssh connection alive on someone else's box indefinitely. 0 disables it.
IDLE_TIMEOUT = _env_float("SWITCHBOARD_IDLE_TIMEOUT", 3600.0)
IDLE_POLL = _env_float("SWITCHBOARD_IDLE_POLL", 30.0)

transcriber = Transcriber(
    _env("WHISPER_MODEL", "base.en"),
    STATE_DIR / "whisper_models",
    cpu_threads=_env_int("WHISPER_CPU_THREADS", 2),
    hotwords=_env("WHISPER_HOTWORDS"),
)

speaker = Speaker(
    _env("ELEVENLABS_API_KEY"),
    _env("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
    _env("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
    stability=_env_float("ELEVENLABS_STABILITY", 0.5),
    similarity_boost=_env_float("ELEVENLABS_SIMILARITY_BOOST", 0.75),
    style=_env_float("ELEVENLABS_STYLE", 0.0),
    speed=_env_float("ELEVENLABS_SPEED", 1.0),
    max_chars=_env_int("SWITCHBOARD_MAX_SPOKEN_CHARS", 700),
)

switchboard = Switchboard(
    Registry.load(PROJECTS_FILE),
    pi_binary=PI_BINARY,
    operator_model=OPERATOR_MODEL,
    operator_system_prompt=OPERATOR_PROMPT,
    operator_extension=OPERATOR_EXTENSION,
    agent_extension_file=AGENT_EXTENSION,
    agent_model=AGENT_MODEL,
    remote_cache_dir=REMOTE_CACHE_DIR,
    agent_thinking=AGENT_THINKING,
    model_swaps=MODEL_SWAPS,
    speak_url=f"{SELF_URL}/speak" if SELF_URL else "",
    state_url=f"{SELF_URL}/leg-state" if SELF_URL else "",
    diagram_url=f"{SELF_URL}/diagram" if SELF_URL else "",
    env=dict(os.environ),
)


async def _watch_for_silence() -> None:
    """Hang up a project leg the caller has gone quiet on, and say so on the page.

    Nothing is synthesized: by definition nobody has said anything for an hour,
    so this is a note to read when they come back, not a line to play into an
    empty room.
    """
    while True:
        await asyncio.sleep(IDLE_POLL)
        try:
            left = await switchboard.return_if_idle(IDLE_TIMEOUT)
        except Exception:  # noqa: BLE001
            log.exception("the idle check failed")
            continue
        if left is None:
            continue
        minutes = int(IDLE_TIMEOUT // 60)
        note = (
            f"Nothing was said for {minutes} minutes, so the line to {left} was "
            "dropped. You're back with the operator."
        )
        log.info("idle timeout: dropped the leg to %s", left)
        entry = transcript_log.add(AGENT, note, route=switchboard.route)
        if entry:
            await _broadcast_json({"type": "spoken", "entry": entry})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    watchdog = asyncio.create_task(_watch_for_silence()) if IDLE_TIMEOUT > 0 else None
    yield
    if watchdog is not None:
        watchdog.cancel()
        # Awaited, not just signalled: the watchdog can be mid-`_hangup` on a
        # session that `shutdown` is about to close underneath it.
        with contextlib.suppress(asyncio.CancelledError):
            await watchdog
    await switchboard.shutdown()


app = FastAPI(title="switchboard", lifespan=lifespan)

# Single-user tool: realistically 0 or 1 browser tabs at a time. Each socket
# carries its own send lock, because a single tab is now written to by three
# different tasks — the turn loop, the receive loop acknowledging a queued clip,
# and `/speak` or `/diagram` arriving mid-turn over HTTP. Two coroutines inside
# `send`/`send_bytes` on one connection interleave frames or raise, which showed
# up as corrupted audio during exactly the mid-turn narration the speak tool
# exists for.
connected_clients: dict[WebSocket, asyncio.Lock] = {}

transcript_log = TranscriptLog(_env_int("SWITCHBOARD_HISTORY_LIMIT", 200))

# The diagram currently on the caller's screen, replayed to a tab that connects
# or reloads mid-call. Without it a refresh loses the picture and the caller has
# no way to ask for it back. Newest replaces: there is no diagram history.
last_diagram: dict | None = None


class SpeakRequest(BaseModel):
    text: str


class DiagramRequest(BaseModel):
    source: str
    title: str = ""
    notes: str = ""


class ConnectRequest(BaseModel):
    project: str
    intent: str = ""


class ThinkingRequest(BaseModel):
    level: str


class LegStateRequest(BaseModel):
    thinking: str = ""


async def _send_json(client: WebSocket, message: dict) -> None:
    """One JSON frame to one tab, never overlapping another write to it."""
    lock = connected_clients.get(client)
    if lock is None:
        await client.send_json(message)
        return
    async with lock:
        await client.send_json(message)


async def _send_bytes(client: WebSocket, data: bytes) -> None:
    """One binary frame to one tab, never overlapping another write to it."""
    lock = connected_clients.get(client)
    if lock is None:
        await client.send_bytes(data)
        return
    async with lock:
        await client.send_bytes(data)


async def _broadcast_json(message: dict) -> int:
    """Send one JSON message to every live tab, dropping the dead ones."""
    delivered = 0
    dead = []
    for client in list(connected_clients):
        try:
            await _send_json(client, message)
            delivered += 1
        except Exception:  # noqa: BLE001
            log.exception("failed to deliver a message to a client")
            dead.append(client)
    for client in dead:
        connected_clients.pop(client, None)
    return delivered


async def _announce_route() -> None:
    """Relabel every open page the instant the line swings.

    Not deferred to the end of the turn: bringing a project leg up means ssh,
    an agent start and an intro prompt, and until this lands the page still
    names whoever the caller was talking to before.
    """
    global last_diagram
    # A diagram belongs to the leg that drew it. Kept across a route change it
    # was replayed to every reconnecting tab long after that agent was gone,
    # captioned as if it were current.
    # ponytail: only stops the *replay*. A tab that is already open keeps the
    # picture on screen until something replaces it — wiping it mid-call is more
    # jarring than a stale one. Send a clear frame here if that changes.
    last_diagram = None
    await _broadcast_json(switchboard.status())


async def _announce_activity(item: dict) -> None:
    """Put what a leg is doing right now on the page, mid-turn.

    The whole reason this exists: a turn that takes four minutes of real work
    and a turn whose agent has died look identical from the browser, so callers
    hang up on healthy legs and wait forever on dead ones.
    """
    await _broadcast_json({"type": "activity", **item})


async def _broadcast_audio(audio: bytes) -> int:
    """Send one mp3 frame to every live tab, dropping the dead ones."""
    delivered = 0
    dead = []
    for client in list(connected_clients):
        try:
            await _send_bytes(client, audio)
            delivered += 1
        except Exception:  # noqa: BLE001
            log.exception("failed to deliver audio to a client")
            dead.append(client)
    for client in dead:
        connected_clients.pop(client, None)
    return delivered


# Assigned after construction: the callbacks need the client set, which is
# defined alongside the app rather than the switchboard.
switchboard.on_route_change = _announce_route
switchboard.on_activity = _announce_activity


@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "whisper_model": transcriber.model_size,
        "elevenlabs_configured": speaker.configured,
        "route": switchboard.route,
        "model": switchboard.status()["model"],
        "thinking": switchboard.status()["thinking"],
        "model_swaps": MODEL_SWAPS,
        "projects": [p["id"] for p in switchboard.registry.catalog()],
    }


@app.get("/status")
async def status():
    return switchboard.status()


@app.post("/hangup")
async def hangup():
    """Drop the current project leg and put the caller back on the operator.

    The escape hatch. Every other way back to the operator runs through an agent
    deciding to let go, which is no use when the leg is the problem — a bad
    model swap, a turn that will not settle, an agent that has stopped making
    sense. This goes around all of it: no agent is asked, and the turn lock is
    not taken, so it works while a turn is still in flight.

    The operator itself is never torn down here. It is the known-good leg, and
    the caller has to land somewhere.
    """
    left = await switchboard.force_hangup()
    if left is None:
        return {"hungup": False, "reason": "already on the operator"}

    note = f"You hung up the line to {left}. You're back with the operator."
    entry = transcript_log.add(AGENT, note, route=switchboard.route)
    if entry:
        await _broadcast_json({"type": "spoken", "entry": entry})
    await _broadcast_json(switchboard.status())
    return {"hungup": True, "left": left}


async def _deliver(reply) -> None:
    """Put a reply nobody spoke into on the page, and say the parts still owed.

    The websocket loop can answer the socket the utterance arrived on. These
    come from a button instead, so there is no such socket: everything goes out
    to every tab, and the switchboard synthesizes whatever the agent did not
    already say itself.
    """
    entry = transcript_log.add(AGENT, reply.text, route=reply.route)
    if entry:
        await _broadcast_json({"type": "spoken", "entry": entry})
    await _broadcast_json(switchboard.status())
    for utterance in reply.to_speak:
        spoken = speaker.clip_for_speech(utterance)
        if not spoken:
            continue
        try:
            await _broadcast_audio(await speaker.synthesize(spoken))
        except TTSError:
            log.exception("TTS failed for a page-initiated reply")
            break


@app.post("/connect")
async def connect(req: ConnectRequest):
    """Put the caller on a project they picked from the page.

    The operator is a router, not a gate: when the caller already knows where
    they want to be, saying it out loud and waiting to be understood is pure
    overhead. `project: "operator"` is the way back.
    """
    reply = await switchboard.dial(req.project, intent=req.intent)
    await _deliver(reply)
    return {"route": switchboard.route, "error": reply.error}


@app.post("/thinking")
async def thinking(req: ThinkingRequest):
    """Set the thinking level, now and for the legs after this one.

    On a live project leg this restarts it against the same session file, so
    the conversation survives but the turn in flight does not.
    """
    reply = await switchboard.set_thinking(req.level)
    await _deliver(reply)
    return {"thinking": switchboard.status()["thinking"], "error": reply.error}


@app.post("/leg-state")
async def leg_state(req: LegStateRequest):
    """Accept a project leg's report of what it is actually running at.

    Posted by the agent extension on the project host, because that is the only
    place the answer exists: the level asked for on the command line is clamped
    to what the model exposes, silently, inside the session.
    """
    if switchboard.report_leg_state(req.thinking):
        await _broadcast_json(switchboard.status())
        return {"accepted": True}
    return {"accepted": False}


@app.post("/speak")
async def speak(req: SpeakRequest):
    """Push a line of text to whatever browser tab is connected.

    Unchanged from voice-bridge: this is how an outside process (the `speak` MCP
    tool) talks through the page without going near the switchboard's routing.
    """
    try:
        audio = await speaker.synthesize(req.text)
    except TTSError as exc:
        log.exception("TTS failed for /speak")
        raise HTTPException(
            status_code=502, detail=f"TTS synthesis failed: {exc}"
        ) from exc

    # Logged even with nobody listening: a caller who steps away and comes back
    # to a fresh tab should still be able to read what was said while they were
    # gone. The text goes out before the audio so the page can show the line as
    # it starts playing.
    entry = transcript_log.add(AGENT, req.text, route=switchboard.route)
    if entry:
        await _broadcast_json({"type": "spoken", "entry": entry})

    if not connected_clients:
        return {"delivered": False, "reason": "no browser connected"}
    if await _broadcast_audio(audio) == 0:
        return {"delivered": False, "reason": "no browser connected"}
    return {"delivered": True}


@app.post("/diagram")
async def diagram(req: DiagramRequest):
    """Put a diagram on the caller's screen while the agent is still working.

    Same shape as /speak and for the same reason: this has to land mid-turn, so
    it goes over HTTP to the socket the browser is already holding rather than
    waiting for the RPC stream to settle. The source is not validated here — the
    page parses it before swapping anything in, which fails somewhere the caller
    can actually see and leaves a good diagram up if a bad one arrives.
    """
    global last_diagram
    message = {
        "type": "diagram",
        "source": req.source,
        "title": req.title,
        "notes": req.notes,
    }
    last_diagram = message
    if await _broadcast_json(message) == 0:
        return {"delivered": False, "reason": "no browser connected"}
    return {"delivered": True}


@app.websocket("/ws")
async def voice_ws(websocket: WebSocket):
    await websocket.accept()
    connected_clients[websocket] = asyncio.Lock()
    log.info("browser connected")

    # Utterances the caller got in while an earlier turn was still running.
    #
    # This used to be one serial loop: receive, transcribe, run the whole turn,
    # only then receive again. A second clip sent during a turn sat unread in
    # the ASGI receive buffer with nothing acknowledging it, which from the page
    # was indistinguishable from the message having been swallowed. Reading the
    # socket continuously means every clip is transcribed and echoed the moment
    # it lands; turns still run strictly one at a time, because a phone call is
    # turn-taking and the switchboard's own lock enforces it anyway.
    pending: asyncio.Queue[str] = asyncio.Queue()

    async def receive_clips() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))
            audio_bytes = message.get("bytes")
            if audio_bytes is None:
                # A text frame. `receive_bytes` did `message["bytes"]` and
                # raised KeyError on these, which is not WebSocketDisconnect, so
                # one stray keepalive killed the handler and the page went dead.
                continue
            log.info("received %d bytes of audio", len(audio_bytes))

            try:
                transcript = await transcriber.transcribe(audio_bytes)
            except Exception as exc:  # noqa: BLE001
                log.exception("transcription failed")
                await _send_json(
                    websocket,
                    {"type": "error", "message": f"Transcription failed: {exc}"},
                )
                continue

            log.info("transcript: %r", transcript)
            if not transcript:
                await _send_json(
                    websocket,
                    {"type": "error", "message": "I didn't catch that — say it again."},
                )
                continue

            transcript_log.add(CALLER, transcript)
            await _send_json(websocket, {"type": "transcript", "text": transcript})
            await pending.put(transcript)
            # Said out loud to the page so a caller who talked over a running
            # turn knows their words landed and where they are in the line.
            if pending.qsize() > 1 or _turn_in_flight:
                await _send_json(
                    websocket, {"type": "queued", "waiting": pending.qsize()}
                )

    async def run_turns() -> None:
        nonlocal _turn_in_flight
        while True:
            transcript = await pending.get()
            _turn_in_flight = True
            try:
                await _run_one_turn(websocket, transcript, pending.qsize())
            finally:
                _turn_in_flight = False

    _turn_in_flight = False
    reader = None
    runner = None
    try:
        # Sent before either task exists, so the page is never asked to render a
        # transcript line for a call it has not been told the shape of yet.
        await _send_json(websocket, switchboard.status())
        await _send_json(websocket, transcript_log.payload())
        if last_diagram is not None:
            await _send_json(websocket, last_diagram)

        reader = asyncio.create_task(receive_clips())
        runner = asyncio.create_task(run_turns())
        # Whichever finishes first ends the call: the reader raises on
        # disconnect, the runner only exits on an error worth surfacing.
        done, _ = await asyncio.wait(
            {reader, runner}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in done:
            task.result()
    except WebSocketDisconnect:
        log.info("browser disconnected")
    except Exception:  # noqa: BLE001
        log.exception("the websocket loop failed")
    finally:
        live = [t for t in (reader, runner) if t is not None]
        for task in live:
            task.cancel()
        # Awaited so a cancelled turn is not still writing to a socket the next
        # connection is about to replace.
        await asyncio.gather(*live, return_exceptions=True)
        connected_clients.pop(websocket, None)


async def _run_one_turn(websocket: WebSocket, transcript: str, waiting: int) -> None:
    """Route one utterance and deliver everything it produced to this tab."""
    await _send_json(
        websocket,
        {"type": "thinking", "route": switchboard.route, "waiting": waiting},
    )
    try:
        reply = await switchboard.handle(transcript)
    except Exception as exc:  # noqa: BLE001
        log.exception("routing failed")
        await _send_json(
            websocket, {"type": "error", "message": f"Switchboard error: {exc}"}
        )
        return

    # The written reply, which is what the page shows. Whatever the agent said
    # through `speak` is separate content and is already in the log from that
    # call, so neither one repeats the other.
    transcript_log.add(AGENT, reply.text, route=reply.route)
    await _send_json(
        websocket, {"type": "reply", "text": reply.text, "route": reply.route}
    )
    await _send_json(websocket, switchboard.status())
    if reply.error:
        log.warning("route %s reported: %s", reply.route, reply.error)

    # Only the lines nobody has voiced yet. A project agent says its own piece
    # through the `speak` tool, which reaches the browser directly while it is
    # still working — synthesizing its written reply on top would say the whole
    # turn twice.
    for utterance in reply.to_speak:
        spoken = speaker.clip_for_speech(utterance)
        if not spoken:
            continue
        try:
            audio = await speaker.synthesize(spoken)
        except TTSError as exc:
            log.exception("TTS failed")
            await _send_json(websocket, {"type": "error", "message": str(exc)})
            break
        await _send_bytes(websocket, audio)


# Mounted last so it does not shadow /ws, /healthz, /status or /speak.
app.mount(
    "/", StaticFiles(directory=str(ROOT_DIR / "static"), html=True), name="static"
)
