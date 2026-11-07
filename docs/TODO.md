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
A writer reported: "The MCP connection doesn't allow you to assist in editing the write section of the book I am writing. We have had to keep using .txt documents to copy back and forth." Chapters run 4–10k words, one scene each. Every new kind still waits in Outside suggestions; nothing changes silently.
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
