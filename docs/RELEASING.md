# Releasing

> **macOS is not supported for now.** CI and the release workflow build and test Windows and Linux only. The macOS notes below are kept for when it comes back.

## Making a release

1. Set the new version in `package.json` and `src-tauri/Cargo.toml`. `src-tauri/tauri.conf.json` reads it from `package.json`, so leave its `"version": "../package.json"` alone. Run `npm install --package-lock-only` and `cargo check --manifest-path src-tauri/Cargo.toml` so the lock files follow, then `npm run version:check`, which fails if any of them disagree. CI runs the same check. Both numbers matter: the installers take the version from `package.json`, and the app reports Cargo's, which the update check compares with the latest release.
2. Add the release's notes to the top of `CHANGELOG.md`.
3. Merge to `main` and wait for CI to pass. On `main` it tests every platform.
4. If macOS or Linux changed in ways CI cannot see, try a dry run first (below).
5. Tag that commit and push the tag:

   ```
   git tag v1.2.3
   git push origin v1.2.3
   ```

6. The `Release` workflow first checks that the tag names the version in `package.json` and `Cargo.toml`, and stops before building anything if not. Then it creates a **draft** GitHub release named after the tag, attaches the installers, and adds `SHA256SUMS.txt`, the SHA-256 of every file as GitHub serves it. A draft is only visible to people with write access.
7. Download and try each installer, paste the notes from `CHANGELOG.md` into the draft, and press **Publish**. The notes are what the app shows under "Check for updates", as Markdown.

Publishing is what makes a release visible to the update check. The check asks GitHub for the latest published release, which leaves out drafts and pre-releases, and compares its tag with the running version. Tags are read as `v1.2.3` or `1.2.3`.

If a tag was wrong, delete the tag and the draft, fix the version, and tag again. Running the workflow again for the same tag reuses its draft and replaces `SHA256SUMS.txt`.

### Dry run

Actions > Release > Run workflow builds the installers without making a release, from whichever branch you pick. Choose one platform to save minutes: macOS minutes count ten times, and `macos` builds both the Apple Silicon and the Intel version. The installers are kept as workflow artifacts on the run's page for five days, then deleted, because artifacts count against the private repository's storage.

Run it from `main` when you can. Compiled dependencies are cached per branch, and a tag can reuse what `main` saved, but not what another branch saved.

## What CI does

The repository is private for now, so GitHub Actions minutes are limited: 2,000 a month on the free plan, where a Windows minute counts as two and a macOS minute as ten. Once the repository is public, minutes on GitHub's standard machines are free. `.github/workflows/ci.yml` is shaped by that:

| Job | When | What |
|---|---|---|
| `checks`, on Linux | Every run | The version check, typecheck, Vitest, the translation check (`npm run i18n -- --check`) and the license check |
| `test (ubuntu-latest)` | Every run, after `checks` | Debug build, then the Rust tests |
| `test (windows-latest)` | On `main`, when run by hand, and on everything once the repository is public | Debug build, Rust tests and the end-to-end tests |
| `test (macos-latest)` | On `main` and when run by hand | Debug build, then the Rust tests |

- A run happens for each push to `main`, each pull request, and by hand from Actions > CI > Run workflow, on any branch. A run by hand tests every platform, so use it to try Windows and macOS before merging to `main`.
- Pushes and pull requests that only change `docs/` or Markdown files start no run.
- A pull request from `main` in this repository is not tested again, because its push already was. Pull requests from other branches and from forks are.
- A new push cancels the run it replaces, on the same branch or pull request.
- The platform jobs wait for `checks`, so a type error costs a few Linux minutes rather than a Windows and a macOS run.
- Each job has a time limit, so a hung test stops within two hours instead of the default six.
- The debug build runs before the Rust tests, because they embed the built frontend. That way the frontend is built once.
- Compiled Rust dependencies are cached per platform, saved only by pushes, since a pull request's cache could only be used by that pull request.
- The meaning tests run the real 91 MB MiniLM model from huggingface.co. It is cached under its pinned revision, which CI reads from `e2e/meaning.test.mjs`, in the runner's temporary folder, which `LORECRAFT_TEST_MODEL_DIR` points the test at. The cache is saved only when the whole job passed, so a damaged download is never kept.
- When Windows fails, the screenshots in `e2e/artifacts` are kept for seven days.

