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

# Round 2

## 9. Brainstorm board
- [x] A Brainstorm view, opened from the AI menu and Ctrl+K. Pick a category (character names, place names, plot twists, what happens next, conflicts, world details, titles, objects, dialogue lines, character traits, or your own question), with an optional note and an optional focus: what was open, or a chosen page.
- [x] About 8 short ideas come back as cards, from one JSON request parsed loosely, with the wiki and book context, the spoiler limit and the focus scene.
- [x] Each card has Keep (to the Inbox, tagged with the category), New page (names, places and objects, through the usual new-page dialog), Discard and More like this.
- [x] The board has More and Clear, and survives switching views within a session. Ideas already shown are not shown again.
- [x] Fully keyboard usable (K, N, M, Delete on a card, arrow keys between cards), with ARIA labels.
- Code: src/brainstorm/.

## 11. Share prompts as files
- [x] In the prompt library: Export for one prompt, Export all custom, and Import.
- [x] A small versioned JSON format, `{ "lorecraft_prompts": 1, "prompts": [...] }`, documented in docs/IMPORT_FORMAT.md.
- [x] Import shows a preview, skips exact duplicates, renames name clashes ("Name (2)") and checks scope and action.
- Code: src/ai/promptFiles.ts, src/ai/PromptLibrary.tsx.
