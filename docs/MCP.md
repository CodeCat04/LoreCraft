# Using LoreCraft from outside AI tools (MCP)

LoreCraft can act as an [MCP](https://modelcontextprotocol.io) server. That lets AI tools outside
the app, such as Claude Code, or OpenCode with a local model, read your lore and your book, and
suggest changes for you to accept or reject. One tool call, `catch_me_up`, gets a new AI up to
speed on your project.

It is off until you turn it on, and it can only be reached from your own computer.

## Turn it on

Open **Settings**, then **AI tools (MCP)**, and tick **Let outside AI tools connect**. That tab
shows ready-to-copy setup for your copy of LoreCraft and your current project. The examples below
show the same things with made-up paths.

## Connect Claude Code

Run this once in a terminal:

```
claude mcp add --scope user lorecraft -- "C:\Program Files\LoreCraft\lorecraft.exe" --mcp --project "C:\Books\My World.lorecraft"
```

Then start Claude Code and ask it to catch up on your book. `--scope user` makes it available in
every folder. Leave that out to set it up for the current folder only.

## Connect OpenCode

Add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "lorecraft": {
      "type": "local",
      "command": ["C:\\Program Files\\LoreCraft\\lorecraft.exe", "--mcp", "--project", "C:\\Books\\My World.lorecraft"],
      "enabled": true
    }
  }
}
```

A local model needs tool-calling support to use any of this. With llama.cpp that usually means
starting the server with `--jinja`. Check your server's documentation for how it handles tools.

## Connect anything else

Tools that run a local command use:

- Command: the path to `lorecraft.exe`
- Arguments: `--mcp --project "<path to your .lorecraft file>"`
- Transport: stdio

## Connecting directly over HTTP

Tools that prefer a URL can connect to the address in the Settings tab, with the token as a
bearer header. This only works while the app is open.

```
claude mcp add --scope user --transport http lorecraft http://127.0.0.1:47615/mcp --header "Authorization: Bearer YOUR-TOKEN"
```

```json
{
  "mcp": {
    "lorecraft": {
      "type": "remote",
      "url": "http://127.0.0.1:47615/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer YOUR-TOKEN" }
    }
  }
}
```

The command form is usually better, because it does not store the token in a config file, it
keeps working with the app closed, and it follows the port if it ever changes.

## What a tool sees

| LoreCraft is | The tool reads | Suggestions |
|---|---|---|
| Open with this project | Your live work, including edits you have not saved | Work |
| Open with a different project | The last saved version of the file you named with `--project` | Refused, with an explanation |
| Closed | The last saved version of the file you named with `--project` | Refused, with an explanation |

With the app closed, LoreCraft opens your file read-only and never writes to it. Each tool call
opens it and closes it again, so it cannot get in the way of saving.

If you leave out `--project`, the tool uses whatever project is open in LoreCraft, and has nothing
to read when the app is closed.

## Tools

Reading:

| Tool | What it gives |
|---|---|
| `catch_me_up` | The overview: books and their structure with word counts, the story so far, the main pages, and the style guide. Takes `max_chars` and says what was left out |
| `search_lore` | Full-text search of pages and scenes |
| `get_page` | One page by title or alias, with its status, aliases, categories, infobox, text and what links to it |
| `list_pages` | Pages, filtered by status, type or category |
| `get_outline` | Books, parts, chapters and scenes, with ids, and the plot threads |
| `get_scene` | One scene, with its point of view, location, cast, plot threads and date |
| `get_chapter` | A chapter, scene by scene, within a size limit |
| `get_timeline` | Dated scenes and pages |
| `get_relationships` | Recorded relationships between pages |
| `list_findings` | Consistency findings and their evidence |
| `get_style_guide` | The project's style guide, if it has one: each field by the name `set_style_guide` takes, then the text every AI is given |
| `get_settings_overview` | What the tool may do here: the permission level, whether local-only content is shared, and the project's language. It cannot change them |
| `list_canvases` | The project's canvases, by title |
| `get_canvas` | One canvas: an outline of its cards, then its JSON Canvas data |
| `list_writing_styles` | The writing styles, built-in and your own, with ids, and the style the project and each book use. Your own styles show only while the app is open |
| `get_writing_style` | One writing style: its description and the prompt the AI is given |
| `list_prompts` | The prompt library, built-in and your own, with ids, scope, action and text |
| `list_ideas` | Your idea inbox, newest first, with ids and status |
| `list_comments` | The comments on a page or scene: author, words, the passage, resolved or not |

Every page's status is stated, and the tool descriptions explain them:

- **canon** is established fact in this world.
- **draft** is still being written and may change.
- **idea** is a possibility that has not been decided.
- **retconned** is no longer true, kept only for reference.

Figures appear in plain text as lines such as `[Figure 2: The gate (Aria at dawn)]`.

Changing things, with the app open (see [Permission levels](#permission-levels)):

| Tool | What it does |
|---|---|
| `propose_edit` | Suggests replacing a quoted part of a page or scene |
| `propose_rewrite` | Suggests rewriting a passage, from `from_quote` to `to_quote`, or the whole scene with `whole: true` |
| `propose_insert` | Suggests new text at the `start` or `end` of a scene, or `after_quote` / `before_quote` |
| `propose_new_scene` | Suggests a new scene, after a scene or at the end of a chapter or book, with its text, synopsis, point of view, location and cast |
| `propose_new_chapter` | Suggests a new chapter with its first scene |
| `propose_scene_details` | Suggests changes to a scene's title, synopsis, point of view, location, cast, status, story date or notes |
| `propose_new_page` | Suggests a new page, from a title, type, Markdown body and infobox fields |
| `set_style_guide` | Replaces or adds to the project's style guide: free-form `text` (kept as voice notes) or any field, with `mode` `replace` or `append` |
| `add_idea` | Adds a short idea to your idea inbox, marked with the tool it came from. It changes no page or scene. Below the edit level it is added at once, as before; at the edit level it shows under Applied by outside AI, with Undo |
| `create_writing_style` | Creates one of your own writing styles, from a name with a prompt or traits, or as a blend of two or three styles |
| `update_writing_style` | Changes one of your own writing styles. Built-in styles cannot be changed |
| `delete_writing_style` | Deletes one of your own writing styles. Projects that use it keep their copy; Undo brings it back |
| `set_default_style` | Sets or clears the default style for the project, a book or a scene. A scene's choice wins over its book's, and a book's over the project's |
| `create_prompt` | Adds a prompt of your own to the prompt library |
| `update_prompt` | Changes one of your own prompts. Built-in prompts cannot be changed; Restore in the app is yours alone |
| `delete_prompt` | Deletes one of your own prompts. Undo makes it again |
| `update_idea` | Changes the text of an idea in your inbox |
| `resolve_idea` | Marks an idea done, or open again |
| `idea_to_page` | Turns an idea into a new page with status idea, the way the Inbox does, and marks the idea done |
| `add_comment` | Adds a comment, or a to-do, on a quoted passage of a page or scene. The text does not change |
| `resolve_comment` | Marks a comment resolved, or open again. The app has no replies, so there is no reply tool |

Pages are also offered as MCP resources (`lorecraft://page/<id>`), and there is a `catch_up` prompt.

