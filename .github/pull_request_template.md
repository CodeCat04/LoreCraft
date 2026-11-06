## What this changes

<!-- What a writer will notice, and why. Link the issue it fixes, if there is one. -->

## How it was tested

- [ ] `npm run typecheck`, `npm test` and `npm run i18n -- --check`
- [ ] `npm run test:rust`
- [ ] `npm run app:debug`, then `npm run e2e` or the suites this touches
- [ ] Screenshots for anything you can see, in a light and a dark theme

## The rules in CONTRIBUTING.md

- [ ] No writing can be lost. Changes to saving, recovery or the file format have tests that force-close the app.
- [ ] The AI never edits text silently. Every change it makes is a suggestion the writer accepts.
- [ ] Lore and model output are treated as data, and rendered only through `renderMarkdownSafe`.
- [ ] It works the same with local models and cloud providers.
- [ ] It uses the theme's CSS tokens, never literal colors, and new interface text goes through `t()`.
