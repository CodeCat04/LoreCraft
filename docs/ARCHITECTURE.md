# Architecture

Read this before changing code. It is the contract between modules.

## Overview

```
React UI (WebView2)                    Rust engine (src-tauri)
  src/lib/api.ts  --invoke('rpc')-->   rpc::dispatch -> module handlers -> SQLite
  src/ai/         --invoke('ai_stream') + Channel --> ai/ providers --> HTTP
                  <--events (project://status, data://changed)--
```

- All data access and all network traffic go through Rust. The web view has a
  strict CSP, no network access and no general filesystem access.
- API keys live in the OS credential store. They never reach JavaScript.
- Files can only be read or written at paths the user picked in a native dialog
  (`files.pickSave`, `files.pickOpen`, `files.pickFolder`). `files.readBytes` and
  `files.readText` refuse a file over 256 MB.
- A window only ever shows the app's own pages (`navigation_guard` in `lib.rs`). A link
  opens through `app.openExternal`, which takes only web addresses, so HTML from
  `renderMarkdownSafe` goes in an element with `followRenderedLink` from
  `src/editor/renderedLinks.ts` as its click handler.

## Source layout and ownership

| Path | Owner | Contents |
|---|---|---|
| `src-tauri/src/engine.rs`, `session.rs`, `db.rs`, `error.rs`, `paths.rs`, `content.rs`, `lib.rs` | foundation | Core. Change with care |
| `src-tauri/src/rpc/mod.rs` | foundation | Dispatch table, already routes every namespace |
| `src-tauri/src/rpc/project.rs`, `app.rs`, `settings.rs`, `files.rs` | foundation | Lifecycle |
| `src-tauri/src/rpc/pages.rs`, `search.rs`, `revisions.rs` | wiki | Wiki backend |
| `src-tauri/src/rpc/manuscript.rs` | write | Novel backend |
| `src-tauri/src/ai/`, `src-tauri/src/rpc/ai.rs` | ai | Providers, streaming, keys, conversations |
| `src-tauri/src/rpc/consistency.rs` | consistency | Findings storage |
| `src-tauri/src/rpc/snapshot.rs`, `import.rs`, `print.rs` | export | Whole-project read, bulk import, PDF |
| `src-tauri/src/rpc/extras.rs` | extras | Maps, relationships, dictionary |
| `src-tauri/src/rpc/ideas.rs` | inbox | The idea inbox |
| `src-tauri/src/rpc/family.rs` | extras | Relationship kinds, family fields kept in step, family tree data |
| `src-tauri/src/rpc/media.rs`, `media_protocol.rs` | media | Asset storage, uploads, the `lbasset` scheme |
| `src/canvas/`, `src-tauri/src/rpc/canvas.rs` | canvas | Canvases (JSON Canvas boards) and the `canvasEmbed` preview |
| `src-tauri/src/rpc/comments.rs` | notes | Comments and to-dos attached to text |
| `src-tauri/src/mcp/`, `src-tauri/src/rpc/mcp.rs`, `src/mcp/` | mcp | Server for AI tools outside the app, and the Outside suggestions screen. See `docs/MCP.md` |
| `src-tauri/src/embeddings/`, `src-tauri/src/rpc/embeddings.rs`, `src-tauri/minilm/`, `src/meaning/` | meaning | Search by meaning |
| `src-tauri/migrations/001_init.sql` | shared | Schema, sectioned by module |
| `src/lib/`, `src/state/`, `src/shell/`, `src/styles/` | foundation | Shared UI core |
| `src/editor/` | foundation | `RichEditor`, schema, conversions |
| `src/editor/ai/` | ai | Selection menu and tracked changes |
| `src/help/` | help | Shortcuts list, About, Getting started, sample world, first-run guide |
| `src/editor/find/` | find | Find and replace within the current editor |
| `src/editor/makePage/` | find | Linking selected text, or making a page from it |
| `src/inbox/` | inbox | Quick capture and the Inbox screen. `src/inbox/api.ts` is the way to add ideas |
| `src/editor/figure/`, `src/media/`, `src/lib/assets.ts` | media | Figures in the editor, drops, uploads, Insert commands |
| `src/wiki/`, `src/write/`, `src/ai/`, `src/consistency/`, `src/exporters/`, `src/extras/`, `src/settings/`, `src/facts/` | per module | Feature UI |
| `src/writingStyles/` | styles | The style library, prompts, blends, style guide and their screen |
| `src-tauri/src/logs.rs`, `updates.rs` | support | Log files and update checks |
| `src/editor/comments/`, `src/notes/` | notes | Comment marks, the margin, the list, `addComment` |
| `src/prose/` | notes | Prose checks with no AI (in a worker), and read-aloud |
| `src/plan/` | plan | Plan a story (the wizard, its progress in project meta `planWizard`) and the story structure templates, with Apply structure |

Each module exposes `src/<module>/index.ts`, which `src/shell/routes.tsx` and
`src/shell/modules.ts` already import. Modules register menu items and shortcuts
in their `register()` function, so shell files rarely need editing.

Change the schema with a new file in `src-tauri/migrations/`, not by editing `001_init.sql`.
Projects made by 0.1.0 exist, and a sample of them is tested. See "Upgrades".

## RPC

The UI calls one Tauri command: `invoke('rpc', { method: 'pages.get', params })`.
Use the typed wrappers in `src/lib/api.ts`.

- `rpc::dispatch` splits the method on the first `.` and calls the module's
  `handle(engine, action, params)`. Handlers run on a blocking thread pool, so a
  slow query never freezes the window.
- Params and results are JSON in camelCase. Errors arrive as
  `{ code, message }`, thrown in TypeScript as `RpcError`.
