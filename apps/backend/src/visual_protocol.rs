use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const MAX_ACTION_BYTES: usize = 48_000;
pub const MAX_ID_UTF16: usize = 128;
pub const MAX_TEXT_UTF16: usize = 50_000;
pub const RESERVED_ID_PREFIX: &str = "__runtime/";

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct DisplayRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub object_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct DisplayEnvelope {
    #[serde(default)]
    pub token: String,
    pub action: Value,
}

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

fn validate_chart_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &[
            "title",
            "subtitle",
            "context",
            "caption",
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

        let mut item = Map::new();
        item.insert("name".into(), name.into());
        item.insert("values".into(), Value::Array(values.clone()));
        if let Some(sem) = sm.get("semantic").and_then(Value::as_str) {
            if !is_valid_semantic(sem) {
                return Err("invalid series.semantic".into());
            }
            item.insert("semantic".into(), sem.into());
        }
        clean_series.push(Value::Object(item));
    }

    let mut out = Map::new();
    out.insert("series".into(), Value::Array(clean_series));

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
        &["label", "value", "semantic", "caption"],
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
    if let Some(sem) = data.get("semantic").and_then(Value::as_str) {
        if !is_valid_semantic(sem) {
            return Err("invalid metric.semantic".into());
        }
        out.insert("semantic".into(), sem.into());
    }
    copy_optional_string(data, &mut out, "caption", 128, "metric.caption")?;
    Ok(Value::Object(out))
}

/// A progress value is read as a 0-1 ratio when it is <= 1 and as a
/// 0-100 percentage above that; out-of-range values clamp to the nearest
/// end. `1` and `100` both land on a full bar.
fn normalize_progress_value(value: f64) -> Value {
    let bounded = value.clamp(0.0, 100.0);
    let ratio = if bounded > 1.0 {
        bounded / 100.0
    } else {
        bounded
    };
    ((ratio * 10000.0).round() / 10000.0).into()
}

