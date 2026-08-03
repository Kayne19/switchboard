"""Speech in, speech out: faster-whisper for STT, ElevenLabs for TTS.

Lifted from the voice-bridge proof of concept this service replaces, with one
addition that matters on a phone line: `clip_for_speech`. An agent reply can run
to hundreds of words, and synthesizing all of it is slow, expensive, and nobody
listens to the tail anyway — so what gets spoken is capped, while the full text
still goes to the browser transcript.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile
from pathlib import Path

import httpx

log = logging.getLogger("switchboard.audio")

ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"


class TTSError(RuntimeError):
    pass


class Transcriber:
    """Wraps the whisper model. Loaded once at startup, shared across calls."""

    def __init__(
        self,
        model_size: str,
        download_root: str | Path,
        cpu_threads: int = 2,
        hotwords: str = "",
    ) -> None:
        # Imported here rather than at module scope so this module — and the
        # reply-shaping logic below it — can be imported and tested without the
        # native ctranslate2 stack present.
        from faster_whisper import WhisperModel

        self.model_size = model_size
        # Words to bias the decoder toward. Without these, lab-specific proper
        # nouns come back mangled ("elenchus" -> "a lencus") no matter how large
        # the model is; with them the same model gets them exactly right.
        self.hotwords = hotwords.strip() or None
        Path(download_root).mkdir(parents=True, exist_ok=True)
        log.info(
            "loading faster-whisper %r (int8, CPU, %d threads)...",
            model_size,
            cpu_threads,
        )
        self._model = WhisperModel(
            model_size,
            device="cpu",
            compute_type="int8",
            cpu_threads=cpu_threads,
            download_root=str(download_root),
        )
        log.info("faster-whisper loaded")

    def _transcribe_file(self, path: str) -> str:
        segments, _info = self._model.transcribe(
            path, beam_size=1, hotwords=self.hotwords
        )
        return " ".join(segment.text.strip() for segment in segments).strip()

    async def transcribe(self, audio: bytes) -> str:
        """Transcribe one push-to-talk clip.

        faster-whisper is synchronous and CPU-bound; run it off the event loop so
        a long clip does not stall the WebSocket or a streaming agent turn.
        """
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
            tmp.write(audio)
            tmp_path = tmp.name
        try:
            return await asyncio.to_thread(self._transcribe_file, tmp_path)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


class Speaker:
    """ElevenLabs TTS."""

    def __init__(
        self,
        api_key: str,
        voice_id: str,
        model_id: str,
        *,
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        style: float = 0.0,
        speed: float = 1.0,
        max_chars: int = 700,
    ) -> None:
        self.api_key = api_key
        self.voice_id = voice_id
        self.model_id = model_id
        self.voice_settings = {
            "stability": stability,
            "similarity_boost": similarity_boost,
            "style": style,
            "speed": speed,
        }
        self.max_chars = max_chars

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def clip_for_speech(self, text: str) -> str:
        """Trim a reply to something worth listening to.

        Cuts on a sentence boundary when there is one in range so the spoken line
        does not end mid-word, and says out loud that it was cut — otherwise a
        truncated answer is indistinguishable from a complete one.
        """
        text = re.sub(r"\s+", " ", (text or "").strip())
        if len(text) <= self.max_chars:
            return text

        window = text[: self.max_chars]
        cut = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
        # Only honor a sentence break in the last third, else it throws away too
        # much of the reply.
        if cut > self.max_chars // 3:
            window = window[: cut + 1]
        else:
            window = window.rsplit(" ", 1)[0]
        return window.rstrip() + " — there's more on screen."

    async def synthesize(self, text: str) -> bytes:
        if not self.configured:
            raise TTSError(
                "ELEVENLABS_API_KEY is not set. Add it to the switchboard env file "
                "(see load-secrets-switchboard.sh) and restart the service."
            )

        url = ELEVENLABS_TTS_URL.format(voice_id=self.voice_id)
        headers = {
            "xi-api-key": self.api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }
        payload = {
            "text": text,
            "model_id": self.model_id,
            "voice_settings": self.voice_settings,
        }
        # Every caller only knows how to handle TTSError. httpx raises its own
        # tree (ConnectError, ReadTimeout, RemoteProtocolError...), and one of
        # those escaping reached the `/ws` loop, was not WebSocketDisconnect,
        # and killed the websocket handler — a single flaky ElevenLabs request
        # took the whole page down until reload. Nothing above here should have
        # to know what HTTP library speaks to the vendor.
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise TTSError(f"could not reach ElevenLabs: {exc}") from exc
        if resp.status_code != 200:
            raise TTSError(
                f"ElevenLabs TTS failed ({resp.status_code}): {resp.text[:500]}"
            )
        return resp.content
