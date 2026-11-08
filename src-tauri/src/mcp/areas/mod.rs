//! Every MCP tool, grouped by area. Each area is one file that declares its tools, their
//! schemas and their handlers, and lists them in `tools()`. The `areas!` line below is the
//! only place an area is registered. See "Adding an MCP tool" in docs/MCP.md.
//!
//! There are three kinds of handler:
//!
//! - `Read`: answers from a `Ctx`, which already hides local-only content. It works on the
//!   live project and on a saved file.
//! - `Write`: validates the arguments, resolves what they name through a `WriteCx`, and
//!   returns a `Draft`. It never changes anything itself. `crate::mcp::write::submit` stores
//!   the draft as a suggestion, and in edit mode waits while the app applies it.
//! - `Direct`: changes something at once, whatever the level, apart from read only. Only
//!   `add_idea` uses it, since an idea is the writer's own list to review. New tools use
//!   `Write`.

use serde_json::{json, Value};

use super::tools::Ctx;
use super::write::{Draft, WriteCx};
use crate::engine::Engine;
use crate::error::AppResult;

pub type ReadFn = fn(&Ctx, &Value) -> AppResult<String>;
pub type WriteFn = fn(&WriteCx, &Value) -> AppResult<Draft>;
pub type DirectFn = fn(&Engine, &str, &Value) -> AppResult<String>;

#[derive(Clone, Copy)]
pub enum Handler {
    Read(ReadFn),
    Write(WriteFn),
    Direct(DirectFn),
}

/// One tool as a client sees it, with the code that runs it.
pub struct Tool {
    pub name: &'static str,
    pub description: String,
    pub schema: Value,
    pub handler: Handler,
}

impl Tool {
    /// True for a tool that changes anything, so it needs the app and more than read only.
    pub fn writes(&self) -> bool {
        !matches!(self.handler, Handler::Read(_))
    }
}

pub fn read(name: &'static str, description: impl Into<String>, schema: Value, f: ReadFn) -> Tool {
    Tool { name, description: description.into(), schema, handler: Handler::Read(f) }
}

pub fn write(name: &'static str, description: impl Into<String>, schema: Value, f: WriteFn) -> Tool {
    Tool { name, description: description.into(), schema, handler: Handler::Write(f) }
}

pub fn direct(name: &'static str, description: impl Into<String>, schema: Value, f: DirectFn) -> Tool {
    Tool { name, description: description.into(), schema, handler: Handler::Direct(f) }
}

pub fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}

/// Declares the area modules and the order a client meets their tools. Adding an area is
/// one name here and one file beside this one.
macro_rules! areas {
    ($($area:ident),* $(,)?) => {
        $(pub mod $area;)*
        /// Every tool, in the order a client should meet them.
        pub fn all() -> Vec<Tool> {
            let mut tools = Vec::new();
            $(tools.extend($area::tools());)*
            tools
        }
    };
}

areas! {
    overview,
    lore,
    book,
    style,
    canvases,
    text_edits,
    book_edits,
    lore_edits,
}

pub fn find(name: &str) -> Option<Tool> {
    all().into_iter().find(|t| t.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn names_are_unique_and_schemas_are_objects() {
        let tools = all();
        let mut seen = HashSet::new();
        for tool in &tools {
            assert!(seen.insert(tool.name), "{} is declared twice", tool.name);
            assert_eq!(tool.schema["type"], "object", "{}", tool.name);
            assert!(!tool.description.is_empty(), "{}", tool.name);
        }
        assert_eq!(tools[0].name, "catch_me_up");
    }
}
