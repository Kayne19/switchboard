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
| `SWITCHBOARD_CONFIG_DIR` | `/etc/switchboard` | Base for the three paths below. |
| `SWITCHBOARD_PROJECTS_FILE` | `<config dir>/projects.json` | The project registry. |
| `SWITCHBOARD_HOST_TOKENS_FILE` | `<config dir>/host-tokens.json` | Secret. The per-host bearer tokens of the host link (`/host`, see `docs/host-link.md`). Read once at startup; format below. |
| `SWITCHBOARD_OPERATOR_PROMPT` | `<config dir>/operator.system.md` | The operator's system prompt; skipped if the file is missing. |
| `SWITCHBOARD_BIND` | `0.0.0.0:8765` | Listen address. |
| `SWITCHBOARD_PI_BINARY` | `pi` | The operator's runtime, run locally. |
| `SWITCHBOARD_OPERATOR_MODEL` | runtime default | The operator's model. Never swappable. |
| `SWITCHBOARD_OPERATOR_EXTENSION` | none | Pi extension loaded into the operator. |
| `SWITCHBOARD_AGENT_MODEL` | none | Model for a project leg whose registry entry names none. |
| `SWITCHBOARD_AGENT_THINKING` | `medium` | Thinking level a project leg starts at unless the caller names one. |
| `SWITCHBOARD_MODEL_SWAPS` | `1` | `0`, `false`, or `no` turns off mid-call model and thinking changes. |
| `SWITCHBOARD_PERSONA` | empty | Given to each project session when it joins the call (`join_call`, see `docs/host-link.md`). |
| `SWITCHBOARD_MAX_SPOKEN_CHARS` | `700` | Longest reply the switchboard voices; longer text is clipped, at a sentence end when one is near. |
| `SWITCHBOARD_SPEECH_DEADLINE_MS` | `25000` | Deadline for one synthesized utterance, 1–120000. Also given to each project session when it joins the call; its host agent enforces the same deadline. |
| `SWITCHBOARD_HISTORY_LIMIT` | `200` | Transcript entries kept for page reloads; `0` keeps none. |
| `SWITCHBOARD_JEV_KEY_FILE` | `/etc/switchboard/secrets/typesafe-api-key` | Secret file path. The Jev bearer key is read from this file and never logged or returned in errors. |
| `SWITCHBOARD_JEV_URL` | `https://api.typesafe.ai/v1/systemone` | Jev System One endpoint. Tests use an in-process fake URL. |
| `SWITCHBOARD_JEV_TIMEOUT_MS` | `2000` | Maximum time for one Jev request, 1–120000 ms; timeout uses the top-level LLM path. |
| `SWITCHBOARD_JEV_FOR_CURRENT_AGENT_LOWER` | `0.3` | Below this probability band Jev's action can be used when its confidence meets the action threshold. |
| `SWITCHBOARD_JEV_FOR_CURRENT_AGENT_UPPER` | `0.7` | At or above this probability a project utterance stays with its current agent. |
| `SWITCHBOARD_JEV_ACTION_THRESHOLD` | `0.6` | Minimum Jev action confidence for a non-uncertain decision. Stopping still asks for confirmation. |
| `SWITCHBOARD_JEV_SUMMARY_TOKEN_BUDGET` | `8000` | Approximate state token budget; oldest conversation turns are removed first and the Jev 32000-token per-question limit is enforced. |
| `SWITCHBOARD_STT_COMMAND` | none | Complete-clip speech-to-text: WebM on stdin, text on stdout. |
| `SWITCHBOARD_STT_STREAM_COMMAND` | none | Optional long-lived streaming worker; framing is described in `README.md`. |
| `SWITCHBOARD_LOG` | `switchboard=info,warn` | Log filter; falls back to `RUST_LOG`. A filter that does not parse is reported and replaced by the default. |
| `SWITCHBOARD_LOG_FORMAT` | `text` | `json` for one JSON object per line. |
| `ELEVENLABS_API_KEY` | none | Secret. Without it an agent's `speak` fails and replies are written only. |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` | |
| `ELEVENLABS_STABILITY` | `0.5` | |
| `ELEVENLABS_SIMILARITY_BOOST` | `0.75` | |
| `ELEVENLABS_STYLE` | `0.0` | |
| `ELEVENLABS_SPEED` | `1.0` | |

A numeric setting that does not parse is logged and replaced by its default,
because the symptom of a silently wrong duration looks nothing like its cause.
`SWITCHBOARD_SPEECH_DEADLINE_MS` is the exception: the host agent enforces the
same deadline, so a value the service would replace with its default would leave
the two sides disagreeing, and startup stops instead.

### Host tokens file

`SWITCHBOARD_HOST_TOKENS_FILE` names one JSON object from host id to that
host's token. The homelab role renders it (mode 0600, readable only by the
service); each host agent holds its own token in its `token_file`.

```json
{
  "scriptorium": "<token>",
  "forge": "<token>"
}
```

Every host in the file is a host the service expects: `/healthz` lists each
under `hosts`, connected or not. A hello whose host id is not in the file, or
whose token does not match, is refused as `bad_token`. An entry whose token is
not a non-empty string is skipped (surrounding whitespace is trimmed). A
missing or unparsable file is logged and leaves no host able to link; the
service still starts. Tokens are never logged or reported; the startup log
names the host ids and their count.

## Given to every project session

Project legs are sessions on their host's prime-agent daemon, reached through
the host link; they get no environment from this service. What a session needs
for the call comes with `join_call` (`docs/host-link.md`): a fresh call token
per leg, and the persona and speech deadline above.

## Removed in this step

The service no longer reads these. The paired homelab pull request removes
them from the env file and the role; a deployed file that still sets them does
no harm, because the service ignores names it does not read.

Each name below is written without its `SWITCHBOARD_` prefix, so a search of
this tree for a retired name finds no live reference
(`scripts/check_no_ssh.mjs` enforces that for the SSH ones).

| Name | Why it went |
|---|---|
| `SSH_PROGRAM` | Project legs run over the host link; the service starts no `ssh`. |
| `REMOTE_CACHE_DIR` | Nothing is staged on project hosts; the host-agent installer ships the skill. |
| `STATE_DIR` | Held only the SSH locks and control sockets. |
| `AGENT_EXTENSION` | The project extension is gone; agents use the `switchboard` skill module. |
| `SELF_URL`, `SPEAK_URL`, `STATE_URL`, `DISPLAY_URL` | The agent callback routes are gone; module calls come over the host link. |
| `IDLE_TIMEOUT`, `IDLE_POLL` | The idle drop is gone; prime-agent's own idle eviction ends sessions nobody uses. |

The registry (`projects.json`) also lost `runtime`, `stage_extension` and
`extra_args`. An entry that still carries them loads; the keys have no effect
and the startup log names them as keys the switchboard does not understand.
Every project needs a `host`: the id of a host agent in the host tokens file.

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