- Rust tests call `dispatch` directly with `Engine::for_test()`. This is the same
  path the UI uses, so test through it.

Every write goes through `engine.write(|tx| ...)`, which runs one transaction and
marks the project dirty. After a write that changes data other views show, call
`engine.notify("pages")`. The UI hook `useDataVersion('pages')` re-renders on it.
Reads go through `engine.read(|conn| ...)`.

An open editor never reloads on those events, because they also follow its own saves.
A write that replaces a document behind an editor (restoring a revision, find and
replace, a rename rewriting links, a family field filled in from another page, or
`pages.update` without `fromEditor: true`) also emits `doc:page:<id>` or
`doc:node:<id>`. An editor reloads its document when
`useDataVersion('doc:node:' + id)` changes, after `flushAllEditors()`.

Everything the writer types is stored through one queue per document in
`src/editor/saving.ts` (`useDocSaver`, keyed like `page:<id>` or `node:<id>`). A value leaves
its queue only when a write of that very value has worked. A failed write, such as on a full
disk, retries with growing waits, the status bar says "Not saved yet, trying again", and the
queue outlives its view, so a view that reopens the document carries on from
`unwrittenValue`. `flushAllEditors()` returns `{ ok, unwritten, reason }`. Save, Save As, Close,
Exit, New and Open stop when it is not `ok` (`ensureWritten` in `src/shell/fileActions.tsx`),
and so should anything else that is about to write over a document. A document holding
content this version does not understand (`src/editor/contentCheck.ts`) is shown read-only
and never saved, so text from a newer version is never blanked.

Saving `parents`, `spouse` or `children` in an infobox keeps relationships and the other
page's field in step (`src-tauri/src/rpc/family.rs`). It writes other pages directly
rather than through `pages.update`, so a sync cannot set off another, and emits
`family://synced` with what it changed, for the writer to be told.

The sync waits while the writer is still typing a name. `InfoboxEditor.tsx` marks those
saves with `familyTyping`, which `pages.update` takes off before storing, and `family.rs`
remembers what the field last held, in the project's `meta` table. When the writer leaves the
field, the editors are saved and `pages.settleFamily` syncs against that, so a half-typed name
that happens to be another page's title never links. Any save without the mark ends the wait
too. Rename and restore sync again. A page in the trash stays in other pages' fields as a red
link, and taking its name out unlinks it.

## Saving and recovery

A `.lorecraft` file is a SQLite database (`application_id` `0x4C4F5245`), but the
app never edits the user's file directly.

1. Opening copies the file to `<data>/sessions/<id>/working.db`, and clears a read-only
   mark the copy inherits. It also removes what an interrupted save left beside the file:
   temporary files with LoreCraft's own names that no save holds open.
2. All edits are committed to that working copy (WAL, `synchronous=FULL`). The UI
   debounces editor writes by 500 ms, so a force-close loses at most that window.
3. `Ctrl+S` runs `VACUUM INTO` a temp file beside the target (`.lc-<8 hex>.saving`, short so
   a path near the length limit still saves, and held open for the whole save), verifies
   it, fsyncs it, copies the old file to the backups folder, then atomically renames over
   the target. The rename retries for about 20 seconds with backoff, because OneDrive and
   antivirus hold files. A failed save leaves the old file untouched. If only the rename
   failed, the checked copy stays beside the target as `<name> (copy <time>).lorecraft` and
   the error says where. A read-only target is refused before any work, with `READ_ONLY`.
4. Each live session holds an exclusive lock on `session.lock`. At startup, a
   session whose lock can be taken is an orphan. If its `session.json` says dirty
   it is offered for recovery, otherwise it is deleted.
5. If the file changed on disk since opening, saving returns `EXTERNAL_CHANGE` so
   the UI can ask before overwriting.
6. Nothing else may write to the user's file. Background data that should not make
   a project dirty, such as story summaries, waits in `<data>/pending-summaries/`
   and reaches the file with the next save.
7. Each save keeps the previous file in `<data>/backups/<project id>/`. `project.openBackup`
   opens one as a new project with no file and a new id, so it cannot overwrite anything.
   `project.restoreBackup` first writes the current state there as another backup, then
   replaces the working copy. The project's file changes only at the next save. Both refuse
   any path outside the backups folder.
8. Unsaved work is never deleted. "Don't save" (`project.close` on a dirty session) and
   Discard on the recovery screen (`project.discardRecovery`) fold the WAL into the working
   copy and move it into the backups, marked `-discarded`. `Session::close_and_remove` does
   this for any dirty session, and `close_without_keeping` is only for a session whose state
   is kept elsewhere. If the move fails, the session folder stays and is offered for recovery.
9. A backup's name says why it exists, after its time (`session::backup_kind`): nothing for a
   save, `-before-restore`, `-discarded`, or `-before-upgrade-<version>`. Saves and restores
   share the rolling limit and budget. Discarded copies are kept for 14 days within a budget
   of their own, so they never push out the others. When a save replaces a file whose
   `user_version` is older than the working copy's, the old file is kept as
   `-before-upgrade-<LoreCraft version>`, even with backups turned off, and never pruned.

Settings (`<data>/settings.json`, with a `version`) are written the same way: a temp file,
fsync, rename, keeping the version replaced as `settings.json.bak`. A file that cannot be read
is never overwritten. It is kept as `settings.broken-<date>.json`, the backup is used, and the
UI hears of it once from `settings.takeLoadReport` at startup.

Set `LORECRAFT_DATA_DIR` to isolate all of this, which the E2E tests do.

### Opening a file