## Writing with an outside AI

An outside AI can help write and revise the book itself, not only the wiki. Everything it writes
waits as a suggestion, so no .txt files need to go back and forth.

- **Add to a scene.** `propose_insert` with `at: "end"` continues a scene, and works on an empty one.
  `after_quote` or `before_quote` puts text beside a few quoted words. Text is Markdown, and a blank
  line starts a new paragraph.
- **Revise a long passage.** `propose_rewrite` takes a short `from_quote` where the passage starts
  and a `to_quote` where it ends, both included, so a model can rewrite twenty paragraphs without
  quoting them. `whole: true` replaces the whole scene, up to the usual size limit, which a
  10,000-word scene fits in.
- **Add scenes and chapters.** `propose_new_scene` and `propose_new_chapter` place new writing after
  a scene or chapter you name, or at the end. Point of view, location and cast are page titles.
- **Change a scene's details.** `propose_scene_details` gives only the fields to change.

Quotes are matched forgivingly but never guessed: curly and straight quotes, dashes typed as `--`,
`...` for `…`, line breaks, odd spaces and `*emphasis*` markers do not matter. A quote must still be
unique. If it is not found, the error shows the closest passage, so the model can try again.

Examples, as a model would call them:

```json
{ "tool": "propose_insert", "arguments": { "id": "<scene id>", "at": "end", "text": "Night came.\n\nAria lit the lamp." } }
{ "tool": "propose_rewrite", "arguments": { "id": "<scene id>", "from_quote": "Aria waited by", "to_quote": "as always.", "replacement": "New first paragraph.\n\nNew second paragraph." } }
{ "tool": "propose_new_scene", "arguments": { "title": "The river", "after": "<scene id>", "pov": "Aria Vance", "cast": ["Bren"], "text": "Water, everywhere." } }
{ "tool": "propose_scene_details", "arguments": { "id": "<scene id>", "synopsis": "Aria waits for Bren.", "status": "revised" } }
```

