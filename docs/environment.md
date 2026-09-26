# Environment contract

The homelab `damocles` role writes `/etc/switchboard/switchboard.env`; this
service reads it. Every variable below is public interface between the two
repositories: renaming one, adding one, or changing what it accepts is a change
on both sides, and the pull request that makes it says so (see `AGENTS.md`).

`Config::from_values` in `apps/backend/src/main.rs` is the only place the
service parses these. Modules receive their settings from `Config`; they do not
read the environment themselves.

## Read by the service

Values come from the env file, overridden by the process environment. Blank
means unset.

| Variable | Default | What it controls |
|---|---|---|
| `SWITCHBOARD_ENV_FILE` | `/etc/switchboard/switchboard.env` | Where the env file is. Process environment only. |
| `SWITCHBOARD_CONFIG_DIR` | `/etc/switchboard` | Base for the two paths below. |
| `SWITCHBOARD_PROJECTS_FILE` | `<config dir>/projects.json` | The project registry. |
| `SWITCHBOARD_OPERATOR_PROMPT` | `<config dir>/operator.system.md` | The operator's system prompt; skipped if the file is missing. |
| `SWITCHBOARD_STATE_DIR` | `/var/lib/switchboard` | SSH lock files and control sockets (`ssh/locks/`, `ssh/control/`). |
| `SWITCHBOARD_BIND` | `0.0.0.0:8765` | Listen address. |
| `SWITCHBOARD_SELF_URL` | none | How a project agent on another host reaches this service. The three callback URLs below default to paths under it. |
| `SWITCHBOARD_SPEAK_URL` | `<self url>/speak` | Where the `speak` tool posts. |
| `SWITCHBOARD_STATE_URL` | `<self url>/leg-state` | Where the extension reports the thinking level a leg actually runs at. |
| `SWITCHBOARD_DISPLAY_URL` | `<self url>/display` | Where the `display` tool posts. The `view` tool calls `/view` on the same origin. |
| `SWITCHBOARD_PI_BINARY` | `pi` | The operator's runtime, run locally. |
| `SWITCHBOARD_SSH_PROGRAM` | `ssh` | The SSH client for project hosts. |
| `SWITCHBOARD_OPERATOR_MODEL` | runtime default | The operator's model. Never swappable. |
| `SWITCHBOARD_OPERATOR_EXTENSION` | none | Pi extension loaded into the operator. |
| `SWITCHBOARD_AGENT_EXTENSION` | none | Pi extension for project legs: staged to each remote host at startup, loaded directly for local projects. Without it, agents are briefed to use the `[[SWITCHBOARD:RETURN]]` sentinel. |
| `SWITCHBOARD_AGENT_MODEL` | none | Model for a project leg whose registry entry names none. |
| `SWITCHBOARD_AGENT_THINKING` | `medium` | Thinking level a project leg starts at unless the caller names one. |
| `SWITCHBOARD_MODEL_SWAPS` | `1` | `0`, `false`, or `no` turns off mid-call model and thinking changes. |
| `SWITCHBOARD_REMOTE_CACHE_DIR` | `.cache/switchboard` | Where extensions are staged on project hosts; relative paths are under the remote `$HOME`. |
| `SWITCHBOARD_PERSONA` | empty | Passed through to every project leg for the `speak` tool description. |
| `SWITCHBOARD_IDLE_TIMEOUT` | `3600` | Seconds of silence before a project leg is dropped back to the operator; `0` or less disables it. |
| `SWITCHBOARD_IDLE_POLL` | `30` | Seconds between idle checks (at least 1). |
| `SWITCHBOARD_MAX_SPOKEN_CHARS` | `700` | Longest reply the switchboard voices; longer text is clipped, at a sentence end when one is near. |
| `SWITCHBOARD_SPEECH_DEADLINE_MS` | `25000` | Deadline for one synthesized utterance, 1–120000. Also passed to project legs, whose extension enforces the same deadline. |
| `SWITCHBOARD_HISTORY_LIMIT` | `200` | Transcript entries kept for page reloads; `0` keeps none. |
| `SWITCHBOARD_STT_COMMAND` | none | Complete-clip speech-to-text: WebM on stdin, text on stdout. |
| `SWITCHBOARD_STT_STREAM_COMMAND` | none | Optional long-lived streaming worker; framing is described in `README.md`. |
| `SWITCHBOARD_LOG` | `switchboard=info,warn` | Log filter; falls back to `RUST_LOG`. A filter that does not parse is reported and replaced by the default. |
| `SWITCHBOARD_LOG_FORMAT` | `text` | `json` for one JSON object per line. |
| `ELEVENLABS_API_KEY` | none | Secret. Without it `/speak` answers 502 and replies are written only. |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` | |
| `ELEVENLABS_STABILITY` | `0.5` | |
| `ELEVENLABS_SIMILARITY_BOOST` | `0.75` | |
| `ELEVENLABS_STYLE` | `0.0` | |
| `ELEVENLABS_SPEED` | `1.0` | |

A numeric setting that does not parse is logged and replaced by its default,
because the symptom of a silently wrong duration looks nothing like its cause.
`SWITCHBOARD_SPEECH_DEADLINE_MS` is the exception: the extension enforces the
same deadline, so a value the service would replace with its default would leave
the two sides disagreeing, and startup stops instead.

## Passed to every project leg

The service adds these to the environment of each project agent, on top of the
env file. `extensions/agent-switchboard.ts` reads them.

| Variable | Value |
|---|---|
| `SWITCHBOARD_SESSION` | `1`. Marks the process as switchboard-driven, so a `speak` extension installed globally on the host can stand down instead of registering the tool twice. |
| `SWITCHBOARD_SESSION_TOKEN` | A fresh token per process. Callbacks carry it so the service can reject speech, display, and thinking reports from a leg that has since been replaced. A correlation value, not authentication. |
| `SWITCHBOARD_SPEAK_URL`, `SWITCHBOARD_STATE_URL`, `SWITCHBOARD_DISPLAY_URL` | The resolved callback URLs above; omitted when empty. |
| `SWITCHBOARD_PERSONA` | As configured; omitted when empty. |
| `SWITCHBOARD_SPEECH_DEADLINE_MS` | The parsed deadline. |

## Build time

`SWITCHBOARD_GIT_SHA` is read by `build.rs`, not at run time. The homelab
builder compiles a `git archive` of the pinned commit, which has no `.git`, and
passes the commit here so `/healthz` and the startup log can name it. See
`README.md`.

## In the same file, read by something else

The env file also carries settings for processes this repository does not own:
`PI_CODING_AGENT_DIR` (read by pi), and `SWITCHBOARD_STT_SOCKET` and `WHISPER_*`
(read by homelab's speech-to-text sidecar). They are listed here only so a
reader of the deployed file can tell them apart from this service's contract.