`db::validate_project_file` reads the file before anything is copied, and gives each reason it
cannot open its own code and message: in use by another program, such as antivirus or OneDrive
(`FILE_LOCKED`), online only and not downloaded (`ONLINE_ONLY`), not readable (`NO_PERMISSION`),
damaged (`CORRUPT`), not a project at all (`NOT_A_PROJECT`), or needing a newer LoreCraft
(`TOO_NEW`). Long paths work: SQLite gets the `\\?\` form of any path over 240 characters from
`db::sqlite_path`, and `db::open_sqlite` uses the `win32-longpath` VFS. Give SQLite a path only
through those two.

### Upgrades

Migrations are the files in `src-tauri/migrations/`, and `PRAGMA user_version` counts how many a
file has had. `db::migrate` runs on the working copy, so the file itself changes only when the
writer saves.

- The pending migrations run in one transaction with foreign keys off, as SQLite asks for schema
  changes. With them on, rebuilding `books` or `nodes` would delete every scene under them.
  Before committing, `foreign_key_check` must find no new rows pointing at nothing, and
  `integrity_check` must pass. Otherwise everything rolls back and the project does not open
  (`UPGRADE_FAILED`). A migration must not hold `BEGIN`, `COMMIT` or `PRAGMA foreign_keys`.
- Change the schema with a new migration, never by editing one that has shipped, because a file
  only runs the migrations it has not had.
- `src-tauri/testdata/projects/` holds a sample project made by each format, with pages, an
  infobox, a picture in a figure, a book of chapters and scenes, comments, a family and a page
  type of the writer's own. Every version must open them with that content, and upgrading one
  must give exactly the schema of a new project (`db/tests.rs`). Never make a sample again: a
  release that changes the format adds its own by running the ignored test `make_sample_project`
  with `LORECRAFT_MAKE_SAMPLE` set, and commits it with `git add -f`, because `*.lorecraft` is
  ignored.

**Files from newer versions.** The `meta` table holds `min_reader_version`, the oldest LoreCraft
that can read the file, and `written_by_version`, the last one that wrote it. A file whose minimum
is newer than the app is refused, with a message naming the version it needs. So is a file with a
newer schema. Each version writes its own `db::MIN_READER_VERSION`, or the file's if that is
higher, so a minimum never goes down. LoreCraft 0.1.0 writes 0.1.0.

A release must raise `MIN_READER_VERSION` to its own version when it stores something an older
version would mangle by reading or saving it:

- new node or mark types in documents, or new attributes that matter, because an older editor
  drops what it does not know,
- new tables or columns whose rows an older version would orphan or leave out of date, such as
  rows tied to a page or scene that it purges without them,
- a changed meaning for something stored, such as a new infobox field kind or another unit.

A newer schema is refused today anyway, but raise the minimum for new tables too, so that check
can be relaxed later. A change older versions can safely ignore, such as a new index, needs no
new minimum.

## Document format

Rich text is stored as ProseMirror JSON (`content` columns), with derived
`content_text`, `word_count`, `links` and `mentions` computed in Rust by
`content.rs` so they cannot drift from the content.

The schema is defined once, in `src/editor/schema.ts`, and is used by the editor,
exporters and importers.

- Nodes: `doc`, `paragraph`, `heading`, `blockquote`, `bulletList`, `orderedList`,
  `listItem`, `codeBlock`, `horizontalRule`, `hardBreak`, `image`
  (`attrs.assetId`), `table` family, `reference` (inline, `attrs.text`), `pageList` (a
  query that shows matching pages; `expandPageLists` turns it into a plain list). Its attrs are `pageType`, `category`, `status`, `sort`, and the optional `field` + `fieldValue`, which match an infobox field by key or label, ignoring case, against its value at the start of the story; `pages.list` and `pageListResults` match the same way).
- Marks: `bold`, `italic`, `underline`, `strike`, `code`, `link`,
  `wikiLink` (`attrs.target`, the target page title), and `comment` (`attrs.id`, a row in
  `comments`). Comment marks can overlap, and plain text, exports and `snapshot.get` leave
  them out. Leave a comment from other modules with `addComment` in `src/notes/api.ts`.
- Figures: `figure` wraps one `image`, `video` or `table`, then a `figcaption`. The caption
  is the writer's label and can hold links. `figure.attrs` are `kind` (`figure | picture |
  table | video`, which sets how it is numbered), `align` (`left | right` wrap text,
  `center | full` do not), `width` (percent of the column, or null) and `description`
  (more detail for the AI, also used as alt text). A `video` has `assetId` when stored in
  the project and `url` when it links elsewhere.

Numbers such as "Figure 2" are computed, never stored. Use `describeFigures(doc)` from
`convert.ts`. Plain text shows a figure as `[Figure 2: label (description)]`, which is how
the AI learns what a document contains. Figure text is searchable and can create links
and mentions, but does not count toward word counts.

Wiki links store the target **title**, not an id, so red links work and resolve
when the page appears. A fresh click on a red link creates the page as a draft article and
opens it to edit, with Undo in its toast. Back, Forward and a restored workspace show the
"Create it as" screen instead, so visiting never creates a page. `pages.rename` rewrites them. Compare titles only through
`titleKey()` (`src/lib/text.ts`) and `content::title_key` (Rust), which match:
trim, collapse whitespace, underscores to spaces, lower-case.

`src/editor/convert.ts` converts between ProseMirror JSON, Markdown, HTML and plain
text. Use it rather than writing another converter. Markdown `[[Target|Label]]`
round-trips to the `wikiLink` mark.

## Data model

See `src-tauri/migrations/001_init.sql`. In short:

- `pages`, `page_aliases`, `page_categories`: the wiki. `status` is
  `canon | draft | idea | retconned`. `infobox` is
  `{ imageAssetId?, caption?, fields: [{ key, label, kind, value, changes? }] }`.
  `value` is what holds at the start of the story. `changes` lists what a field becomes
  during it, each with a scene, an in-world date, or both. See `src/lib/facts.ts`.
- `books`, `nodes`: the manuscript. `kind` is `part | chapter | scene`. Only scenes
  hold prose. Ordering is `(parent_id, position)`.
- `links`: explicit wiki links from pages or nodes. `mentions`: automatic name
  detection in text. `revisions`: full-text history. `search_fts`: FTS5 index.
- Snapshots: `pages.update` and `nodes.update` take `snapshot: '<reason>'` and save one in the
  same transaction, before the change. AI-written text, imports and project-wide replace all
  do, so every change the writer didn't type can be taken back from History (scenes have one
  too, `src/write/history/`). `revisions.undo` takes back a whole replace or import: each
  document returns to its snapshot only if nothing changed it since. Splits and merges are
  recorded in `meta` (`splitFrom:` and `mergedInto:` keys), so restoring a merged-away scene
  takes its text back out of the scene it went into. `nodes.restore` with `force` restores it
  without doing that, once the writer has been told.
- History retention: each new revision thins out the old history of its page or scene
  (`revisions::prune`). Everything from the last 14 days stays. Older than that, the newest
  revision of each day stays, and after 90 days the newest of each week. The newest 10 of
  every document always stay, however old. Snapshots whose reason is `import`, `merge`,
  `unmerge`, `split`, `split-off`, `restore` or `manual` are never dropped, because undo and
  restoring a merged scene rely on them. The policy is stored per project in `meta`
  (`revision_retention`) and read and written with `revisions.retention` and
  `revisions.setRetention`. `enabled: false` keeps everything.
- Index upkeep (`002_index_keys.sql`): `search_fts_keys` records which FTS row belongs to
  which document, so a write replaces its row by rowid instead of scanning the index.
  Triggers on `pages` and `page_aliases` put a new random `names_stamp` in `meta` whenever a
  title or alias changes. The name matcher is kept between writes and built again only when
  the stamp differs. A rename or new page recomputes mentions only in texts that mentioned the
  page or hold one of its names now (`indexing::refresh_mentions_of`).
- `assets`, `asset_chunks`: pictures and videos. See "Media".
- `ai_*`, `prompts`, `findings`, `claims_cache`, `maps`, `map_pins`, `relationships`,
  `dictionary`: per-module tables.
- `meta`: small project settings by key. Besides the version keys (see "Upgrades"), modules
  keep state there that must be saved with the project, such as `consistency.wikiUpdates`
  (wiki updates proposed after a chapter, kept until applied or closed) and `calendar`.

In-world dates are free text with a derived sort key. See `parseStoryDate` in
`src/lib/storyDate.ts`. A project can name its months (meta key `calendar`), and the list
`getEras()` returns brings that calendar along, so dates read with it understand them.

## Facts that change during the story

Rules are in `src/lib/facts.ts`: `fieldValueAt`, `ageAt` and friends, which are pure. In-world
dates decide when both sides have one, because scenes can be told out of order. Otherwise
reading order does. `src/facts/` puts this on screen, and exports what other modules need:

- `loadStoryIndex()` gives every node's place in reading order, and `momentOf(index, nodeId)`
  turns a scene or chapter into a `StoryMoment`.
- `factsForPrompt(page, promptMoment(index, nodeId))` is a page's infobox as a model should read
  it: values as of that point, what changed and when, and the character's age there. Use it for
  anything that gives facts to a model, so a starting value is never taken as the truth later.

## Canvases

`src/canvas/` and `src-tauri/src/rpc/canvas.rs`. A canvas is one row in `canvases` (migration
`003_canvases.sql`) whose `data` is a JSON Canvas 1.0 object (https://jsoncanvas.org/spec/1.0/).
`src/canvas/model.ts` is the only reader and writer: it drops nodes it cannot draw and edges to
missing nodes, and keeps any other field, so a file from another app round-trips. Presets
`"1"`–`"6"` map to `--canvas-color-N`, mixed from theme tokens in `src/styles/canvas.css`.

- **References.** A `file` node naming something in the project uses `lorecraft:page/<id>`,
  `lorecraft:scene/<id>`, `lorecraft:asset/<id>` or `lorecraft:canvas/<id>`, with an optional
  `#<heading>` to show one section. There is no foreign key: a purged page leaves a card that
  says so. Project JSON import maps these ids to the imported ones.
