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
| `get_style_guide` | The project's style guide, if it has one |
| `list_canvases` | The project's canvases, by title |
| `get_canvas` | One canvas: an outline of its cards, then its JSON Canvas data |

Every page's status is stated, and the tool descriptions explain them:

- **canon** is established fact in this world.
- **draft** is still being written and may change.
- **idea** is a possibility that has not been decided.
- **retconned** is no longer true, kept only for reference.

Figures appear in plain text as lines such as `[Figure 2: The gate (Aria at dawn)]`.

Suggesting, with the app open:

| Tool | What it does |
|---|---|
| `propose_edit` | Suggests replacing a quoted part of a page or scene |
| `propose_new_page` | Suggests a new page, from a title, type, Markdown body and infobox fields |
| `add_idea` | Adds a short idea to your idea inbox, marked with the tool it came from. It changes no page or scene |

Pages are also offered as MCP resources (`lorecraft://page/<id>`), and there is a `catch_up` prompt.

## Suggestions

Nothing an outside AI does changes a document. When a tool suggests something, a button appears in
the top bar, and the suggestion waits under **AI > Outside suggestions**, showing what would change.

- **Accept** saves the old version in History first, then applies the change. Words the suggestion
  leaves alone keep their links and formatting, and figures and tables are not touched.
- If the quoted text has changed since, the suggestion says it is out of date and changes nothing.
- A new page always starts as a draft.
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
- **Permissions.** Choose **Read and suggest changes** (the default) or **Read only**.
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
| `src-tauri/src/mcp/tools.rs` | The read tools, on any `&Connection` |
| `src-tauri/src/mcp/suggest.rs` | Storing suggestions |
| `src-tauri/src/mcp/server.rs` | The protocol, through `rmcp`, and the stdio routing |
| `src-tauri/src/mcp/http.rs` | The local endpoint and its security checks |
| `src/mcp/apply.ts` | Applying an accepted edit to a document |
| `e2e/mcp.test.mjs` | Tests with a real MCP client against the real executable |
