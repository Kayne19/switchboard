# Jev routing evaluation

## Purpose

This is the step-1 check for plan `sb-one-assistant` (#52, #53). The plan makes
Jev the routing decider for caller utterances. The backend router now uses the
request and thresholds below; when Jev is unavailable or unsure, the existing
operator LLM path handles the utterance. This document records how Jev was
evaluated and what the numbers were, so the deployed thresholds remain tied to
evidence.

Jev receives speech-to-text text and a compact call summary. It returns typed
decisions. In the plan, the top-level LLM takes over when Jev is unavailable or
unsure.

Jev does not receive audio. The speech-to-text service must produce the
utterance first.

## API request

The evaluator sends one request per labelled case:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>
Content-Type: application/json
```

The body has this shape:

```json
{
  "model": "jev-latest",
  "state": {
    "caller_is_talking_to": "atlas",
    "last_thing_that_agent_said": "synthetic agent reply",
    "caller_just_said": "synthetic example text",
    "agents": {"atlas": "live"},
    "registered_projects": [{"id": "atlas", "description": "Example project", "aliases": ["planning"]}]
  },
  "questions": {
    "action": {"type": "choice", "instructions": "...", "criteria": {"continue": "..."}},
    "for_current_agent": {"type": "noul", "instructions": "...", "criteria": {"true": "...", "false": "..."}},
    "target": {"type": "choice", "instructions": "...", "criteria": {"atlas": "...", "none": "..."}},
    "continue_or_fresh": {"type": "choice", "instructions": "...", "criteria": {"continue": "...", "fresh": "...", "not_applicable": "..."}},
    "multi_target": {"type": "noul", "instructions": "...", "criteria": {"true": "...", "false": "..."}}
  }
}
```

Choice answers include the selected option, all option probabilities, and a
confidence value. Noul answers include a probability from zero to one and no
confidence. The evaluator records the full answers and token usage in its
private output.

Jev's `confidence` is computed from the probabilities. For a Choice it measures
how far the top option stands out, scaled by the number of options (the docs'
three-option example is `(3 × top − 1) / 2`). So a threshold only keeps its
meaning while the option set stays the same: the router must ask the same ten
actions, or the thresholds must be measured again. Jev's docs also gate risky
actions higher than safe ones, so the report shows threshold coverage per
predicted action as well as overall (see
https://docs.typesafe.ai/confidence.md).

The question set is built in `buildRouterQuestions` in
`scripts/spikes/jev-routing-eval.mjs`. It is the copyable contract for the
router slice:

- `action`: a Choice over `continue`, `go_to_project`, `answer_waiting`,
  `stop`, `set_model`, `set_thinking`, `status`, `general`, `unclear`, and
  `take_over`.
- `for_current_agent`: a Noul asking whether the utterance is meant for the
  project agent the caller is talking to now.
- `target`: a Choice over every registry project plus `none`.
- `continue_or_fresh`: a Choice over `continue`, `fresh`, and
  `not_applicable`.
- `multi_target`: a Noul asking whether more than one project or agent is
  addressed.

## Floor good-moment gate

Background `request_to_speak` messages use the same Jev client and timeout but a
separate one-question request named `good_moment`. Jev answers `yes` or `no`.
A failure or timeout is held until the next configured quiet moment; the floor
does not retry the failed gate in a loop. The floor setting is
`SWITCHBOARD_FLOOR_QUIET_THRESHOLD_MS` in `docs/environment.md`.

The gate reads the call from `RoutingView`, as caller routing does, never
through the PBX lock. The turn worker holds that lock for a whole prompt, and a
foreground turn is when the caller waits on a quiet line, so a gate that waited
for it held every background update for the length of the turn (#245). The
rewrite reaches the routing utility through that lock, so the wait for it counts
against `REWRITE_TIMEOUT` (5 s); past it the update is spoken as the agent wrote
it.

## Call state

The state is what the switchboard knows at the moment the caller speaks.
`callState` in the script builds it, in this order:

1. `caller_is_talking_to`: a project id, or the operator.
2. `agents`: one object per agent with its state (busy or idle), model,
   thinking level and task.
3. `recent_conversation`: recent turns, oldest first, each `{speaker, text}`.
4. `caller_just_said`: the utterance.
5. `registered_projects`: each project's id, description and aliases.

Host names, working directories and secrets are not sent.

On a live call the service sends the same named fields, built from what it
knows (`CallSummary` in `apps/backend/src/router.rs`):

- `agents` lists every agent on the call: the operator, the agent on the line,
  and every background agent. `state` is busy, idle or waiting;
  `pending_request_to_speak` is true while a queued message waits; and
  `display_ready` is true while the agent holds a display the caller has not
  seen. `task` is the last request the agent was given on this call.
- The floor gate keeps `caller_just_said` as the caller's last words and puts
  the update it judges in `queued_update` (`from_agent`, `message`).

The operator and the routing utility get the same facts as a short
`[CALL STATE]` block with their prompt, once per utterance. When Jev chooses
`answer_waiting` without a target and exactly one agent has something waiting,
that agent is the target. A route to an id that is not registered is refused
without moving the caller. A missing `mode` means continue, and an agent that
is already on the call is brought forward, never refused or replaced; stopping
it is the way to start over. A `second_opinion` without `confident` is not
confident.

Context matters more than wording. Three versions were run on the same 328
cases:

| State | Action answer right | Lines meant for the current agent kept there |
|---|---:|---:|
| Utterance inside a generic `call_summary`, one-question framing | 0.62 | 0.56 |
| Named fields, the agent's last line only, plus `for_current_agent` | 0.79 | 0.78 |
| Named fields, last six turns, agent state, model and task | 0.89 | 0.89 |

In the first version Jev read ordinary work requests to an agent (an invented example: "add a chart to the settings page") as switchboard commands.

## Labelled case schema

The cases file is JSON Lines. It has one object per line:

```json
{
  "id": "case-001",
  "utterance": "synthetic example text",
  "context": {
    "talking_to": "operator",
    "agents": {"atlas": "live", "beacon": "waiting"},
    "last_turns": [{"speaker": "caller", "text": "synthetic prior turn"}]
  },
  "expected": {
    "action": "go_to_project",
    "target": "atlas",
    "continue_or_fresh": "continue",
    "multi_target": false
  },
  "synthetic": true
}
```

`id`, `utterance`, `context`, and `expected.action` are required. Include the
other expected fields when they apply. `action` must be one of the ten actions
listed above. `target` is a project id when a project is expected. Set
`synthetic` to `true` for test cases that are not real transcripts.

## Running the evaluation

Use a registry in the service format: either a project list or an object with a
`projects` list. The key is read only from
`~/.config/switchboard/secrets/typesafe-api-key`.

Check the request without using the key or the network:

```sh
node scripts/spikes/jev-routing-eval.mjs \
  --cases /path/to/cases.jsonl \
  --registry /path/to/projects.json \
  --out /tmp/jev-routing-results \
  --dry-run 1
```

Run the labelled evaluation:

```sh
node scripts/spikes/jev-routing-eval.mjs \
  --cases /path/to/cases.jsonl \
  --registry /path/to/projects.json \
  --out /tmp/jev-routing-results
```

`--out` must be outside the git work tree, or under a path that Git ignores.
The default concurrency is four requests, and each request has a bounded
15-second timeout. It spaces request starts at the documented 1,200 requests per minute limit. `--concurrency` and `--timeout-ms` can change those limits.
The output directory contains private per-case results and aggregate
`summary.json` and `summary.md` files. The command exits non-zero if required
inputs are missing, the key cannot be read, or the aggregate report is
incomplete.

## Real cases

The real cases come from past calls. The service does not save call
transcripts: `TranscriptLog` in `apps/backend/src/history.rs` is in memory only,
the journal records only character counts, and the operator runs with
`--no-session`. Project legs, however, run pi with `--session-id`, so a project
host keeps the leg's pi session file. The cases were taken from those files on
the project host, with the user's approval:

- Switchboard legs are the sessions whose id the service minted (not a pi UUID).
- Each caller line in a leg is a case where the caller was talking to that
  project agent. Its context is rebuilt from the session file as the service
  would know it at that moment: the last six turns (caller lines, agent
  replies and spoken lines), whether the agent was mid-turn, its model and
  thinking level, and the task it was given at transfer.
- The caller transcript that the older service forwarded at transfer time is a
  case where the caller was talking to the operator.
- Service-written messages (greetings, model-change notices, operator intent
  summaries) are not caller speech and are left out.
- Lines that contain a slur are removed before labelling or any request to Jev.

The tool calls the old agents made after a line (`return_to_operator`,
`transfer_to_project`, `set_model`) are hints for labelling. The action meanings in `buildRouterQuestions` are the labelling rules.

These cases do not cover what callers say to the operator after the first
transfer, or projects on hosts other than the one they were taken from.

## Privacy

The key is never printed, logged, written to output, or put on a command line.
Error messages redact Authorization values. Real transcript files and per-case
results stay outside this repository. Do not commit them. Only aggregate
numbers may be copied into this document or another committed document.

The smoke check uses invented cases marked `synthetic: true`. It is not the
real evaluation.

## Decisions (reviewed with the user, 2026-09-27)

- **The call summary is as rich as the budget allows.** Jev gets everything
  that helps it decide: what the caller said before, what the agents said and
  are doing (state, model, task, a pending request to speak), what is on the
  caller's screen, and live desk sessions. Each part is a small named object.
  The summary must stay under Jev's limit of 32,000 tokens for the state plus
  the longest question; when it would not, the oldest conversation turns are
  dropped first. The budget is a setting. The evaluation state above is a
  subset of this: the old calls had one agent at a time and no saved screen
  state.
- **When Jev is unsure, the LLM decides** (the plan as written, "ask when
  unsure" below). The test set cannot show calls with several agents at once,
  so a policy that defaults to the current agent is not proven for them.
- **Starting thresholds** (settings, not constants): the line is for the
  current agent when `for_current_agent` is at least 0.7; the LLM decides when
  it is between 0.3 and 0.7; otherwise Jev's action is used when its
  confidence is at least 0.6, and the LLM decides below that. Stopping an agent
  always asks the caller first, whatever the confidence.
- Revisit the thresholds with real calls once several agents can run at once.
- A `take_over` decision is offered only for a live top-level desk session whose
  exact folder is registered. The PBX rechecks the host before attaching and
  refuses when a service-created agent already owns that project; attachment
  records `taken_over` provenance and the session is detached, never killed,
  when the caller leaves.

## Results

Run on 2026-09-27 with `jev-latest`, on the real cases described above, with
the full evaluation state (last six turns, agent state, model and task).

### The cases

- 346 caller lines from 58 switchboard legs on scriptorium (switchboard,
  grape-segmentation, youtube-downloader). 5 lines were removed by the slur
  filter first.
- A model pre-labelled every line; the coordinator checked every line that was
  not `continue` and a sample of the rest, and corrected 2 labels.
- 18 lines are held out: 13 answer an operator question that was never saved
  (for example a bare model name), and 5 have no single right route. Jev
  cannot be judged on them.
- The main set is 328 lines: continue 279, go_to_project 26, unclear 12,
  status 7, general 2, set_model 1, stop 1. There are no answer_waiting,
  set_thinking, or take_over cases; the old system had none of those moments.

### Speed and cost

- p50 latency 109 ms, p95 159 ms (one request per line, five questions).
- About 2,200 input tokens per line; a full run of 328 lines costs about
  US$0.03.
- No errors or timeouts.

### Accuracy of the answers

- The action answer alone: 0.887 overall. continue 0.889 (248/279),
  go_to_project 0.923 (24/26), unclear 12/12, status 3/7, general 2/2,
  set_model 1/1, stop 1/1.
- Target project: 26/26 when the caller asked for a project.
- Calibration holds: answers at action confidence 0.7 or more are right 98% of
  the time (259 of 328 lines), and at 0.9 or more, 100% (175 lines).

### What the router would do

Both policies treat "go to the project I am already on" as continue. "Wrongly
moved away" means a line meant for the current agent was sent elsewhere.
"Left with agent" means a request to the switchboard (status, stop, noise) was
passed to the current agent instead.

| Policy | Thresholds | Decided by Jev | Right when decided | Sent to the LLM | Wrongly moved away | Left with agent |
|---|---|---:|---:|---:|---:|---:|
| **Ask when unsure (chosen)** | yes/no band 0.3–0.7, act at 0.6 | 77% | 98.8% | 77 of 328 | 1 | 1 |
| Ask when unsure | band 0.4–0.6, act at 0.6 | 88% | 97.6% | 38 | 3 | 3 |
| Ask when unsure | band 0.3–0.7, act at 0.8 | 75% | 99.6% | 81 | 0 | 1 |
| Stay unless sure | stay at 0.3, override at 0.8, act at 0.6 | 98% | 95.3% | 6 | 3 | 11 |
| Stay unless sure | stay at 0.4, override at 0.8, act at 0.6 | 98% | 95.6% | 8 | 4 | 9 |

"Stay unless sure": on a project agent, keep the line with that agent when
`for_current_agent` is at least the stay threshold, unless the action answer is
something else with confidence at least the override threshold.

With the chosen policy about one line in four goes to the LLM, which adds the
LLM's delay to that turn. A richer production summary should lower that share;
measure it on real calls.

### Limits

- Rare actions have one to seven cases each; their numbers are not reliable.
- All lines come from one host and one caller, mostly on the switchboard
  project, with one agent at a time.
- What a caller says to the operator between transfers was never saved, so
  operator-side routing is covered only by the lines forwarded at transfer
  time, with no context.
- Jev's answers vary a little between runs (0.774 and 0.787 on two runs of the
  same short-state design).

### Synthetic smoke check

Before the real cases, a live smoke check ran eight invented cases through the
first design: 8/8 actions, 3/3 targets, p50 133 ms, p95 179 ms. It showed only
that the request shape works.
