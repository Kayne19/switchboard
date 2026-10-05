use serde_json::{Map, Value};
use std::collections::HashSet;

pub const MAX_ACTION_BYTES: usize = 48_000;
/// An image action carries raster bytes, so it gets its own cap: the raw
/// image is at most 8 MiB, and the action around its base64 at most 12 MiB.
/// Every other type keeps `MAX_ACTION_BYTES`. The host link and the browser
/// socket both allow 16 MiB frames (`hosts::MAX_HOST_FRAME_BYTES`,
/// `browser::MAX_WEBSOCKET_MESSAGE_BYTES`), so one image action always fits
/// one frame; the reconnect snapshot sends each action as its own frame for
/// the same reason. The browser's `validation.ts` holds the same two numbers.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_IMAGE_ACTION_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_ID_UTF16: usize = 128;
pub const MAX_TEXT_UTF16: usize = 50_000;
pub const RESERVED_ID_PREFIX: &str = "__runtime/";
const CHART_KINDS: [&str; 4] = ["line", "bar", "area", "scatter"];
const MAX_CHART_LABELS: usize = 100;
const MAX_CHART_LABEL_UTF16: usize = 64;
const MAX_PROGRESS_STEPS: usize = 30;
const MAX_METRIC_DELTA_UTF16: usize = 32;
/// What an agent may `show`. The browser reports the same kinds back in its
/// screen state, so this list is the one both directions are checked against.
pub const CONTENT_TYPES: [&str; 14] = [
    "chart", "metric", "progress", "diagram", "document", "code", "table", "note", "image",
    "calendar", "tasks", "timer", "weather", "inbox",
];

// The table contract (docs/display-tool.md, "Table v1 rules"); the browser's
// validateTableData holds the same numbers.
const MAX_TABLE_COLUMNS: usize = 12;
const MAX_TABLE_ROWS: usize = 200;
const MAX_TABLE_COLUMN_LABEL_UTF16: usize = 64;
const MAX_TABLE_CELL_UTF16: usize = 256;

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Unicode White_Space, the one whitespace set both validators use
/// (docs/display-tool.md, "How the two validators agree"). It is listed
/// rather than left to `str::trim`, so the set is written down where it is
/// used; the browser's `NOT_WHITE_SPACE` lists the same 25 code points.
const WHITE_SPACE: [char; 25] = [
    '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{85}', '\u{a0}', '\u{1680}', '\u{2000}',
    '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}',
    '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}',
];

/// Whether `s` is empty or White_Space only: a blank identifier or alt.
fn is_blank(s: &str) -> bool {
    s.chars().all(|c| WHITE_SPACE.contains(&c))
}

fn check_identifier(s: &str, field_name: &str) -> Result<String, String> {
    if is_blank(s) {
        return Err(format!("{field_name} must be a non-empty identifier"));
    }
    if utf16_len(s) > MAX_ID_UTF16 {
        return Err(format!(
            "{field_name} exceeds maximum length of {MAX_ID_UTF16} UTF-16 code units"
        ));
    }
    if s.starts_with(RESERVED_ID_PREFIX) {
        return Err(format!("reserved identifier namespace: {s}"));
    }
    Ok(s.to_string())
}

/// An object's entries with their keys in code point order, the one order
/// both validators walk an object in (docs/display-tool.md, "How the two
/// validators agree"): with two unknown or forbidden keys, or two unsafe
/// strings, the error is about the first in this order, wherever the agent
/// put it. serde_json's map iterates in this order today, but a dependency
/// that turned on its `preserve_order` feature would change that for the
/// whole build, so the order is made here. The browser's `keysInOrder`
/// sorts the same way.
fn entries_in_order(m: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut entries: Vec<(&String, &Value)> = m.iter().collect();
    // `str`'s order is byte order of UTF-8, which is code point order.
    entries.sort_by(|a, b| a.0.cmp(b.0));
    entries
}

/// The first forbidden key met walking depth first, keys in code point order.
fn forbidden_layout(v: &Value) -> Option<&'static str> {
    const KEYS: &[&str] = &[
        "layout",
        "style",
        "css",
        "className",
        "width",
        "height",
        "left",
        "right",
        "top",
        "bottom",
    ];
    match v {
        Value::Object(m) => entries_in_order(m).into_iter().find_map(|(key, value)| {
            KEYS.iter()
                .find(|forbidden| **forbidden == key.as_str())
                .copied()
                .or_else(|| forbidden_layout(value))
        }),
        Value::Array(a) => a.iter().find_map(forbidden_layout),
        _ => None,
    }
}

/// Whether `s` names an external resource: a `scheme://` of any scheme, a
/// leading `//`, or a `//` followed by a host name with a dot and a
/// top-level part of two letters or more (`see //cdn.example.com`). The
/// browser's `EXTERNAL_URL_REGEX` is the same rule; the last part is its
/// `//[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`, matched here without a regex crate.
fn names_external_resource(s: &str) -> bool {
    if s.contains("://") || s.starts_with("//") {
        return true;
    }
    let bytes = s.as_bytes();
    bytes.windows(2).enumerate().any(|(at, pair)| {
        if pair != b"//" {
            return false;
        }
        let rest = &bytes[at + 2..];
        let host_len = rest
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric() || **b == b'.' || **b == b'-')
            .count();
        let host = &rest[..host_len];
        (1..host_len).any(|dot| {
            host[dot] == b'.'
                && host.get(dot + 1).is_some_and(u8::is_ascii_alphabetic)
                && host.get(dot + 2).is_some_and(u8::is_ascii_alphabetic)
        })
    })
}

fn check_unsafe_string(v: &Value) -> Result<(), String> {
    match v {
        Value::String(s) => {
            let lower = s.to_ascii_lowercase();
            if lower.contains("<script")
                || lower.contains("<iframe")
                || lower.contains("<html")
                || lower.contains("<style")
                || lower.contains("<svg")
                || lower.contains("<object")
                || lower.contains("<embed")
                || lower.contains("javascript:")
                || lower.contains("data:text/html")
            {
                return Err("raw markup or script injection is forbidden".to_string());
            }
            if names_external_resource(s) {
                return Err("external resource URL is forbidden".to_string());
            }
            Ok(())
        }
        Value::Object(m) => {
            for (_, val) in entries_in_order(m) {
                check_unsafe_string(val)?;
            }
            Ok(())
        }
        Value::Array(a) => {
            for val in a {
                check_unsafe_string(val)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn finite(v: &Value) -> bool {
    match v {
        Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
        Value::Object(m) => m.values().all(finite),
        Value::Array(a) => a.iter().all(finite),
        _ => true,
    }
}

fn check_unknown_keys(
    m: &Map<String, Value>,
    allowed: &[&str],
    context: &str,
) -> Result<(), String> {
    for (k, _) in entries_in_order(m) {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("unknown field in {context}: {k}"));
        }
    }
    Ok(())
}

fn copy_optional_string(
    data: &Map<String, Value>,
    out: &mut Map<String, Value>,
    key: &str,
    max_len: usize,
    field_name: &str,
) -> Result<(), String> {
    let Some(value) = data.get(key) else {
        return Ok(());
    };
    let text = value
        .as_str()
        .ok_or_else(|| format!("{field_name} must be a string"))?;
    if utf16_len(text) > max_len {
        return Err(format!(
            "{field_name} exceeds maximum length of {max_len} UTF-16 code units"
        ));
    }
    out.insert(key.into(), text.into());
    Ok(())
}

fn is_valid_semantic(s: &str) -> bool {
    matches!(
        s,
        "red" | "orange" | "green" | "cyan" | "amber" | "paper" | "muted"
    )
}

/// Copies an optional `semantic`. Anything but one of the seven names, a
/// non-string or `null` included, is `invalid {field_name}`, as the
/// browser's `ALLOWED_SEMANTICS.has` check refuses it: a field the browser
/// refuses is refused here, never dropped.
fn copy_optional_semantic(
    data: &Map<String, Value>,
    out: &mut Map<String, Value>,
    field_name: &str,
) -> Result<(), String> {
    let Some(value) = data.get("semantic") else {
        return Ok(());
    };
    let semantic = value
        .as_str()
        .filter(|s| is_valid_semantic(s))
        .ok_or_else(|| format!("invalid {field_name}"))?;
    out.insert("semantic".into(), semantic.into());
    Ok(())
}

fn validate_chart_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &[
            "title",
            "subtitle",
            "context",
            "caption",
            "kind",
            "labels",
            "xLabel",
            "yLabel",
            "xMax",
            "yMin",
            "yMax",
            "series",
            "marker",
            "compareLabel",
        ],
        "chart data",
    )?;

    let kind = match data.get("kind") {
        None => None,
        Some(v) => {
            let k = v
                .as_str()
                .filter(|k| CHART_KINDS.contains(k))
                .ok_or("invalid chart.kind")?;
            Some(k)
        }
    };
    let labels = match data.get("labels") {
        None => None,
        Some(v) => {
            let arr = v
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= MAX_CHART_LABELS)
                .ok_or(format!(
                    "chart.labels must be an array of 1 to {MAX_CHART_LABELS} strings"
                ))?;
            for label in arr {
                let text = label.as_str().ok_or("chart label must be a string")?;
                if utf16_len(text) > MAX_CHART_LABEL_UTF16 {
                    return Err(format!(
                        "chart label exceeds maximum length of {MAX_CHART_LABEL_UTF16} UTF-16 code units"
                    ));
                }
            }
            Some(arr)
        }
    };

    let series_val = data.get("series").ok_or("chart.series must be an array")?;
    let series_arr = series_val
        .as_array()
        .ok_or("chart.series must be an array")?;
    let mut clean_series = Vec::new();

    for s in series_arr {
        let sm = s.as_object().ok_or("chart series item must be an object")?;
        check_unknown_keys(sm, &["name", "semantic", "values"], "chart series item")?;

        let name = sm
            .get("name")
            .and_then(Value::as_str)
            .ok_or("series.name must be a string")?;
        if utf16_len(name) > 128 {
            return Err("series.name exceeds maximum length of 128 UTF-16 code units".into());
        }

        let values = sm
            .get("values")
            .and_then(Value::as_array)
            .ok_or("series.values must be an array")?;
        for v in values {
            if !v.is_number() || !v.as_f64().is_some_and(f64::is_finite) {
                return Err("series.values must contain finite numbers".into());
            }
        }
        if labels.is_some_and(|labels| values.len() > labels.len()) {
            return Err("series.values is longer than chart.labels".into());
        }

        let mut item = Map::new();
        item.insert("name".into(), name.into());
        item.insert("values".into(), Value::Array(values.clone()));
        copy_optional_semantic(sm, &mut item, "series.semantic")?;
        clean_series.push(Value::Object(item));
    }

    let mut out = Map::new();
    out.insert("series".into(), Value::Array(clean_series));
    if let Some(kind) = kind {
        out.insert("kind".into(), kind.into());
    }
    if let Some(labels) = labels {
        out.insert("labels".into(), Value::Array(labels.clone()));
    }

    for (k, max_len) in [("title", 256), ("subtitle", 256), ("context", 256)] {
        if let Some(v) = data.get(k) {
            let s = v.as_str().ok_or(format!("chart.{k} must be a string"))?;
            if utf16_len(s) > max_len {
                return Err(format!(
                    "chart.{k} exceeds maximum length of {max_len} UTF-16 code units"
                ));
            }
            out.insert(k.into(), s.into());
        }
    }
    for (k, max_len) in [
        ("caption", 128),
        ("xLabel", 128),
        ("yLabel", 128),
        ("compareLabel", 128),
    ] {
        if let Some(v) = data.get(k) {
            let s = v.as_str().ok_or(format!("chart.{k} must be a string"))?;
            if utf16_len(s) > max_len {
                return Err(format!(
                    "chart.{k} exceeds maximum length of {max_len} UTF-16 code units"
                ));
            }
            out.insert(k.into(), s.into());
        }
    }
    for k in ["xMax", "yMin", "yMax"] {
        if let Some(v) = data.get(k) {
            if !v.is_number() || !v.as_f64().is_some_and(f64::is_finite) {
                return Err(format!("chart.{k} must be a finite number"));
            }
            out.insert(k.into(), v.clone());
        }
    }

    if let Some(marker_val) = data.get("marker") {
        let mm = marker_val
            .as_object()
            .ok_or("chart.marker must be an object")?;
        check_unknown_keys(mm, &["x", "series"], "chart marker")?;
        let x = mm
            .get("x")
            .filter(|v| v.is_number() && v.as_f64().is_some_and(f64::is_finite))
            .ok_or("chart.marker.x must be a finite number")?;
        let mut marker_out = Map::new();
        marker_out.insert("x".into(), x.clone());
        if let Some(s) = mm.get("series") {
            let series_str = s.as_str().ok_or("chart.marker.series must be a string")?;
            if utf16_len(series_str) > 128 {
                return Err(
                    "chart.marker.series exceeds maximum length of 128 UTF-16 code units".into(),
                );
            }
            marker_out.insert("series".into(), series_str.into());
        }
        out.insert("marker".into(), Value::Object(marker_out));
    }

    Ok(Value::Object(out))
}

