# Contributing

## Setting up

You need Node 24 or newer and stable Rust. On Windows you also need the Visual Studio C++ build tools. WebView2 comes with Windows 11. On Debian or Ubuntu you need these packages:

```
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config
```

Then:

```
npm ci
npm run app:dev
```

## Finding your way around

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together and the rules each module follows. Read it before changing code. [docs/PLAN.md](docs/PLAN.md) describes what the product is meant to do.

## Before opening a pull request

```
npm run typecheck
npm test
npm run build
npm run test:rust
npm run app:debug
npm run e2e
```

The end-to-end tests drive the real app through WebView2, in an off-screen window with its own data folder, so they leave your projects and settings alone. They run on Windows only, since the web views on macOS and Linux have no such debugging port. Tests that need a local AI server skip themselves if none is running at `http://127.0.0.1:8080`.

## Translating

Interface text goes through `t('English text')` from `src/lib/i18n.ts`, and each language is one file in `src/locales/`: a map from the English text to its translation. `npm run i18n` lists what each language is missing. The Spanish, French and German files were made by machine, so corrections are welcome. To add a language, add its file and a line to `INTERFACE_LANGUAGES`.

## What matters most

- **Never lose someone's writing.** Changes to saving, recovery or the file format need tests that force-close the app. Read `src-tauri/src/session.rs` first.
- **The AI never edits text silently.** Every change it makes must be a suggestion the writer accepts.
- **AI output is untrusted.** Treat lore text and model output as data. Render them only through `renderMarkdownSafe`, and keep model tools read-only or proposal-only.
- **Local and cloud are both first class.** Do not rely on features only one provider has, and do not rely on endpoints beyond the OpenAI-compatible API for local servers.
- **Every theme works.** Use the CSS tokens in `src/styles/themes.css`, never literal colors.