fn validate_progress_data(data: &Map<String, Value>) -> Result<Value, String> {
    check_unknown_keys(
        data,
        &["label", "detail", "value", "text", "caption"],
        "progress data",
    )?;
    let label = data
        .get("label")
        .and_then(Value::as_str)
        .ok_or("progress.label must be a string")?;
    if utf16_len(label) > 128 {
        return Err("progress.label exceeds maximum length of 128 UTF-16 code units".into());
    }

    let val = data
        .get("value")
        .filter(|v| v.is_number() && v.as_f64().is_some_and(f64::is_finite))
        .ok_or("progress.value must be a finite number")?
        .as_f64()
        .unwrap();

    let mut out = Map::new();
    out.insert("label".into(), label.into());
    // Values arrive as either a 0-1 ratio or a 0-100 percentage; the
    // browser stores a 0-1 ratio, so the projection applies the same
    // normalization to keep both sides of the socket in agreement.
    out.insert("value".into(), normalize_progress_value(val));

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

fn validate_diagram_data(data: &Map<String, Value>) -> Result<Value, String> {
    if data.contains_key("source") {
        return Err("diagram data source field is forbidden in v1".into());
    }
    check_unknown_keys(
        data,
        &[
            "title", "subtitle", "context", "caption", "mode", "nodes", "edges",
        ],
        "diagram data",
    )?;

    let mode = data
        .get("mode")
        .and_then(Value::as_str)
        .ok_or("diagram.mode must be \"graph\"")?;
    if mode != "graph" {
        return Err("diagram.mode must be \"graph\"".into());
    }

    let nodes_arr = data
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or("diagram.nodes must be an array")?;
    if nodes_arr.is_empty() || nodes_arr.len() > 100 {
        return Err("diagram.nodes must be an array of 1 to 100 items".into());
    }

    let edges_arr = data
        .get("edges")
        .and_then(Value::as_array)
        .ok_or("diagram.edges must be an array")?;
    if edges_arr.len() > 200 {
        return Err("diagram.edges must be an array of at most 200 items".into());
    }

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
            .ok_or("diagram node.id must be a string")?;
        if id.trim().is_empty() || utf16_len(id) > 128 {
            return Err("diagram node id must be non-empty and <= 128 UTF-16 code units".into());
        }
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

        if let Some(sub) = nm.get("sub").and_then(Value::as_str) {
            if utf16_len(sub) > 256 {
                return Err(
                    "diagram node.sub exceeds maximum length of 256 UTF-16 code units".into(),
                );
            }
            node_out.insert("sub".into(), sub.into());
        }
        if let Some(detail) = nm.get("detail").and_then(Value::as_str) {
            if utf16_len(detail) > 256 {
                return Err(
                    "diagram node.detail exceeds maximum length of 256 UTF-16 code units".into(),
                );
            }
            node_out.insert("detail".into(), detail.into());
        }
        if let Some(sem) = nm.get("semantic").and_then(Value::as_str) {
            if !is_valid_semantic(sem) {
                return Err("invalid diagram node.semantic".into());
            }
            node_out.insert("semantic".into(), sem.into());
        }
        if let Some(st) = nm.get("state").and_then(Value::as_str) {
            if !matches!(st, "done" | "active" | "todo" | "blocked") {
                return Err("invalid diagram node.state".into());
            }
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

        let from = em
            .get("from")
            .and_then(Value::as_str)
            .ok_or("diagram edge.from must be a string")?;
        let to = em
            .get("to")
            .and_then(Value::as_str)
            .ok_or("diagram edge.to must be a string")?;

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

        if let Some(label) = em.get("label").and_then(Value::as_str) {
            if utf16_len(label) > 256 {
                return Err(
                    "diagram edge.label exceeds maximum length of 256 UTF-16 code units".into(),
                );
            }
            edge_out.insert("label".into(), label.into());
        }
        if let Some(sem) = em.get("semantic").and_then(Value::as_str) {
            if !is_valid_semantic(sem) {
                return Err("invalid diagram edge.semantic".into());
            }
            edge_out.insert("semantic".into(), sem.into());
        }
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
        let k = kind.as_str().ok_or("document.kind must be a string")?;
        if !matches!(k, "email" | "document") {
            return Err("invalid document.kind".into());
        }
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
        if let Some(sem) = sm.get("semantic").and_then(Value::as_str) {
            if !is_valid_semantic(sem) {
                return Err("invalid note segment.semantic".into());
            }
            seg_out.insert("semantic".into(), sem.into());
        }
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

pub fn validate_action(action: &Value) -> Result<Value, String> {
    let bytes = serde_json::to_vec(action).map_err(|_| "action must be valid JSON".to_string())?;
    if bytes.len() > MAX_ACTION_BYTES {
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
            if !matches!(
                ty,
                "chart" | "metric" | "progress" | "diagram" | "document" | "code" | "note"
            ) {
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
                "note" => validate_note_data(data_obj)?,
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
                    let t_str = t_val.as_str().ok_or("say.target is invalid")?;
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

pub fn validate(req: &DisplayRequest, raw: &Value) -> Result<Value, String> {
    if let Some(action) = &req.action {
        return validate_action(action);
    }

    // In legacy/transitional wire, raw is the direct action, but might contain "token" synthesized by to_value(&req).
    if let Value::Object(m) = raw {
        let mut clean = m.clone();
        clean.remove("token");
        validate_action(&Value::Object(clean))
    } else {
        validate_action(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::validate_action;
    use serde_json::{json, Value};

    #[test]
    fn normalizes_note_anchor_and_caption() {
        let action = json!({
            "op": "show",
            "id": "spike-note",
            "type": "note",
            "role": "secondary",
            "data": {
                "tag": "LOOK HERE",
                "caption": "ANNOTATION / VALIDATION SPIKE",
                "segments": [{"text": "Validation turns upward here."}],
                "anchor": {"target": "loss-chart", "x": 32, "series": "VAL LOSS"}
            }
        });

        assert_eq!(validate_action(&action), Ok(action));
    }

    #[test]
    fn rejects_note_anchor_without_a_target() {
        let action = json!({
            "op": "show",
            "id": "spike-note",
            "type": "note",
            "data": {
                "segments": [{"text": "No target."}],
                "anchor": {"x": 32}
            }
        });

        assert_eq!(
            validate_action(&action),
            Err("note.anchor.target must be a non-empty identifier".into())
        );
    }

    fn progress_value(value: Value) -> Value {
        let action = json!({
            "op": "show",
            "id": "deploy",
            "type": "progress",
            "data": { "label": "DEPLOY", "value": value, "text": "65% COMPLETE" }
        });
        match validate_action(&action) {
            Ok(normalized) => normalized["data"]["value"].clone(),
            Err(error) => panic!("expected progress action to validate, got: {error}"),
        }
    }

    #[test]
    fn normalizes_progress_percentage_values_to_ratios() {
        assert_eq!(progress_value(json!(65)), json!(0.65));
        assert_eq!(progress_value(json!(67)), json!(0.67));
        assert_eq!(progress_value(json!(100)), json!(1.0));
    }

    #[test]
    fn keeps_progress_ratio_values_and_clamps_out_of_range() {
        assert_eq!(progress_value(json!(0)), json!(0.0));
        assert_eq!(progress_value(json!(1)), json!(1.0));
        assert_eq!(progress_value(json!(150)), json!(1.0));
        assert_eq!(progress_value(json!(-3)), json!(0.0));
    }
}
