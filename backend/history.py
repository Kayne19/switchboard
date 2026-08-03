"""What was said on this line, kept so a reloaded page is not a blank one.

The page is a phone, not a chat window: a caller who walks away and comes back
to a reconnected tab used to find nothing at all. This holds the last N turns in
memory and replays them to whoever connects, which covers the case that actually
happens (tab reload, laptop sleep, reconnect) without dragging a database in for
the case that does not (surviving a service restart).
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any, Iterable

# Roughly an afternoon of calling. Entries are short strings; the whole buffer
# is far smaller than one clip of synthesized audio.
DEFAULT_LIMIT = 200

CALLER = "caller"
AGENT = "agent"


class TranscriptLog:
    """A bounded, newest-last log of everything said in either direction."""

    def __init__(self, limit: int = DEFAULT_LIMIT) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=limit)

    @property
    def limit(self) -> int:
        return self._entries.maxlen or 0

    def add(self, role: str, text: str, route: str = "") -> dict[str, Any] | None:
        """Record one utterance. Blank text is dropped rather than stored."""
        cleaned = (text or "").strip()
        if not cleaned:
            return None
        entry = {"role": role, "text": cleaned, "route": route, "ts": time.time()}
        self._entries.append(entry)
        return entry

    def entries(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def replace(self, entries: Iterable[dict[str, Any]]) -> None:
        self._entries.clear()
        self._entries.extend(entries)

    def payload(self) -> dict[str, Any]:
        """The websocket message a freshly connected browser gets."""
        return {"type": "history", "entries": self.entries()}
