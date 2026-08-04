"""Turn a spoken model name into an argument the agent runtime will accept.

A caller asking for "sonnet five, thinking high" is heard by whisper, guessed at
by a language model, and then handed here. The one failure that matters is
landing on the *wrong* model: a leg started against the wrong provider looks
like it worked, and the caller only finds out by talking to it. Worse, they are
now stuck on the very thing they were trying to move away from.

So resolution refuses rather than guesses. A phrase that could mean two models —
which is exactly what happens when one model id is served by two providers — is
an error carrying both candidates, not a coin flip. The caller hears the
choices and says which.

The catalog is per host: a project agent runs on the box that holds its code,
and that box has its own providers configured. `pi --list-models` is asked
there, and cached for the life of the process.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from dataclasses import dataclass

log = logging.getLogger("switchboard.models")

# pi's --thinking levels, in order. "" means "leave the model's default alone".
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")

# What a person actually says out loud for those levels.
THINKING_ALIASES = {
    "none": "off",
    "no thinking": "off",
    "without thinking": "off",
    "lowest": "minimal",
    "min": "minimal",
    "mid": "medium",
    "normal": "medium",
    "extra high": "xhigh",
    "x high": "xhigh",
    "very high": "xhigh",
    "maximum": "max",
    "highest": "max",
    "default": "",
}

# Spoken digits, because "sonnet five" is what a microphone hears.
NUMBER_WORDS = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
}

LIST_TIMEOUT = 30.0


class ModelError(ValueError):
    """A model request that cannot be honoured, phrased to be read aloud."""


@dataclass(frozen=True)
class ModelChoice:
    provider: str
    model: str
    thinking: str = ""

    @property
    def spec(self) -> str:
        """The `--model` argument: always provider-qualified, never ambiguous."""
        base = f"{self.provider}/{self.model}" if self.provider else self.model
        return f"{base}:{self.thinking}" if self.thinking else base

    @property
    def spoken(self) -> str:
        """The same thing, for someone listening rather than reading."""
        where = f" on {self.provider}" if self.provider else ""
        level = f", thinking {self.thinking}" if self.thinking else ""
        return f"{self.model}{where}{level}"


def _normalize(text: str) -> str:
    """Fold a spoken model name down to something comparable.

    Separators go, spoken digits become digits: "sonnet four point five",
    "sonnet-4-5" and "Sonnet 4.5" all land on the same key.
    """
    lowered = (text or "").lower()
    words = re.split(r"[^a-z0-9]+", lowered)
    return "".join(NUMBER_WORDS.get(word, word) for word in words if word)


def parse_spec(text: str) -> tuple[str, str, str]:
    """Split "provider/model:thinking" into its parts. Any part may be absent."""
    raw = (text or "").strip()
    if not raw:
        return "", "", ""
    base, _, thinking = raw.partition(":")
    provider, sep, model = base.partition("/")
    if not sep:
        provider, model = "", provider
    return provider.strip(), model.strip(), thinking.strip()


def pin_thinking(spec: str, level: str) -> str:
    """Force a thinking level onto a model spec that does not already carry one.

    Every leg runs at a level somebody chose, because the alternative is a level
    nobody can name: the runtime does not report its own default, so an unpinned
    leg leaves the page with nothing honest to show. A spec that already names a
    level wins — that one was asked for out loud.

    This is a request, not a promise. The level a model does not support is
    clamped away by the runtime, which is why the effective level is reported
    back from inside the session rather than assumed from this string.
    """
    if not spec or not level:
        return spec
    provider, model, thinking = parse_spec(spec)
    if thinking:
        return spec
    base = f"{provider}/{model}" if provider else model
    return f"{base}:{level}"


def normalize_thinking(text: str) -> str:
    """Map what the caller said to a level pi knows. Empty means "unchanged"."""
    level = re.sub(r"[^a-z ]+", " ", (text or "").lower()).strip()
    level = re.sub(r"\s+", " ", level)
    if not level:
        return ""
    # Check whole-phrase aliases before removing filler words. Otherwise the
    # documented phrases "no thinking" and "without thinking" become the
    # unrecognised fragments "no" and "without".
    if level in THINKING_ALIASES:
        return THINKING_ALIASES[level]
    # "reasoning high", "high reasoning", "thinking level high" all reduce to
    # the level itself; the model asking for this rarely says the bare word.
    level = re.sub(r"\b(reasoning|thinking|effort|level|set|to)\b", " ", level).strip()
    level = re.sub(r"\s+", " ", level)
    if level in THINKING_ALIASES:
        return THINKING_ALIASES[level]
    collapsed = level.replace(" ", "")
    if collapsed in THINKING_LEVELS:
        return collapsed
    raise ModelError(
        f"{text!r} is not a thinking level. The levels are "
        + ", ".join(THINKING_LEVELS)
        + "."
    )


@dataclass
class CatalogEntry:
    provider: str
    model: str
    thinks: bool = True


class ModelCatalog:
    """What one host's agent runtime will actually accept as a `--model`."""

    def __init__(self, entries: list[CatalogEntry]) -> None:
        self.entries = entries

    def __bool__(self) -> bool:
        return bool(self.entries)

    @classmethod
    def parse(cls, table: str) -> ModelCatalog:
        """Read `pi --list-models` output: a header row then whitespace columns."""
        entries: list[CatalogEntry] = []
        for line in (table or "").splitlines():
            fields = line.split()
            if len(fields) < 5 or fields[0] == "provider":
                continue
            entries.append(
                CatalogEntry(
                    provider=fields[0], model=fields[1], thinks=fields[4] == "yes"
                )
            )
        return cls(entries)

    def resolve(self, model: str, thinking: str = "") -> ModelChoice:
        """Pick exactly one model, or raise saying why that was not possible."""
        want_provider, want_model, spec_thinking = parse_spec(model)
        level = normalize_thinking(thinking or spec_thinking)
        if not want_model:
            raise ModelError("no model was named")

        if not self.entries:
            # The catalog could not be read. A provider-qualified spec is
            # unambiguous by construction, so pass it through and let the
            # runtime reject it; a bare name would be a guess.
            if not want_provider:
                raise ModelError(
                    f"I can't check which provider serves {want_model}. "
                    "Say it as provider slash model."
                )
            return ModelChoice(want_provider, want_model, level)

        key = _normalize(want_model)
        pool = self.entries
        if want_provider:
            provider_key = _normalize(want_provider)
            pool = [e for e in pool if _normalize(e.provider) == provider_key]
            if not pool:
                known = sorted({e.provider for e in self.entries})
                raise ModelError(
                    f"there is no provider called {want_provider} here. I have "
                    + ", ".join(known)
                    + "."
                )

        exact = [e for e in pool if _normalize(e.model) == key]
        matches = exact or [e for e in pool if key in _normalize(e.model)]
        if not matches:
            raise ModelError(f"I don't have a model matching {want_model}")

        distinct = {(e.provider, e.model): e for e in matches}
        if len(distinct) > 1:
            names = ", ".join(f"{p}/{m}" for p, m in sorted(distinct))
            raise ModelError(
                f"{want_model} is ambiguous here. It could be {names}. Which one?"
            )

        entry = next(iter(distinct.values()))
        if level and level != "off" and not entry.thinks:
            raise ModelError(
                f"{entry.model} has no thinking levels, so I can't set {level}"
            )
        return ModelChoice(entry.provider, entry.model, level)


async def fetch_catalog(argv: list[str]) -> ModelCatalog:
    """Ask one host's runtime what it can run. Never raises — an empty catalog
    is a degraded mode (provider-qualified specs only), not a dropped call."""
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=LIST_TIMEOUT
        )
    except (asyncio.TimeoutError, OSError) as exc:
        log.warning("could not list models (%s): %s", " ".join(argv), exc)
        # `wait_for` cancels the read, never the child, and this argv is usually
        # an ssh. Left alone it holds a local client and a remote command open
        # for the life of the service, one per attempt, with nothing to reap it.
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, OSError):
                proc.kill()
                await proc.wait()
        return ModelCatalog([])

    if proc.returncode != 0:
        log.warning(
            "listing models exited %s: %s",
            proc.returncode,
            stderr.decode("utf-8", "replace").strip()[:300],
        )
        return ModelCatalog([])

    catalog = ModelCatalog.parse(stdout.decode("utf-8", "replace"))
    log.info("%s knows %d model(s)", " ".join(argv[:2]), len(catalog.entries))
    return catalog