- **Saving.** The board keeps the canvas as immutable data. Each change goes through
  `useDocSaver` with the key `canvas:<id>` and is stored whole by `canvases.update`, so a
  force-close loses at most the 500 ms delay, and a failed write retries like any document.
  Undo (`history.ts`) keeps whole canvases, which share what did not change.
- **Editing on a card.** Double-click or Enter on a page or scene card edits it in a
  `RichEditor` on the card (`src/canvas/docEditor.tsx`), saving through the same queues as
  the page and scene editors, `page:<id>` (a `{ content }` patch) and `node:<id>`. A card
  narrowed to a heading edits only that section: the blocks before and after it are taken
  once when editing starts and put back around the edit on each save, so renaming the
  heading itself works. Escape leaves editing. Text cards grow while typed into until the
  writer resizes one, which sets `lorecraftFixedSize` on the node.
- **Clipboard.** Ctrl+C and Ctrl+X put the selected cards, what their groups hold, and the
  connections between them on the clipboard as a JSON Canvas fragment in `text/plain`.
  Pasting one (from this or another canvas, or another app) gives new ids, keeps the
  connections between copies, and lands offset from the originals, or at the center of the
  view if they are not on screen.
- **Dragging in.** Lists set `REF_MIME` with `refDragProps` (`src/canvas/refDrag.ts`). The
  binder reorders with its own pointer drag, so a scene let go over a board is handed over
  with `dropRefAt`, which sends the board a `lorecraft-ref-drop` event.
