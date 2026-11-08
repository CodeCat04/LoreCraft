# Changelog

What changed in each release. Versions follow [semantic versioning](https://semver.org/), and the newest is at the top. The notes for a release are also what the app shows under Help > "Check for updates".

## 0.4.0

Outside AI gets real control. Claude Code, OpenCode and other MCP tools can now work on nearly every part of a project, not only suggest text edits. There are about 80 tools now, up from 21.

- **A new permission: Make changes directly.** In Settings › AI tools (MCP), choose what outside tools may do:
  - **Read only**;
  - **Suggest**, where every change waits for you, as before, and which stays the default;
  - **Make changes directly**, where changes happen at once.

  Each direct change shows a notice and is listed under **Applied by outside AI** in Outside suggestions, with **Undo**. Undo refuses if you've changed that thing since, so it never throws away your newer work.
- **The wiki.** Edit a page's summary, status, type, aliases, categories and infobox fields. Rename pages, with links following. Trash and restore pages, add Talk notes, record relationships (family fields keep in step), and place map pins.
- **Books and the manuscript.**
  - Create books and change their settings: title, point of view, tense, default style, word goal.
  - Move, rename, trash and restore scenes, chapters and parts, and set their status.
  - Split and merge scenes.
  - Set chapter synopses and notes.
  - Create plot threads and put scenes in them.
- **Styles.** Update the style guide, field by field. Create, change and blend your own writing styles, and set the default style for the project, a book or a scene. Manage your own prompts.
- **Organizing.** Work through the idea inbox: edit ideas, mark them done, or turn them into pages. Add comments on a passage and resolve them. Create and edit canvases: cards, arrows, groups and colors, live in an open canvas. Run the rule checks and dismiss or resolve findings. Label pictures and videos.
- **Limits that stay.** Outside tools can never:
  - change their own permission, your AI providers and keys, or your spending limit;
  - change what is marked local only;
  - delete the project, or write files outside it.

  Local-only pages and scenes stay hidden from them unless you choose to share them. They can run the free rule checks, but not AI checks that would spend your money.

The file format hasn't changed, so 0.4.0 projects still open in 0.3.0. Before opening a project in an older copy, accept or reject any outside suggestions that are waiting.

## 0.3.0

Drafting help: the AI can now write with you, not only edit. Everything works with a local model, respects "local only" and your spending limit, and arrives as tracked changes for you to accept or reject.

- **Write as a scene.** Select rough notes, such as stream of consciousness, beats or bullet points, and press **Write as a scene** (`Ctrl+Shift+E`). It becomes finished prose, using the scene's point of view, cast, location, your lore and your default style. Choose short, medium or long.
- **Draft from synopsis and First draft.** From the AI menu, write a scene from its synopsis, or start an empty scene from a few lines of premise. Long drafts on a local model are written in parts.
- **Point of view and tense.** Set them for a book in Book settings. Every AI request that writes prose follows them, and a scene's own point-of-view character still applies.
- **Guided Continue.** "Continue writing" takes an optional note on what should happen next. Ask for 2 or 3 versions and insert the one you like.
- **Describe with the senses.** Select a moment to get short options for sight, sound, smell, touch, taste and metaphor, drawn from your lore. Tick the ones you want and insert them.
- **Brainstorm.** A board of ideas (names, places, plot twists, conflicts, world details and more) that reads your wiki and book, so the ideas fit your world. Keep an idea to the Inbox, make it a page, discard it, or ask for more like it. Open it from the AI menu or `Ctrl+K`.
- **Plan a story.** A step-by-step wizard (Insert › Plan a story…): braindump, synopsis, characters, world, structure, outline and review. The AI suggests at each step, or you can turn it off and fill in everything yourself. Nothing is created until you press Create, and your progress is saved.
- **Story structures.** Three acts, the hero's journey, a story circle, seven points, a beat sheet, a romance arc and a mystery. Use them in the wizard, or apply one to an existing book's Outline or Corkboard. Applying a structure only adds chapters, and you review them first.
- **Outside AI can write in your book.** Claude Code, OpenCode and other MCP tools can now:
  - add text to a scene, even an empty one;
  - rewrite a passage between two anchors, or a whole scene;
  - suggest new scenes and chapters;
  - change a scene's synopsis, point of view, cast and other details.

  Quotes match even with different dashes, ellipses or quote marks. **Review in the scene** lays out a big rewrite as tracked changes, so you accept or reject it paragraph by paragraph. See docs/MCP.md, "Writing with an outside AI".
- **Share prompts as files.** Export one or all of your custom prompts, and import them on another computer, with a preview before anything is added.

The file format hasn't changed, so 0.3.0 projects still open in 0.2.0. 0.2.0 doesn't understand the new kinds of outside suggestions, though. Before opening a project in an older copy, accept or reject any that are waiting.

## 0.2.0

Changes from real use, to make everyday writing faster.

- **Pin outside suggestions.** If your AI works through MCP (Claude Code, OpenCode and the like), pin "Outside suggestions" to the top bar. A live badge shows how many are waiting, one click opens the list, and you stay in it while you accept or reject each one.
- **Back and Forward.** Arrow buttons at the top left, plus your mouse's side buttons. Right-click either arrow for a list of recent pages to jump to.
- **Your writing style by default.** "Rewrite in a style…" now opens with your scene's, book's or project's style already selected. **Rewrite in my style** (`Ctrl+Shift+Y`) skips the picker entirely, recently used styles come first, and you can set the default from the picker or from Book settings.
- **Edit and rerun in the AI chat.** Edit any of your messages (or press Up in an empty message box) and run it again, or Regenerate a reply. Earlier answers are kept: flip between them with ‹ 1 of 2 ›.

Projects saved by 0.2.0 use a newer file format, for chat versions. LoreCraft 0.1.0 refuses to open them rather than misread them, so update every copy you use.

## 0.1.0

The first release, for Windows and Linux (a `.deb` package and an AppImage). macOS isn't supported yet.

### Wiki

- Articles that look and work like Wikipedia: infoboxes, contents boxes, references, categories, and red links for pages that do not exist yet.
- Create a page in a keystroke (`Ctrl+N`), link with `[[`, or make a page straight from a name selected in the manuscript.
- Page templates for characters, places, factions, items, events and concepts, and custom page types.
- History with comparison, a Talk tab for notes, and canon status on every page. Backlinks, wanted pages, orphans, stubs, recent changes and a trash.
- Lists that fill themselves in from infoboxes, family trees and two-way relationships, a relationship graph, maps with pins, and a timeline built from the dates already on your pages.

### Novel

- Books, parts, chapters and scenes in a binder you can drag to reorder, with several books per project.
- Split a scene at the cursor and merge it with the next one. Record each scene's point of view, location and cast.
- Plot threads and a chart of who appears where.
- Word counts, targets, daily goals, focus mode, a corkboard and an outline.
- Names of characters and places are recognized as you write, and hovering one shows its page.
- Document tabs and split view, so a wiki page can sit beside the scene being written.

### AI

- Works with local models through any OpenAI-compatible server, such as llama.cpp, LM Studio or Ollama, and with Anthropic and OpenAI using your own API key, kept in the system's credential store.
- Select text and ask for a change, or send it to the AI pane. Every edit arrives as a tracked change to accept or reject.
- The AI reads your lore, respects what is canon, and can be limited to what is known as of a given chapter.
- A context view shows exactly what will be sent. Pages and scenes marked "local only" are never sent to a cloud model, and a monthly spending limit caps cloud costs.
- Talk to one of your characters, get beta-reader notes, or see three versions of a rewrite.
- A project style guide, and story-so-far summaries that keep the AI up to date.
- Search by meaning, with an optional built-in model that is downloaded only when you ask.

### Consistency

- Rule checks with no AI: impossible dates, characters appearing after their deaths, near-duplicate names and broken links.
- AI checks compare the manuscript with the lore, and every finding quotes both sources.
- Facts can change during the story, including a character's age at any scene, so a character who dyes her hair in chapter 10 is not a contradiction.

### Writing styles

- A library of over 200 writing styles and techniques, each explaining how that author writes and giving the AI a prompt to write in that manner, in original prose.
- Blend styles, write your own, or build one from your own writing.

### Pictures, video and tables

- Drag pictures and videos into any page or scene, label them so the AI knows what they show, and let the text wrap around them.
- A media library to browse, reuse and see where each item is used.

### Saving

- Saving works like Word: the file changes only when you save.
- Every edit is kept in a recovery copy, so a crash or power cut loses nothing, and each save keeps a backup you can browse and restore.
- Reopens the last project where you left off.

### Export and import

- Books: PDF, DOCX, EPUB, Markdown and plain text, with a publishing kit for covers, front matter and print sizes.
- Wiki: JSON, JSONL, CSV, YAML, XML, MediaWiki, a static website, a SQLite copy and SillyTavern lorebooks.
- Import from DOCX, Markdown, an Obsidian vault, or the JSON format in [docs/IMPORT_FORMAT.md](docs/IMPORT_FORMAT.md).

### Tools and comfort

- Project-wide find and replace, a command palette, find in page, comments and to-dos attached to text, and an idea inbox.
- Prose checks with no AI: overused and repeated words, sentence length, read-aloud.
- Spellcheck with a dictionary built from your lore names. Interface in English, Spanish, French and German.
- Four themes in light and dark, a high-contrast theme, a dyslexia-friendly font, and separate interface and writing text sizes.
- A built-in MCP server, off by default, that lets Claude Code, OpenCode and other AI tools read your lore and book and suggest changes for you to approve. See [docs/MCP.md](docs/MCP.md).
- Help > "Check for updates", log files, and "Copy diagnostics" for bug reports.