fn validate_metric_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &["label", "value", "semantic", "caption", "trend", "delta"],
        "metric data",
    )?;
    let label = data
        .get("label")
        .and_then(Value::as_str)
        .ok_or("metric.label must be a string")?;
    if utf16_len(label) > 128 {
        return Err("metric.label exceeds maximum length of 128 UTF-16 code units".into());
    }
    let value = data
        .get("value")
        .and_then(Value::as_str)
        .ok_or("metric.value must be a string")?;
    if utf16_len(value) > 128 {
        return Err("metric.value exceeds maximum length of 128 UTF-16 code units".into());
    }

    let mut out = Map::new();
    out.insert("label".into(), label.into());
    out.insert("value".into(), value.into());
    copy_optional_semantic(data, &mut out, "metric.semantic")?;
    copy_optional_string(data, &mut out, "caption", 128, "metric.caption")?;
    if let Some(trend) = data.get("trend") {
        let t = trend
            .as_str()
            .filter(|t| matches!(*t, "up" | "down" | "flat"))
            .ok_or("invalid metric.trend")?;
        out.insert("trend".into(), t.into());
    }
    copy_optional_string(
        data,
        &mut out,
        "delta",
        MAX_METRIC_DELTA_UTF16,
        "metric.delta",
    )?;
    Ok(Value::Object(out))
}

/// A progress value is a 0-100 percentage. Out-of-range values clamp
/// to [0, 100], and values are rounded to two decimal places.
fn normalize_progress_value(value: f64) -> Value {
    let bounded = value.clamp(0.0, 100.0);
    let rounded = (bounded * 100.0).round() / 100.0;
    if rounded.fract() == 0.0 {
        (rounded as i64).into()
    } else {
        rounded.into()
    }
}

/// The percent a step list stands for when the agent gives no `value`: the
/// share of its steps that are done. The browser's `progressValueOfSteps`
/// computes it the same way, so a filled-in value agrees on both sides.
fn progress_value_of_steps(steps: &[Value]) -> Value {
    let done = steps
        .iter()
        .filter(|step| step["state"].as_str() == Some("done"))
        .count();
    normalize_progress_value((done as f64 * 100.0) / steps.len() as f64)
}

fn validate_progress_steps(value: &Value) -> Result<Vec<Value>, String> {
    let steps = value
        .as_array()
        .filter(|steps| !steps.is_empty() && steps.len() <= MAX_PROGRESS_STEPS)
        .ok_or(format!(
            "progress.steps must be an array of 1 to {MAX_PROGRESS_STEPS} items"
        ))?;
    let mut clean_steps = Vec::new();
    for step in steps {
        let sm = step.as_object().ok_or("progress step must be an object")?;
        check_unknown_keys(sm, &["label", "state", "detail"], "progress step")?;
        let label = sm
            .get("label")
            .and_then(Value::as_str)
            .ok_or("progress step.label must be a string")?;
        if utf16_len(label) > 128 {
            return Err(
                "progress step.label exceeds maximum length of 128 UTF-16 code units".into(),
            );
        }
        let mut step_out = Map::new();
        step_out.insert("label".into(), label.into());
        if let Some(state) = sm.get("state") {
            let st = state
                .as_str()
                .filter(|st| matches!(*st, "done" | "active" | "todo" | "blocked"))
                .ok_or("invalid progress step.state")?;
            step_out.insert("state".into(), st.into());
        }
        copy_optional_string(sm, &mut step_out, "detail", 256, "progress step.detail")?;
        clean_steps.push(Value::Object(step_out));
    }
    Ok(clean_steps)
}

fn validate_progress_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &["label", "detail", "value", "text", "caption", "steps"],
        "progress data",
    )?;
    let label = data
        .get("label")
        .and_then(Value::as_str)
        .ok_or("progress.label must be a string")?;
    if utf16_len(label) > 128 {
        return Err("progress.label exceeds maximum length of 128 UTF-16 code units".into());
    }

    let steps = data.get("steps").map(validate_progress_steps).transpose()?;

    // The bar needs a percent: the agent's own, or the share of steps done.
    let value = match (data.get("value"), &steps) {
        (Some(v), _) => {
            let val = v
                .as_f64()
                .filter(|val| val.is_finite())
                .ok_or("progress.value must be a finite number")?;
            // Values arrive as a 0-100 percentage; the projection applies
            // the same normalization as the browser to keep both sides of the
            // socket in agreement.
            normalize_progress_value(val)
        }
        (None, Some(steps)) => progress_value_of_steps(steps),
        (None, None) => return Err("progress requires value or steps".into()),
    };

    let mut out = Map::new();
    out.insert("label".into(), label.into());
    out.insert("value".into(), value);
    if let Some(steps) = steps {
        out.insert("steps".into(), Value::Array(steps));
    }

    if let Some(detail) = data.get("detail") {
        let d = detail.as_str().ok_or("progress.detail must be a string")?;
        if utf16_len(d) > 256 {
            return Err("progress.detail exceeds maximum length of 256 UTF-16 code units".into());
        }
        out.insert("detail".into(), d.into());
    }
    if let Some(text) = data.get("text") {
        let t = text.as_str().ok_or("progress.text must be a string")?;
        if utf16_len(t) > 128 {
            return Err("progress.text exceeds maximum length of 128 UTF-16 code units".into());
        }
        out.insert("text".into(), t.into());
    }
    copy_optional_string(data, &mut out, "caption", 128, "progress.caption")?;
    Ok(Value::Object(out))
}

/// The two diagram modes are told apart by `mode` before anything else is
/// read, so a graph payload is judged by the graph rules and a sequence
/// payload by the sequence rules; each refuses the other's arrays by name.
fn validate_diagram_data(data: &Map<String, Value>) -> Result<Value, String> {
    if data.contains_key("source") {
        return Err("diagram data source field is forbidden in v1".into());
    }
    match data.get("mode").and_then(Value::as_str) {
        Some("graph") => validate_graph_diagram_data(data),
        Some("sequence") => validate_sequence_diagram_data(data),
        _ => Err("diagram.mode must be \"graph\" or \"sequence\"".into()),
    }
}