End-to-end tests run on Windows only, because they drive the app through WebView2's DevTools port, and the web views on macOS and Linux have no equivalent. Before them, CI sets GitHub's Windows machine to 1920x1080 and turns window animations on, since it starts at 1024x768, which would shrink the app's window below the width at which the Write screen opens its details panel, and a Server image may leave animations off, which makes the web view prefer reduced motion. It then runs `e2e/foundation.test.mjs` alone, so a machine where the app cannot start fails in minutes instead of once per test. Tests that need a local AI server skip themselves on GitHub's machines, and API keys go to a file in the test's data folder, not the credential store. GitHub's Windows machines run Windows Server, which may have no H.264 decoder, as Windows plays it through its own media features. If so, the media tests still add, store and save the `.mp4` and `.mov` fixtures and check that each says it cannot be played, but do not play them. The test log says so.

Billed minutes per run, roughly, once the caches are warm:

| Run | Before | Now |
|---|---|---|
| A pull request | 250 to 290 | 15 to 25 |
| Push to `main`, or a run by hand | 250 to 290 | 200 to 300 |
| Change to docs or Markdown only | 250 to 290 | 0 |

Most of a full run is the Windows end-to-end tests, at twice their time, and macOS, at ten times. These are estimates until the first runs show the real times: a run that starts without caches, such as the first one or one after a week without runs, takes longer. With 2,000 minutes a month, that leaves room for many pushes to `develop` but only a handful of full runs, so merge to `main` in batches. A release costs about as much as a full run again, most of it the two macOS builds.

### The release workflow

`.github/workflows/release.yml` builds these on a `v*` tag, or in a dry run:

| Platform | Runner | Files | Target set in |
|---|---|---|---|
| Windows x64 | `windows-latest` | NSIS `.exe` installer | `tauri.conf.json` |
| macOS Apple Silicon | `macos-latest` | `.dmg`, compressed `.app` | `tauri.macos.conf.json` |
| macOS Intel | `macos-latest` | `.dmg`, compressed `.app` | `tauri.macos.conf.json` |
| Linux x64 | `ubuntu-22.04` | `.deb`, `.AppImage` | `tauri.linux.conf.json` |

`bundle.targets` is a single list in Tauri's config, so each platform has a small override file beside `tauri.conf.json`, which Tauri merges on top of it. The AppImage and the `.deb` need at least the glibc of the machine that built them, so Linux is built on Ubuntu 22.04, the oldest that has `libwebkit2gtk-4.1-dev`. They run on Ubuntu 22.04, Debian 12 and other distributions from 2022 on.

## Repository settings

These are set on GitHub, not in the code:

- **Private vulnerability reporting**: Settings > Code security > "Private vulnerability reporting" > Enable. `SECURITY.md` sends people there, and the link in it does nothing until this is on. GitHub offers it for public repositories, so turn it on when the repository goes public. Until then nobody outside can see the repository to report anything.
- **Required checks**: if `main` gets branch protection, the check names are `checks`, `test (ubuntu-latest)`, `test (windows-latest)` and `test (macos-latest)`. A pull request that only changes docs or Markdown starts no run, so a required check would wait for it forever.
- **Actions**: Settings > Actions > General > "Artifact and log retention" can be lowered too, since the workflows already keep their artifacts for at most a week.

## Code signing

Nothing is code signed yet, so operating systems warn about the downloads. Each release's notes tell people what to expect.

| Platform | What people see | What to do |
|---|---|---|
| Windows | SmartScreen: "Windows protected your PC" | "More info", then "Run anyway" |
| macOS | "Apple could not verify" the app. It is ad-hoc signed (`signingIdentity: "-"`), which Apple Silicon needs in order to run at all, but that does not satisfy Gatekeeper | Try to open it, then System Settings > Privacy & Security > "Open Anyway" |
| Linux | Nothing for the `.deb`. An AppImage has to be marked executable | `chmod +x LoreCraft*.AppImage` |

What signing would need:

- **Windows:** a code signing certificate from a certificate authority, or an Azure Trusted Signing account. Set `bundle.windows.signCommand`, or the certificate settings in `bundle.windows`, in `tauri.windows.conf.json`, and put the secrets in the release workflow. Reputation with SmartScreen builds up over time unless the certificate is an EV one.
- **macOS:** an Apple Developer account (paid) and a "Developer ID Application" certificate. Add the secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and either `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` or `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`, pass them to `tauri-action` as environment variables, and remove `signingIdentity` from `tauri.macos.conf.json`. Tauri then signs and notarizes during the build. See <https://v2.tauri.app/distribute/sign/macos/>.