- **Drawing.** The world layer moves with one CSS transform; cards are placed with transforms
  and only those near the screen are drawn. `SpatialIndex` (buckets of 512 units) answers
  hit-tests and box selection. The e2e test measures panning and zooming with 500 cards.
- **Pages.** A `canvasEmbed` block (`attrs.canvasId`) shows a read-only preview with "Open
  canvas" (`src/canvas/embedView.ts`). Plain text and exports show it as `[Canvas]`.

**Web cards and frames.** The CSP's `frame-src` is `https: http:` rather than `'none'`, only so
canvas web cards and YouTube embeds can show. Nothing else in the app makes frames. Each frame:

- loads only after the writer presses "Load this page", which says it contacts that site;
- takes only http(s) addresses (`safeWebUrl`), never `lbasset` or app pages;
- is sandboxed: web pages get `allow-scripts allow-forms`, an opaque origin with no popups and
  no top navigation, so it can neither reach the app nor replace it. YouTube gets
  `allow-scripts allow-same-origin`, and its address is always `youtube-nocookie.com/embed/<id>`;
- sends no referrer (`referrerpolicy="no-referrer"`).

`navigation_guard` still blocks every navigation of the main window. WebView2 reports only
main-frame navigations to it, so frames do not trip it, and the sandbox keeps them from
navigating the top. Canvases never call the AI.

## Media

Pictures and videos are stored in the project file, or linked from disk for a video too
large to want in it. Documents refer to them by asset id, never by location.

**Types.** Pictures: PNG, JPEG, GIF, WebP, AVIF. Videos: MP4, WebM, MOV, Ogg. A file's
leading bytes decide, as well as what the browser reports: `sniff` in `rpc/media.rs`, with
`src/media/sniff.ts` agreeing so a refused file fails at once. SVG and HTML are refused
because they can carry scripts. Canvas cards and the media library also take sound files
(MP3, M4A, AAC, Ogg/Opus, WAV, FLAC; up to 1 GB) and PDFs (up to 128 MB); pages and scenes
refuse them (`FIGURE_KINDS` and `CARD_KINDS` in `sniff.ts`). An Ogg file is a sound unless it
holds a Theora stream. A sound card is an `<audio>` player on the `lbasset` scheme. A PDF
cannot show in a frame (`frame-src` is web addresses only, and the scheme sends `sandbox`),
so its card draws page one with pdf.js from bytes read through `media_read`, and "Open"
(`media.open`) copies it to the temp folder and hands it to the system viewer. The canvas
PNG export reads pictures the same way, into a blob, so the canvas is not tainted.

**Storing.** Bytes go in `asset_chunks`, 4 MiB to a row, so an asset can exceed SQLite's
1 GB value limit and a range read touches only the chunks it needs. An upload is
`media.uploadBegin`, then the raw `media_upload_chunk` command for each chunk (bytes, not
JSON or base64), then `media.uploadFinish`, which checks the size and SHA-256 of what was
stored. Identical content is stored once, so finishing can return an earlier asset's id.
Each chunk is its own transaction, so the rest of the app saves between them. A row with
`complete = 0` is an upload in progress, and any left over are removed as a project opens.

**Reading.** The web view gets bytes from the `lbasset` scheme (`media_protocol.rs`), with
ranges, so video seeking works. A URL holds only an asset id. Reads use their own read-only
connection beside the session's, which WAL allows, so they never wait on or hold the
session lock. Get a URL from `assetUrl(id)`, never by building one.

**Linked videos.** `assets.external_path` holds the path, and the file is streamed from disk
through its asset id. A path must come from a dialog to be linked. A project file can come
from someone else, so at read time a path is only followed if it has a video extension, is
really a video by its bytes, and is on a local disk or was picked in this run.

**Exporting.** Read bytes with `readAssetChunks(id)` from `src/lib/assets.ts`, which yields a
`Uint8Array` at a time with no base64, so a large video is never in memory all at once.
`assetInfo(id)` has the name and type, and `media.list` lists everything.

**The library.** The `{ view: 'media' }` route lists every asset, with where it is used, from
`media.library` and `media.usage`, which read documents through their JSON. A label set there
goes to figures that share the old words or have none. One with words of its own keeps them,
because a caption stays the writer's label for that figure. `assets.label` only fills in when
no figure has words, and starts off a new figure of that asset.

**Unused media.** "Remove unused media", in the library, lists assets nothing mentions,
searching every text column of every table but the search index, and deletes only on
confirmation. Nothing is ever deleted automatically, because undo and history may still need
it.

**In the editor.** `src/editor/figure/` adds the behavior: node views, labeling, dropping and
pasting. `schema.ts` alone defines what is stored. While a file uploads, its placeholder is
a decoration, so it can never reach a stored document.

**Saving and backups.** `project://saving` tells the status bar while a save runs. Backups
have a size budget per project (`save.backupBudgetBytes` in settings, default 5 GiB). The
oldest go first, but the newest always stays. A project larger than the whole budget gets no
backup, and `project://backup-skipped` tells the UI, which warns once.

## AI

`invoke('ai_stream', { request, onEvent: Channel })` streams normalized events:
`thinking`, `text`, `toolStart`, `toolCall`, `usage`, `retrying`, `fallback`, `done` and
`error`. `ai_cancel(streamId)` stops one. Rust maps each provider to these: Anthropic through
the Messages API, OpenAI through the Responses API, and local servers through Chat
Completions. Orchestration (context assembly, the tool loop, suggestions) is in TypeScript
under `src/ai/`.

