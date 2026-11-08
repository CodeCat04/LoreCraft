//! The Settings tab and the Outside suggestions screen. The server itself is in `crate::mcp`.

use serde::Deserialize;
use serde_json::{json, Value};

use super::{ok, parse, unknown};
use crate::engine::Engine;
use crate::error::AppResult;
use crate::mcp::{self, suggest};
use crate::rpc::pages;

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "status" => Ok(mcp::status(engine)),
        "update" => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct P {
                enabled: Option<bool>,
                permission: Option<String>,
                share_local_only: Option<bool>,
            }
            let p: P = parse(params)?;
            mcp::update(engine, p.enabled, p.permission, p.share_local_only)?;
            Ok(mcp::status(engine))
        }
        "rotateToken" => {
            mcp::rotate_token(engine)?;
            Ok(mcp::status(engine))
        }
        "proposals" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                status: Option<String>,
            }
            let p: P = parse(params)?;
            let status = p.status.unwrap_or_else(|| suggest::STATUS_PENDING.to_string());
            ok(engine.read(|c| suggest::list(c, &status))?)
        }
        "proposalCount" => {
            // The badge asks whether or not a project is open.
            if engine.session().is_none() {
                return ok(0);
            }
            ok(engine.read(suggest::pending_count)?)
        }
        "proposalResolve" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                /// accepted or rejected from pending; applying from auto (the window picks it
                /// up); applied or failed from applying; undone from applied.
                status: String,
                /// The document an accepted edit replaced, so an open editor reloads it.
                target_kind: Option<String>,
                target_id: Option<String>,
                /// What Undo needs, kept with an applied change.
                undo: Option<Value>,
                /// Why it could not be applied, for the waiting tool call.
                error: Option<String>,
            }
            let p: P = parse(params)?;
            let mut extra = serde_json::Map::new();
            if let Some(undo) = p.undo {
                extra.insert("undo".into(), undo);
            }
            if let Some(error) = p.error {
                extra.insert("error".into(), Value::String(error));
            }
            let changed = engine.write(|tx| suggest::resolve_with(tx, &p.id, &p.status, &extra))?;
            if let (Some(kind), Some(id)) = (p.target_kind, p.target_id) {
                pages::notify_replaced(engine, &[(kind, id)]);
            }
            engine.notify("proposals");
            ok(json!({ "changed": changed }))
        }
        _ => Err(unknown(&format!("mcp.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::call;

    #[test]
    fn it_is_off_until_turned_on_and_a_token_appears_then() {
        let (engine, _host, _dir) = Engine::for_test();
        crate::mcp::attach(&engine);
        let status = call(&engine, "mcp.status", Value::Null);
        assert_eq!(status["enabled"], false);
        assert_eq!(status["running"], false);
        assert_eq!(status["permission"], "suggest");
        assert_eq!(status["shareLocalOnly"], false);

        let on = call(&engine, "mcp.update", json!({ "enabled": true }));
        assert_eq!(on["running"], true);
        let token = on["token"].as_str().unwrap().to_string();
        assert_eq!(token.len(), 64);

        let rotated = call(&engine, "mcp.rotateToken", Value::Null);
        assert_ne!(rotated["token"], Value::String(token));

        let off = call(&engine, "mcp.update", json!({ "enabled": false }));
        assert_eq!(off["running"], false);
        assert!(crate::mcp::config::read_discovery(&engine.paths).is_none());
        assert!(crate::rpc::dispatch(&engine, "mcp.update", json!({ "permission": "everything" })).is_err());
        let edit = call(&engine, "mcp.update", json!({ "permission": "edit" }));
        assert_eq!(edit["permission"], "edit");
    }

    #[test]
    fn counting_needs_no_project() {
        let (engine, _host, _dir) = Engine::for_test();
        assert_eq!(call(&engine, "mcp.proposalCount", Value::Null), 0);
    }
}
