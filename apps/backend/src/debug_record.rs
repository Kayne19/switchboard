//! How a published value becomes a bounded, scrubbed debug record.
use crate::debug::DebugEvent;
use crate::protocol::AgentState;
use serde_json::Value;

/// Bounds on one record, so a single event (a long prompt, a large tool
/// result) cannot grow the rings by more than a few kilobytes.
const MAX_FIELD_BYTES: usize = 4 * 1024;
pub(crate) const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_JSON_ITEMS: usize = 64;
/// Names and ids (an agent, a tool, a call id, a JSON key) are short in
/// practice, but they come from hosts and models, so they are cut too.
const MAX_NAME_BYTES: usize = 256;
/// How far past a cut `Clip` still scrubs (`scrub_window`).
const SCRUB_MARGIN: usize = 1024;
/// What a record costs in a ring beyond its text: seq, timestamp, kind,
/// numbers and the `Arc`.
pub(crate) const RECORD_OVERHEAD_BYTES: usize = 256;
const CLIP_MARKER: &str = "…[clipped]";

/// Makes one record safe for the debug page, before it takes the publish
/// lock. Each string, names and ids included, is first cut to what the
/// record can keep (plus `SCRUB_MARGIN`), then scrubbed (`scrub_text`), then
/// cut to its bound with a marker: 4 KiB for text, 256 bytes for a name, id
/// or JSON key, and about 16 KiB for the whole record. A JSON value under a
/// credential-like name (`secret_name`, `secret_value`) becomes
/// `[redacted]`. So the cost of a record does not grow with its input. This
/// is the only place debug records are scrubbed or clipped; producers
/// publish raw values.
pub(crate) struct Clip {
    remaining: usize,
    /// Bytes kept so far, cut markers included: the record's size estimate.
    used: usize,
    /// Whether the record lost anything to a cut or a scrub.
    clipped: bool,
}

/// The longest prefix of `text` of at most `bytes` bytes.
fn prefix(text: &str, bytes: usize) -> &str {
    if text.len() <= bytes {
        return text;
    }
    let mut cut = bytes;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    &text[..cut]
}

/// The part of a string `Clip` scrubs when it keeps at most `limit` bytes:
/// the kept part and `SCRUB_MARGIN` more, so a credential that runs across
/// the cut is still recognized up to it. The rest is dropped unread, so a
/// field's cost does not grow with its input.
fn scrub_window(text: &str, limit: usize) -> &str {
    prefix(text, limit.saturating_add(SCRUB_MARGIN))
}

/// What a record cost in a ring, and whether it lost anything.
#[derive(Clone, Copy)]
pub(crate) struct Bound {
    pub(crate) bytes: usize,
    pub(crate) clipped: bool,
}

impl Clip {
    pub(crate) fn bound_event(event: &mut DebugEvent) -> Bound {
        let mut clip = Self::new();
        clip.event(event);
        clip.bound()
    }

    pub(crate) fn bound_log(
        level: &mut String,
        target: &mut String,
        message: &mut String,
        fields: &mut Value,
    ) -> Bound {
        let mut clip = Self::new();
        clip.name(level);
        clip.name(target);
        clip.text(message);
        clip.json(fields);
        clip.bound()
    }

    pub(crate) fn bound_agents(agents: &mut [AgentState]) {
        Self::new().agents(agents);
    }

    fn bound(&self) -> Bound {
        Bound {
            bytes: self.bytes(),
            clipped: self.clipped,
        }
    }

    fn new() -> Self {
        Self {
            remaining: MAX_RECORD_BYTES,
            used: 0,
            clipped: false,
        }
    }

    /// The record's estimated size in a ring, for the byte budget.
    fn bytes(&self) -> usize {
        self.used + RECORD_OVERHEAD_BYTES
    }

    fn spend(&mut self, bytes: usize) {
        self.used += bytes;
        self.remaining = self.remaining.saturating_sub(bytes.max(1));
    }

    /// One JSON node kept in the record: a `Value` is this size in memory
    /// whatever its text, so an empty string or array is not free.
    fn node(&mut self) {
        self.spend(std::mem::size_of::<Value>());
    }