- `src/ai/client.ts` is the interface other modules use (`complete`, `stream`,
  `completeJson`). `describeImage` in `src/ai/vision.ts` shows a project image to a model.
  The "Describe with AI" control (`src/editor/figure/describeAi.ts`, in the figure popover
  and the media library) shows its text as a suggestion the writer uses, edits or discards. A
  picture used on any local-only page or scene goes only to a local profile, and fails with
  `LOCAL_ONLY` when no local profile reads images.
- Local servers stream thinking separately (`reasoning_content`) and it counts
  against `max_tokens`, so the UI collapses it and limits must allow for it.
- Assume only the OpenAI-compatible API on local servers. The default server
  may be any OpenAI-compatible server, not necessarily llama.cpp, so llama.cpp-only endpoints are not
  safe to rely on. The one exception is asking `/props` whether it reads images, and a
  server without that simply counts as not reading them.
- Conversation history is append-only. Thinking blocks are tied to everything before them,
  so `system`, tools and earlier messages stay byte-identical: lore goes in user messages,
  never in `system`. Each block keeps its provider's `raw` form for replay to that provider,
  and another provider gets the normalized fields instead.
- Editing a message or asking for a reply again never rewrites history: it adds a new
  version. Each message has a `parent_id`, so a chat is a tree, and `leaf_id` on the
  conversation names the version on screen. `src/ai/versions.ts` turns these into the line
  that shows and the "‹ 1 of 2 ›" steps. Every version is append-only on its own.
- The AI edits through suggestions in `src/editor/ai/`: decorations that do not touch the
  document until accepted. Figures, tables and images are never part of a change. A model
  sees each as a `{{KEEP n: ...}}` line and its reply is split around them, so they keep
  every attribute whatever it writes.
- Tools a model can call only read or propose. Nothing in lore text can cause an action.
- `src/ai/companions/` holds help that is not plain chat. A character chat is a normal
  conversation with `context.character` set, which gives it its own fixed `system`, read-only
  tools and a first message naming who is played. The beta reader checks every quote against
  the text (`quotes.ts`) and drops what is not there. Several versions of a rewrite share one
  prompt from `editPrompt` in `src/editor/ai/flow.ts`, and the chosen one ends in `finishEdit`,
  the same step as any other edit, so figures and stale text are handled in one place.

Story-so-far summaries live in the `summaries` table, one row per scene, chapter, part and
book, with a hash of what each was made from. `rpc/summaries.rs` decides what is out of date,
children first, and holds the rule that an edited summary stays until the writer asks for a
new one. `src/ai/summaries/worker.ts` calls the model, one item at a time, after typing has
paused, and steps aside when the person asks the same model for something. Its progress is
all in the table, so it carries on after a restart. A cloud profile makes them only if the
writer has allowed that. `summaries.storySoFar` (`getStorySoFar`) gives the story up to a
node, at the highest level there is a summary for, and needs no window, so the MCP server can
use it too. Saving a summary the app made does not mark the project as changed.

Pages and scenes marked `localOnly` never go to a profile with `isCloud`. Context assembly and
the lore tools withhold them, and the context view says so. A chapter or book summary made
from a marked scene counts as marked. A message that held such material carries `localOnly`
on its block, and `historyForProfile` keeps it, and anything a local model wrote after it, out
of a request to a cloud profile. Anything else that sends project text, such as a whole-book
check, must test `canSendTo(profile, item)` first.

The monthly cloud limit is in settings, because it covers every project. `stream` checks it
before sending: a person is asked whether to go past it, and background work just stops. Run
`confirmRun` (which uses `estimateRunCost`) before anything that goes over a whole book.

## Writing styles

`src/writingStyles/index.ts` is the module's API. `buildStylePrompt(style)` is the one place a
style becomes text for a model, and `resolveStyleInstructions({ bookId, nodeId, styleId })`
gives the block for a request: the writer's style guide, then the style chosen by the request,
scene, book or project, in that order. `assembleContext` sends it first as `<writing_style>`.
Its output has no dates or counters, because it sits in a cached prefix.

- App settings hold custom styles and favorites (`writingStyles`), for every project.
- Project meta holds `writingStyles.choices` and `writingStyles.guide`. A choice of a custom
  style also stores its name and prompt, so a project still works on a computer without it.
- Project meta `writingStyles.recent` lists the last five styles used to rewrite, newest first.
  "Rewrite in a style…" starts on the default (`resolveRewriteDefault`: scene, book, project),
  then these. "Rewrite in my style" (Ctrl+Shift+Y) uses the default with no picker. Both still
  give suggestions, never direct edits.
- Project meta `styleGuide.text` is the project-level text as plain text, for the MCP server,
  which cannot call TypeScript. It is written only after a change the writer made, and only if
  it differs, so opening a project never marks it as changed.

## Search by meaning

`src-tauri/src/embeddings/` splits pages and scenes into passages and turns each into a vector.
Passages are about 18 words (at most 45) and don't overlap: overlap blurred each passage
with the one before it. Search scores each passage after taking away the project's average
passage (`CENTERING_PRIOR` in `search.rs`), so passages that read like the rest of the book
stop crowding out the one that answers the question. `embeddings::bench` holds the book-scale
benchmark behind these choices, as ignored tests.
Where a vector comes from is behind the `Provider` trait: the built-in model, a provider profile
through `/v1/embeddings`, or a deterministic stand-in in tests. The built-in model runs in plain
Rust in the `src-tauri/minilm` crate, with nothing to install. That crate has no dependencies and
is compiled optimized even in debug builds, because it is unusable otherwise. Its files are
downloaded only after the writer agrees, from a pinned revision, and checked against known hashes.

