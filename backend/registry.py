"""The directory of extensions the operator can patch a caller through to.

Backed by a JSON file rendered from Ansible (`switchboard_projects` in the
damocles role), so adding a project is a repo change that ships through the
normal PR loop rather than something edited on the box.

Resolution is deliberately forgiving: the operator is matching against a
speech-to-text transcript, so "the grape segmentation project", "grape
segmentation" and "grapes" all have to land on the same extension.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("switchboard.registry")


@dataclass
class Project:
    id: str
    description: str = ""
    aliases: list[str] = field(default_factory=list)
    # Where the code lives. `host` is an ssh alias resolved by the damocles
    # user's ~/.ssh/config; None means "on this box".
    host: str | None = None
    cwd: str = ""
    runtime: str = "pi"
    model: str | None = None
    # Whether to stage the switchboard tool extension onto `host` before
    # starting a session there. Off for runtimes that are not pi.
    stage_extension: bool = True
    extra_args: list[str] = field(default_factory=list)
    # Shell run in `cwd` before the agent starts, e.g. to bring a checkout up to
    # date. Its stdout is handed to the agent as an opening note, so it should
    # print one line describing what it found. Failure is never fatal — a stale
    # checkout still takes the call.
    prepare: str = ""

    @property
    def is_remote(self) -> bool:
        return bool(self.host)

    def public(self) -> dict:
        """The view handed to the operator model — routing facts only."""
        return {
            "id": self.id,
            "description": self.description,
            "aliases": self.aliases,
            "location": f"{self.host or 'damocles'}:{self.cwd}",
        }


def _normalize(text: str) -> str:
    """Fold a spoken phrase down to comparable words."""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


class Registry:
    def __init__(self, projects: list[Project]) -> None:
        self.projects = projects
        self._by_key: dict[str, Project] = {}
        for project in projects:
            for key in [project.id, *project.aliases]:
                normalized = _normalize(key)
                if not normalized:
                    continue
                if normalized in self._by_key and self._by_key[normalized] is not project:
                    log.warning(
                        "alias %r maps to both %s and %s; keeping the first",
                        key,
                        self._by_key[normalized].id,
                        project.id,
                    )
                    continue
                self._by_key[normalized] = project

    @classmethod
    def load(cls, path: str | Path) -> "Registry":
        path = Path(path)
        if not path.exists():
            log.warning("no project registry at %s; the operator has nowhere to send anyone", path)
            return cls([])
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            log.exception("could not read the project registry at %s", path)
            return cls([])

        entries = raw.get("projects", []) if isinstance(raw, dict) else raw
        projects: list[Project] = []
        known = {f.name for f in Project.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        for entry in entries or []:
            if not isinstance(entry, dict) or not entry.get("id"):
                log.warning("skipping malformed registry entry: %r", entry)
                continue
            unknown = set(entry) - known
            if unknown:
                log.warning("registry entry %s has unknown keys: %s", entry["id"], sorted(unknown))
            projects.append(Project(**{k: v for k, v in entry.items() if k in known}))

        log.info("loaded %d project(s): %s", len(projects), ", ".join(p.id for p in projects))
        return cls(projects)

    def resolve(self, spoken: str) -> Project | None:
        """Best-effort match of a spoken phrase to a project."""
        normalized = _normalize(spoken or "")
        if not normalized:
            return None

        exact = self._by_key.get(normalized)
        if exact is not None:
            return exact

        # Substring either way: the caller said more than the alias ("put me in
        # the grape segmentation project") or less ("grape").
        matches = [
            project
            for key, project in self._by_key.items()
            if key in normalized or normalized in key
        ]
        unique = {project.id: project for project in matches}
        if len(unique) == 1:
            return next(iter(unique.values()))
        if len(unique) > 1:
            log.info("ambiguous project phrase %r -> %s", spoken, sorted(unique))
        return None

    def catalog(self) -> list[dict]:
        return [project.public() for project in self.projects]
