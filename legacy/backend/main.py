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
import json
import logging
import os
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass
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

ROOT_DIR = Path(__file__).resolve().parents[2]
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
AGENT_PERSONA = _env("SWITCHBOARD_PERSONA")
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
    persona=AGENT_PERSONA,
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
        try:
            minutes = int(IDLE_TIMEOUT // 60)
        except (OverflowError, ValueError):
            minutes = 0
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
    workers = [
        asyncio.create_task(_process_clips(), name="switchboard-clips"),
        asyncio.create_task(_process_turns(), name="switchboard-turns"),
    ]
    if IDLE_TIMEOUT > 0:
        workers.append(
            asyncio.create_task(_watch_for_silence(), name="switchboard-idle")
        )
    try:
        yield
    finally:
        for worker in workers:
            worker.cancel()
        # Awaited, not just signalled: a worker can be mid-turn on a session
        # that `shutdown` is about to close underneath it.
        await asyncio.gather(*workers, return_exceptions=True)
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


@dataclass(frozen=True)
class Clip:
    id: str
    audio: bytes
    mime: str = ""


# Ownership transfers to the application before an acknowledgement is sent.
# Neither queue belongs to a socket, so closing the tab only stops its reader;
# accepted transcription and turns keep running and are replayed from history.
clip_queue: asyncio.Queue[Clip] = asyncio.Queue()
turn_queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
turn_in_flight = False

# Application-lifetime, bounded idempotency.  A reconnect repeats an unacked
# clip; remembering its id is what makes that retry safe after the first socket
# died between enqueue and acknowledgement.
CLIP_ID_LIMIT = 512
accepted_clip_ids: OrderedDict[str, None] = OrderedDict()

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


async def _process_clips() -> None:
    """Transcribe accepted clips and hand their text to the live call."""
    while True:
        clip = await clip_queue.get()
        try:
            log.info("transcribing clip %s (%d bytes)", clip.id, len(clip.audio))
            try:
                transcript = await transcriber.transcribe(clip.audio)
            except Exception as exc:  # noqa: BLE001
                log.exception("transcription failed for clip %s", clip.id)
                await _broadcast_json(
                    {
                        "type": "error",
                        "id": clip.id,
                        "message": f"Transcription failed: {exc}",
                    }
                )
                continue

            log.info("transcript for %s: %r", clip.id, transcript)
            if not transcript:
                await _broadcast_json(
                    {
                        "type": "error",
                        "id": clip.id,
                        "message": "I didn't catch that — say it again.",
                    }
                )
                continue

            entry = transcript_log.add(CALLER, transcript, route=switchboard.route)
            if entry is not None:
                # TranscriptLog intentionally has a generic entry shape.  The
                # clip id is websocket metadata used to reconcile the browser's
                # optimistic bubble, and retaining it also fixes reconnects that
                # land after transcription but before the live frame arrives.
                entry["id"] = clip.id
            await _broadcast_json(
                {"type": "transcript", "id": clip.id, "text": transcript}
            )

            try:
                steered = await switchboard.steer_if_busy(transcript)
            except Exception:  # noqa: BLE001
                # Steering is opportunistic.  If its RPC path itself fails, an
                # ordinary prompt is the safe fallback and keeps accepted words.
                log.exception("steering clip %s failed; queueing it", clip.id)
                steered = False

            if steered:
                await _broadcast_json(
                    {"type": "queued", "id": clip.id, "waiting": 0, "steered": True}
                )
                continue

            await turn_queue.put((clip.id, transcript))
            if turn_queue.qsize() > 1 or turn_in_flight:
                await _broadcast_json(
                    {
                        "type": "queued",
                        "id": clip.id,
                        "waiting": turn_queue.qsize(),
                        "steered": False,
                    }
                )
        finally:
            clip_queue.task_done()


async def _process_turns() -> None:
    """Run prompts serially for the application, independent of any socket."""
    global turn_in_flight
    while True:
        _clip_id, transcript = await turn_queue.get()
        turn_in_flight = True
        try:
            await _run_one_turn(transcript, turn_queue.qsize())
        except Exception:  # noqa: BLE001
            # A worker must survive one bad delivery; otherwise every later
            # accepted clip would remain queued forever with no visible reason.
            log.exception("the turn worker failed")
            await _broadcast_json(
                {"type": "error", "message": "The call worker failed on that turn."}
            )
        finally:
            turn_in_flight = False
            turn_queue.task_done()


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
    """Register one reader; accepted work is owned by application workers."""
    await websocket.accept()
    connected_clients[websocket] = asyncio.Lock()
    log.info("browser connected")
    pending_header: dict | None = None

    try:
        # History comes before this socket starts contributing new clips.  A
        # reconnect can therefore rebuild its transcript before retransmitting.
        await _send_json(websocket, switchboard.status())
        await _send_json(websocket, transcript_log.payload())
        if last_diagram is not None:
            await _send_json(websocket, last_diagram)

        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            text = message.get("text")
            if text is not None:
                try:
                    command = json.loads(text)
                except (json.JSONDecodeError, TypeError):
                    await _send_json(
                        websocket, {"type": "error", "message": "Invalid JSON frame."}
                    )
                    continue

                if not isinstance(command, dict):
                    await _send_json(
                        websocket,
                        {"type": "error", "message": "Invalid command shape."},
                    )
                    continue

                if command.get("type") == "ping":
                    await _send_json(
                        websocket,
                        {
                            "type": "pong",
                            "nonce": command.get("nonce"),
                            "time": command.get("time"),
                        },
                    )
                    continue

                if command.get("type") != "clip":
                    await _send_json(
                        websocket,
                        {"type": "error", "message": "Unknown websocket command."},
                    )
                    continue

                clip_id = command.get("id")
                if not isinstance(clip_id, str) or not clip_id or len(clip_id) > 128:
                    await _send_json(
                        websocket, {"type": "error", "message": "Invalid clip id."}
                    )
                    pending_header = None
                    continue
                pending_header = {
                    "id": clip_id,
                    "mime": str(command.get("mime") or "")[:100],
                }
                continue

            audio = message.get("bytes")
            if audio is None:
                continue
            if pending_header is None:
                await _send_json(
                    websocket,
                    {
                        "type": "error",
                        "message": "Audio arrived without a clip header.",
                    },
                )
                continue

            header, pending_header = pending_header, None
            clip_id = header["id"]
            if clip_id not in accepted_clip_ids:
                # Put first, remember second, acknowledge last.  Once accepted
                # reaches the browser there is no path on which a socket close
                # can take ownership of the bytes back from the application.
                await clip_queue.put(Clip(clip_id, audio, header["mime"]))
                accepted_clip_ids[clip_id] = None
                while len(accepted_clip_ids) > CLIP_ID_LIMIT:
                    accepted_clip_ids.popitem(last=False)
                log.info("accepted clip %s (%d bytes)", clip_id, len(audio))
            else:
                accepted_clip_ids.move_to_end(clip_id)
                log.info("acknowledging repeated clip %s", clip_id)
            await _send_json(websocket, {"type": "accepted", "id": clip_id})
    except WebSocketDisconnect:
        log.info("browser disconnected")
    except Exception:  # noqa: BLE001
        log.exception("the websocket reader failed")
    finally:
        # No task is cancelled here.  The application queues and workers own all
        # accepted clips and turns; this socket owns only its reader and send lock.
        connected_clients.pop(websocket, None)


async def _run_one_turn(transcript: str, waiting: int) -> None:
    """Route one queued utterance and broadcast everything it produces."""
    await _broadcast_json(
        {"type": "thinking", "route": switchboard.route, "waiting": waiting}
    )
    try:
        reply = await switchboard.handle(transcript)
    except Exception as exc:  # noqa: BLE001
        log.exception("routing failed")
        await _broadcast_json({"type": "error", "message": f"Switchboard error: {exc}"})
        return

    # The written reply, which is what the page shows. Whatever the agent said
    # through `speak` is separate content and is already in the log from that
    # call, so neither one repeats the other.
    transcript_log.add(AGENT, reply.text, route=reply.route)
    await _broadcast_json({"type": "reply", "text": reply.text, "route": reply.route})
    await _broadcast_json(switchboard.status())
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
            await _broadcast_json({"type": "error", "message": str(exc)})
            break
        await _broadcast_audio(audio)


# Mounted last so it does not shadow /ws, /healthz, /status or /speak.
app.mount(
    "/", StaticFiles(directory=str(ROOT_DIR / "static"), html=True), name="static"
)
