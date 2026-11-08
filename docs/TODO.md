# TODO

Changes needed after real use. Each is a must-have.

## 1. Pin "Outside suggestions" so it's always one click away
Writers without an API key use frontier models through MCP, so proposals arrive all the time. Today it takes AI menu › Outside suggestions every time.
- [x] A pin button on the Outside suggestions view docks it: in the top bar, beside the AI button, as a badge with the waiting count, or as a tab/pane that stays open.
- [x] Clicking the badge opens the list. Accepting or rejecting keeps you in the list, and the next suggestion is ready.
- [x] The pin is remembered between sessions.
- [x] New suggestions arriving from MCP update the badge live, with no need to reopen anything.
- Code: src/mcp/ProposalsView.tsx, src/mcp/index.ts, the top bar in src/shell/AppShell.tsx.

## 2. Back and Forward buttons
Navigation history already exists (`goBack` / `goForward` in src/state/nav.ts, View › Back, Alt+←), but there's no visible button.
- [x] Back and Forward arrow buttons at the left of the top bar, disabled when there's nowhere to go, with tooltips showing the shortcut.
- [x] The mouse's side buttons (back/forward) work too.
- [x] They work per tab and per pane, as the history already does.
- [x] Right-click or a long press shows recent pages to jump to (nice to have).

## 3. A default writing style for "Rewrite in a style…"
A style can already be set for a project or book (`choices.project.styleId`, src/writingStyles/), but the picker in the selection menu (src/writingStyles/rewrite.tsx, src/editor/ai/SelectionMenu.tsx) makes you search every time.
- [x] The rewrite picker opens with the scene's style, then the book's, then the project's, selected at the top. Enter rewrites with it right away.
- [x] Add a **Rewrite in my style** item, shown when a default exists, that skips the picker entirely.
- [x] Recently used styles appear first in the picker.
- [x] Make "Set a default style for this project" easy to find: in the picker itself and in Book settings.

