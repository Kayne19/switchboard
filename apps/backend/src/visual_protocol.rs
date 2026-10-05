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
pub const CONTENT_TYPES: [&str; 9] = [
    "chart", "metric", "progress", "diagram", "document", "code", "table", "note", "image",
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

fn check_identifier(s: &str, field_name: &str) -> Result<String, String> {
    if s.trim().is_empty() {
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
        Value::Object(m) => {
            for k in KEYS {
                if m.contains_key(*k) {
                    return Some(k);
                }
            }
            m.values().find_map(forbidden_layout)
        }
        Value::Array(a) => a.iter().find_map(forbidden_layout),
        _ => None,
    }
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
            if lower.contains("http://")
                || lower.contains("https://")
                || lower.contains("ftp://")
                || lower.starts_with("//")
                || lower.contains("//") && s.contains("://")
            {
                return Err("external resource URL is forbidden".to_string());
            }
            Ok(())
        }
        Value::Object(m) => {
            for val in m.values() {
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
    for k in m.keys() {
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
            .filter(|id| !id.trim().is_empty() && utf16_len(id) <= 128)
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
        if id.trim().is_empty() || utf16_len(id) > 128 {
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
    // Unicode White_Space only; the browser's `isBlank` uses the same set.
    if alt.chars().all(char::is_whitespace) {
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
        check_unknown_keys(anchor, &["target", "x", "series", "node"], "note anchor")?;
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

pub fn validate_action(action: &Value) -> Result<Value, String> {
    let bytes = serde_json::to_vec(action).map_err(|_| "action must be valid JSON".to_string())?;
    if bytes.len() > action_size_cap(action) {
        return Err("action exceeds size limit".into());
    }

    let map = action.as_object().ok_or("action must be an object")?;

    if let Some(k) = forbidden_layout(action) {
        return Err(format!("model-controlled layout field is forbidden: {k}"));
    }

    check_unsafe_string(action)?;

    if !finite(action) {
        return Err("action contains a non-finite number".into());
    }

    let op = map
        .get("op")
        .and_then(Value::as_str)
        .ok_or("unknown operation")?;

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

    Ok(Value::Object(out))
}

#[cfg(test)]
#[path = "../tests/test_visual_protocol.rs"]
mod tests;