## Permission levels

Under **Settings > AI tools (MCP) > What outside tools can do** you choose one of three:

- **Read only.** Tools can read, and the tools that change things are not offered.
- **Read and suggest changes** (the default). Each change waits under Outside suggestions until you
  accept or reject it. Nothing changes before that.
- **Make changes directly.** Each change is made at once, through the same code as Accept, so the
  old version is in History first and an open page or scene shows the new text. The tool hears
  "Done" or the real reason it failed. Each change is announced, and listed under **Applied by
  outside AI** in Outside suggestions, with **Undo**. If LoreCraft's window does not respond within
  about 20 seconds, the change waits as a normal suggestion instead.

Undo puts back the version saved before a text change, the old values of details or the style
guide, or moves a new page, scene or chapter to the trash. If what it changed has been edited since,
Undo refuses and says so, so newer work is never lost. The top bar's count shows waiting
suggestions only, never changes already made.

At every level, no tool can change these permissions or any other setting, AI providers or keys,
spending limits, or what is local only. No tool can delete the project or write a file outside it.
Local-only content stays hidden unless you share it, and only so many changes can wait at once.
LoreCraft checks these itself; it does not rely on the AI behaving.

## Suggestions

At the suggest level, nothing an outside AI does changes a document. When a tool suggests something,
a button appears in the top bar, and the suggestion waits under **AI > Outside suggestions**, showing
what would change.

- **Accept** saves the old version in History first, then applies the change. Words the suggestion
  leaves alone keep their links and formatting, and figures and tables are not touched.
- **Review in the scene** opens the scene with the suggestion marked as tracked changes, one per
  changed stretch, so you can accept or reject each paragraph. The suggestion is done when none are
  left. Use it for long rewrites.
- If the scene has changed since, the suggestion is found again by its quotes. If they are gone, it
  says so and changes nothing. A whole-scene rewrite of a scene you have edited since can only be
  reviewed in the scene, so your edits are not undone in one click.
- A new page always starts as a draft. A new scene or chapter goes where the suggestion said, or at
  the end of its chapter if the scene it followed is gone.
- **Reject** dismisses it.

Suggestions are kept in the project, so they wait for you across restarts. You still save as usual.

If suggestions come often, press **Pin to top bar** on the list. The count then stays in the top
bar, even at none, and goes up as suggestions arrive. Clicking it opens the list in the pane beside
your writing. After you accept or reject one, the next one is ready, and a page named in a
suggestion opens in the other pane, so the list stays open. The pin is kept in your settings.

