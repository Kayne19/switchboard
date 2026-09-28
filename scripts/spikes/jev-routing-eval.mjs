#!/usr/bin/env node
/**
 * Jev routing evaluation spike.
 *
 * Labelled case schema (one JSON object per line):
 * {
 *   "id": "case-001",
 *   "utterance": "the speech-to-text utterance",
 *   "context": {
 *     "talking_to": "operator" | "<project id>",
 *     "agents": {"<project id>": {"state": "busy|idle|finished|waiting", "model": "provider/model",
 *                                 "thinking": "high", "task": "what the agent was asked to do"}},
 *     "last_turns": [{"speaker": "caller|operator|<project id>", "text": "..."}]
 *   },
 *   "expected": {
 *     "action": "continue|go_to_project|answer_waiting|stop|set_model|set_thinking|status|general|unclear|take_over",
 *     "target": "<project id>",
 *     "continue_or_fresh": "continue|fresh",
 *     "multi_target": true
 *   },
 *   "synthetic": false
 * }
 *
 * Only id, utterance, context, and expected.action are required. The other
 * expected fields are required when the question applies to the case.
 * The context is what the switchboard knows at that moment: the agents with
 * their state, model and task, and the recent conversation, oldest first. An
 * agent may also be given as a bare state string. It must not contain a key.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, relative, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const KEY_PATH = join(homedir(), ".config", "switchboard", "secrets", "typesafe-api-key");
const ACTIONS = [
  "continue", "go_to_project", "answer_waiting", "stop", "set_model",
  "set_thinking", "status", "general", "unclear", "take_over",
];
const MAX_CONCURRENCY = 32;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
const BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

function fail(message) {
  console.error(`jev-routing-eval: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    if (arg === "--dry-run") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { values.set("dry-run", Number(next)); i += 1; }
      else values.set("dry-run", 1);
      continue;
    }
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values.set(name, value); i += 1;
  }
  return values;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`missing required flag --${name}`);
  return value;
}

function numberFlag(args, name, defaultValue, { integer = false, min = 0 } = {}) {
  const raw = args.get(name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min) {
    throw new Error(`--${name} must be a number${integer ? " (integer)" : ""} >= ${min}`);
  }
  return value;
}

function parseJson(raw, source) {
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`${source} is not valid JSON: ${error.message}`); }
}

function parseRegistry(value, source) {
  const projects = Array.isArray(value) ? value : value?.projects;
  if (!Array.isArray(projects)) throw new Error(`${source} must be a list or an object with a projects list`);
  const result = [];
  const seen = new Set();
  for (const project of projects) {
    if (!project || typeof project !== "object" || typeof project.id !== "string" || !project.id.trim()) {
      throw new Error(`${source} contains a project without a non-empty id`);
    }
    const id = project.id.trim();
    if (seen.has(id)) throw new Error(`${source} contains duplicate project id ${id}`);
    seen.add(id);
    result.push({
      id,
      description: typeof project.description === "string" ? project.description : "",
      aliases: Array.isArray(project.aliases) ? project.aliases.filter((x) => typeof x === "string") : [],
    });
  }
  return result;
}

function parseCases(raw, source) {
  const cases = [];
  for (const [lineNumber, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const value = parseJson(line, `${source} line ${lineNumber + 1}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} line ${lineNumber + 1} must be an object`);
    if (typeof value.id !== "string" || !value.id.trim()) throw new Error(`${source} line ${lineNumber + 1} has no id`);
    if (typeof value.utterance !== "string") throw new Error(`${source} line ${lineNumber + 1} has no utterance string`);
    if (!value.context || typeof value.context !== "object" || Array.isArray(value.context)) throw new Error(`${source} line ${lineNumber + 1} has no context object`);
    if (!value.expected || typeof value.expected !== "object" || Array.isArray(value.expected)) throw new Error(`${source} line ${lineNumber + 1} has no expected object`);
    const expected = value.expected;
    if (!ACTIONS.includes(expected.action)) throw new Error(`${source} line ${lineNumber + 1} has invalid expected.action`);
    if (expected.target !== undefined && typeof expected.target !== "string") throw new Error(`${source} line ${lineNumber + 1} expected.target must be a string`);
    if (expected.continue_or_fresh !== undefined && !["continue", "fresh"].includes(expected.continue_or_fresh)) throw new Error(`${source} line ${lineNumber + 1} expected.continue_or_fresh must be continue or fresh`);
    if (expected.multi_target !== undefined && typeof expected.multi_target !== "boolean") throw new Error(`${source} line ${lineNumber + 1} expected.multi_target must be boolean`);
    cases.push(value);
  }
  if (cases.length === 0) throw new Error(`${source} contains no cases`);
  return cases;
}

/**
 * The Jev state: what the switchboard knows at the moment the caller speaks.
 * Who the caller is talking to comes first and the utterance is named for what
 * it is. With the utterance buried in a generic call summary, Jev read ordinary
 * work requests to an agent as switchboard commands.
 */
