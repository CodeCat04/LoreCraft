//! The one path every change from an outside tool takes.
//!
//! A write tool returns a `Draft`. `submit` checks it against the hard limits and stores it
//! as one row in `proposals`. At the "suggest" level it waits there for the writer. At the
//! "edit" level it is stored as `auto`, and the app's window picks it up, applies it with
//! the same code as Accept (`src/mcp/kinds/`), and marks it `applied` or `failed`. The call
//! waits for that, so the client hears "Done" or the real error. If the window does not
//! pick it up in time, the row goes back to `pending` as a normal suggestion.
//!
//! Statuses: pending -> accepted | rejected; auto -> applying -> applied | failed;
//! auto -> pending when the window does not answer; applied -> undone.

use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::config::PERMISSION_EDIT;
use super::limits;
use super::suggest::{self, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO, STATUS_FAILED, STATUS_PENDING};
use super::tools::Ctx;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

/// What a write tool wants to change, ready to store.
pub struct Draft {
    /// The proposal kind. The app must have a kind of the same name in `src/mcp/kinds/`.
    pub kind: &'static str,
    /// `page`, `node`, `book`, `meta` or None, with the id it names.
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    /// A short name for the list, such as the page or scene title.
    pub title: String,
    /// Everything the app needs to apply it, and to undo it: keep old values here.
    pub payload: Value,
    /// Said at the suggest level. `{id}` becomes the suggestion's id.
    pub suggested: String,
    /// Said after "Done: " once applied.
    pub done: String,
}

impl Draft {
    pub fn new(kind: &'static str, title: impl Into<String>, payload: Value) -> Self {
        let title = title.into();
        Self {
            kind,
            target_kind: None,
            target_id: None,
            suggested: format!(
                "Suggested a change to \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
            ),
            done: format!("changed \"{title}\"."),
            title,
            payload,
        }
    }

    pub fn target(mut self, kind: &str, id: impl Into<String>) -> Self {
        self.target_kind = Some(kind.to_string());
        self.target_id = Some(id.into());
        self
    }

    pub fn suggested(mut self, text: impl Into<String>) -> Self {
        self.suggested = text.into();
        self
    }

    pub fn done(mut self, text: impl Into<String>) -> Self {
        self.done = text.into();
        self
    }
}

/// What a write handler may use. Reading goes through a `Ctx`, so local-only content stays
/// hidden unless the writer shares it.
pub struct WriteCx<'a> {
    pub(super) engine: &'a Engine,
    pub client: &'a str,
    pub share: bool,
}

impl<'a> WriteCx<'a> {
    pub fn new(engine: &'a Engine, client: &'a str, share: bool) -> Self {
        Self { engine, client, share }
    }

    pub fn read<T>(&self, f: impl FnOnce(&Ctx) -> AppResult<T>) -> AppResult<T> {
        self.engine.read(|conn| {
            let ctx = Ctx::new(conn, String::new(), true, self.share)?;
            f(&ctx)
        })
    }
}

/// How long an edit-level call waits for the window.
#[derive(Clone, Copy)]
pub struct Waits {
    /// For the window to pick it up.
    pub claim: Duration,
    /// For it to be applied, counted from the start. Below the stdio bridge's 30 seconds.
    pub apply: Duration,
    pub poll: Duration,
}

impl Default for Waits {
    fn default() -> Self {
        Self {
            claim: Duration::from_secs(20),
            apply: Duration::from_secs(26),
            poll: Duration::from_millis(100),
        }
    }
}

pub const NO_WINDOW: &str = "LoreCraft's window did not respond, so nothing has changed yet. The change waits as a normal suggestion for the writer to review under Outside suggestions";

/// Stores a draft, and at the edit level waits for the app to apply it.
pub fn submit(engine: &Engine, client: &str, draft: Draft, permission: &str, waits: Waits) -> AppResult<String> {
    limits::check_draft(&draft)?;
    let auto = permission == PERMISSION_EDIT;
    let status = if auto { STATUS_AUTO } else { STATUS_PENDING };
    let id = suggest::insert(engine, client, &draft, status)?;
    if !auto {
        return Ok(draft.suggested.replace("{id}", &id));
    }
    wait(engine, &id, &draft, waits)
}

fn wait(engine: &Engine, id: &str, draft: &Draft, waits: Waits) -> AppResult<String> {
    let started = Instant::now();
    loop {
        thread::sleep(waits.poll);
        let Some((status, payload)) = engine.read(|c| suggest::status_of(c, id))? else {
            return Err(AppError::not_found("That change"));
        };
        let elapsed = started.elapsed();
        match status.as_str() {
            STATUS_APPLIED | "accepted" => return Ok(format!("Done: {}", draft.done)),
            STATUS_FAILED => {
                let reason = payload["error"].as_str().unwrap_or("it could not be applied.");
                return Err(AppError::new("NOT_APPLIED", format!("Nothing changed: {reason}")));
            }
            "rejected" => return Err(AppError::new("NOT_APPLIED", "The writer turned it down.")),
            STATUS_PENDING => return Ok(format!("{NO_WINDOW} (suggestion {id}).")),
            STATUS_AUTO if elapsed >= waits.claim => {
                if engine.write(|tx| suggest::back_to_pending(tx, id))? {
                    engine.notify("proposals");
                    return Ok(format!("{NO_WINDOW} (suggestion {id})."));
                }
            }
            STATUS_APPLYING if elapsed >= waits.apply => {
                return Ok(format!(
                    "LoreCraft is still applying it (suggestion {id}). The writer can see it under Outside suggestions."
                ))
            }
            _ => {}
        }
    }
}
