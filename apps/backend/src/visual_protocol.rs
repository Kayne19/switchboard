use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct DisplayRequest {
    pub op: String,
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub object_type: Option<String>,
    pub role: Option<String>,
    pub data: Option<Value>,
    pub text: Option<String>,
    pub target: Option<String>,
    pub at: Option<Value>,
    #[serde(default)]
    pub token: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn identifier(v: Option<&String>) -> bool {
    v.is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 128)
}
fn forbidden(v: &Value) -> Option<&'static str> {
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
            m.values().find_map(forbidden)
        }
        Value::Array(a) => a.iter().find_map(forbidden),
        _ => None,
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

pub fn validate(req: &DisplayRequest, raw: &Value) -> Result<Value, String> {
    if serde_json::to_vec(raw)
        .map_err(|_| "action must be valid JSON".to_string())?
        .len()
        > 256_000
    {
        return Err("action exceeds size limit".into());
    }
    if let Some(k) = forbidden(raw) {
        return Err(format!("model-controlled layout field is forbidden: {k}"));
    }
    let mut out = Map::new();
    match req.op.as_str() {
        "show" => {
            if !identifier(req.id.as_ref()) {
                return Err("show.id must be a non-empty identifier".into());
            }
            let ty = req.object_type.as_deref().ok_or("show.type is unknown")?;
            if !matches!(
                ty,
                "chart" | "metric" | "progress" | "diagram" | "document" | "code" | "note"
            ) {
                return Err("show.type is unknown".into());
            }
            if let Some(role) = &req.role {
                if !matches!(
                    role.as_str(),
                    "primary" | "compare" | "secondary" | "ambient"
                ) {
                    return Err("show.role is unknown".into());
                }
            }
            let data = req
                .data
                .as_ref()
                .filter(|v| v.is_object())
                .ok_or("show.data must be an object")?;
            if !finite(data) {
                return Err("data contains a non-finite number".into());
            }
            out.insert("op".into(), req.op.clone().into());
            out.insert("id".into(), req.id.clone().unwrap().into());
            out.insert("type".into(), ty.into());
            if let Some(role) = &req.role {
                out.insert("role".into(), role.clone().into());
            }
            out.insert("data".into(), data.clone());
        }
        "hide" | "focus" => {
            if !identifier(req.id.as_ref()) {
                return Err(format!("{}.id must be a non-empty identifier", req.op));
            }
            out.insert("op".into(), req.op.clone().into());
            out.insert("id".into(), req.id.clone().unwrap().into());
        }
        "say" => {
            let text = req
                .text
                .as_ref()
                .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 50_000)
                .ok_or("say.text must be non-empty and within the text limit")?;
            if let Some(t) = &req.target {
                if !identifier(Some(t)) {
                    return Err("say.target is invalid".into());
                }
            }
            if let Some(at) = &req.at {
                if !at.is_object() || !finite(at) {
                    return Err("say.at is invalid".into());
                }
                if let Some(m) = at.as_object() {
                    if m.keys().any(|k| k != "x" && k != "series") {
                        return Err("say.at is invalid".into());
                    }
                    if m.get("x").is_some_and(|x| !x.is_number())
                        || m.get("series").is_some_and(|x| !x.is_string())
                    {
                        return Err("say.at is invalid".into());
                    }
                }
            }
            out.insert("op".into(), req.op.clone().into());
            out.insert("text".into(), text.clone().into());
            if let Some(t) = &req.target {
                out.insert("target".into(), t.clone().into());
            }
            if let Some(a) = &req.at {
                out.insert("at".into(), a.clone());
            }
        }
        "clear" => {
            out.insert("op".into(), "clear".into());
        }
        _ => return Err("unknown operation".into()),
    }
    Ok(Value::Object(out))
}