function callState(projects, testCase) {
  const context = testCase.context;
  const state = {
    caller_is_talking_to: context.talking_to === "operator" ? "the operator (no project agent)" : context.talking_to,
    agents: context.agents ?? {},
    ...(context.last_turns?.length ? { recent_conversation: context.last_turns } : {}),
    caller_just_said: testCase.utterance,
    registered_projects: projects.map(({ id, description, aliases }) => ({ id, description, aliases })),
  };
  return state;
}

/** The router question set. Keep this function aligned with the future router. */
function buildRouterQuestions(projects) {
  // These meanings are also the labelling rules for real cases. Change both together.
  const actionCriteria = {
    continue: "The caller is talking to a project agent, and the utterance is meant for that same agent: work, questions about its work, answers, feedback, or small talk.",
    go_to_project: "The caller wants a project agent other than the one they are talking to (or any project agent, when they are talking to the operator). Use target and continue_or_fresh.",
    answer_waiting: "The caller answers, accepts, or lets through a project agent that is waiting to speak.",
    stop: "The caller wants a project agent to stop its work or end its session. This is not hanging up the call.",
    set_model: "The caller wants the current project agent to use a different model.",
    set_thinking: "The caller wants the current project agent to use a different thinking level.",
    status: "The caller asks the switchboard which agents are running, busy, finished, or waiting, or asks about the call itself. A question to an agent about its own work is continue.",
    general: "The utterance is for the operator, not a project agent: the caller leaves the current agent (for example 'take me back' or 'I'm done here'), or asks or says something general while talking to the operator.",
    unclear: "It is not safe to tell what the caller wants: noise, a fragment, or garbled speech-to-text.",
    take_over: "The caller wants to join a project session that is already running at the desk.",
  };
  const targetCriteria = Object.fromEntries(projects.map(({ id, description, aliases }) => [
    id, `${description || "Registered project"}${aliases.length ? `; aliases: ${aliases.join(", ")}` : ""}`,
  ]));
  targetCriteria.none = "No project target is requested or the utterance is not a project transfer.";
  return {
    action: {
      type: "choice",
      instructions: "The caller is on a voice call and is speaking to `caller_is_talking_to`. Most of what a caller says is simply part of that conversation. Which one action fits what the caller just said (`caller_just_said`)?",
      criteria: actionCriteria,
    },
    for_current_agent: {
      type: "noul",
      instructions: "Is `caller_just_said` meant for the project agent the caller is talking to now: work, questions, answers, feedback, or small talk for that agent? Answer no if the caller wants to leave that agent, go to another project, or control the call or the agents (stop, change model, ask which agents are running).",
      criteria: {
        true: "Meant for the current project agent.",
        false: "Meant for the switchboard or operator, or not usable.",
      },
    },
    target: {
      type: "choice",
      instructions: "Which registered project is the target of what the caller just said? Choose none when no project is targeted.",
      criteria: targetCriteria,
    },
    continue_or_fresh: {
      type: "choice",
      instructions: "If what the caller just said sends them to a project, should it continue the existing conversation or start a fresh conversation? Choose not_applicable when no project transfer or takeover is requested.",
      criteria: {
        continue: "Keep the existing project conversation and context.",
        fresh: "Start a new project conversation without the old context.",
        not_applicable: "No project conversation choice applies.",
      },
    },
    multi_target: {
      type: "noul",
      instructions: "Does `caller_just_said` address more than one project or agent at the same time?",
      criteria: {
        true: "The caller clearly addresses multiple targets and the request should be split.",
        false: "The caller addresses one target or no project agent.",
      },
    },
  };
}