The UI runs indexing by calling `embeddings.step` in a loop (`src/meaning/store.ts`). Each step does
one small batch and holds the project's lock only for short reads and writes, never while a model
runs. Local-only documents are never given to a cloud provider.

The index is derived data, so `embeddings::write_quiet` writes it without marking the project dirty.
It reaches the file with the next real save, and is kept there, including through Save As. A
project closed with nothing to save loses those rows with its working copy, so every vector is also
kept in `<data>/embeddings/vectors.db`, keyed by model and text hash, which holds no text. Any step
that finds a hash there uses it rather than embedding again, so re-indexing after a restart is free.

## Languages

A project's language is the `language` meta value, or `settings.language.writing` if it has
none (`writingLanguage()` in `src/state/language.ts`). It picks the spelling dictionary and
what the AI writes in. The AI is told through a `language` item in context assembly, sent once
per conversation, and not at all for American English.

- Word counts: Han and kana count per character, Thai, Lao, Burmese and Khmer are estimated at
  one word per four letters, and everything else counts as before, by runs between spaces.
  `wordCount` and `word_count` must agree, which `src/lib/wordCountCases.json` tests on both sides.
- Search: `search_index_text` puts a separator around each character of a script without
  spaces, for the index and for queries, so a word is found anywhere in a sentence. Anything
  read back from `search_fts` goes through `search_display_text` before people see it.
- Names: `is_unspaced_script` scripts match without word boundaries, from two characters, and
  count as a word boundary for a Latin name beside them. `MentionMatcher`, `NameMatcher` in
  `src/write` and whole-word find share this rule.
- Spellcheck: dictionaries are not in the program. They ship as separate files beside it
  (`bundle.resources`: `dictionaries/<language>/index.aff`, `index.dic` and `LICENSE.txt`), which
  matters because the German and Italian ones are GPL. The client reads them on demand through
  `files.readResource`, which serves only an allowlist, and passes them to the worker
  (`src/editor/spellcheck/hunspell.ts`). Debug builds read the same files from `node_modules`.
  A language without a dictionary turns spelling off.
- Licenses: `npm run licenses` writes `THIRD_PARTY_LICENSES.txt` (npm, Rust and dictionaries),
  which the installer carries and About shows. `npm run licenses:check`, run in CI, fails when
  it is out of date.
- Direction: blocks render with `dir="auto"` from `schema.ts`, which is not stored. Use logical
  CSS properties, such as `padding-inline-start`, for anything inside text.
- Interface text: `t('English text', { vars })` from `src/lib/i18n.ts`. The English text is the
  key, with whole sentences and `{placeholders}`, never joined pieces. A component using `t()`
  also calls `useLocale()` so it re-renders. Catalogs are `src/locales/<code>.json`, and
  `npm run i18n` lists what is missing. So far only the shell and the settings frame use it.

## Export and import

Each export format is one function from the project's data to bytes, in `src/exporters/wiki/`
and `src/exporters/novel/`, run in a worker so the window stays free. Stored files are read in
one place, `src/exporters/assets.ts`. Every import becomes one payload for `import.apply`, which
runs in a single transaction. `import.preview` runs the same code and rolls it back.

PDFs come from the browser engine rather than a PDF library, because that is what gives text
wrapped around floated figures, every script through system fonts, and working links. The
document is built as HTML (`src/exporters/print/document.ts`) and laid out in a hidden window
(`print.html`), in its own renderer process, using the DevTools `Page.printToPDF` command
through WebView2 on Windows. `Host::supports_pdf` reaches the UI as `platform().pdf`
(`src/lib/platform.ts`), so on macOS the export screen says PDFs are not available before anyone
chooses a file.

On Linux, `Host::print_native` prints the same window through WebKitGTK's print operation to a
file (`src-tauri/src/rpc/print_linux.rs`), on the paper and margins of the page's first `@page`
rule. WebKit differs from Chromium in ways the print page and `rpc/print_stamp.rs` make up for:

- It draws no `@page` margin boxes. `print_stamp::stamp` reads the @page rules, the counter
  styles and each page's named page, and adds the page numbers and running heads as an update at
  the end of the PDF, in the document's own fonts. Those fonts are copied from a last measuring
  print in which the print page wrote out every letter the boxes need.
- It marks no link targets, so `print.measure` cannot use named destinations. The print page
  puts `LCMK<n>Q` marker text at each element instead, and `print_stamp::markers` finds the page
  each landed on, counting only text inside the page's clip.
- It prints every page with the first page's margins, so left-hand pages are moved over.
- It lays out 1.25 units to the point rather than 4/3, and drops the fraction of line heights
  that Chromium rounds. `Sheet::layout_rule` and whole-pixel line heights make up for both, and
  `display: flow-root` keeps the margin above a chapter title at the top of a page.

`--e2e-print <job.json> <out.pdf>` makes one PDF headlessly under the test harness, for example
under `xvfb-run` on Linux.

## Logs and updates

`src-tauri/src/logs.rs` writes rotating files to `<data>/logs`, because a release build has no
console. Failed RPCs, panics and uncaught JavaScript errors (`src/support/errorReporting.ts`)
all arrive there on their own. Add a record with `logs::info`, `warn` or `error`.

A log must be safe to post publicly: **never prose, lore, prompts, model responses, keys or file
contents.** Identifiers go in as `tokens` and are dropped unless they look like identifiers.
Messages go through `logs::scrub`, which keeps only words from a fixed technical list. Leave
provider error text out altogether, as `ai::run_request` does, because it can echo the prompt.