fn validate_graph_diagram_data(data: &Map<String, Value>) -> Result<Value, String> {
    if data.contains_key("actors") || data.contains_key("messages") {
        return Err("diagram.actors and diagram.messages belong to mode \"sequence\"".into());
    }
    check_unknown_keys(
        data,
        &[
            "title", "subtitle", "context", "caption", "mode", "nodes", "edges",
        ],
        "diagram data",
    )?;

    let nodes_arr = data
        .get("nodes")
        .and_then(Value::as_array)
        .filter(|nodes| !nodes.is_empty() && nodes.len() <= 100)
        .ok_or("diagram.nodes must be an array of 1 to 100 items")?;
    let edges_arr = data
        .get("edges")
        .and_then(Value::as_array)
        .filter(|edges| edges.len() <= 200)
        .ok_or("diagram.edges must be an array of at most 200 items")?;

    let mut node_ids = HashSet::new();
    let mut clean_nodes = Vec::new();

    for n in nodes_arr {
        let nm = n.as_object().ok_or("diagram node must be an object")?;
        check_unknown_keys(
            nm,
            &["id", "label", "sub", "detail", "semantic", "state"],
            "diagram node",
        )?;

        let id = nm
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !is_blank(id) && utf16_len(id) <= 128)
            .ok_or("diagram node id must be non-empty and <= 128 UTF-16 code units")?;
        if !node_ids.insert(id.to_string()) {
            return Err(format!("duplicate diagram node id: {id}"));
        }

        let label = nm
            .get("label")
            .and_then(Value::as_str)
            .ok_or("diagram node.label must be a string")?;
        if utf16_len(label) > 256 {
            return Err(
                "diagram node.label exceeds maximum length of 256 UTF-16 code units".into(),
            );
        }

        let mut node_out = Map::new();
        node_out.insert("id".into(), id.into());
        node_out.insert("label".into(), label.into());

        copy_optional_string(nm, &mut node_out, "sub", 256, "diagram node.sub")?;
        copy_optional_string(nm, &mut node_out, "detail", 256, "diagram node.detail")?;
        copy_optional_semantic(nm, &mut node_out, "diagram node.semantic")?;
        if let Some(state) = nm.get("state") {
            let st = state
                .as_str()
                .filter(|st| matches!(*st, "done" | "active" | "todo" | "blocked"))
                .ok_or("invalid diagram node.state")?;
            node_out.insert("state".into(), st.into());
        }
        clean_nodes.push(Value::Object(node_out));
    }

    let mut edge_pairs = HashSet::new();
    let mut clean_edges = Vec::new();

    for e in edges_arr {
        let em = e.as_object().ok_or("diagram edge must be an object")?;
        check_unknown_keys(
            em,
            &["from", "to", "label", "semantic", "active"],
            "diagram edge",
        )?;

        let (Some(from), Some(to)) = (
            em.get("from").and_then(Value::as_str),
            em.get("to").and_then(Value::as_str),
        ) else {
            return Err("diagram edge from and to must be strings".into());
        };

        if !node_ids.contains(from) {
            return Err(format!(
                "diagram edge from endpoint \"{from}\" not found in nodes"
            ));
        }
        if !node_ids.contains(to) {
            return Err(format!(
                "diagram edge to endpoint \"{to}\" not found in nodes"
            ));
        }
        if from == to {
            return Err(format!("diagram edge self-loop is forbidden: {from}"));
        }
        if !edge_pairs.insert((from.to_string(), to.to_string())) {
            return Err(format!("duplicate diagram edge pair: {from} -> {to}"));
        }

        let mut edge_out = Map::new();
        edge_out.insert("from".into(), from.into());
        edge_out.insert("to".into(), to.into());

        copy_optional_string(em, &mut edge_out, "label", 256, "diagram edge.label")?;
        copy_optional_semantic(em, &mut edge_out, "diagram edge.semantic")?;
        if let Some(active) = em.get("active") {
            let b = active
                .as_bool()
                .ok_or("diagram edge.active must be boolean")?;
            edge_out.insert("active".into(), b.into());
        }
        clean_edges.push(Value::Object(edge_out));
    }

    let mut out = Map::new();
    out.insert("mode".into(), "graph".into());
    out.insert("nodes".into(), Value::Array(clean_nodes));
    out.insert("edges".into(), Value::Array(clean_edges));

    for (k, max_len) in [("title", 256), ("subtitle", 256), ("context", 256)] {
        if let Some(v) = data.get(k) {
            let s = v.as_str().ok_or(format!("diagram.{k} must be a string"))?;
            if utf16_len(s) > max_len {
                return Err(format!(
                    "diagram.{k} exceeds maximum length of {max_len} UTF-16 code units"
                ));
            }
            out.insert(k.into(), s.into());
        }
    }
    copy_optional_string(data, &mut out, "caption", 128, "diagram.caption")?;

    Ok(Value::Object(out))
}

fn validate_sequence_diagram_data(data: &Map<String, Value>) -> Result<Value, String> {
    if data.contains_key("nodes") || data.contains_key("edges") {
        return Err("diagram.nodes and diagram.edges belong to mode \"graph\"".into());
    }
    check_unknown_keys(
        data,
        &[
            "title", "subtitle", "context", "caption", "mode", "actors", "messages",
        ],
        "diagram data",
    )?;

    let actors_arr = data
        .get("actors")
        .and_then(Value::as_array)
        .ok_or("diagram.actors must be an array of 1 to 12 items")?;
    if actors_arr.is_empty() || actors_arr.len() > 12 {
        return Err("diagram.actors must be an array of 1 to 12 items".into());
    }

    let messages_arr = data
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("diagram.messages must be an array of at most 100 items")?;
    if messages_arr.len() > 100 {
        return Err("diagram.messages must be an array of at most 100 items".into());
    }

    let mut actor_ids = HashSet::new();
    let mut clean_actors = Vec::new();

    for a in actors_arr {
        let am = a.as_object().ok_or("diagram actor must be an object")?;
        check_unknown_keys(am, &["id", "label", "sub", "semantic"], "diagram actor")?;

        let id = am
            .get("id")
            .and_then(Value::as_str)
            .ok_or("diagram actor id must be non-empty and <= 128 UTF-16 code units")?;
        if is_blank(id) || utf16_len(id) > 128 {
            return Err("diagram actor id must be non-empty and <= 128 UTF-16 code units".into());
        }
        if !actor_ids.insert(id.to_string()) {
            return Err(format!("duplicate diagram actor id: {id}"));
        }

        let label = am
            .get("label")
            .and_then(Value::as_str)
            .ok_or("diagram actor.label must be a string")?;
        if utf16_len(label) > 256 {
            return Err(
                "diagram actor.label exceeds maximum length of 256 UTF-16 code units".into(),
            );
        }

        let mut actor_out = Map::new();
        actor_out.insert("id".into(), id.into());
        actor_out.insert("label".into(), label.into());
        copy_optional_string(am, &mut actor_out, "sub", 256, "diagram actor.sub")?;
        copy_optional_semantic(am, &mut actor_out, "diagram actor.semantic")?;
        clean_actors.push(Value::Object(actor_out));
    }

    // A self-message and a repeated pair are both ordinary in a sequence, so
    // unlike graph edges neither is refused.
    let mut clean_messages = Vec::new();
    for m in messages_arr {
        let mm = m.as_object().ok_or("diagram message must be an object")?;
        check_unknown_keys(
            mm,
            &["from", "to", "label", "kind", "active"],
            "diagram message",
        )?;

        let (Some(from), Some(to)) = (
            mm.get("from").and_then(Value::as_str),
            mm.get("to").and_then(Value::as_str),
        ) else {
            return Err("diagram message from and to must be strings".into());
        };
        if !actor_ids.contains(from) {
            return Err(format!(
                "diagram message from endpoint \"{from}\" not found in actors"
            ));
        }
        if !actor_ids.contains(to) {
            return Err(format!(
                "diagram message to endpoint \"{to}\" not found in actors"
            ));
        }
        let label = mm
            .get("label")
            .and_then(Value::as_str)
            .ok_or("diagram message.label must be a string")?;
        if utf16_len(label) > 256 {
            return Err(
                "diagram message.label exceeds maximum length of 256 UTF-16 code units".into(),
            );
        }

        let mut message_out = Map::new();
        message_out.insert("from".into(), from.into());
        message_out.insert("to".into(), to.into());
        message_out.insert("label".into(), label.into());
        if let Some(kind) = mm.get("kind") {
            let k = kind.as_str().ok_or("invalid diagram message.kind")?;
            if !matches!(k, "call" | "return" | "async") {
                return Err("invalid diagram message.kind".into());
            }
            message_out.insert("kind".into(), k.into());
        }
        if let Some(active) = mm.get("active") {
            let b = active
                .as_bool()
                .ok_or("diagram message.active must be boolean")?;
            message_out.insert("active".into(), b.into());
        }
        clean_messages.push(Value::Object(message_out));
    }

    let mut out = Map::new();
    out.insert("mode".into(), "sequence".into());
    out.insert("actors".into(), Value::Array(clean_actors));
    out.insert("messages".into(), Value::Array(clean_messages));

    for (k, max_len) in [("title", 256), ("subtitle", 256), ("context", 256)] {
        if let Some(v) = data.get(k) {
            let s = v.as_str().ok_or(format!("diagram.{k} must be a string"))?;
            if utf16_len(s) > max_len {
                return Err(format!(
                    "diagram.{k} exceeds maximum length of {max_len} UTF-16 code units"
                ));
            }
            out.insert(k.into(), s.into());
        }
    }
    copy_optional_string(data, &mut out, "caption", 128, "diagram.caption")?;

    Ok(Value::Object(out))
}

fn validate_document_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &[
            "kind",
            "context",
            "caption",
            "source",
            "from",
            "timestamp",
            "subject",
            "paragraphs",
        ],
        "document data",
    )?;

    let subject = data
        .get("subject")
        .and_then(Value::as_str)
        .ok_or("document.subject must be a string")?;
    if utf16_len(subject) > 256 {
        return Err("document.subject exceeds maximum length of 256 UTF-16 code units".into());
    }

    let paras = data
        .get("paragraphs")
        .and_then(Value::as_array)
        .ok_or("document.paragraphs must be an array")?;
    let mut clean_paras = Vec::new();
    for p in paras {
        let s = p.as_str().ok_or("document paragraph must be a string")?;
        if utf16_len(s) > 50_000 {
            return Err(
                "document paragraph exceeds maximum length of 50000 UTF-16 code units".into(),
            );
        }
        clean_paras.push(Value::String(s.to_string()));
    }

    let mut out = Map::new();
    out.insert("subject".into(), subject.into());
    out.insert("paragraphs".into(), Value::Array(clean_paras));

    if let Some(kind) = data.get("kind") {
        let k = kind
            .as_str()
            .filter(|k| matches!(*k, "email" | "document"))
            .ok_or("invalid document.kind")?;
        out.insert("kind".into(), k.into());
    }

    for (k, max_len) in [("context", 256), ("source", 256)] {
        if let Some(v) = data.get(k) {
            let s = v.as_str().ok_or(format!("document.{k} must be a string"))?;
            if utf16_len(s) > max_len {
                return Err(format!(
                    "document.{k} exceeds maximum length of {max_len} UTF-16 code units"
                ));
            }
            out.insert(k.into(), s.into());
        }
    }
    for (k, max_len) in [("from", 128), ("timestamp", 128)] {
        if let Some(v) = data.get(k) {
            let s = v.as_str().ok_or(format!("document.{k} must be a string"))?;
            if utf16_len(s) > max_len {
                return Err(format!(
                    "document.{k} exceeds maximum length of {max_len} UTF-16 code units"
                ));
            }
            out.insert(k.into(), s.into());
        }
    }
    copy_optional_string(data, &mut out, "caption", 128, "document.caption")?;

    Ok(Value::Object(out))
}