function buildRequest(projects, testCase) {
  return {
    model: MODEL,
    state: callState(projects, testCase),
    questions: buildRouterQuestions(projects),
  };
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*["']?)[^,\s}"']+/gi, "$1[REDACTED]");
}

async function readKey() {
  let raw;
  try { raw = await readFile(KEY_PATH, "utf8"); }
  catch (error) { throw new Error(`cannot read Jev key at ${KEY_PATH}: ${error.message}`); }
  const key = raw.trim();
  if (!key) throw new Error(`Jev key at ${KEY_PATH} is empty`);
  return key;
}

function safeOutputDirectory(outPath) {
  const absolute = resolve(outPath);
  // Check against this script's own work tree, not the caller's current directory.
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const rootResult = spawnSync("git", ["-C", scriptDirectory, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (rootResult.status !== 0) throw new Error("cannot determine the git work tree for --out safety check");
  const root = resolve(rootResult.stdout.trim());
  const rel = relative(root, absolute);
  const inside = rel === "" || (!rel.startsWith("../") && rel !== ".." && !/^[A-Za-z]:/.test(rel));
  if (!inside) return absolute;
  const ignored = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", absolute], { stdio: "ignore" });
  if (ignored.status !== 0) throw new Error(`--out ${absolute} is inside the git work tree and is not ignored`);
  return absolute;
}

function createRateGate(requestsPerSecond) {
  const intervalMs = 1000 / requestsPerSecond;
  let nextStart = 0;
  return {
    async wait() {
      const now = performance.now();
      const start = Math.max(now, nextStart);
      nextStart = start + intervalMs;
      const delay = start - now;
      if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    },
  };
}

async function fetchJev(request, key, timeoutMs, rateGate) {
  await rateGate.wait();

  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const latencyMs = performance.now() - started;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${redact(bodyText).slice(0, 1000)}`);
    let body;
    try { body = JSON.parse(bodyText); }
    catch (error) { throw new Error(`response was not JSON: ${error.message}`); }
    return { body, latencyMs };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`request timed out after ${timeoutMs} ms`);
    throw new Error(redact(error.message));
  } finally { clearTimeout(timeout); }
}

function validateAnswers(body) {
  if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") throw new Error("response has no answers map");
  for (const id of ["action", "for_current_agent", "target", "continue_or_fresh", "multi_target"]) {
    if (!body.answers[id] || typeof body.answers[id] !== "object") throw new Error(`response is missing answer ${id}`);
  }
  const action = body.answers.action;
  const target = body.answers.target;
  const fresh = body.answers.continue_or_fresh;
  const multi = body.answers.multi_target;
  if (!ACTIONS.includes(action.choice)) throw new Error("action answer has an unknown choice");
  if (typeof action.confidence !== "number" || !action.probabilities || typeof action.probabilities !== "object") throw new Error("action answer has no confidence/probabilities");
  if (typeof target.choice !== "string" || typeof target.confidence !== "number" || !target.probabilities) throw new Error("target answer has no confidence/probabilities");
  if (typeof fresh.choice !== "string" || typeof fresh.confidence !== "number" || !fresh.probabilities) throw new Error("continue_or_fresh answer has no confidence/probabilities");
  if (typeof multi.noul !== "number") throw new Error("multi_target answer has no noul probability");
  if (typeof body.answers.for_current_agent.noul !== "number") throw new Error("for_current_agent answer has no noul probability");
}

/**
 * Two ways the router could turn Jev's answers into a decision. Both treat
 * go_to_project aimed at the agent the caller is already on as continue.
 * - ask_when_unsure (the plan as written): act only when Jev is sure;
 *   otherwise the LLM gives a second opinion.
 * - stay_unless_sure: on a project agent, keep the utterance with that agent
 *   unless Jev is sure it is something else; the LLM sees the rest.
 * A null decision means "ask the LLM".
 */
const POLICIES = [
  { policy: "ask_when_unsure", lower: 0.3, upper: 0.7, act: 0.6 },
  { policy: "ask_when_unsure", lower: 0.4, upper: 0.6, act: 0.6 },
  { policy: "ask_when_unsure", lower: 0.3, upper: 0.7, act: 0.8 },
  { policy: "stay_unless_sure", stay: 0.3, override: 0.8, act: 0.6 },
  { policy: "stay_unless_sure", stay: 0.4, override: 0.8, act: 0.6 },
  { policy: "stay_unless_sure", stay: 0.2, override: 0.8, act: 0.6 },
];

function decide(testCase, answers, settings) {
  const onAgent = testCase.context.talking_to !== "operator";
  const forAgent = answers.for_current_agent.noul;
  let action = answers.action.choice;
  if (action === "go_to_project" && answers.target.choice === testCase.context.talking_to) action = "continue";
  const sure = answers.action.confidence >= settings.act;
  if (settings.policy === "ask_when_unsure") {
    if (onAgent && forAgent >= settings.upper) return "continue";
    if (onAgent && forAgent > settings.lower) return null;
    return sure ? action : null;
  }
  const clearlyElse = action !== "continue" && answers.action.confidence >= settings.override;
  if (onAgent && forAgent >= settings.stay && !clearlyElse) return "continue";
  return sure ? action : null;
}

function policyRows(valid) {
  return POLICIES.map((settings) => {
    let decided = 0, correct = 0, asked = 0, movedAway = 0, leftWithAgent = 0;
    for (const result of valid) {
      const expected = result.case.expected.action;
      const decision = decide(result.case, result.response.answers, settings);
      if (decision === null) { asked += 1; continue; }
      decided += 1;
      if (decision === expected) correct += 1;
      else if (expected === "continue") movedAway += 1;
      else if (decision === "continue") leftWithAgent += 1;
    }
    const { policy, ...thresholds } = settings;
    return {
      policy, thresholds, decided, asked_llm: asked,
      decided_share: valid.length ? decided / valid.length : null,
      accuracy_when_decided: decided ? correct / decided : null,
      wrongly_moved_away: movedAway, command_left_with_agent: leftWithAgent,
      other_errors: decided - correct - movedAway - leftWithAgent,
    };
  });
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[index];
}

function emptyCounter(keys) { return Object.fromEntries(keys.map((key) => [key, 0])); }

function calculateReport(cases, results) {
  const valid = results.filter((result) => result.response && !result.error);
  const actionCounts = emptyCounter(ACTIONS);
  const actionCorrect = emptyCounter(ACTIONS);
  const confusion = Object.fromEntries(ACTIONS.map((action) => [action, emptyCounter(ACTIONS)]));
  const confidenceRows = [];
  let targetTotal = 0, targetCorrect = 0;
  for (const result of valid) {
    const expected = result.case.expected;
    const answers = result.response.answers;
    const predicted = answers.action.choice;
    if (ACTIONS.includes(expected.action)) {
      actionCounts[expected.action] += 1;
      if (predicted === expected.action) actionCorrect[expected.action] += 1;
      if (confusion[expected.action]?.[predicted] !== undefined) confusion[expected.action][predicted] += 1;
      confidenceRows.push({ predicted, confidence: answers.action.confidence, correct: predicted === expected.action });
    }
    if (expected.target !== undefined) {
      targetTotal += 1;
      if (answers.target.choice === expected.target) targetCorrect += 1;
    }
  }
  const perAction = Object.fromEntries(ACTIONS.map((action) => [action, {
    total: actionCounts[action], correct: actionCorrect[action],
    accuracy: actionCounts[action] ? actionCorrect[action] / actionCounts[action] : null,
  }]));
  const calibration = BUCKETS.map((upper, index) => {
    const lower = index === 0 ? 0 : BUCKETS[index - 1];
    const rows = confidenceRows.filter(({ confidence }) => confidence >= lower && (index === BUCKETS.length - 1 ? confidence <= upper : confidence < upper));
    return { range: `${lower.toFixed(2)}-${upper.toFixed(2)}`, count: rows.length, accuracy: rows.length ? rows.filter((row) => row.correct).length / rows.length : null };
  });
  const coverage = THRESHOLDS.map((threshold) => {
    const accepted = confidenceRows.filter(({ confidence }) => confidence >= threshold);
    return { threshold, accepted: accepted.length, coverage: confidenceRows.length ? accepted.length / confidenceRows.length : null, accuracy: accepted.length ? accepted.filter((row) => row.correct).length / accepted.length : null };
  });
  // Jev's docs gate risky actions (stop) higher than safe ones, so thresholds are also shown per predicted action.
  const coverageByPredictedAction = Object.fromEntries(ACTIONS.map((action) => {
    const rows = confidenceRows.filter((row) => row.predicted === action);
    return [action, THRESHOLDS.map((threshold) => {
      const accepted = rows.filter(({ confidence }) => confidence >= threshold);
      return { threshold, accepted: accepted.length, of: rows.length, accuracy: accepted.length ? accepted.filter((row) => row.correct).length / accepted.length : null };
    })];
  }));
  const act = coverage.find((row) => row.accuracy !== null && row.accuracy >= 0.95);
  const second = coverage.find((row) => row.accuracy !== null && row.accuracy >= 0.80);
  const errors = results.filter((result) => result.error).length;
  const latencies = valid.map((result) => result.latency_ms).filter(Number.isFinite);
  return {
    case_count: cases.length, successful_cases: valid.length, error_count: errors,
    top1_accuracy: { overall: confidenceRows.length ? confidenceRows.filter((row) => row.correct).length / confidenceRows.length : null, per_action: perAction, target: { total: targetTotal, correct: targetCorrect, accuracy: targetTotal ? targetCorrect / targetTotal : null } },
    confusion,
    confidence_calibration: { buckets: calibration, threshold_coverage: coverage, threshold_coverage_by_predicted_action: coverageByPredictedAction },
    proposed_thresholds: {
      act: act ? act.threshold : null,
      second_opinion: second ? second.threshold : null,
      caller: second ? `< ${second.threshold}` : null,
      tradeoff: "Higher thresholds reduce automatic misroutes but send more utterances to a second opinion or the caller. These are proposals until real transcripts are evaluated.",
    },
    decision_policies: policyRows(valid),
    latency_ms: { p50: percentile(latencies, 0.50), p95: percentile(latencies, 0.95), count: latencies.length },
    usage: {
      input_tokens: results.reduce((sum, result) => sum + (Number(result.response?.usage?.input_tokens) || 0), 0),
      output_tokens: results.reduce((sum, result) => sum + (Number(result.response?.usage?.output_tokens) || 0), 0),
    },
  };
}

function markdownReport(summary) {
  const lines = ["# Jev routing evaluation", "", "Aggregate results only. Per-case transcript text is stored only in the selected output directory.", "", `- Cases: ${summary.case_count}`, `- Successful cases: ${summary.successful_cases}`, `- Errors: ${summary.error_count}`, `- Overall action top-1 accuracy: ${formatNumber(summary.top1_accuracy.overall)}`, `- Target top-1 accuracy: ${formatNumber(summary.top1_accuracy.target.accuracy)} (${summary.top1_accuracy.target.correct}/${summary.top1_accuracy.target.total})`, `- p50 latency (ms): ${formatNumber(summary.latency_ms.p50)}`, `- p95 latency (ms): ${formatNumber(summary.latency_ms.p95)}`, "", "## Action accuracy", "", "| Action | Correct | Cases | Accuracy |", "|---|---:|---:|---:|"];
  for (const [action, row] of Object.entries(summary.top1_accuracy.per_action)) lines.push(`| ${action} | ${row.correct} | ${row.total} | ${formatNumber(row.accuracy)} |`);
  lines.push("", "## Action confusion", "", `| Expected / predicted | ${Object.keys(summary.confusion).join(" | ")} |`, `|---|${Object.keys(summary.confusion).map(() => "---:").join("|")}|`);
  for (const [expected, row] of Object.entries(summary.confusion)) lines.push(`| ${expected} | ${Object.values(row).join(" | ")} |`);
  lines.push("", "## Confidence calibration", "", "| Bucket | Cases | Accuracy |", "|---|---:|---:|");
  for (const row of summary.confidence_calibration.buckets) lines.push(`| ${row.range} | ${row.count} | ${formatNumber(row.accuracy)} |`);
  lines.push("", "## Threshold coverage", "", "| Candidate threshold | Accepted | Coverage | Accuracy |", "|---:|---:|---:|---:|");
  for (const row of summary.confidence_calibration.threshold_coverage) lines.push(`| ${row.threshold.toFixed(2)} | ${row.accepted} | ${formatNumber(row.coverage)} | ${formatNumber(row.accuracy)} |`);
  lines.push("", "## Threshold coverage by predicted action", "", "Accuracy of accepted answers (accepted/predicted) at each candidate threshold.", "", `| Predicted | ${THRESHOLDS.map((t) => t.toFixed(2)).join(" | ")} |`, `|---|${THRESHOLDS.map(() => "---:").join("|")}|`);
  for (const [action, rows] of Object.entries(summary.confidence_calibration.threshold_coverage_by_predicted_action)) {
    if (!rows[0].of) continue;
    lines.push(`| ${action} | ${rows.map((row) => `${formatNumber(row.accuracy)} (${row.accepted}/${row.of})`).join(" | ")} |`);
  }
  lines.push("", "## Decision policies", "", "The action answer alone (above) is not what the router would do. These rows apply each policy to the same answers. Asked LLM = the utterance would go to the LLM for a second opinion.", "", "| Policy | Thresholds | Decided by Jev | Accuracy when decided | Asked LLM | Wrongly moved away | Command left with agent | Other errors |", "|---|---|---:|---:|---:|---:|---:|---:|");
  for (const row of summary.decision_policies) lines.push(`| ${row.policy} | ${Object.entries(row.thresholds).map(([name, value]) => `${name} ${value}`).join(", ")} | ${formatNumber(row.decided_share)} (${row.decided}) | ${formatNumber(row.accuracy_when_decided)} | ${row.asked_llm} | ${row.wrongly_moved_away} | ${row.command_left_with_agent} | ${row.other_errors} |`);
  lines.push("", "## Proposed thresholds", "", `- Act automatically: ${summary.proposed_thresholds.act ?? "not enough evidence"}`, `- Ask the LLM for a second opinion: ${summary.proposed_thresholds.second_opinion ?? "not enough evidence"}`, `- Ask the caller: ${summary.proposed_thresholds.caller ?? "not enough evidence"}`, `- Trade-off: ${summary.proposed_thresholds.tradeoff}`, "");
  return lines.join("\n");
}

function formatNumber(value) { return value === null || value === undefined ? "n/a" : typeof value === "number" ? value.toFixed(3) : String(value); }

// Output files hold transcript text, so they are readable by the owner only.
async function atomicWrite(path, data) {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, data, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

async function runPool(items, concurrency, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = required(args, "cases");
  const registryPath = required(args, "registry");
  const outPath = safeOutputDirectory(required(args, "out"));
  const concurrency = Math.min(numberFlag(args, "concurrency", DEFAULT_CONCURRENCY, { integer: true, min: 1 }), MAX_CONCURRENCY);
  const timeoutMs = numberFlag(args, "timeout-ms", DEFAULT_TIMEOUT_MS, { integer: true, min: 1 });
  const cases = parseCases(await readFile(casesPath, "utf8"), casesPath);
  const projects = parseRegistry(parseJson(await readFile(registryPath, "utf8"), registryPath), registryPath);
  const dryRun = args.get("dry-run");
  if (dryRun !== undefined) {
    const count = Math.max(1, Math.min(cases.length, Number(dryRun)));
    if (!Number.isInteger(count)) throw new Error("--dry-run count must be an integer");
    for (let i = 0; i < count; i += 1) console.log(JSON.stringify(buildRequest(projects, cases[i]), null, 2));
    return;
  }
  const key = await readKey();
  await mkdir(outPath, { recursive: true, mode: 0o700 });
  // The documented limit is 1,200 requests/minute. Space starts at 20/sec.
  const rateGate = createRateGate(20);
  const results = await runPool(cases, concurrency, async (testCase) => {
    const request = buildRequest(projects, testCase);
    const base = { case: testCase, request };
    try {
      const { body, latencyMs } = await fetchJev(request, key, timeoutMs, rateGate);
      try { validateAnswers(body); }
      catch (error) { return { ...base, error: error.message, response: body, latency_ms: latencyMs }; }
      return { ...base, response: body, latency_ms: latencyMs };
    } catch (error) { return { ...base, error: redact(error.message) }; }
  });
  const summary = calculateReport(cases, results);
  await atomicWrite(join(outPath, "per-case-results.jsonl"), results.map((result) => JSON.stringify(result)).join("\n") + "\n");
  await atomicWrite(join(outPath, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await atomicWrite(join(outPath, "summary.md"), markdownReport(summary));
  console.log(markdownReport(summary));
  if (summary.successful_cases === 0 || summary.top1_accuracy.overall === null || summary.latency_ms.p50 === null || !summary.confidence_calibration.buckets || !summary.top1_accuracy.per_action) {
    throw new Error("report is incomplete: successful answers, per-action accuracy, calibration, and p50/p95 latency are required");
  }
}

try { await main(); }
catch (error) { fail(redact(error.message)); }
