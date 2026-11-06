# Third-party notices

LoreCraft itself is under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)). It is built from other open-source projects and ships with files from others, each under its own license.

The full list is [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt): every npm package and Rust crate in the app, with its version, license, source, and full license and notice texts. The installer puts that file beside the program, and Help > About LoreCraft > Third-party licenses shows it. `npm run licenses` writes it from `package-lock.json` and `cargo metadata`, and `npm run licenses:check` fails when it is out of date.

## Spelling dictionaries

The dictionaries are data files, not part of the program. The installer puts each one in its own folder, `dictionaries/<language>/` beside the program, with a `LICENSE.txt` that gives its license in full and a link to its source. The spellchecker reads one when its language is chosen.

| Package | Language | License | LoreCraft distributes it under |
|---|---|---|---|
| `dictionary-en` | English (US) | MIT and BSD | MIT and BSD |
| `dictionary-en-gb` | English (UK) | MIT and BSD | MIT and BSD |
| `dictionary-es` | Spanish | GPL-3.0 or LGPL-3.0 or MPL-1.1 | MPL-1.1 |
| `dictionary-fr` | French | MPL-2.0 | MPL-2.0 |
| `dictionary-de` | German | GPL-2.0 or GPL-3.0 | GPL-2.0 or GPL-3.0, both texts included |
| `dictionary-it` | Italian | GPL-3.0 | GPL-3.0 |
| `dictionary-pt` | Portuguese | LGPL-3.0 or MPL-2.0 | MPL-2.0 |
| `dictionary-ru` | Russian | BSD-3-Clause | BSD-3-Clause |

The German and Italian dictionaries are under the GPL. They ship beside LoreCraft as separate, unchanged files, with the GPL's text and a link to their source. The program only reads them as data, so they are an aggregate with it, not part of it.

## Fonts

All bundled fonts are under the SIL Open Font License 1.1: Inter, Libertinus Serif, EB Garamond, Courier Prime, Source Serif 4, OpenDyslexic and Atkinson Hyperlegible. A website exported from LoreCraft carries Inter and Libertinus Serif, with their license and copyright lines in `assets/fonts/OFL.txt`.

## Other software

`jszip` is offered under MIT or GPL-3.0-or-later. LoreCraft uses it under MIT.

The optional search-by-meaning model, all-MiniLM-L6-v2, is downloaded only when the writer asks for it, and is under the Apache-2.0 license.