fn validate_code_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &["title", "file", "context", "caption", "source"],
        "code data",
    )?;
    let source_obj = data
        .get("source")
        .and_then(Value::as_object)
        .ok_or("code.source must be an object")?;
    check_unknown_keys(
        source_obj,
        &["language", "text", "highlight"],
        "code.source",
    )?;

    let text = source_obj
        .get("text")
        .and_then(Value::as_str)
        .ok_or("code.source.text must be a string")?;
    if utf16_len(text) > 50_000 {
        return Err("code.source.text exceeds maximum length of 50000 UTF-16 code units".into());
    }

    let mut clean_source = Map::new();
    clean_source.insert("text".into(), text.into());

    if let Some(lang) = source_obj.get("language") {
        let l = lang
            .as_str()
            .ok_or("code.source.language must be a string")?;
        if utf16_len(l) > 64 {
            return Err(
                "code.source.language exceeds maximum length of 64 UTF-16 code units".into(),
            );
        }
        clean_source.insert("language".into(), l.into());
    }
    if let Some(hl) = source_obj.get("highlight") {
        let arr = hl
            .as_array()
            .ok_or("code.source.highlight must be an array")?;
        for n in arr {
            if !n.is_number() || !n.as_f64().is_some_and(f64::is_finite) {
                return Err("code.source.highlight must contain finite numbers".into());
            }
        }
        clean_source.insert("highlight".into(), Value::Array(arr.clone()));
    }

    let mut out = Map::new();
    out.insert("source".into(), Value::Object(clean_source));

    for (k, max_len) in [("title", 256), ("file", 256), ("context", 256)] {
        if let Some(v) = data.get(k) {
            let s = v.as_str().ok_or(format!("code.{k} must be a string"))?;
            if utf16_len(s) > max_len {
                return Err(format!(
                    "code.{k} exceeds maximum length of {max_len} UTF-16 code units"
                ));
            }
            out.insert(k.into(), s.into());
        }
    }
    copy_optional_string(data, &mut out, "caption", 128, "code.caption")?;

    Ok(Value::Object(out))
}

fn validate_table_cell(cell: &Value) -> Result<Value, String> {
    match cell {
        Value::Number(n) => {
            if !n.as_f64().is_some_and(f64::is_finite) {
                return Err("table cell must be a finite number".into());
            }
            Ok(cell.clone())
        }
        Value::String(s) => {
            if utf16_len(s) > MAX_TABLE_CELL_UTF16 {
                return Err(format!(
                    "table cell exceeds maximum length of {MAX_TABLE_CELL_UTF16} UTF-16 code units"
                ));
            }
            Ok(cell.clone())
        }
        Value::Object(cm) => {
            check_unknown_keys(cm, &["text", "semantic", "bold"], "table cell")?;
            let text = cm
                .get("text")
                .and_then(Value::as_str)
                .ok_or("table cell.text must be a string")?;
            if utf16_len(text) > MAX_TABLE_CELL_UTF16 {
                return Err(format!(
                    "table cell.text exceeds maximum length of {MAX_TABLE_CELL_UTF16} UTF-16 code units"
                ));
            }
            let mut cell_out = Map::new();
            cell_out.insert("text".into(), text.into());
            copy_optional_semantic(cm, &mut cell_out, "table cell.semantic")?;
            if let Some(bold) = cm.get("bold") {
                let b = bold.as_bool().ok_or("table cell.bold must be boolean")?;
                cell_out.insert("bold".into(), b.into());
            }
            Ok(Value::Object(cell_out))
        }
        _ => Err("table cell must be a string, a number or an object".into()),
    }
}

fn validate_table_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &[
            "title",
            "subtitle",
            "context",
            "caption",
            "columns",
            "rows",
            "highlight",
        ],
        "table data",
    )?;

    let columns_err = format!("table.columns must be an array of 1 to {MAX_TABLE_COLUMNS} items");
    let columns_arr = data
        .get("columns")
        .and_then(Value::as_array)
        .ok_or_else(|| columns_err.clone())?;
    if columns_arr.is_empty() || columns_arr.len() > MAX_TABLE_COLUMNS {
        return Err(columns_err);
    }
    let mut clean_columns = Vec::new();
    for c in columns_arr {
        let cm = c.as_object().ok_or("table column must be an object")?;
        check_unknown_keys(cm, &["label", "semantic"], "table column")?;
        let label = cm
            .get("label")
            .and_then(Value::as_str)
            .ok_or("table column.label must be a string")?;
        if utf16_len(label) > MAX_TABLE_COLUMN_LABEL_UTF16 {
            return Err(format!(
                "table column.label exceeds maximum length of {MAX_TABLE_COLUMN_LABEL_UTF16} UTF-16 code units"
            ));
        }
        let mut column_out = Map::new();
        column_out.insert("label".into(), label.into());
        copy_optional_semantic(cm, &mut column_out, "table column.semantic")?;
        clean_columns.push(Value::Object(column_out));
    }

    let rows_err = format!("table.rows must be an array of at most {MAX_TABLE_ROWS} items");
    let rows_arr = data
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| rows_err.clone())?;
    if rows_arr.len() > MAX_TABLE_ROWS {
        return Err(rows_err);
    }
    let mut clean_rows = Vec::new();
    for (row_index, r) in rows_arr.iter().enumerate() {
        let cells = r
            .as_array()
            .ok_or(format!("table row {row_index} must be an array"))?;
        if cells.len() != clean_columns.len() {
            return Err(format!(
                "table row {row_index} has {} cells; the table has {} columns",
                cells.len(),
                clean_columns.len()
            ));
        }
        let mut clean_cells = Vec::new();
        for cell in cells {
            clean_cells.push(validate_table_cell(cell)?);
        }
        clean_rows.push(Value::Array(clean_cells));
    }

    let mut out = Map::new();
    out.insert("columns".into(), Value::Array(clean_columns));
    let row_count = clean_rows.len();
    out.insert("rows".into(), Value::Array(clean_rows));

    if let Some(hl) = data.get("highlight") {
        let arr = hl.as_array().ok_or("table.highlight must be an array")?;
        for n in arr {
            // An integer, as the browser's Number.isInteger counts it: 2.0 is
            // one, 1.5 and -1 are not.
            let is_row_index = n
                .as_f64()
                .is_some_and(|f| f.fract() == 0.0 && f >= 0.0 && f < row_count as f64);
            if !is_row_index {
                return Err("table.highlight must contain row indices".into());
            }
        }
        out.insert("highlight".into(), Value::Array(arr.clone()));
    }

    for (k, max_len) in [("title", 256), ("subtitle", 256), ("context", 256)] {
        if let Some(v) = data.get(k) {
            let s = v.as_str().ok_or(format!("table.{k} must be a string"))?;
            if utf16_len(s) > max_len {
                return Err(format!(
                    "table.{k} exceeds maximum length of {max_len} UTF-16 code units"
                ));
            }
            out.insert(k.into(), s.into());
        }
    }
    copy_optional_string(data, &mut out, "caption", 128, "table.caption")?;

    Ok(Value::Object(out))
}

// ---- image -----------------------------------------------------------------

/// The fewest bytes a signature check needs: WebP's `WEBP` ends at byte 12.
const IMAGE_SIGNATURE_BYTES: usize = 12;

/// The index of `byte` in the standard base64 alphabet.
fn base64_index(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// The decoded length of `text` when it is strict standard base64 -- the
/// `A-Za-z0-9+/` alphabet, a multiple of four characters long, at most two
/// `=` at the end and nothing else (no whitespace, no URL-safe variant) --
/// or `None` when it is not. The browser's `base64DecodedLength` applies the
/// same rule, so the two validators accept the same strings.
fn base64_decoded_length(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes
        .iter()
        .rev()
        .take(2)
        .take_while(|b| **b == b'=')
        .count();
    let body = &bytes[..bytes.len() - padding];
    if !body.iter().all(|b| base64_index(*b).is_some()) {
        return None;
    }
    Some(bytes.len() / 4 * 3 - padding)
}

/// Decodes strict standard base64 (`base64_decoded_length`'s rule). The
/// crate has no base64 dependency and an image check needs only its first
/// bytes, so this stays a small decoder of its own.
fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let length = base64_decoded_length(text).ok_or("not standard base64")?;
    let mut out = Vec::with_capacity(length);
    for group in text.as_bytes().chunks(4) {
        let sextet = |at: usize| -> Option<u32> {
            let byte = group[at];
            if byte == b'=' {
                None
            } else {
                base64_index(byte).map(u32::from)
            }
        };
        let (Some(a), Some(b)) = (sextet(0), sextet(1)) else {
            return Err("not standard base64".into());
        };
        let c = sextet(2);
        let d = sextet(3);
        out.push(((a << 2) | (b >> 4)) as u8);
        if let Some(c) = c {
            out.push((((b & 0xf) << 4) | (c >> 2)) as u8);
        }
        if let (Some(c), Some(d)) = (c, d) {
            out.push((((c & 0x3) << 6) | d) as u8);
        }
    }
    Ok(out)
}

/// The first `count` bytes `text` decodes to, at most.
fn decode_base64_head(text: &str, count: usize) -> Result<Vec<u8>, String> {
    let chars = count.div_ceil(3) * 4;
    let head = text.get(..chars).unwrap_or(text);
    let mut bytes = decode_base64(head)?;
    bytes.truncate(count);
    Ok(bytes)
}

