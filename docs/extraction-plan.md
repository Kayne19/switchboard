# Moving the switchboard into its own repository

Status: proposal, not started. Written so a future session can pick it up
without re-deriving the shape of it.

## Why

`ansible/roles/damocles/files/switchboard/` is ~2,800 lines of Python across six
modules with its own pytest suite. `files/` is where a role keeps static
artefacts it copies verbatim; an application with a test suite has outgrown
that. It wants a repo of its own on scriptorium (alongside the other projects
the switchboard already dials), so the agent that has code tooling can work on
it, and so its tests run on its own commits rather than incidentally inside
infrastructure review.

## What must not be lost

The current arrangement has one genuinely good property: **nothing reaches
damocles without a homelab PR**. Editing the app and deploying it are the same
reviewed action. Any split has to preserve a checkpoint in this repo, which is
why the recommendation below is a *pinned tag*, never a floating branch.

## The split

**Moves out** (to `switchboard`, a new repo, working copy on scriptorium at
`/home/kayne19/projects/switchboard`):

- `backend/`, `static/`, `tests/`, `requirements.txt`, and the app half of the
  role README.
- The two pi extension sources, `templates/pi-extensions/*.ts.j2` — but see
  *The persona problem* below, they cannot move as Jinja templates.

**Stays here** (this is deployment, not application):

- `ansible/roles/damocles/` itself: tasks, handlers, systemd unit,
  `switchboard.env.j2`, `operator.system.md.j2`, `projects.json.j2`,
  `ssh_config.j2`, and every variable in `defaults/main.yml`.
- The project registry (`switchboard_projects`) and the ssh host list. Adding a
  project is a lab fact, not an application change.
- Secrets. The ElevenLabs key keeps arriving from `secrets/switchboard.env`.

The contract between the two halves is the environment file: the app reads
`SWITCHBOARD_*` and the role writes them. That contract is the thing that will
drift, so it gets a section in the new repo's README listing every variable the
app reads, and a PR to either side that changes it says so.

## How the deploy works after the split

Add one variable to `ansible/roles/damocles/defaults/main.yml`:

```yaml
# The switchboard release deployed to damocles. Bump this (and nothing else) to
# ship a new version; the tag is cut in the switchboard repo after its own CI
# passes.
switchboard_version: "v1.4.0"
```

Replace the `Deploy the switchboard application` copy task with a checkout of
that tag into `{{ switchboard_app_dir }}`:

```yaml
- name: Deploy the switchboard application
  ansible.builtin.git:
    repo: "{{ switchboard_repo }}"
    dest: "{{ switchboard_app_dir }}/src"
    version: "{{ switchboard_version }}"
    depth: 1
  become: true
  become_user: "{{ damocles_user }}"
  notify: Restart switchboard
```

Notes on that:

- `version:` must be a tag or a full SHA. Never `master` — a branch turns every
  push in the code repo into an unreviewed production deploy, which is the one
  outcome this whole design exists to prevent.
- damocles needs outbound access to wherever the repo is hosted, plus a
  read key if it is private. If that is unwelcome, the alternative is a
  release tarball fetched with `ansible.builtin.get_url` and a checksum — same
  pinning property, no git on the box, but somewhere has to publish the
  artefact.
- Keep the venv step pointed at `{{ switchboard_app_dir }}/src/requirements.txt`
  and the unit's `WorkingDirectory`/module path at `src` so a rollback is just
  putting the old tag back.

The routine becomes: scriptorium agent writes the code and cuts a tag → you ask
here for a bump → one-line change, `tofu`-free PR, review loop, merge, deploy.
About a minute, same as everything else. An agent in this repo can read the
code repo's tags and tell you what changed between the deployed tag and the
tip; it still cannot deploy it without the PR.

## The persona problem

`switchboard_persona` in `defaults/main.yml` is one definition used in two
places that must not drift: the operator's system prompt and the `speak` tool
description handed to project agents. The second of those lives inside
`agent-switchboard.ts.j2`, which is why that file is a template.

Once the extension source lives in the code repo it can no longer be rendered
by Ansible. Two options:

1. **Read it at runtime.** The extension takes the persona from an environment
   variable the switchboard already passes to the agent process
   (`SWITCHBOARD_PERSONA`), the way it takes `SWITCHBOARD_SPEAK_URL` today.
   Persona stays a lab variable, the extension stays plain TypeScript. This is
   the recommended one; it is a small change to `pbx._start_agent` and to the
   tool description string.
2. Leave both extensions behind in this repo as templates. Works, but splits
   the app across two repos along a seam that will confuse everyone, since
   `pbx.py` and the extension are two halves of one protocol.

Do option 1, and do it *before* the move, as its own PR — it is testable here
and it makes the move itself a pure relocation.

## Order of work

1. Persona to an environment variable (this repo, own PR).
2. Create the new repo from the current `files/switchboard/` tree, history
   optional; add CI running the existing pytest suite plus a lint. Tag `v1.0.0`
   at exactly what is deployed today, so step 4 is a no-op deploy.
3. Bring the pi extension sources over; the switchboard already stages them onto
   project hosts at connect time, so they only need to be on damocles.
4. This repo: add `switchboard_repo` / `switchboard_version`, swap the copy task
   for the checkout, delete `files/switchboard/`, point the venv and the unit at
   `src/`. Verify with `--check --diff` first; the first real run replaces a
   directory tree with a checkout, which is the riskiest single step here.
5. Add `switchboard` to `switchboard_projects` so you can call the project that
   runs the call you are on. Worth the joke, and genuinely useful.

## Risks

- **Two-repo drift on the env contract.** Mitigated by documenting the variables
  in the app repo and treating them as its public interface.
- **Review coverage thins.** Application changes stop passing under
  `secrets-sentinel` and the rest. The tag bump is still reviewed, but nobody
  reads the diff it pulls in unless asked to. If that matters, have the bump PR
  body carry the changelog between the two tags.
- **A bad tag is now a two-step rollback**: put the old tag back here, PR, merge.
  Slower than reverting a file. Acceptable, but know it before an outage.
- **The service restart drops a live call.** Already true today.
