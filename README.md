<p align="center"><i>&ldquo;You will own everything, and you will be happy.&rdquo;</i></p>

<p align="center">
  <img src="docs/brand/lorecraft-icon.png" width="128" height="128" alt="LoreCraft icon: an engraved octopus on a deep-sea navy tile">
</p>

<h1 align="center">LoreCraft</h1>

<p align="center"><img src="docs/media/trailer.png" width="900" alt="A one-minute tour of LoreCraft"></p>
<p align="center"><sub>The built-in sample world: a wiki page and its infobox, a new page from a red link, the book beside it, an AI suggestion you accept, the consistency check, the atlas, a canvas, and the themes. Remake it with <code>npm run trailer</code>.</sub></p>

<p align="center">
  <b>A worldbuilding wiki and novel writer, with an AI companion that knows your world.</b><br>
  Build your lore like Wikipedia, write your books beside it, and keep every detail consistent,<br>
  with a local model or a frontier one. Offline-first, and your files stay yours.
</p>

<p align="center">
  <img alt="Tauri 2 · Rust · React" src="https://img.shields.io/badge/Tauri%202-Rust%20%C2%B7%20React-1d3753?style=flat-square&logo=tauri">
  <img alt="Windows · Linux" src="https://img.shields.io/badge/Windows%20%C2%B7%20Linux-desktop-b29e84?style=flat-square">
  <img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-3a3a3a?style=flat-square">
  <img alt="Status: early alpha" src="https://img.shields.io/badge/status-early%20alpha-d69e2e?style=flat-square">
  <a href="https://github.com/CodeCat04/LoreCraft/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/CodeCat04/LoreCraft/ci.yml?branch=main&style=flat-square&label=CI"></a>
</p>

<p align="center">
  <a href="https://github.com/CodeCat04/LoreCraft/releases"><b>Download</b></a> ·
  <a href="#what-it-does">Features</a> ·
  <a href="#ai-providers">AI providers</a> ·
  <a href="#build-from-source">Build</a> ·
  <a href="docs/MCP.md">Use it from Claude Code or OpenCode</a>
</p>

![The main page of the sample world, a wiki with a sidebar of page types](docs/screenshots/wiki-main-page.png)

## Your words, your worlds, your machine

**LoreCraft collects nothing.** No telemetry, no analytics, no usage metrics, no crash reports sent anywhere, no accounts, no sign-in. It doesn't phone home. Everything you write lives in one file on your own computer, and it never leaves unless you choose to send it.

- **Local first.** The whole app runs on your machine and works fully offline. Your worlds are ordinary `.lorecraft` files you can copy, move, back up or delete like any other file.
- **Nothing goes out unless you ask.** The only connections LoreCraft ever makes are ones you start: an AI provider you set up yourself, a one-time download of the search model (only after you agree), a web page you click to load on a canvas, or an update check, which is **off** by default. Pages you mark *local only* are never sent to any cloud AI.
- **Run your AI locally if you like.** Point it at llama.cpp, LM Studio or Ollama and not a single word leaves your computer.
- **You own it.** What you create with LoreCraft is yours alone: your writing, your characters, your worlds. The app is free software under the AGPL, so no one can take it away or lock your work inside it.
- **Backups are your responsibility.** LoreCraft keeps rolling backups and a recovery copy on your machine, but it can't protect you from a dead drive or a lost laptop. Keep copies of your project files somewhere else you trust. And remember: *the cloud is just someone else's computer.* If you keep your only copy there, it's only as safe as their servers and their terms of service.

## Why LoreCraft

Long series fall apart in the details: an eye color that changes, a character who walks in after dying, a date that cannot be. LoreCraft keeps your world and your manuscript in one file, links them as you write, and checks one against the other. The AI helps, but it never changes a word without you accepting it, and nothing you mark "local only" ever leaves your computer.

## What it does

**A wiki for your world.** Articles that look and work like Wikipedia, with infoboxes, contents boxes, references, categories, red links for pages that do not exist yet, history with comparison, and a Talk tab for notes. Create a page in a keystroke, link with `[[`, and make a page straight from a name you select in your manuscript. Custom page types, lists that fill themselves in from infoboxes, family trees, a relationship graph, maps with pins, and a timeline built from the dates already on your pages.

**Canvases for research and brainstorming.** An endless board of cards: Markdown notes, live wiki pages and scenes (or one section of them), pictures and videos from the project, other canvases, and web pages or YouTube videos that load only when you ask. Connect cards with labeled arrows, gather them in colored groups, snap, align and spread them, and undo anything. Canvases use the open JSON Canvas format, so `.canvas` files import and export, and a canvas can be shown inside a wiki page.

![A character article with its infobox, contents box and links](docs/screenshots/wiki-article.png)

![The relationship graph of the sample world, drawn from links between its pages](docs/screenshots/relationship-graph.png)

**Your novel.** Books, parts, chapters and scenes in a binder you can drag to reorder. Split and merge scenes, record each scene's point of view, location and cast, and track plot threads and who appears where. Word counts, daily goals, focus mode, a corkboard and an outline. Names of characters and places are recognized as you write, and hovering one shows its page.