/// Whether `bytes` start with `format`'s file signature: PNG
/// `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`. The
/// browser's `imageSignatureMatches` sniffs the same bytes.
fn image_signature_matches(format: &str, bytes: &[u8]) -> bool {
    match format {
        "png" => bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}

/// Raster only: the format names the bytes' encoding, and the bytes must
/// carry that encoding's signature, so `format` can never label markup (an
/// SVG) or anything else as an image. The page builds the only `img` source
/// there is from these two fields once they have passed here.
fn validate_image_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &[
            "format", "bytes", "alt", "title", "subtitle", "context", "caption",
        ],
        "image data",
    )?;

    let format = data.get("format").and_then(Value::as_str);
    if matches!(format, Some("svg") | Some("svg+xml")) {
        return Err("image.format svg is refused: an image is raster bytes, not markup".into());
    }
    let format = format
        .filter(|f| matches!(*f, "png" | "jpeg" | "webp"))
        .ok_or("image.format must be one of png, jpeg, webp")?;

    let bytes = data
        .get("bytes")
        .and_then(Value::as_str)
        .ok_or("image.bytes must be a base64 string")?;
    let decoded_length = base64_decoded_length(bytes).ok_or(
        "image.bytes must be standard base64: the A-Za-z0-9+/ alphabet, padded with =, no data: prefix",
    )?;
    if decoded_length > MAX_IMAGE_BYTES {
        return Err(format!(
            "image.bytes decode to more than {MAX_IMAGE_BYTES} bytes"
        ));
    }
    if decoded_length < IMAGE_SIGNATURE_BYTES {
        return Err(format!("image.bytes are too short to be a {format}"));
    }
    let head = decode_base64_head(bytes, IMAGE_SIGNATURE_BYTES)?;
    if !image_signature_matches(format, &head) {
        return Err(format!(
            "image.bytes do not start with the {format} signature"
        ));
    }

    let alt = data
        .get("alt")
        .and_then(Value::as_str)
        .ok_or("image.alt must be a string")?;
    if utf16_len(alt) > 256 {
        return Err("image.alt exceeds maximum length of 256 UTF-16 code units".into());
    }
    if is_blank(alt) {
        return Err("image.alt must not be empty".into());
    }

    let mut out = Map::new();
    out.insert("format".into(), format.into());
    out.insert("bytes".into(), bytes.into());
    out.insert("alt".into(), alt.into());
    for k in ["title", "subtitle", "context"] {
        copy_optional_string(data, &mut out, k, 256, &format!("image.{k}"))?;
    }
    copy_optional_string(data, &mut out, "caption", 128, "image.caption")?;
    Ok(Value::Object(out))
}

// ---- time values -------------------------------------------------------------

/// How a time is written (docs/display-tool.md, "Time values"): a date
/// (`YYYY-MM-DD`), a wall time on the caller's clock (`YYYY-MM-DDTHH:MM`), or
/// an instant (RFC 3339 with seconds and an offset). Only a timer takes an
/// instant: it is the one thing measured against the page clock. The
/// browser's `TimeForm` names the same three.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TimeForm {
    Date,
    Wall,
    Instant,
}

impl TimeForm {
    /// The form as an error names it; the browser's `TIME_FORM_TEXT`.
    fn text(self) -> &'static str {
        match self {
            TimeForm::Date => "a date (YYYY-MM-DD)",
            TimeForm::Wall => "a wall time (YYYY-MM-DDTHH:MM)",
            TimeForm::Instant => "an instant (YYYY-MM-DDTHH:MM:SS with Z or an offset like -07:00)",
        }
    }
}

/// A time as `parse_time_value` read it: its form, the day it falls on as
/// written (days from 1970-01-01), and its place on its form's own line --
/// days for a date, minutes for a wall time, and for an instant the second
/// and nanosecond it names, its offset applied.
#[derive(Clone, Copy)]
struct TimeValue {
    form: TimeForm,
    day_number: i64,
    place: (i64, u32),
}

const MIN_TIME_YEAR: i64 = 1970;
const MAX_TIME_YEAR: i64 = 2199;

/// The number ASCII digits spell, or `None` for any other byte.
fn ascii_number(digits: &[u8]) -> Option<u32> {
    digits.iter().try_fold(0u32, |n, digit| {
        digit
            .is_ascii_digit()
            .then(|| n * 10 + u32::from(digit - b'0'))
    })
}

fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from 1970-01-01 to a Gregorian date (Howard Hinnant's
/// days_from_civil); the browser's `daysFromCivil`.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Reads a time value, the one time parser the service has, used by every
/// type that carries a time. The browser's `parseTimeValue` reads the same
/// text with one pattern: a real Gregorian date in the years 1970-2199;
/// hours 00-23 (no 24:00), minutes and seconds 00-59 (no leap second); an
/// instant's fraction 1 to 9 digits and its offset `Z` or `+HH:MM`/`-HH:MM`
/// (hours 00-23); upper-case `T` and `Z`, ASCII digits, nothing around it.
fn parse_time_value(text: &str) -> Option<TimeValue> {
    let b = text.as_bytes();
    let field = |at: usize, len: usize| b.get(at..at + len).and_then(ascii_number).map(i64::from);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let (year, month, day) = (field(0, 4)?, field(5, 2)?, field(8, 2)?);
    if !(MIN_TIME_YEAR..=MAX_TIME_YEAR).contains(&year)
        || !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
    {
        return None;
    }
    let day_number = days_from_civil(year, month, day);
    if b.len() == 10 {
        return Some(TimeValue {
            form: TimeForm::Date,
            day_number,
            place: (day_number, 0),
        });
    }
    if b.get(10) != Some(&b'T') || b.get(13) != Some(&b':') {
        return None;
    }
    let (hour, minute) = (field(11, 2)?, field(14, 2)?);
    if hour > 23 || minute > 59 {
        return None;
    }
    if b.len() == 16 {
        return Some(TimeValue {
            form: TimeForm::Wall,
            day_number,
            place: (day_number * 1440 + hour * 60 + minute, 0),
        });
    }
    if b.get(16) != Some(&b':') {
        return None;
    }
    let second = field(17, 2)?;
    if second > 59 {
        return None;
    }
    let mut rest = b.get(19..)?;
    let mut nanos = 0;
    if let Some(fraction) = rest.strip_prefix(b".") {
        let digits = fraction.iter().take_while(|c| c.is_ascii_digit()).count();
        if !(1..=9).contains(&digits) {
            return None;
        }
        nanos = ascii_number(&fraction[..digits])? * 10u32.pow(9 - digits as u32);
        rest = &fraction[digits..];
    }
    let offset = match rest {
        b"Z" => 0,
        [sign @ (b'+' | b'-'), h1, h2, b':', m1, m2] => {
            let hours = i64::from(ascii_number(&[*h1, *h2])?);
            let minutes = i64::from(ascii_number(&[*m1, *m2])?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            if *sign == b'-' {
                -(hours * 60 + minutes)
            } else {
                hours * 60 + minutes
            }
        }
        _ => return None,
    };
    let seconds = day_number * 86_400 + hour * 3600 + minute * 60 + second - offset * 60;
    Some(TimeValue {
        form: TimeForm::Instant,
        day_number,
        place: (seconds, nanos),
    })
}

/// A field that holds a time of one of `forms`; the error names them, as
/// the browser's `readTime` does.
fn read_time(value: Option<&Value>, forms: &[TimeForm], field: &str) -> Result<TimeValue, String> {
    value
        .and_then(Value::as_str)
        .and_then(parse_time_value)
        .filter(|time| forms.contains(&time.form))
        .ok_or_else(|| {
            let forms: Vec<&str> = forms.iter().map(|form| form.text()).collect();
            format!(
                "{field} must be {} in the years 1970-2199",
                forms.join(" or ")
            )
        })
}

// ---- personal-assistant types -------------------------------------------------
//
// calendar, tasks, timer, weather and inbox (docs/display-tool.md,
// "Personal-assistant types"). Each item id is checked as a diagram node id
// is (non-blank, <= 128 UTF-16 units) and is unique in its list; the
// browser's validators hold the same rules in the same order.

/// The scene-frame text every type may carry, checked last.
fn copy_frame_text(
    data: &Map<String, Value>,
    out: &mut Map<String, Value>,
    kind: &str,
) -> Result<(), String> {
    for key in ["title", "subtitle", "context"] {
        copy_optional_string(data, out, key, 256, &format!("{kind}.{key}"))?;
    }
    copy_optional_string(data, out, "caption", 128, &format!("{kind}.caption"))
}

fn required_string<'a>(
    data: &'a Map<String, Value>,
    key: &str,
    max_len: usize,
    field: &str,
) -> Result<&'a str, String> {
    let text = data
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} must be a string"))?;
    if utf16_len(text) > max_len {
        return Err(format!(
            "{field} exceeds maximum length of {max_len} UTF-16 code units"
        ));
    }
    Ok(text)
}

fn copy_optional_bool(
    data: &Map<String, Value>,
    out: &mut Map<String, Value>,
    key: &str,
    field: &str,
) -> Result<(), String> {
    if let Some(value) = data.get(key) {
        let b = value
            .as_bool()
            .ok_or_else(|| format!("{field} must be boolean"))?;
        out.insert(key.into(), b.into());
    }
    Ok(())
}

/// An optional name from `allowed`; anything else, `null` included, is
/// `invalid {field}`.
fn copy_optional_name(
    data: &Map<String, Value>,
    out: &mut Map<String, Value>,
    key: &str,
    allowed: &[&str],
    field: &str,
) -> Result<(), String> {
    if let Some(value) = data.get(key) {
        let name = value
            .as_str()
            .filter(|name| allowed.contains(name))
            .ok_or_else(|| format!("invalid {field}"))?;
        out.insert(key.into(), name.into());
    }
    Ok(())
}

fn copy_number(
    data: &Map<String, Value>,
    out: &mut Map<String, Value>,
    key: &str,
    field: &str,
    required: bool,
) -> Result<(), String> {
    match data.get(key) {
        None if !required => Ok(()),
        value => {
            let number = value
                .filter(|v| v.as_f64().is_some_and(f64::is_finite))
                .ok_or_else(|| format!("{field} must be a finite number"))?;
            out.insert(key.into(), number.clone());
            Ok(())
        }
    }
}

fn copy_optional_percent(
    data: &Map<String, Value>,
    out: &mut Map<String, Value>,
    key: &str,
    field: &str,
) -> Result<(), String> {
    if let Some(value) = data.get(key) {
        if !value
            .as_f64()
            .is_some_and(|v| v.is_finite() && (0.0..=100.0).contains(&v))
        {
            return Err(format!("{field} must be a number from 0 to 100"));
        }
        out.insert(key.into(), value.clone());
    }
    Ok(())
}

/// An item's id: non-blank, within the id cap, and the first of its name in
/// `seen`.
fn check_item_id<'a>(
    item: &'a Map<String, Value>,
    seen: &mut HashSet<String>,
    context: &str,
) -> Result<&'a str, String> {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !is_blank(id) && utf16_len(id) <= MAX_ID_UTF16)
        .ok_or_else(|| {
            format!("{context} id must be non-empty and <= {MAX_ID_UTF16} UTF-16 code units")
        })?;
    if !seen.insert(id.to_string()) {
        return Err(format!("duplicate {context} id: {id}"));
    }
    Ok(id)
}

