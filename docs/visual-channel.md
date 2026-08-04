# What else the visual channel should carry

Proposals, not decisions. `docs/diagram-tool.md` describes what is built; this
describes what has been considered and why, so the next person picking it up
argues with a position instead of starting from a blank page. Nothing here is
committed to, and the ranking is a recommendation.

## The principle worth keeping

The screen exists to answer the questions voice is bad at. That is already the
reason the activity strip exists — four minutes of real work and a leg that died
sound identical, so the page shows tools firing and an elapsed clock while the
caller listens to nothing.

Every proposal below earns its place the same way: it answers a question that is
expensive to ask or answer out loud. A visual that merely repeats what the agent
just said is not worth the transport.

The corollary is that these should compose with speech rather than compete with
it. "I'm on step three of five" is a good spoken sentence *because* the screen is
holding the other four.

## Free today: Mermaid forms the agent probably is not using

`diagram` already accepts arbitrary Mermaid, but an agent defaults to
`flowchart TD` unless its tool description suggests otherwise. Several forms map
directly onto what a call involves:

| form | what it is for |
|---|---|
| `sequenceDiagram` | caller → operator → project agent → back; the best fit there is, and the thing voice explains worst |
| `stateDiagram-v2` | the leg state itself: transfer, return, hangup, idle timeout |
| `gitGraph` | branch and commit topology, miserable to describe aloud |
| `timeline` / `gantt` | the order work will happen in |
| `erDiagram` | schema questions |
| `mindmap` | "what are the options", a common operator-level question |

The cost is a sentence in the extension's tool description telling the agent to
pick the form that fits. No infrastructure, no new payload, no server change.
On effort ratio alone this comes first.

## New payload types

Each of these follows the existing shape — the agent POSTs, the service
broadcasts on the socket the browser already holds — so none of them needs a new
module or a new transport. That is the same argument `diagram` made for being
shaped like `speak`, and it still holds.

Ranked by what is worth building, not by difficulty:

### 1. Live plan or checklist

The agent pushes a list of steps with states and updates it in place as it goes.

This attacks the black-box problem directly. The activity strip says *a tool
fired*; a plan says *where we are in the work*, which is what a caller actually
wants when they cannot read scrollback. It is a JSON list and some CSS — no
library, no new transport, and it composes with speech better than anything else
here.

### 2. Diff view

These are coding agents; what they produce is diffs, and a diff read aloud is
close to useless. It is also the thing a caller most wants to approve or reject.

A unified diff renderer is a couple of hundred lines written by hand, which
matters: `static/index.html` is deliberately one hand-written file with no
toolchain, and the diagram tool already refused to add one. This is the natural
place to grow a voice approve/reject affordance later, if gating changes by voice
ever becomes interesting.

### 3. Diagram history strip

Already scoped in `docs/diagram-tool.md`: *"if flipping back through diagrams
turns out to matter, the payloads are small and keeping the last N is a list and
two buttons."* The service already holds `last_diagram` and replays it to a
browser that connects or reconnects; making that the last N is a small change on
both sides. Cheapest real win on this page.

### 4. Images

Mechanically easy — mp3 bytes already travel over this socket, so a PNG is the
same shape.

Worth more thought than its difficulty suggests, because it is the first payload
where the agent controls arbitrary rendered content. The diagram tool's trust
argument is that the source comes from our own agent over our own socket; that
argument weakens when the agent has been reading a repository whose contents it
did not write. Wants a size cap and a deliberate decision rather than being
fallen into.

### 5. Call-path timeline

Hops between legs over the life of the call, with durations. Answers "how did I
get to this leg", which is otherwise reconstructed from memory. Cheap, and it
makes the routing legible when debugging a bad transfer.

## What to skip

**A general HTML payload.** It collapses every proposal above into one feature
and destroys the property that makes them safe: each type above renders from
structured data whose rendering we control. Once the agent ships markup, the page
that is also holding the call owns an XSS surface reachable by prompt injection.
The convenience is not worth it.

## Suggested first cut

The Mermaid tool-description change plus the plan/checklist. That pair is the
cheapest available and changes what a call *feels* like more than anything else
on this page — one costs a sentence, the other costs a list and some CSS.