## 4. Edit a message and rerun it in the AI pane
- [x] Each of the writer's own messages has **Edit**. Editing replaces it, removes the replies after it, and runs the prompt again.
- [x] Each AI reply has **Regenerate**, which reruns the same prompt.
- [x] Optionally keep earlier versions as "1 of 2" arrows instead of deleting them.
- [x] It works with local and cloud providers alike. The cloud permission and spending-limit checks apply to reruns too.
- Code: src/ai/AiPane.tsx, src/ai/store.ts (there's already a `retry`, used only after errors).

---

# Round 2: drafting help

Ideas from comparing LoreCraft with other AI writing tools. Everything uses the same AI as the rest of the app (local or cloud). It respects "local only" and the spending limit, and nothing changes the writer's text without review.

## 5. Write a scene from notes, a synopsis or a premise
- [x] Select rough notes (stream of consciousness, beats or bullet points) and choose **Write this as a scene**. The AI turns them into finished prose using the scene's point of view, cast, location, the lore it mentions and the default style. The result arrives as a tracked change for the selection.
- [x] **Draft from synopsis** in a scene's AI menu, for a scene that has a synopsis but little or no text. It writes the scene from the synopsis, cast, location and the scenes around it.
- [x] **First draft** in an empty scene: type a premise or a few lines of what should happen, and get a draft of a chosen length.
- [x] It works with small local models: short prompts, a length choice, and long scenes written in parts if needed.
- Code: src/editor/ai/, src/ai/context.ts, src/ai/prompts.ts, src/write/.

## 6. Point of view and tense for the book
- [x] Book settings gets **Point of view** (first, close third, omniscient, second, and so on) and **Tense** (past or present), beside the default style.
- [x] Every AI request that writes prose for that book follows them. A scene's own point-of-view character still applies.
- [x] Older projects keep working; empty means "not set".

## 7. Guided Continue
- [x] **Continue** can take an instruction ("she finds the letter; end on a cliffhanger") or run with none.
- [x] Choose between 2 or 3 versions before anything is inserted, and insert the one you pick as a tracked change.

## 8. Describe with the senses
- [x] Select a moment and choose **Describe**. You get short options under Sight, Sound, Smell, Touch, Taste and Metaphor.
- [x] Tick the ones you like and insert them, or ask for more. Insertions are tracked changes. It uses the lore: what a place smells like, what a character wears.

## 9. Brainstorm board
- [x] A Brainstorm view (AI menu and Ctrl+K) with categories: character names, place names, plot twists, what happens next, conflicts, world details, titles, objects, dialogue lines, character traits, and your own question.
- [x] Unlike other tools, it reads the wiki and the book, so its ideas fit the world.
- [x] Each idea can be kept or discarded, and "more like this" asks for more. Kept ideas go to the Inbox or straight to a new page.

## 10. Story planning wizard
- [x] A step-by-step **Plan a story** wizard: Braindump, then Synopsis, Characters, World, Outline and Scenes. The AI suggests at each step, and you edit, skip or go back.
- [x] At the end, it creates the wiki pages (characters, places) and the book's chapters and scenes with synopses. You review everything first; nothing is created silently.
- [x] Story structure templates to start from: three-act, the hero's journey, a story circle, a beat sheet, a romance arc, a mystery. They're also available on their own for the outline and corkboard of an existing book.
- [x] Progress is saved, so the wizard can be left and resumed.

## 11. Share prompts as files
- [x] Export one or all custom prompts from the prompt library to a file, and import prompts from a file (with a preview, and no duplicates).

## 12. Outside AI can write in the book
Outside AI tools could read the book but not really write in it, so text had to be copied back and forth by hand. Long chapters of one scene each must work too. Every new kind still waits in Outside suggestions; nothing changes silently.
- [x] `propose_insert`: new Markdown text at the `start` or `end` of a scene, or `after_quote` / `before_quote`. Works on an empty scene.
- [x] `propose_rewrite` (also reachable through `propose_edit`): a range from `from_quote` to `to_quote`, both included, or `whole: true` for the entire scene.
- [x] `propose_new_scene` and `propose_new_chapter`: placed after a named scene or chapter, or at the end; with synopsis, point of view, location and cast by page title, and the text. A new chapter carries its first scene.
- [x] `propose_scene_details`: title, synopsis, point of view, location, cast, status, story date and notes.
- [x] Outside suggestions shows a readable diff for rewrites and inserts, and the details of new scenes, chapters and scene details.
- [x] **Review in the scene** opens the scene with the suggestion as tracked changes, accepted or rejected per paragraph. Plain Accept and Reject still work.
- [x] A suggestion is found again by its quotes when the scene has changed. If the anchors are gone it says so and changes nothing.
- [x] Forgiving matching on both sides (dashes, `--`, `…`/`...`, odd and invisible spaces, curly quotes, emphasis markers), checked by shared cases in src/mcp/quote-cases.json. A missing quote's error shows the closest passage.
- [x] Tool descriptions, the server instructions, the `catch_up` prompt and docs/MCP.md ("Writing with an outside AI") explain it. Local-only scenes stay refused; the pending cap and size limits still apply.
- Code: src-tauri/src/mcp/suggest.rs, text.rs, tools.rs, server.rs; src/mcp/apply.ts, actions.ts, ProposalsView.tsx.

# Round 3: outside AI with full control

## 13. MCP: full control
The writer uses Claude Code through LoreCraft's MCP server and found it far too limiting: it could only suggest, and could not change things such as the style guide. This is the foundation that later tools build on.
- [x] A third permission level, **Make changes directly** (`edit`), in MCP settings and Settings › AI tools (MCP), with a plain explanation. The default stays `suggest`.
- [x] At the edit level a write tool still makes a proposal through one path (`mcp/write.rs`); the app picks it up and applies it with the same code as Accept, so History, open editors, figure safety and stores stay right. The call waits about 20 s and answers "Done: …" or the real error. If the window does not respond, the change waits as a normal suggestion.
- [x] Undo: changes made directly are listed under **Applied by outside AI** in Outside suggestions, each with Undo. Text changes go back to the revision saved before, details and the style guide to the old values kept in the payload, and new pages, scenes and chapters go to the trash. Undo refuses if the target changed since. The badge counts waiting suggestions only.
- [x] Tools split into area modules (`src-tauri/src/mcp/areas/`), each declaring its tools, schemas and handlers, registered from one `areas!` list. Existing tools moved without changing their behaviour.
- [x] Proposal kinds in a registry (`src/mcp/kinds/`), each with its card, apply and undo: edit, rewrite, insert, newPage, newScene, newChapter, sceneDetails, styleGuide.
- [x] `set_style_guide` (replace or append, through the style store so the Style guide screen updates) and `get_settings_overview` (permission level, local-only sharing, project language).
- [x] Hard limits enforced in Rust (`mcp/limits.rs`), stated in the server instructions and tested: no tool changes MCP permissions or settings, AI providers or keys, spending limits or local-only flags; none deletes the project or writes outside it; local-only content stays hidden unless shared; the pending cap counts changes waiting for the window too.
- [x] Server instructions, tool descriptions and docs/MCP.md explain the three levels; docs/MCP.md has "Adding an MCP tool".
- Code: src-tauri/src/mcp/areas/, write.rs, limits.rs, suggest.rs; src/mcp/kinds/, auto.ts, actions.ts, ProposalsView.tsx, McpSettings.tsx.

## 14. MCP: manuscript structure and books
The outside AI can shape the book itself, not only its text, at the suggest or edit level, with Undo for each change.
- [x] `create_book` and `update_book`: title, subtitle, author, word goal, point of view and tense (`books.voice`) and the book's default writing style, through the same stores as Book settings. `get_book_settings` reads them.
- [x] `move_node`: before or after another node, or into a chapter or part at a position. Undo moves it back.
- [x] `rename_node`, `set_node_status` (scenes, chapters and parts) and `set_chapter_details` (synopsis, notes, word goal).
- [x] `trash_node` and `restore_node`, through the manuscript trash. Nothing is ever purged.
- [x] `split_scene` at a quote and `merge_scenes` for two neighbouring scenes, with the app's split and merge and their undo.
- [x] Plot threads: `get_threads`, `create_thread`, `rename_thread`, `delete_thread`, `add_scene_to_thread`, `remove_scene_from_thread`.
- [x] Local-only scenes and chapters stay hidden and refused unless shared; moving or trashing a node that holds local-only scenes is refused.
- Code: src-tauri/src/mcp/areas/structure.rs; src/mcp/kinds/structure.tsx; e2e/mcp-book.test.mjs.
## 15. MCP: the wiki
An outside AI can change the wiki, not only suggest new pages. Every change has Undo.
- [x] `update_page`: summary, status, page type, aliases and categories (set, add or remove). Only the given fields change; the old values are kept for Undo.
- [x] `set_infobox_fields`: set, rename or remove fields with their kind, or replace them all. Fields keep their place, key and story changes. Timeline dates and family fields come from these, so no separate timeline tool.
- [x] `rename_page` through the app's rename and its preview: links follow, the old title stays as an alias, and the call says how many documents' links change.
- [x] `trash_page` and `restore_page`. Never purge.
- [x] `add_talk_note`: a Markdown note at the end of the Talk tab.
- [x] `add_relationship` and `remove_relationship` on the explicit relationships; family fields follow `parent of` and `spouse`.
- [x] `add_map_pin`, `move_map_pin` and `remove_map_pin`.
- [x] Reads: `list_categories`, `list_page_types`, `get_page_history`, `list_maps`.
- [x] Local-only pages are hidden unless shared, and refused even when shared.
- Code: src-tauri/src/mcp/areas/wiki.rs; src/mcp/kinds/wiki.tsx; e2e/mcp-wiki.test.mjs.
## 16. MCP: styles, prompts, ideas and comments
The writer asked whether the outside AI could update the style guide and more. These tools give it the rest of the writing setup and the review notes, each with Undo at the edit level.
- [x] Writing styles: `list_writing_styles` and `get_writing_style` (built-in and custom, with ids, description and prompt); `create_writing_style` (from a prompt or traits, or a blend), `update_writing_style` and `delete_writing_style` for custom styles only; `set_default_style` for the project, a book or a scene. All through the style store. The built-in library reaches Rust as `styles_library.json`, kept in step by a test.
- [x] Style guide: `get_style_guide` lists each named field as `set_style_guide` takes it, and `set_style_guide` names its fields.
- [x] Prompt library: `list_prompts`; `create_prompt`, `update_prompt` and `delete_prompt` for the writer's own prompts only.
- [x] Idea inbox: `list_ideas`, `update_idea`, `resolve_idea`, `idea_to_page` (as the Inbox does it). `add_idea` is a normal write: below the edit level it still goes straight to the inbox; at the edit level it shows under Applied by outside AI, with Undo.
- [x] Comments: `list_comments`, `add_comment` on a quoted passage (the mark appears in an open editor), `resolve_comment`. The app has no replies, so there is no `reply_comment`.
- [x] Local-only pages and scenes, and ideas captured in them, stay hidden and are refused unless shared.
- Code: src-tauri/src/mcp/areas/styles.rs, prompts.rs, ideas.rs, comments.rs; src/mcp/kinds/styles.tsx, prompts.tsx, ideas.tsx, comments.tsx; e2e/mcp-organize.test.mjs.
## 17. MCP: canvases, consistency checks and media
The writer wants an outside AI to arrange canvases, run the checks and describe pictures, not only read them.
- [x] `create_canvas`, `rename_canvas`, `trash_canvas` (the canvas trash; Undo restores) and `edit_canvas`: a list of operations (add a text, page or scene card or a group, move, resize, edit text, remove, connect with an optional label, disconnect, color), cards and arrows named by id or by what they show, new cards placed beside related ones without overlaps. Applied through the open board (`src/canvas/live.ts`), so it updates live and joins the board's own undo; Undo restores the canvas data.
- [x] `run_consistency_check` (the rule checks, run by the app, with a summary in the reply; AI checks stay with the writer), `dismiss_finding` (ignored or intentional) and `resolve_finding` (fixed), each with Undo. `list_findings` shows each finding's id.
- [x] `list_media` (id, kind, label, description, where used) and `label_media` (the library label and alt text, with Undo). No file imports.
- [x] Local-only pages and scenes stay hidden and refused: their canvas cards are counted as hidden in `get_canvas` and cannot be named, added or removed; media used only there is left out; findings quoting them cannot be changed.
- [x] Tests: Rust per tool (success, missing target, local only, suggest level, edit level), TS apply and undo, E2E `e2e/mcp-canvas.test.mjs`.
- Code: src-tauri/src/mcp/areas/canvas.rs, checks.rs, media.rs; src/mcp/kinds/canvas.tsx, checks.tsx, media.tsx; src/canvas/live.ts.