const CALENDAR_VIEWS: [&str; 4] = ["day", "week", "month", "agenda"];
const MAX_CALENDAR_EVENTS: usize = 200;
const CALENDAR_EVENT_STATUSES: [&str; 3] = ["confirmed", "tentative", "cancelled"];

fn validate_calendar_event(event: &Value, seen: &mut HashSet<String>) -> Result<Value, String> {
    let em = event
        .as_object()
        .ok_or("calendar event must be an object")?;
    check_unknown_keys(
        em,
        &[
            "id", "title", "start", "end", "location", "detail", "semantic", "status", "active",
        ],
        "calendar event",
    )?;
    let id = check_item_id(em, seen, "calendar event")?;
    let title = required_string(em, "title", 256, "calendar event.title")?;
    let both = [TimeForm::Date, TimeForm::Wall];
    let start = read_time(em.get("start"), &both, "calendar event.start")?;
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("title".into(), title.into());
    out.insert("start".into(), em["start"].clone());
    if let Some(end_value) = em.get("end") {
        let end = read_time(Some(end_value), &both, "calendar event.end")?;
        if end.form != start.form {
            return Err(
                "calendar event.end must be written like its start: both dates or both wall times"
                    .into(),
            );
        }
        if end.place < start.place {
            return Err("calendar event.end is before its start".into());
        }
        out.insert("end".into(), end_value.clone());
    }
    copy_optional_string(em, &mut out, "location", 128, "calendar event.location")?;
    copy_optional_string(em, &mut out, "detail", 256, "calendar event.detail")?;
    copy_optional_semantic(em, &mut out, "calendar event.semantic")?;
    copy_optional_name(
        em,
        &mut out,
        "status",
        &CALENDAR_EVENT_STATUSES,
        "calendar event.status",
    )?;
    copy_optional_bool(em, &mut out, "active", "calendar event.active")?;
    Ok(Value::Object(out))
}

fn validate_calendar_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &[
            "title", "subtitle", "context", "caption", "view", "start", "days", "today", "now",
            "events",
        ],
        "calendar data",
    )?;
    let view = data
        .get("view")
        .and_then(Value::as_str)
        .filter(|view| CALENDAR_VIEWS.contains(view))
        .ok_or("calendar.view must be one of day, week, month, agenda")?;
    read_time(data.get("start"), &[TimeForm::Date], "calendar.start")?;
    let mut out = Map::new();
    out.insert("view".into(), view.into());
    out.insert("start".into(), data["start"].clone());
    if let Some(days) = data.get("days") {
        // The most days a view may show; the day and month views take none.
        let max = match view {
            "week" => 7,
            "agenda" => 31,
            _ => return Err("calendar.days applies only to the week and agenda views".into()),
        };
        // An integer, as the browser's Number.isInteger counts it: 7.0 is one.
        if !days
            .as_f64()
            .is_some_and(|d| d.fract() == 0.0 && (1.0..=f64::from(max)).contains(&d))
        {
            return Err(format!(
                "calendar.days must be an integer from 1 to {max} on the {view} view"
            ));
        }
        out.insert("days".into(), days.clone());
    }
    let today = match data.get("today") {
        Some(value) => {
            let today = read_time(Some(value), &[TimeForm::Date], "calendar.today")?;
            out.insert("today".into(), value.clone());
            Some(today)
        }
        None => None,
    };
    if let Some(value) = data.get("now") {
        let now = read_time(Some(value), &[TimeForm::Wall], "calendar.now")?;
        if today.is_some_and(|today| today.day_number != now.day_number) {
            return Err("calendar.now must fall on calendar.today".into());
        }
        out.insert("now".into(), value.clone());
    }
    let events = data
        .get("events")
        .and_then(Value::as_array)
        .filter(|events| events.len() <= MAX_CALENDAR_EVENTS)
        .ok_or(format!(
            "calendar.events must be an array of at most {MAX_CALENDAR_EVENTS} items"
        ))?;
    let mut seen = HashSet::new();
    let events = events
        .iter()
        .map(|event| validate_calendar_event(event, &mut seen))
        .collect::<Result<Vec<_>, _>>()?;
    out.insert("events".into(), Value::Array(events));
    copy_frame_text(data, &mut out, "calendar")?;
    Ok(Value::Object(out))
}

const MAX_TASKS: usize = 100;
const TASK_STATES: [&str; 4] = ["todo", "active", "done", "blocked"];
const TASK_PRIORITIES: [&str; 2] = ["high", "low"];
const MAX_TASK_TAGS: usize = 4;
const MAX_TASK_TAG_UTF16: usize = 32;

fn validate_task(task: &Value, seen: &mut HashSet<String>) -> Result<Value, String> {
    let tm = task.as_object().ok_or("task must be an object")?;
    check_unknown_keys(
        tm,
        &[
            "id", "text", "state", "due", "priority", "group", "detail", "tags",
        ],
        "task",
    )?;
    let id = check_item_id(tm, seen, "task")?;
    let text = required_string(tm, "text", 256, "task.text")?;
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("text".into(), text.into());
    copy_optional_name(tm, &mut out, "state", &TASK_STATES, "task.state")?;
    if let Some(due) = tm.get("due") {
        read_time(Some(due), &[TimeForm::Date, TimeForm::Wall], "task.due")?;
        out.insert("due".into(), due.clone());
    }
    copy_optional_name(tm, &mut out, "priority", &TASK_PRIORITIES, "task.priority")?;
    copy_optional_string(tm, &mut out, "group", 128, "task.group")?;
    copy_optional_string(tm, &mut out, "detail", 256, "task.detail")?;
    if let Some(tags) = tm.get("tags") {
        let list = tags
            .as_array()
            .filter(|tags| tags.len() <= MAX_TASK_TAGS)
            .ok_or(format!(
                "task.tags must be an array of at most {MAX_TASK_TAGS} strings"
            ))?;
        for tag in list {
            let text = tag.as_str().ok_or("task tag must be a string")?;
            if utf16_len(text) > MAX_TASK_TAG_UTF16 {
                return Err(format!(
                    "task tag exceeds maximum length of {MAX_TASK_TAG_UTF16} UTF-16 code units"
                ));
            }
        }
        out.insert("tags".into(), tags.clone());
    }
    Ok(Value::Object(out))
}

fn validate_tasks_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &["title", "subtitle", "context", "caption", "today", "items"],
        "tasks data",
    )?;
    let mut out = Map::new();
    if let Some(today) = data.get("today") {
        read_time(Some(today), &[TimeForm::Date], "tasks.today")?;
        out.insert("today".into(), today.clone());
    }
    let items = data
        .get("items")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= MAX_TASKS)
        .ok_or(format!(
            "tasks.items must be an array of 1 to {MAX_TASKS} items"
        ))?;
    let mut seen = HashSet::new();
    let items = items
        .iter()
        .map(|task| validate_task(task, &mut seen))
        .collect::<Result<Vec<_>, _>>()?;
    out.insert("items".into(), Value::Array(items));
    copy_frame_text(data, &mut out, "tasks")?;
    Ok(Value::Object(out))
}

const MAX_TIMERS: usize = 8;
const TIMER_STATES: [&str; 2] = ["running", "paused"];

fn validate_timer(timer: &Value, seen: &mut HashSet<String>) -> Result<Value, String> {
    let tm = timer.as_object().ok_or("timer must be an object")?;
    check_unknown_keys(
        tm,
        &["id", "label", "endsAt", "startedAt", "state", "remaining"],
        "timer",
    )?;
    let id = check_item_id(tm, seen, "timer")?;
    let label = required_string(tm, "label", 128, "timer.label")?;
    let ends_at = read_time(tm.get("endsAt"), &[TimeForm::Instant], "timer.endsAt")?;
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("label".into(), label.into());
    out.insert("endsAt".into(), tm["endsAt"].clone());
    if let Some(value) = tm.get("startedAt") {
        let started_at = read_time(Some(value), &[TimeForm::Instant], "timer.startedAt")?;
        if started_at.place >= ends_at.place {
            return Err("timer.startedAt must be before timer.endsAt".into());
        }
        out.insert("startedAt".into(), value.clone());
    }
    copy_optional_name(tm, &mut out, "state", &TIMER_STATES, "timer.state")?;
    // A running timer is counted down on the page clock; a paused one is
    // not, so it says how much is left, and a running one may not.
    let paused = tm.get("state").and_then(Value::as_str) == Some("paused");
    match tm.get("remaining") {
        None if paused => return Err("timer.remaining is required when the timer is paused".into()),
        None => {}
        Some(_) if !paused => return Err("timer.remaining is only for a paused timer".into()),
        Some(remaining) => {
            if !remaining
                .as_f64()
                .is_some_and(|seconds| seconds.is_finite() && seconds >= 0.0)
            {
                return Err("timer.remaining must be a number of seconds, 0 or more".into());
            }
            out.insert("remaining".into(), remaining.clone());
        }
    }
    Ok(Value::Object(out))
}

fn validate_timer_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &["title", "subtitle", "context", "caption", "timers"],
        "timer data",
    )?;
    let timers = data
        .get("timers")
        .and_then(Value::as_array)
        .filter(|timers| !timers.is_empty() && timers.len() <= MAX_TIMERS)
        .ok_or(format!(
            "timer.timers must be an array of 1 to {MAX_TIMERS} items"
        ))?;
    let mut seen = HashSet::new();
    let timers = timers
        .iter()
        .map(|timer| validate_timer(timer, &mut seen))
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Map::new();
    out.insert("timers".into(), Value::Array(timers));
    copy_frame_text(data, &mut out, "timer")?;
    Ok(Value::Object(out))
}

const WEATHER_CONDITIONS: [&str; 13] = [
    "clear",
    "partly-cloudy",
    "cloudy",
    "fog",
    "drizzle",
    "rain",
    "heavy-rain",
    "thunder",
    "snow",
    "sleet",
    "hail",
    "wind",
    "haze",
];
const MAX_WEATHER_HOURS: usize = 48;
const MAX_WEATHER_DAYS: usize = 14;

fn copy_condition(
    data: &Map<String, Value>,
    out: &mut Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    let condition = data
        .get("condition")
        .and_then(Value::as_str)
        .filter(|condition| WEATHER_CONDITIONS.contains(condition))
        .ok_or_else(|| format!("{field} must be one of {}", WEATHER_CONDITIONS.join(", ")))?;
    out.insert("condition".into(), condition.into());
    Ok(())
}