    /// Scrubs `text` and keeps at most `field_limit` bytes of it, and no
    /// more than the record has left. Only the window that can be kept is
    /// scrubbed.
    fn bounded(&mut self, text: &mut String, field_limit: usize) {
        let limit = field_limit.min(self.remaining);
        let window = scrub_window(text, limit);
        let cut_input = window.len() < text.len();
        let mut scrubbed = scrub_text(window);
        if cut_input || scrubbed.len() > limit {
            let kept = prefix(&scrubbed, limit).len();
            scrubbed.truncate(kept);
            scrubbed.push_str(CLIP_MARKER);
            self.clipped = true;
        }
        *text = scrubbed;
        self.spend(text.len());
    }

    fn text(&mut self, text: &mut String) {
        self.bounded(text, MAX_FIELD_BYTES);
    }

    /// A name or id: scrubbed like text, and cut much shorter.
    fn name(&mut self, name: &mut String) {
        self.bounded(name, MAX_NAME_BYTES);
    }

    fn marker(&mut self, dropped: usize) -> Value {
        let marker = format!("{CLIP_MARKER} {dropped} more");
        self.node();
        self.spend(marker.len());
        self.clipped = true;
        Value::String(marker)
    }

    fn json(&mut self, value: &mut Value) {
        self.node();
        match value {
            Value::String(text) => self.text(text),
            Value::Array(items) => {
                self.spend(2);
                let mut kept = 0;
                for item in items.iter_mut() {
                    if self.remaining == 0 || kept == MAX_JSON_ITEMS {
                        break;
                    }
                    self.json(item);
                    kept += 1;
                }
                if kept < items.len() {
                    // A new buffer: `truncate` would keep the input's whole
                    // allocation, which the byte estimate does not see.
                    let dropped = items.len() - kept;
                    let mut cut = Vec::with_capacity(kept + 1);
                    cut.extend(items.drain(..kept));
                    cut.push(self.marker(dropped));
                    *items = cut;
                }
            }
            Value::Object(map) => {
                self.spend(2);
                let entries = std::mem::take(map);
                let total = entries.len();
                let mut kept = 0;
                for (mut key, mut value) in entries {
                    if self.remaining == 0 || kept == MAX_JSON_ITEMS {
                        break;
                    }
                    // Judge the name by its start: a key can be any length.
                    let head = prefix(&key, MAX_NAME_BYTES);
                    if secret_name(head) && secret_value(head, &value) {
                        value = Value::String(REDACTED.to_owned());
                    }
                    self.name(&mut key);
                    self.json(&mut value);
                    map.insert(key, value);
                    kept += 1;
                }
                if kept < total {
                    let marker = self.marker(total - kept);
                    map.insert("…".to_owned(), marker);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => self.spend(8),
        }
    }

    fn opt_text(&mut self, text: &mut Option<String>) {
        if let Some(text) = text {
            self.text(text);
        }
    }

    fn opt_json(&mut self, value: &mut Option<Value>) {
        if let Some(value) = value {
            self.json(value);
        }
    }

    fn opt_name(&mut self, name: &mut Option<String>) {
        if let Some(name) = name {
            self.name(name);
        }
    }

    /// The agent projection, as an `agents_state` event and a snapshot both
    /// carry it.
    fn agents(&mut self, agents: &mut [AgentState]) {
        for agent in agents {
            self.name(&mut agent.project);
            self.name(&mut agent.state);
            if let Some(request) = &mut agent.pending_request {
                self.text(&mut request.message);
                self.text(&mut request.reason);
            }
        }
    }

    /// Scrubs and clips every string in `event`. Names and ids come from
    /// hosts and models too, so they are scrubbed like text (`name`). The
    /// match names every field, so a new field does not compile until it is
    /// handled here.
    fn event(&mut self, event: &mut DebugEvent) {
        match event {
            DebugEvent::CallerUtterance {
                utterance_id,
                text,
                talking_to,
            } => {
                self.name(utterance_id);
                self.name(talking_to);
                self.text(text);
            }
            DebugEvent::JevRequest {
                utterance_id,
                purpose,
                state,
                floor_id,
            } => {
                self.opt_name(utterance_id);
                self.name(purpose);
                self.opt_name(floor_id);
                self.json(state);
            }
            DebugEvent::JevResponse {
                utterance_id,
                purpose,
                latency_ms: _,
                outcome,
                answers,
                error,
                floor_id,
            } => {
                self.opt_name(utterance_id);
                self.name(purpose);
                self.name(outcome);
                self.opt_name(floor_id);
                self.opt_text(error);
                self.json(answers);
            }
            DebugEvent::RouteDecision {
                utterance_id,
                rule,
                reason,
                action,
                target,
                mode,
                decided_by,
            } => {
                self.name(utterance_id);
                self.name(rule);
                self.name(action);
                self.opt_name(target);
                self.name(mode);
                self.name(decided_by);
                self.text(reason);
            }
            DebugEvent::PbxBranch {
                utterance_id,
                branch,
                reason,
            } => {
                self.name(utterance_id);
                self.name(branch);
                self.text(reason);
            }
            DebugEvent::UtilityRequest {
                utterance_id,
                attempt,
                prompt,
            } => {
                self.name(utterance_id);
                self.name(attempt);
                self.text(prompt);
            }
            DebugEvent::UtilityDecision {
                utterance_id,
                attempt,
                decision,
                latency_ms: _,
            } => {
                self.name(utterance_id);
                self.name(attempt);
                self.json(decision);
            }
            DebugEvent::OperatorHop {
                utterance_id,
                text,
                outcome,
            } => {
                self.name(utterance_id);
                self.name(outcome);
                self.text(text);
            }
            DebugEvent::OperatorRouteTool {
                utterance_id,
                target,
                mode,
                action,
            } => {
                self.name(utterance_id);
                self.name(target);
                self.name(mode);
                self.name(action);
            }
            DebugEvent::Routed {
                utterance_id,
                to_agent,
                text_part,
                mode,
                via,
            } => {
                self.name(utterance_id);
                self.name(to_agent);
                self.name(mode);
                self.name(via);
                self.text(text_part);
            }
            DebugEvent::AgentInput {
                agent,
                turn_id,
                text,
                source,
                utterance_id,
            } => {
                self.name(agent);
                self.opt_name(turn_id);
                self.name(source);
                self.opt_name(utterance_id);
                self.text(text);
            }
            DebugEvent::AgentText {
                agent,
                turn_id,
                text,
                final_: _,
            } => {
                self.name(agent);
                self.opt_name(turn_id);
                self.text(text);
            }
            DebugEvent::ToolStart {
                agent,
                call_id,
                tool,
                args,
                turn_id,
            } => {
                self.name(agent);
                self.opt_name(call_id);
                self.name(tool);
                self.opt_name(turn_id);
                self.opt_json(args);
            }
            DebugEvent::ToolEnd {
                agent,
                call_id,
                tool,
                result,
                error,
                turn_id,
            } => {
                self.name(agent);
                self.opt_name(call_id);
                self.name(tool);
                self.opt_name(turn_id);
                self.opt_text(error);
                self.opt_json(result);
            }
            DebugEvent::ModuleCall {
                agent,
                call_id,
                name,
                args,
                turn_id,
            } => {
                self.name(agent);
                self.name(call_id);
                self.name(name);
                self.opt_name(turn_id);
                self.json(args);
            }
            DebugEvent::ModuleResult {
                agent,
                call_id,
                ok: _,
                detail,
            } => {
                self.name(agent);
                self.name(call_id);
                self.json(detail);
            }
            DebugEvent::TurnStart {
                agent,
                turn_id,
                generation: _,
                utterance_id,
            }
            | DebugEvent::TurnEnd {
                agent,
                turn_id,
                generation: _,
                utterance_id,
            } => {
                self.name(agent);
                self.name(turn_id);
                self.opt_name(utterance_id);
            }
            DebugEvent::Rescue {
                generation: _,
                reason,
                leg,
            } => {
                self.opt_name(leg);
                self.text(reason);
            }
            DebugEvent::Speech {
                agent,
                text,
                delivered: _,
                reason,
                floor_id,
            } => {
                self.name(agent);
                self.opt_name(floor_id);
                self.opt_text(reason);
                self.text(text);
            }
            DebugEvent::FloorRequest {
                agent,
                message,
                floor_id,
            }
            | DebugEvent::FloorHeld {
                agent,
                message,
                floor_id,
            } => {
                self.name(agent);
                self.opt_name(floor_id);
                self.text(message);
            }
            DebugEvent::FloorGate {
                agent,
                answer,
                latency_ms: _,
                floor_id,
            } => {
                self.name(agent);
                self.name(answer);
                self.opt_name(floor_id);
            }
            DebugEvent::FloorRewrite {
                agent,
                original,
                rewritten,
                latency_ms: _,
                floor_id,
            } => {
                self.name(agent);
                self.opt_name(floor_id);
                self.text(original);
                self.text(rewritten);
            }
            DebugEvent::FloorReleased {
                agent,
                how,
                floor_id,
            } => {
                self.name(agent);
                self.name(how);
                self.opt_name(floor_id);
            }
            DebugEvent::AgentsState { agents } => self.agents(agents),
            DebugEvent::HostLink { host, connected: _ } => self.name(host),
            DebugEvent::CallBoundary {
                phase,
                call_id,
                reason,
            } => {
                self.name(phase);
                self.name(call_id);
                self.opt_text(reason);
            }
        }
    }
}

/// What replaces a credential on the debug page. The page is
/// unauthenticated; the journal keeps whatever the log line carried.
const REDACTED: &str = "[redacted]";

/// True for a field name that usually holds a credential: `token`,
/// `call_token`, `api_key`, `apiKey`, `Authorization`, `client_secret` and so
/// on. Case-insensitive. `key` counts only as a whole name part, so `keyboard`
/// and `monkey` do not.
fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.split(['_', '-', '.'])
        .any(|part| part == "key" || part == "keys")
        || [
            "token",
            "secret",
            "password",
            "passwd",
            "apikey",
            "privatekey",
            "authorization",
            "bearer",
            "credential",
            "cookie",
        ]
        .iter()
        .any(|word| name.contains(word))
}

/// True when `value`, under the credential-like name `key`, is redacted
/// whole: any string, array or object, and a number unless the name says it
/// is a count (`jev_summary_token_budget`, `input_tokens`). A `null` or a
/// boolean (`*_key_configured`) cannot carry a credential.
fn secret_value(key: &str, value: &Value) -> bool {
    const COUNT_WORDS: [&str; 10] = [
        "budget", "count", "max", "limit", "chars", "bytes", "tokens", "size", "length", "total",
    ];
    match value {
        Value::Null | Value::Bool(_) => false,
        Value::Number(_) => {
            let key = key.to_ascii_lowercase();
            !COUNT_WORDS.iter().any(|word| key.contains(word))
        }
        Value::String(_) | Value::Array(_) | Value::Object(_) => true,
    }
}

/// Replaces credential-looking parts of text: a PEM private key block, the
/// value after a credential-like name and `=` or `:` (`API_KEY=...`,
/// `"token": "..."`), the word after `Bearer`, words with a well-known key
/// prefix or shape (`sk-`, `ghp_`, `AKIA`, `AIza`, `hf_`, a JWT, ...), and
/// long random-looking words. A heuristic: it keeps a pasted `.env`, key
/// file or auth header off the page, not every secret.
pub(crate) fn scrub_text(text: &str) -> String {
    let text = redact_private_keys(text);
    scrub_words(&text)
}

/// Replaces each `-----BEGIN ... PRIVATE KEY-----` block through its
/// `-----END ...-----` line. A block with no end (the text was cut) is
/// redacted to the end of the text.
fn redact_private_keys(text: &str) -> std::borrow::Cow<'_, str> {
    const BEGIN: &str = "-----BEGIN ";
    const DASHES: &str = "-----";
    if !text.contains(BEGIN) {
        return text.into();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(BEGIN) {
        let after_begin = &rest[start + BEGIN.len()..];
        let Some(label_end) = after_begin.find(DASHES) else {
            break;
        };
        let label = &after_begin[..label_end];
        let header_end = start + BEGIN.len() + label_end + DASHES.len();
        if !label.contains("PRIVATE KEY") || label.contains('\n') {
            out.push_str(&rest[..header_end]);
            rest = &rest[header_end..];
            continue;
        }
        out.push_str(&rest[..start]);
        out.push_str(REDACTED);
        let body = &rest[header_end..];
        rest = match body.find("-----END ") {
            Some(end) => {
                let footer = &body[end + "-----END ".len()..];
                match footer.find(DASHES) {
                    Some(close) => &footer[close + DASHES.len()..],
                    None => "",
                }
            }
            None => "",
        };
    }
    out.push_str(rest);
    out.into()
}

/// A word that is a credential by its own shape, whatever surrounds it.
/// `rest` is the text after the word, for the shapes that span punctuation
/// (a JWT's `.`-separated segments).
fn credential_word(word: &str, rest: &[char]) -> bool {
    // Prefixes of provider keys. Each is followed by a long random part, so
    // a short word that happens to start the same way (`sk-learn`) is kept.
    const KEY_PREFIXES: [&str; 20] = [
        "sk-",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxa-",
        "xoxb-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "xapp-",
        "glpat-",
        "glsa_",
        "hf_",
        "npm_",
        "AIza",
        "pypi-",
        "dop_v1_",
    ];
    if word.len() >= 16 && KEY_PREFIXES.iter().any(|prefix| word.starts_with(prefix)) {
        return true;
    }
    // AWS access key ids: `AKIA` or `ASIA` and 16 upper-case letters or digits.
    if word.len() == 20
        && (word.starts_with("AKIA") || word.starts_with("ASIA"))
        && word[4..]
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return true;
    }
    // A JWT: base64url JSON (`eyJ`) and two more `.`-separated segments.
    if word.len() >= 8 && word.starts_with("eyJ") {
        let dots = rest
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
            .filter(|c| **c == '.')
            .count();
        if dots >= 2 {
            return true;
        }
    }
    random_looking(word)
}