## Privacy and safety

- **Off by default.** With it off, nothing listens, and `--mcp` refuses every tool call.
- **This computer only.** It binds to `127.0.0.1`. A bearer token is required, and you can replace
  it. Requests from web pages are refused by checking `Origin` and `Host`, which also blocks DNS
  rebinding, so a site you visit cannot reach it.
- **Local-only content stays hidden.** Pages and scenes marked local only do not exist as far as a
  tool can tell, because the AI behind a tool may be a cloud model. **Share local-only content with
  outside tools** changes that.
- **Permissions.** Choose **Read only**, **Read and suggest changes** (the default), or **Make
  changes directly**. See [Permission levels](#permission-levels) for what no tool can do at any level.
- **Your text is data.** Tools are told to treat what they read as your material, not as instructions.
  Even so, remember that whatever a tool reads goes to the AI behind it.
- **The activity log holds no text.** The Settings tab lists which tools were called and when, in
  memory only. It never records your words.

The token and settings are in `mcp-settings.json` in LoreCraft's data folder. While the app is
serving, `mcp.json` there holds the port and token for the command form to find it. Both are readable
only by you where the system allows it: on Windows that comes from your user folder's permissions,
and elsewhere the files are private to your account. `mcp.json` is removed when the app exits, and a
copy left by a crash is ignored because nothing answers there.

## For developers

`lorecraft.exe --mcp [--project "<path>"]` is handled before Tauri starts, in `src-tauri/src/main.rs`.
It speaks MCP on stdin and stdout, and writes problems to stderr only. Release builds use the Windows
GUI subsystem, which has no console but still inherits the pipes a parent process provides.

Each tool call in that process decides where to go. If `mcp.json` names an app that answers and has
the right project open, the call is forwarded to it over Streamable HTTP. Otherwise it reads the file.

| Path | What it is |
|---|---|
| `src-tauri/src/mcp/areas/` | Every tool, one file per area, registered in `areas/mod.rs` |
| `src-tauri/src/mcp/tools.rs` | `Ctx` and the read tools' code, on any `&Connection` |
| `src-tauri/src/mcp/write.rs` | The one path a change takes: `Draft`, `WriteCx`, `submit` and the edit-level wait |
| `src-tauri/src/mcp/suggest.rs` | The `proposals` table, statuses, and helpers write tools share |
| `src-tauri/src/mcp/limits.rs` | What no tool may do, checked before anything is stored |
| `src-tauri/src/mcp/server.rs` | The protocol, through `rmcp`, and the stdio routing |
| `src-tauri/src/mcp/http.rs` | The local endpoint and its security checks |
| `src/mcp/kinds/` | Every kind of proposal: its card, apply and undo, registered in `kinds/index.ts` |
| `src/mcp/auto.ts` | The edit level: picks up changes and applies them |
| `src/mcp/apply.ts` | Applying a text change to a document without an editor |
| `e2e/mcp.test.mjs` | Tests with a real MCP client against the real executable |

## Adding an MCP tool

A tool is one Rust file in `src-tauri/src/mcp/areas/` and, if it changes anything, one proposal kind
in `src/mcp/kinds/`. Neither touches the shared server code. As an example, a tool that sets a page's
summary.

**1. The tool, in `src-tauri/src/mcp/areas/summaries.rs`:**

```rust
use serde_json::{json, Value};

use super::{write, Tool};
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{optional, reason, required};
use crate::mcp::tools::resolve_page;
use crate::mcp::write::{Draft, WriteCx};

pub fn tools() -> Vec<Tool> {
    vec![write(
        "set_page_summary",
        "Set a wiki page's one-line summary. Needs LoreCraft to be open with this project.",
        json!({ "type": "object", "properties": {
            "title": { "type": "string", "description": "The page title or an alias." },
            "summary": { "type": "string", "description": "The new summary." },
        }, "required": ["title", "summary"] }),
        set_page_summary,
    )]
}

/// Validates, resolves the target and builds the payload. It never changes anything.
fn set_page_summary(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let summary = required(args, "summary")?.trim().to_string();
    let (id, title, before) = cx.read(|ctx| {
        // Through `Ctx`, a local-only page does not exist unless the writer shares it.
        let id = resolve_page(ctx, args)?;
        let (title, before): (String, String) = ctx.conn.query_row(
            "SELECT title, summary FROM pages WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok((id, title, before))
    })?;
    if before == summary {
        return Err(AppError::invalid("Nothing would change."));
    }
    // Keep the old value, so Undo can put it back.
    let payload = json!({ "summary": summary, "before": before, "reason": reason(args) });
    Ok(Draft::new("pageSummary", title.clone(), payload)
        .target("page", id)
        .done(format!("set the summary of \"{title}\".")))
}
```

Then add `summaries,` to the `areas!` list in `areas/mod.rs`. A read tool uses `read(...)` with a
`fn(&Ctx, &Value) -> AppResult<String>` instead, and needs nothing in the app.

`submit` does the rest: the hard limits in `limits.rs`, the pending cap, storing the row, and at the
edit level waiting for the app. A tool that writes project meta must call `limits::check_meta_key`
(or put the key in the payload as `metaKey`); one that names a file must keep it inside the project
(`limits::check_project_path`, or a payload `path`).

**2. The kind, in `src/mcp/kinds/pageSummary.tsx`:**

```tsx
import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import type { AnyProposal } from '../api';
import { changedSince, DiffView } from './shared';
import { compareTexts } from '../../wiki/diff';
import { defineKind } from './types';

interface Payload { summary: string; before: string }

function Card({ proposal }: { proposal: AnyProposal<Payload> }) {
  return (
    <>
      <p className="mcp-proposal-title">{t('Summary of {title}', { title: proposal.title })}</p>
      <DiffView lines={compareTexts(proposal.payload.before, proposal.payload.summary)} />
    </>
  );
}

export const pageSummaryKind = defineKind<Payload>({
  kind: 'pageSummary',
  Card,
  // Accept and the edit level both run this. Do not resolve the proposal here.
  apply: async (p) => {
    await api.pages.update(p.targetId!, { summary: p.payload.summary });
    return { ok: true, target: { targetKind: 'page', targetId: p.targetId! } };
  },
  // Refuse if it changed since; otherwise put the old value back.
  undo: async (p) => {
    const page = await api.pages.get(p.targetId!);
    if (page.summary !== p.payload.summary) return { ok: false, reason: changedSince() };
    await api.pages.update(p.targetId!, { summary: p.payload.before });
    return { ok: true };
  },
  accepted: () => t('Summary changed.'),
});
```

Then add `pageSummaryKind` to `KINDS` in `kinds/index.ts`. `apply` may return `undo` data, which is
kept in the payload as `payload.undo` and passed to `undo` later; `shared.tsx` has `writeText` and
`undoText` for text changes (History revision before, fingerprint after) and `undoCreated` for
things made new (moved to the trash). Put translations in `src/locales/<code>/<your module>.json`, a
new file per area, so parallel work does not collide.

**3. Tests.** Rust: in your area file, a `#[cfg(test)]` module that calls
`crate::mcp::suggest::call(&engine, "c", "set_page_summary", &args, false)` and checks the stored
row with `suggest::list(conn, "pending")`; `call_as(..., "edit", waits)` with a thread playing the
window shows the edit level (see the tests in `suggest.rs`). The registry test in
`src/mcp/kinds.test.ts` fails if a Rust `Draft::new("kind", ...)` has no kind in the app. E2E in
`e2e/mcp.test.mjs`: set the level with the **What outside tools can do** select, call the tool
over HTTP, expect `Done: `, and press **Undo: <title>** under Applied by outside AI.