fn validate_weather_current(current: Option<&Value>) -> Result<Value, String> {
    let cm = current
        .and_then(Value::as_object)
        .ok_or("weather.current must be an object")?;
    check_unknown_keys(
        cm,
        &[
            "temp",
            "condition",
            "summary",
            "high",
            "low",
            "feelsLike",
            "humidity",
            "precip",
            "wind",
        ],
        "weather current",
    )?;
    let mut out = Map::new();
    copy_number(cm, &mut out, "temp", "weather current.temp", true)?;
    copy_condition(cm, &mut out, "weather current.condition")?;
    copy_optional_string(cm, &mut out, "summary", 256, "weather current.summary")?;
    copy_number(cm, &mut out, "high", "weather current.high", false)?;
    copy_number(cm, &mut out, "low", "weather current.low", false)?;
    copy_number(
        cm,
        &mut out,
        "feelsLike",
        "weather current.feelsLike",
        false,
    )?;
    copy_optional_percent(cm, &mut out, "humidity", "weather current.humidity")?;
    copy_optional_percent(cm, &mut out, "precip", "weather current.precip")?;
    copy_optional_string(cm, &mut out, "wind", 128, "weather current.wind")?;
    Ok(Value::Object(out))
}

fn validate_weather_hour(hour: &Value, seen: &mut HashSet<String>) -> Result<Value, String> {
    let hm = hour.as_object().ok_or("weather hour must be an object")?;
    check_unknown_keys(hm, &["time", "temp", "condition", "precip"], "weather hour")?;
    read_time(hm.get("time"), &[TimeForm::Wall], "weather hour.time")?;
    let time = hm["time"].as_str().unwrap_or_default();
    // A note names an hour by its time, so no two hours share one.
    if !seen.insert(time.to_string()) {
        return Err(format!("duplicate weather hour: {time}"));
    }
    let mut out = Map::new();
    out.insert("time".into(), time.into());
    copy_number(hm, &mut out, "temp", "weather hour.temp", true)?;
    copy_condition(hm, &mut out, "weather hour.condition")?;
    copy_optional_percent(hm, &mut out, "precip", "weather hour.precip")?;
    Ok(Value::Object(out))
}

fn validate_weather_day(day: &Value, seen: &mut HashSet<String>) -> Result<Value, String> {
    let dm = day.as_object().ok_or("weather day must be an object")?;
    check_unknown_keys(
        dm,
        &["date", "high", "low", "condition", "precip"],
        "weather day",
    )?;
    read_time(dm.get("date"), &[TimeForm::Date], "weather day.date")?;
    let date = dm["date"].as_str().unwrap_or_default();
    // A note names a day by its date, so no two days share one.
    if !seen.insert(date.to_string()) {
        return Err(format!("duplicate weather day: {date}"));
    }
    let mut out = Map::new();
    out.insert("date".into(), date.into());
    copy_number(dm, &mut out, "high", "weather day.high", true)?;
    copy_number(dm, &mut out, "low", "weather day.low", true)?;
    copy_condition(dm, &mut out, "weather day.condition")?;
    copy_optional_percent(dm, &mut out, "precip", "weather day.precip")?;
    Ok(Value::Object(out))
}

fn validate_weather_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &[
            "title", "subtitle", "context", "caption", "location", "units", "current", "hourly",
            "daily", "alert",
        ],
        "weather data",
    )?;
    let location = required_string(data, "location", 128, "weather.location")?;
    let units = data
        .get("units")
        .and_then(Value::as_str)
        .filter(|units| matches!(*units, "C" | "F"))
        .ok_or("weather.units must be \"C\" or \"F\"")?;
    let current = validate_weather_current(data.get("current"))?;
    let mut out = Map::new();
    out.insert("location".into(), location.into());
    out.insert("units".into(), units.into());
    out.insert("current".into(), current);
    if let Some(hourly) = data.get("hourly") {
        let hours = hourly
            .as_array()
            .filter(|hours| hours.len() <= MAX_WEATHER_HOURS)
            .ok_or(format!(
                "weather.hourly must be an array of at most {MAX_WEATHER_HOURS} items"
            ))?;
        let mut seen = HashSet::new();
        let hours = hours
            .iter()
            .map(|hour| validate_weather_hour(hour, &mut seen))
            .collect::<Result<Vec<_>, _>>()?;
        out.insert("hourly".into(), Value::Array(hours));
    }
    if let Some(daily) = data.get("daily") {
        let days = daily
            .as_array()
            .filter(|days| days.len() <= MAX_WEATHER_DAYS)
            .ok_or(format!(
                "weather.daily must be an array of at most {MAX_WEATHER_DAYS} items"
            ))?;
        let mut seen = HashSet::new();
        let days = days
            .iter()
            .map(|day| validate_weather_day(day, &mut seen))
            .collect::<Result<Vec<_>, _>>()?;
        out.insert("daily".into(), Value::Array(days));
    }
    copy_optional_string(data, &mut out, "alert", 256, "weather.alert")?;
    copy_frame_text(data, &mut out, "weather")?;
    Ok(Value::Object(out))
}

const MAX_INBOX_MESSAGES: usize = 50;
const MAX_INBOX_CHANNEL_UTF16: usize = 32;

fn validate_inbox_message(message: &Value, seen: &mut HashSet<String>) -> Result<Value, String> {
    let mm = message
        .as_object()
        .ok_or("inbox message must be an object")?;
    check_unknown_keys(
        mm,
        &[
            "id", "from", "subject", "snippet", "time", "channel", "unread", "flagged", "semantic",
        ],
        "inbox message",
    )?;
    let id = check_item_id(mm, seen, "inbox message")?;
    let from = required_string(mm, "from", 128, "inbox message.from")?;
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("from".into(), from.into());
    copy_optional_string(mm, &mut out, "subject", 256, "inbox message.subject")?;
    copy_optional_string(mm, &mut out, "snippet", 256, "inbox message.snippet")?;
    read_time(
        mm.get("time"),
        &[TimeForm::Date, TimeForm::Wall],
        "inbox message.time",
    )?;
    out.insert("time".into(), mm["time"].clone());
    copy_optional_string(
        mm,
        &mut out,
        "channel",
        MAX_INBOX_CHANNEL_UTF16,
        "inbox message.channel",
    )?;
    copy_optional_bool(mm, &mut out, "unread", "inbox message.unread")?;
    copy_optional_bool(mm, &mut out, "flagged", "inbox message.flagged")?;
    copy_optional_semantic(mm, &mut out, "inbox message.semantic")?;
    Ok(Value::Object(out))
}

fn validate_inbox_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &[
            "title", "subtitle", "context", "caption", "today", "messages",
        ],
        "inbox data",
    )?;
    let mut out = Map::new();
    if let Some(today) = data.get("today") {
        read_time(Some(today), &[TimeForm::Date], "inbox.today")?;
        out.insert("today".into(), today.clone());
    }
    let messages = data
        .get("messages")
        .and_then(Value::as_array)
        .filter(|messages| !messages.is_empty() && messages.len() <= MAX_INBOX_MESSAGES)
        .ok_or(format!(
            "inbox.messages must be an array of 1 to {MAX_INBOX_MESSAGES} items"
        ))?;
    let mut seen = HashSet::new();
    let messages = messages
        .iter()
        .map(|message| validate_inbox_message(message, &mut seen))
        .collect::<Result<Vec<_>, _>>()?;
    out.insert("messages".into(), Value::Array(messages));
    copy_frame_text(data, &mut out, "inbox")?;
    Ok(Value::Object(out))
}

// ---- note ------------------------------------------------------------------

fn validate_note_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(data, &["tag", "segments", "caption", "anchor"], "note data")?;
    let segs_arr = data
        .get("segments")
        .and_then(Value::as_array)
        .ok_or("note.segments must be an array")?;
    let mut clean_segs = Vec::new();

    for seg in segs_arr {
        let sm = seg.as_object().ok_or("note segment must be an object")?;
        check_unknown_keys(sm, &["text", "accent", "bold", "semantic"], "note segment")?;

        let text = sm
            .get("text")
            .and_then(Value::as_str)
            .ok_or("note segment.text must be a string")?;
        if utf16_len(text) > 50_000 {
            return Err(
                "note segment.text exceeds maximum length of 50000 UTF-16 code units".into(),
            );
        }

        let mut seg_out = Map::new();
        seg_out.insert("text".into(), text.into());

        if let Some(accent) = sm.get("accent") {
            let b = accent
                .as_bool()
                .ok_or("note segment.accent must be boolean")?;
            seg_out.insert("accent".into(), b.into());
        }
        if let Some(bold) = sm.get("bold") {
            let b = bold.as_bool().ok_or("note segment.bold must be boolean")?;
            seg_out.insert("bold".into(), b.into());
        }
        copy_optional_semantic(sm, &mut seg_out, "note segment.semantic")?;
        clean_segs.push(Value::Object(seg_out));
    }

    let mut out = Map::new();
    out.insert("segments".into(), Value::Array(clean_segs));

    if let Some(tag) = data.get("tag") {
        let t = tag.as_str().ok_or("note.tag must be a string")?;
        if utf16_len(t) > 128 {
            return Err("note.tag exceeds maximum length of 128 UTF-16 code units".into());
        }
        out.insert("tag".into(), t.into());
    }
    copy_optional_string(data, &mut out, "caption", 128, "note.caption")?;

    if let Some(anchor_value) = data.get("anchor") {
        let anchor = anchor_value
            .as_object()
            .ok_or("note.anchor must be an object")?;
        check_unknown_keys(
            anchor,
            &["target", "x", "series", "node", "item"],
            "note anchor",
        )?;
        let target = anchor
            .get("target")
            .and_then(Value::as_str)
            .ok_or("note.anchor.target must be a non-empty identifier")?;
        let target = check_identifier(target, "note.anchor.target")?;
        let mut clean_anchor = Map::new();
        clean_anchor.insert("target".into(), target.into());
        if let Some(x) = anchor.get("x") {
            if !x.is_number() || !x.as_f64().is_some_and(f64::is_finite) {
                return Err("note.anchor.x must be a finite number".into());
            }
            clean_anchor.insert("x".into(), x.clone());
        }
        for key in ["series", "node"] {
            copy_optional_string(
                anchor,
                &mut clean_anchor,
                key,
                128,
                &format!("note.anchor.{key}"),
            )?;
        }
        // An item inside the target, named as the item names itself: an id,
        // or a forecast hour's `time` or day's `date`. Like `node` and
        // `series`, it is not looked up here: the note and its target are
        // separate objects, and the page marks the item only when the target
        // has one of that name.
        if let Some(item) = anchor.get("item") {
            let item = item
                .as_str()
                .filter(|item| !is_blank(item) && utf16_len(item) <= MAX_ID_UTF16)
                .ok_or_else(|| {
                    format!(
                        "note.anchor.item must be non-empty and <= {MAX_ID_UTF16} UTF-16 code units"
                    )
                })?;
            clean_anchor.insert("item".into(), item.into());
        }
        out.insert("anchor".into(), Value::Object(clean_anchor));
    }

    Ok(Value::Object(out))
}

