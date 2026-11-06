# Changelog

What changed in each release. Versions follow [semantic versioning](https://semver.org/), and the newest is at the top. The notes for a release are also what the app shows under Help > "Check for updates".

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