![A scene in the manuscript, with the binder on the left and the scene's point of view, location and cast on the right](docs/screenshots/manuscript.png)

**Pictures, video and tables.** Drag them in, label them so the AI knows what they show, and let the text wrap around them.

**An AI that keeps your world straight.** Select text and ask for a change, or send it to the AI pane. Every edit arrives as a tracked change you accept or reject. The AI reads your lore, respects what is canon, and can be limited to what is known as of a given chapter. Talk to one of your characters, get beta-reader notes, or see three versions of a rewrite.

**Consistency checks.** Rule checks catch impossible dates, characters appearing after their deaths, near-duplicate names and broken links. AI checks compare your manuscript against your lore, and every finding quotes both sources. Facts can change during the story, so a character who dyes her hair in chapter 10 is not a contradiction.

**Writing styles.** A library of over 200 writing styles, from Tom Clancy and Andy Weir to Jane Austen and Terry Pratchett, plus techniques such as deep third person. Each explains how that author writes and gives the AI a prompt to write in that manner, in original prose. Blend styles, write your own, or build one from your own writing.

**Never lose work.** Saving works like Word: your file changes only when you save. Every edit is kept in a recovery copy, so a crash or power cut loses nothing, and each save keeps a backup you can restore.

**Export anything.** PDF, DOCX, EPUB, Markdown and plain text for your book, with a publishing kit for covers, front matter and print-ready sizes. JSON, CSV, YAML, XML, MediaWiki, a static website and SillyTavern lorebooks for your wiki.

**Outside AI tools.** A built-in MCP server lets Claude Code, OpenCode and other AI tools read your lore and book, and suggest changes for you to approve. See [docs/MCP.md](docs/MCP.md).

## AI providers

LoreCraft works with:

- **Local models** through any OpenAI-compatible server, such as llama.cpp, LM Studio or Ollama. Nothing leaves your computer.
- **Anthropic (Claude)** and **OpenAI**, with your own API key, stored in your system's credential store.

Set them up in Settings > AI. Pages and scenes marked "local only" are never sent to a cloud model, you can set a monthly spending limit, and you can see exactly what will be sent before anything is.

## Quick start

1. Install LoreCraft from the [releases page](https://github.com/CodeCat04/LoreCraft/releases).
2. Open the sample world from the start screen to look around, or download [examples/The Saltmarch.lorecraft](examples/) and open it. It has a few planted mistakes for the consistency checker to find.
3. Make your own project with **File > New project**, then press **Ctrl+K** to find any page or command.
4. Optional: add an AI in **Settings > AI**, local or cloud.

## Install

Download the installer for your system from the [releases page](https://github.com/CodeCat04/LoreCraft/releases). The builds are not code signed yet, so Windows may show a SmartScreen warning: choose "More info", then "Run anyway".

LoreCraft runs on **Windows** and **Linux**. On Windows, use the `-setup.exe` installer. On Linux, use the `.deb` package (Debian, Ubuntu and their relatives) or the `.AppImage` (most other distributions; make it executable, then run it). It needs WebKitGTK 4.1, which current distributions include. PDF export works on both. macOS isn't supported yet.

Each release lists the SHA-256 of every file in `SHA256SUMS.txt`. To check a download, compare it with `Get-FileHash <file>` in PowerShell, or run `sha256sum -c SHA256SUMS.txt --ignore-missing` on Linux.

### Portable (no install)

On Windows you can also download `LoreCraft_<version>_x64-portable.zip`. Unzip it anywhere, such as a USB drive or a folder in Documents, and run `lorecraft.exe`. Settings, recovery copies, backups, logs and models stay in the `data` folder beside it, so copying the folder moves everything. The folder must be writable. It needs Microsoft Edge WebView2, which comes with Windows 11.

### Run from source

On Windows, double-click `run-from-source.cmd` in a copy of this repository. It checks for Node 24 or newer and Rust, says what is missing and where to get it, installs the packages the first time, builds the app and starts it. The first build takes a while.

## Build from source

You need Node 24 or newer and stable Rust. See [CONTRIBUTING.md](CONTRIBUTING.md) for the platform packages, then:

```
npm ci
npm run app:dev
```

## Keyboard essentials

| Keys | Does |
|---|---|
| Ctrl+K | Find any page or command |
| Ctrl+N | New page (selected text becomes its title) |
| Ctrl+S | Save |
| Ctrl+Shift+A | Show or hide the AI pane |
| Ctrl+Shift+K | Ask the AI about selected text |
| Ctrl+F / Ctrl+H | Find / replace in the page |
| F11 | Focus mode |
| Alt or F10 | Open the menus from the keyboard |

## Documentation

- [docs/PLAN.md](docs/PLAN.md): what the product does and why.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built.
- [docs/IMPORT_FORMAT.md](docs/IMPORT_FORMAT.md): bringing existing notes in.
- [docs/MCP.md](docs/MCP.md): connecting outside AI tools.
- [docs/RELEASING.md](docs/RELEASING.md): making a release.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.
- [CONTRIBUTING.md](CONTRIBUTING.md): setting up, and what a change needs.
- [SECURITY.md](SECURITY.md): reporting a security problem privately.

## License

Copyright (C) 2026 CodeCat04.

LoreCraft is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License, version 3](LICENSE), as published by the Free Software Foundation. It comes with no warranty. If you run a modified version for others over a network, the license asks you to offer them its source. Bundled spelling dictionaries and fonts keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