## Updates

The app does not install anything by itself. Help > "Check for updates" and the setting "Check for updates at startup" (off by default) call `src-tauri/src/updates.rs`, which makes one plain GET to `https://api.github.com/repos/CodeCat04/LoreCraft/releases/latest` with the User-Agent `LoreCraft`. A person reads the notes and downloads the new version from the release page.

GitHub answers 404 while no release has been published, and also while the repository is private. The app reports that calmly when someone asked, and says nothing at startup.

### Adding Tauri's signed auto-updater later

This needs a signing key the project does not have yet. It is separate from the code signing above, and it signs update bundles only.

1. Generate a key with `npx tauri signer generate -w ~/.tauri/lorebook.key`, and keep the private key and its password safe. Losing it means existing installs can never update again.
2. Add `tauri-plugin-updater`, and `plugins.updater.pubkey` and `plugins.updater.endpoints` in `tauri.conf.json`. The endpoint for GitHub releases is `https://github.com/CodeCat04/LoreCraft/releases/latest/download/latest.json`. Set `bundle.createUpdaterArtifacts` to `true`.
3. Add the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and pass them to `tauri-action` as environment variables. It then signs the bundles and uploads `latest.json`. Because the workflow creates the release first and passes `releaseId`, keep passing `tagName` too, so the download addresses in `latest.json` point at that exact tag.
4. Keep `updates.rs`, or replace it with the plugin's check. Either way, ask before installing anything, and keep the startup check off by default.

## Logs

Logs are in the `logs` folder of the app's data folder, and Help > "Open log folder" shows them. `lorebook.log` is the newest. It moves to `lorebook.1.log` at 1 MB, and four old files are kept. No log leaves the computer unless someone sends it.

Logs are meant to be safe to attach to a public bug report, so they hold event names, codes and scrubbed error wording, never prose, lore, prompts, model responses, keys or file contents. See the top of `src-tauri/src/logs.rs` before adding a log call.

Help > "Copy diagnostics" gives the version, build type, OS, web view version and whether PDF export works, with no paths or content.

## State of each platform

Windows is the only platform that is used day to day. Before CI first ran on the others, this much was checked by hand, on Ubuntu 24.04 under WSL with no system packages installed:

- Linux: the Rust tests, typecheck, Vitest and `npm run build` pass. A `.deb` is made, with its dependencies, a desktop entry that opens `.lorecraft` files, and their file type. The app starts under WebKitGTK, creates a project, shows the wiki and the export screen, copies diagnostics, and checks GitHub for updates. The AppImage was not made there, so the release workflow's first run, or a dry run of it, is its first real test.
- macOS: the Rust code type-checks for `aarch64-apple-darwin`. Nothing has been built, linked or run on a Mac yet.

Known gaps:

- **PDF export** is Windows-only, since it uses WebView2's `Page.printToPDF`. The export screen says so and offers the other formats. Adding it means `print_*` methods on `Host` in `src-tauri/src/lib.rs`, using `WKWebView.createPDF` on macOS and WebKitGTK printing on Linux, and returning true from `supports_pdf`.
- **Quitting on macOS:** Cmd+Q in Tauri's default menu probably ends the app without asking about unsaved changes. This is not checked yet. No work would be lost, because the session is offered for recovery at the next start. Closing the window does ask.
- **Linux keys:** API keys need a Secret Service provider, such as GNOME Keyring or KWallet. Without one, Settings > AI reports a credential store error, and local models still work.
- **MP4 video without H.264:** most `.mp4` and `.mov` files use H.264, which WebView2 plays through Windows' own media features. Windows N editions leave those out until the Media Feature Pack is added, and Windows Server leaves them out too. There a video figure says the computer cannot play MP4 videos and how to add the pack. On Linux, WebKitGTK plays H.264 only with GStreamer's plugins for it, such as `gstreamer1.0-libav`, and without them the figure gives the general "cannot be played" message.
- **Linux file association:** the `.deb` tells the desktop about `.lorecraft` files (`src-tauri/linux/lorecraft-mime.xml`). An AppImage cannot, so with one, open projects from inside the app.