/// A long word that looks generated rather than written: 32 or more
/// characters mixing upper case, lower case and digits, with high entropy.
/// Hex digests (`git` hashes) and UUIDs are lower case and kept, as are
/// identifiers, whose letters repeat.
fn random_looking(word: &str) -> bool {
    const MIN_LEN: usize = 32;
    const MIN_BITS_PER_CHAR: f64 = 4.2;
    if word.len() < MIN_LEN {
        return false;
    }
    let bytes = word.as_bytes();
    let upper = bytes.iter().any(u8::is_ascii_uppercase);
    let lower = bytes.iter().any(u8::is_ascii_lowercase);
    let digit = bytes.iter().any(u8::is_ascii_digit);
    if !(upper && lower && digit) {
        return false;
    }
    let mut counts = [0usize; 256];
    for byte in bytes {
        counts[usize::from(*byte)] += 1;
    }
    let len = bytes.len() as f64;
    let bits: f64 = counts
        .iter()
        .filter(|count| **count > 0)
        .map(|count| {
            let p = *count as f64 / len;
            -p * p.log2()
        })
        .sum();
    bits >= MIN_BITS_PER_CHAR
}

/// The word-level part of `scrub_text`.
fn scrub_words(text: &str) -> String {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let is_value = |c: char| !c.is_whitespace() && !matches!(c, '"' | '\'' | ',' | '}' | ']');
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut redact_next_word = false;
    while i < chars.len() {
        let c = chars[i];
        if !is_word(c) {
            out.push(c);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_word(chars[i]) {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        if redact_next_word || credential_word(&word, &chars[i..]) {
            redact_next_word = false;
            // The rest of a value such as `abc.def/ghi` goes with it.
            while i < chars.len() && is_value(chars[i]) {
                i += 1;
            }
            out.push_str(REDACTED);
            continue;
        }
        out.push_str(&word);
        if word.eq_ignore_ascii_case("bearer") {
            redact_next_word = chars.get(i).is_some_and(|c| *c == ' ');
            continue;
        }
        if !secret_name(&word) {
            continue;
        }
        // `name`, an optional closing quote, spaces, `=` or `:`, spaces and an
        // optional opening quote, then the value.
        let mut j = i;
        if matches!(chars.get(j), Some('"' | '\'')) {
            j += 1;
        }
        while matches!(chars.get(j), Some(' ' | '\t')) {
            j += 1;
        }
        if !matches!(chars.get(j), Some('=' | ':')) {
            continue;
        }
        j += 1;
        while matches!(chars.get(j), Some(' ' | '\t')) {
            j += 1;
        }
        if matches!(chars.get(j), Some('"' | '\'')) {
            j += 1;
        }
        let value_start = j;
        while j < chars.len() && is_value(chars[j]) {
            j += 1;
        }
        // A count such as `tokens: 500` is not a credential.
        let numeric = chars[value_start..j].iter().all(|c| c.is_ascii_digit());
        if j > value_start && !numeric {
            let value: String = chars[value_start..j].iter().collect();
            // `Authorization: Bearer <token>`: the scheme, then the token.
            redact_next_word = ["bearer", "basic"]
                .iter()
                .any(|scheme| value.eq_ignore_ascii_case(scheme));
            out.extend(&chars[i..value_start]);
            out.push_str(REDACTED);
            i = j;
        }
    }
    out
}

#[cfg(test)]
#[path = "../tests/test_debug_record.rs"]
mod tests;