/// The byte cap an action is held to: an image action is the one kind
/// allowed past the general cap, and its own fields are capped in
/// `validate_image_data`, so nothing else can ride in under its limit.
fn action_size_cap(action: &Value) -> usize {
    let is_image_show = action.get("op").and_then(Value::as_str) == Some("show")
        && action.get("type").and_then(Value::as_str) == Some("image");
    if is_image_show {
        MAX_IMAGE_ACTION_BYTES
    } else {
        MAX_ACTION_BYTES
    }
}

/// The bytes of `value` as the browser's `JSON.stringify` writes it, in
/// UTF-8: what both validators hold to the size cap (docs/display-tool.md,
/// "How the two validators agree"). serde_json's own output is not measured,
/// because it spells some numbers differently (`1.0` and `1e+16` where
/// JSON.stringify writes `1` and `10000000000000000`).
fn json_len(value: &Value) -> usize {
    match value {
        Value::Null | Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(n) => js_number_len(n),
        Value::String(s) => json_string_len(s),
        Value::Array(items) => {
            2 + items.len().saturating_sub(1) + items.iter().map(json_len).sum::<usize>()
        }
        Value::Object(m) => {
            2 + m.len().saturating_sub(1)
                + m.iter()
                    .map(|(key, value)| json_string_len(key) + 1 + json_len(value))
                    .sum::<usize>()
        }
    }
}

/// A string's bytes in JSON: two quotes, its UTF-8, and the escapes
/// JSON.stringify writes (`\"`, `\\`, `\b \f \n \r \t`, and `\u00XX` for
/// the other control characters).
fn json_string_len(s: &str) -> usize {
    2 + s
        .chars()
        .map(|c| match c {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            c if u32::from(c) < 0x20 => 6,
            c => c.len_utf8(),
        })
        .sum::<usize>()
}

/// The length of `n` as JavaScript writes a number (Number::toString): the
/// shortest digits that read back as the same double, written plainly from
/// 1e-6 up to 1e21 and with an exponent outside that (`1e+21`, `1.5e-7`);
/// zero, `-0` too, is `0`. serde_json already finds the shortest digits;
/// only where it puts the point differs, so its text is re-spelled here.
fn js_number_len(n: &serde_json::Number) -> usize {
    let value = n.as_f64().unwrap_or(0.0);
    if value == 0.0 {
        return 1;
    }
    let text = serde_json::Number::from_f64(value.abs())
        .map(|shortest| shortest.to_string())
        .unwrap_or_default();
    let (mantissa, exponent) = match text.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i64>().unwrap_or(0)),
        None => (text.as_str(), 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let all_digits = format!("{whole}{fraction}");
    let significant = all_digits.trim_start_matches('0');
    let leading_zeros = (all_digits.len() - significant.len()) as i64;
    // The value is 0.<digits> times ten to the `point`.
    let digits = significant.trim_end_matches('0').len() as i64;
    let point = whole.len() as i64 + exponent - leading_zeros;
    let spelled = if digits <= point && point <= 21 {
        point
    } else if 0 < point && point <= 21 {
        digits + 1
    } else if -6 < point && point <= 0 {
        2 - point + digits
    } else {
        // d[.ddd]e+N or e-N
        let exponent_len = 2 + (point - 1).unsigned_abs().to_string().len() as i64;
        digits + i64::from(digits > 1) + exponent_len
    };
    spelled as usize + usize::from(value < 0.0)
}

/// Checks one display action and returns it normalized. The checks run in
/// the browser's order (docs/display-tool.md, "How the two validators
/// agree"): an object, within its size cap, with a known `op`; then no
/// layout key, no unsafe string and no non-finite number anywhere in it;
/// then the op's own rules; and last the normalized action, which may have
/// gained a field (a say's `at: null`), is held to the same cap.
pub fn validate_action(action: &Value) -> Result<Value, String> {
    let map = action.as_object().ok_or("action must be an object")?;
    let size_cap = action_size_cap(action);
    if json_len(action) > size_cap {
        return Err("action exceeds size limit".into());
    }
    let op = map
        .get("op")
        .and_then(Value::as_str)
        .filter(|op| matches!(*op, "show" | "hide" | "focus" | "say" | "clear"))
        .ok_or("unknown operation")?;

    if let Some(k) = forbidden_layout(action) {
        return Err(format!("model-controlled layout field is forbidden: {k}"));
    }

    check_unsafe_string(action)?;

    if !finite(action) {
        return Err("action contains a non-finite number".into());
    }

    let mut out = Map::new();

    match op {
        "show" => {
            check_unknown_keys(map, &["op", "id", "type", "role", "data"], "show action")?;

            let id_str = map
                .get("id")
                .and_then(Value::as_str)
                .ok_or("show.id must be a non-empty identifier")?;
            let clean_id = check_identifier(id_str, "show.id")?;

            let ty = map
                .get("type")
                .and_then(Value::as_str)
                .ok_or("show.type is unknown")?;
            if !CONTENT_TYPES.contains(&ty) {
                return Err("show.type is unknown".into());
            }

            let role_opt = if let Some(r) = map.get("role") {
                let role_str = r.as_str().ok_or("show.role is unknown")?;
                if !matches!(role_str, "primary" | "compare" | "secondary" | "ambient") {
                    return Err("show.role is unknown".into());
                }
                Some(role_str.to_string())
            } else {
                None
            };

            let data_obj = map
                .get("data")
                .and_then(Value::as_object)
                .ok_or("show.data must be an object")?;

            let clean_data = match ty {
                "chart" => validate_chart_data(data_obj)?,
                "metric" => validate_metric_data(data_obj)?,
                "progress" => validate_progress_data(data_obj)?,
                "diagram" => validate_diagram_data(data_obj)?,
                "document" => validate_document_data(data_obj)?,
                "code" => validate_code_data(data_obj)?,
                "table" => validate_table_data(data_obj)?,
                "note" => validate_note_data(data_obj)?,
                "image" => validate_image_data(data_obj)?,
                "calendar" => validate_calendar_data(data_obj)?,
                "tasks" => validate_tasks_data(data_obj)?,
                "timer" => validate_timer_data(data_obj)?,
                "weather" => validate_weather_data(data_obj)?,
                "inbox" => validate_inbox_data(data_obj)?,
                _ => return Err("show.type is unknown".into()),
            };

            out.insert("op".into(), "show".into());
            out.insert("id".into(), clean_id.into());
            out.insert("type".into(), ty.into());
            if let Some(r) = role_opt {
                out.insert("role".into(), r.into());
            }
            out.insert("data".into(), clean_data);
        }
        "hide" => {
            check_unknown_keys(map, &["op", "id"], "hide action")?;
            let id_str = map
                .get("id")
                .and_then(Value::as_str)
                .ok_or("hide.id must be a non-empty identifier")?;
            let clean_id = check_identifier(id_str, "hide.id")?;
            out.insert("op".into(), "hide".into());
            out.insert("id".into(), clean_id.into());
        }
        "focus" => {
            check_unknown_keys(map, &["op", "id"], "focus action")?;
            let id_str = map
                .get("id")
                .and_then(Value::as_str)
                .ok_or("focus.id must be a non-empty identifier")?;
            let clean_id = check_identifier(id_str, "focus.id")?;
            out.insert("op".into(), "focus".into());
            out.insert("id".into(), clean_id.into());
        }
        "say" => {
            check_unknown_keys(map, &["op", "text", "target", "at"], "say action")?;

            let text = map
                .get("text")
                .and_then(Value::as_str)
                .ok_or("say.text must be non-empty and within the text limit")?;
            if text.is_empty() || utf16_len(text) > MAX_TEXT_UTF16 {
                return Err("say.text must be non-empty and within the text limit".into());
            }

            out.insert("op".into(), "say".into());
            out.insert("text".into(), text.into());

            if let Some(t_val) = map.get("target") {
                if !t_val.is_null() {
                    let t_str = t_val
                        .as_str()
                        .ok_or("say.target must be a non-empty identifier")?;
                    let clean_target = check_identifier(t_str, "say.target")?;
                    out.insert("target".into(), clean_target.into());
                }
            }

            let at_val = match map.get("at") {
                None | Some(Value::Null) => Value::Null,
                Some(Value::Object(at_map)) => {
                    check_unknown_keys(at_map, &["x", "series"], "say.at")?;
                    let has_x = at_map.get("x").is_some();
                    let has_series = at_map.get("series").is_some();
                    if !has_x && !has_series {
                        return Err("say.at must contain at least one of x or series".into());
                    }
                    let mut at_clean = Map::new();
                    if let Some(x) = at_map.get("x") {
                        if !x.is_number() || !x.as_f64().is_some_and(f64::is_finite) {
                            return Err("say.at.x must be a finite number".into());
                        }
                        at_clean.insert("x".into(), x.clone());
                    }
                    if let Some(series) = at_map.get("series") {
                        let s = series.as_str().ok_or("say.at.series must be a string")?;
                        if utf16_len(s) > 128 {
                            return Err(
                                "say.at.series exceeds maximum length of 128 UTF-16 code units"
                                    .into(),
                            );
                        }
                        at_clean.insert("series".into(), s.into());
                    }
                    Value::Object(at_clean)
                }
                _ => return Err("say.at is invalid".into()),
            };
            out.insert("at".into(), at_val);
        }
        "clear" => {
            check_unknown_keys(map, &["op"], "clear action")?;
            out.insert("op".into(), "clear".into());
        }
        _ => return Err("unknown operation".into()),
    }

    let normalized = Value::Object(out);
    if json_len(&normalized) > size_cap {
        return Err("action exceeds size limit".into());
    }
    Ok(normalized)
}

#[cfg(test)]
#[path = "../tests/test_visual_protocol.rs"]
mod tests;