`src-tauri/src/updates.rs` asks GitHub for the latest release when someone asks, or at startup
if they turned that on. It is the only network call the app makes on its own account, and
nothing is installed automatically. See [RELEASING.md](RELEASING.md).

### Publishing details

A book's cover, series, ISBN, front and back matter and appendices are JSON in
`books.publishing` (`BookPublishing` in `src/lib/types.ts`), edited on the screen at
`src/exporters/PublishingView.tsx`. `applyScope` turns them into `book.matter` for an
export of a book, through `src/exporters/novel/matter.ts`, as ordinary documents that DOCX,
EPUB and PDF print the way they print scenes. Appendices are built from the wiki at that
moment. A manuscript leaves all of it out, and a print-ready PDF leaves out the cover.

## UI conventions

- Styling: only the CSS tokens in `src/styles/themes.css`, never hard-coded colors.
  All themes must work in light and dark. UI sizes in `rem`, article and manuscript
  sizes in `em`, so the two text-size settings keep working.
- Dialogs: `confirm`, `promptText` and `choose` from `src/shell/dialogs.tsx`, never
  `window.confirm`. Notifications: `toast` from `src/shell/toasts.tsx`.
- Navigation: `useNav((s) => s.go)(route)`, with routes defined in `src/state/nav.ts`. See
  "Tabs and panes" below for which pane that means.
- Commands: `registerCommand` in `src/shell/commands.ts` feeds the menus, shortcuts
  and palette.
- Editors: use `RichEditor` from `src/editor/`. Do not create another TipTap instance.
- Modules keep their own API wrappers (`src/<module>/api.ts`, calling `rpc()`) and CSS
  (`src/styles/<module>.css`, imported by the module's index). This keeps shared files
  stable. `src/lib/api.ts` and `src/styles/base.css` hold only what several modules use.
- Hover cards: any element with `data-wiki-target` shows the page's summary card.
- Page types: read them with `usePageTypes` or `allPageTypes` from `src/wiki`. The writer's
  own are stored in project meta under `pageTypes`.
- Spoilers: a page is known from `revealPoint` in `src/ai/context.ts`, which is its
  `revealNodeId` or else its first appearance (`pages.firstAppearances`).
- Links: every `RichEditor` opens page suggestions on `[[`. Infobox fields of kind
  `page` and `pages` count as links, so they appear in backlinks and wanted pages.
- Images and videos: `addAsset` and `assetUrl` from `src/lib/assets.ts`. See "Media".
- AI output is untrusted text. Render it through `renderMarkdownSafe` from
  `src/editor/convert.ts`, never with raw HTML.

## Tabs and panes

The main area holds one or two panes (`main`, and `side` while split), each with its own tabs,
and each tab has its own route and back and forward history. The layout logic is pure and lives
in `src/state/tabs.ts`. Only a pane's front tab is mounted, so an editor's undo history ends when
its tab goes to the back, as it does when a route changes.

- `useNav` keeps working as if there were one current screen. Inside a pane the hook means that
  pane. Everywhere else, and always for `useNav.getState()`, it means the focused pane. A click
  in a pane focuses it before the click arrives, so a handler's `go` lands where it should.
- An effect or a promise in a screen must use `replace` or `go` from the hook, not from
  `getState()`, because its pane may not be the focused one. Use `isFocusedPane(usePaneId())`
  before taking keyboard focus or showing something in the status bar.
- A screen scrolls in `.content`, which is per pane. Find it from your own element with
  `closest('.content')`, never with a query on the document.
- Anything about "the current document" follows the focused pane: `useWikiSession`, `activeEditor()`
  and the open scene in the Write store. The Write store is on one book at a time, the focused
  pane's. A pane in the background on another book shows a read-only `SceneCopy`.
- Two panes can show one document, but only one may edit it. Editors take a claim with
  `useDocClaim(key, wanted)` from `src/state/docs.ts`, where the key is `page:<id>` or `node:<id>`.
  The second in line shows a read-only copy that follows what is saved, and it reloads before it
  gets its turn to edit. Read-only copies are not offered to the AI.
- A document's cursor and scroll position are kept in `src/state/docs.ts` under the same keys.
- Back and Forward act on the focused pane's front tab: View › Back and Forward (Alt+← and Alt+→),
  the arrows in the top bar (`src/shell/NavButtons.tsx`, whose right-click menu jumps with `jump`) and
  the mouse's side buttons. A link, search result, palette entry or sidebar link uses `go`, so it adds
  history. `replace` is for a screen that corrects its own route, such as a red link becoming its page.

`src/shell/workspace.ts` saves the layout and places in the app settings, per project id and never
in the project file, because that would mark it dirty. `Settings.save.reopenLast` turns this off.
At startup, recovery comes first. If a recovery offer is put off, the app stays on the start screen.

## Testing

| What | Command |
|---|---|
| Types | `npm run typecheck` |
| Unit (TypeScript) | `npm test` |
| Rust | `npm run test:rust` |
| Real app, end to end | `npm run app:debug`, then `npm run e2e` |

`cargo test` embeds `dist/`, so run `npm run build` once in a fresh checkout first.

E2E tests drive the real app through WebView2's DevTools port with
`playwright-core`. Each launch gets its own data folder and port, and the window
opens off-screen so it does not take focus. Screenshots go to `e2e/artifacts/`.
Helpers are in `e2e/harness.mjs`. `answerNextDialog` makes the next native file dialog answer
with a given path, so a test can press the same buttons a person would. Under the E2E flag,
links are noted rather than opened, so a run never starts a real browser. Playwright copies
every request body over DevTools, so step off it during a large upload with `disconnect`
and `quietEvaluate`.

`scripts/mock-ai-server.mjs` imitates Anthropic and OpenAI for tests, because real
keys are not available in CI.
