# LoreCraft: product plan

LoreCraft is a desktop app for writers: a Wikipedia-style lorebook and a novel
manuscript in one project file, with AI help from local or frontier models and
checks that keep the two consistent.

## Decisions

| Question | Decision |
|---|---|
| Stack | Tauri 2 (Rust + WebView2), React + TypeScript, TipTap, SQLite |
| Storage | One `.lorecraft` file per project, with Markdown export |
| Project scope | One world with multiple books, so a series shares one wiki |
| Audience | Personal first, then open source: installer polish is in scope |
| AI providers | Anthropic, OpenAI and local (OpenAI-compatible servers) |
| Default local server | `http://127.0.0.1:8080` (OpenAI-compatible API only) |
| Importing the author's lore | Later, once the program is nearly complete |

## Features

### Wiki
- Wikipedia-like layout: contents box, infoboxes, categories, references and
  red links for pages that do not exist yet.
- `Ctrl+N` creates a page immediately. Clicking a red link creates that page.
- Page templates: character, place, faction, item, event, concept and others.
- Backlinks, wanted pages, orphans, stubs, recent changes, random page, trash.
- History with comparison, a Talk tab for notes, canon status on every page.

### Novel
- Book, Part, Chapter, Scene tree with drag to reorder. Several books per project.
- Word counts, targets, daily goal, scene status, point of view, synopsis.
- Distraction-free mode.
- Hover a name to see its wiki summary. Each wiki page lists the scenes that
  mention it.

### AI
- Right-hand pane that toggles open and closed (`Ctrl+Shift+A`).
- Selecting text offers **Ask AI** (a small text box in place) and
  **Send to pane**.
- Suggested edits appear as tracked changes to accept or reject. The AI never
  edits text silently, and a snapshot is taken before an edit is accepted.
- Provider profiles, connection test, model list, per-task model routing.
- Context view showing exactly what will be sent, with a warning for cloud
  providers. Lore lookup tools, a prompt library, token and cost display.
- Canon status drives what the AI treats as fact. Spoiler control limits it to
  what is known as of a chosen chapter.

### Consistency
- Rule checks (no AI): near-duplicate names, infobox conflicts, broken links,
  timeline errors such as a character appearing after their death.
- AI checks: claims are extracted and compared with the wiki. Every finding
  quotes both sources, and findings whose quotes are not really in the text are
  discarded.
- Each finding can be fixed in the manuscript, fixed in the wiki, marked
  intentional or ignored.
- After a chapter, the AI proposes wiki updates for approval.

### Saving
- `Ctrl+S`, Save As, recent files and an unsaved-changes marker, as in Word.
- Work is continuously journaled to a recovery copy, so a crash or force-close
  does not lose it. Rolling backups on each save.

### Themes and text size
- Encyclopedia (default, dark), Parchment, Typewriter, Midnight Ink and Lorekeeper, each
  with light and dark versions, plus High contrast. Lorekeeper takes its sepia, parchment and
  terracotta from an engraved griffin, the app’s first icon. The app icon is now an
  engraved octopus on deep-sea navy.
- Interface size and writing text size adjust separately.

### Export and import
- Wiki data: JSON, JSONL, Markdown with metadata, CSV, YAML, XML, MediaWiki XML,
  static HTML site, SQLite copy, SillyTavern World Info.
- Novel: DOCX, EPUB, PDF, Markdown, plain text.
- Import: DOCX, Markdown, Obsidian vault, and a documented JSON format for a
  later guided import of the author's lore.

### Project tools
- Project-wide find and replace, including renaming a character everywhere.
- Command palette. Spellcheck with a dictionary built from lore names.
- Timeline view, relationship graph, maps with pins.

### Media
- Drag and drop pictures and videos into any page or scene. Text wraps around them.
- Label each figure, table, picture or video so the AI knows what it shows.
- PDF export covers one wiki page, the whole wiki, one book or all books.

### Writing styles
- A browsable library of writing styles for many popular authors, plus techniques such
  as deep third person or hardboiled narration. Each explains how that author writes and
  provides a prompt for the AI.
- Use a style for a project, book, scene or chat. Blend styles, edit a copy, write your
  own, or build one from your own prose.
- A style describes a manner of writing. Prompts tell the AI to write original text and
  never to reuse an author's text, characters or settings.

### Approved additions

Before v1:
1. Document tabs and split view, so a wiki page can sit beside the scene being written.
2. Reopen the last project and return to where the writer left off.
3. Browse and restore backups.
4. Find in the current page, with highlights.
5. Create and link a wiki page from selected text.
6. Split a scene at the cursor, and merge a scene with the next one.
7. An AI style guide for the project: tense, point of view, voice, words to avoid.
8. Story-so-far summaries of scenes and chapters, kept up to date for the AI.
9. Mark pages "local only", set a cloud spending limit, and see cost estimates before
   whole-book runs.
10. Record each scene's location and cast.
11. Facts that change over time, including a character's age at any scene.
12. Automatic first appearance for each page, which also feeds spoiler control.
13. Help: shortcuts list, About, a sample world and a first-run guide.

Next:
14. Custom page types.
15. Family trees and two-way relationships.
16. Lists that fill themselves in from infobox fields, such as a faction's members.
17. Comments and to-dos attached to text.
18. Plot threads and a character presence chart.
19. An idea inbox with a quick-capture shortcut.
20. A media library: browse, reuse and see where each item is used.
21. Publishing kit: EPUB cover, title and copyright pages, print sizes such as 6x9, and
    an appendix built from the wiki.
22. Prose checks with no AI: overused and repeated words, sentence length, read-aloud.
23. Writing comfort: font, line spacing, page width, first-line indents, a
    dyslexia-friendly font and a high-contrast theme.
24. More AI help: talk to a character, beta-reader feedback, several rewrite options.
25. Search by meaning.

Public release:
26. Update checks and log files.
28. Other languages: spellcheck, interface text, and word counts for languages such as
    Chinese and Japanese.
29. Mac and Linux builds.

30. An MCP server, so AI tools outside the app (Claude Code, OpenCode with a local model
    and others) can read the lore and the book, and propose changes.
    - One "catch me up" tool gives a new AI the overview: books, outline, story so far,
      main pages and the style guide. Other tools search and read pages, scenes, the
      timeline and consistency findings.
    - With the app open, it sees live work. With the app closed, it reads the last saved
      file, read-only.
    - The AI never edits silently from outside either. Changes arrive in the app as
      suggestions to accept or reject, which needs the app open.
    - Off by default and reachable only from this computer. Pages marked "local only" are
      hidden from it unless the writer allows otherwise, because the AI behind a client
      may be a cloud model.

Item 27, tracking how much text came from AI, was considered and rejected by the author.
Do not add it.

## Build order

| Phase | What gets built | Done when |
|---|---|---|
| 0. Foundation | Window, project files, saving and recovery, themes, text size | Force-closing the app loses nothing |
| 1. Wiki | Pages, links, infoboxes, search, history | A 50-page world can be built quickly |
| 2. Novel | Chapter tree, editor, word counts, wiki links | A whole book can be drafted in it |
| 3. AI | Settings, pane, selection menu, tracked changes, lore lookup | Rewriting a passage with the local model works end to end |
| 4. Consistency | Rule checks, AI checks, findings list | It catches errors planted in a test project |
| 5. Export and release | All formats, import, installer | Exports reopen correctly and the installer works |
| 6. Extras | Timeline, graph, maps | Usable from a real project |
