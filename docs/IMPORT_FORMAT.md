# LoreCraft import format

This is the format for bringing a world into LoreCraft: a wiki of pages, plus any books.
It is written for a person or an AI agent converting someone's existing notes. LoreCraft's
own JSON and YAML exports use this same format, so an export is always a valid import.

Go to **File > Import**, choose the file, read the preview, and press **Import**. Nothing
is written until then, and a failed import leaves the project exactly as it was.

## The shape of a file

A file is one JSON object, or the same structure in YAML.

```json
{
  "format": "lorebook",
  "version": 1,
  "pages": [],
  "books": [],
  "relationships": []
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Always `"lorebook"`. |
| `version` | yes | Always `1`. |
| `pages` | no | Wiki pages. |
| `books` | no | Books, each with its parts, chapters and scenes. |
| `relationships` | no | Links between pages for the relationship graph. |
| `threads` | no | Plot threads. See [Plot threads](#plot-threads). |
| `assets` | no | Pictures and videos, as base64. See [Pictures and videos](#pictures-and-videos). |
| `maps` | no | Maps with pins. Written by LoreCraft's export. See [Other fields](#other-fields). |
| `dictionary` | no | Words the spellchecker should accept. A list of text. |

A field left out, or set to `null`, is treated as absent. A field LoreCraft does not know
is ignored with a warning naming it, so a misspelling shows up in the preview.

## Body text

`content` on a page or scene, and `notes` on a page, may be either of these:

- **Markdown**, as a text value. This is what to write when converting notes.
- **ProseMirror JSON**, as an object with `"type": "doc"`. LoreCraft's exports use this,
  because it keeps everything. It must fit the schema in `src/editor/schema.ts`.

In Markdown, write links between pages as `[[Page title]]` or `[[Page title|shown text]]`.
A link to a page that does not exist is fine: it appears as a red link, and starts working
when that page is created. Also supported:

| You write | You get |
|---|---|
| `## Early life` | A section heading. Use levels 2 to 4. The page title is the level 1 heading. |
| `**bold**`, `*italic*`, `~~struck~~`, `` `code` `` | That formatting. |
| `[text](https://example.com)` | An outside link. |
| `- item`, `1. item` | Lists, which can nest. |
| `> quoted` | A block quote. |
| `---` | A horizontal rule. |
| A pipe table | A table. A line `Table: Her ranks` straight after it becomes its label. |
| `^[Annals of the Vale, vol. 2]` | A citation, listed under the article. |
| `![The road north](asset:map1 "A map of the road")` | A figure: a picture with a label. The `asset:` name is an `id` from `assets`, the text in brackets is the label, and the quoted text describes what it shows. |
| `![The ride](video:https://example.com/ride.mp4)` | A figure holding a linked video. |
| `![The ride](video:asset:clip1)` | A figure holding a video from `assets`. |

Raw HTML is not interpreted. It stays as visible text.

### Figures

A figure is a labeled picture, video or table, numbered automatically: "Figure 1", "Picture 2",
"Table 1", "Video 1". Text wraps around it when it sits at the left or right. In Markdown a
figure sits at the right at its default width. To choose how one is laid out, write that body
as ProseMirror JSON:

```json
{
  "type": "figure",
  "attrs": { "kind": "picture", "align": "left", "width": 40, "description": "A map of the road" },
  "content": [
    { "type": "image", "attrs": { "assetId": "map1" } },
    { "type": "figcaption", "content": [{ "type": "text", "text": "The road north" }] }
  ]
}
```

| Attribute | Meaning |
|---|---|
| `kind` | `figure`, `picture`, `table` or `video`, which sets how it is numbered. |
| `align` | `left` or `right` to wrap text around it, `center` or `full` not to. |
| `width` | A percentage of the text column, or `null` for the default. |
| `description` | More detail about what it shows. It is the picture's alt text, and the AI reads it. |

The first child is an `image` (`attrs.assetId`), a `video` (`attrs.assetId`, or `attrs.url` for a
linked one) or a `table`. The second is the `figcaption`, which holds the label and may hold links.

## Pages

```json
{
  "title": "Aria Vale",
  "pageType": "character",
  "status": "canon",
  "summary": "A ranger of the north, and the last of her line.",
  "aliases": ["The Ranger", "Aria of the Vale"],
  "categories": ["Characters", "Rangers"],
  "infobox": {
    "caption": "Aria at the Silver Gate",
    "imageAssetId": "aria-portrait",
    "fields": [
      { "key": "born", "value": "12 Frost 1204" },
      { "key": "location", "value": "Silver Vale" }
    ]
  },
  "content": "**Aria Vale** is a ranger of [[Silver Vale|the Vale]].",
  "notes": "Check her age against the timeline."
}
```

| Field | Required | Type | Meaning |
|---|---|---|---|
| `title` | yes | text | The name. Unique in a project, ignoring case and spacing. |
| `pageType` | no | text | `character`, `place`, `faction`, `item`, `event`, `concept`, `species`, `culture`, `organization`, or anything else. Default `article`. |
| `status` | no | text | `canon` (true of the story), `draft`, `idea` or `retconned`. Default `draft`. |
| `summary` | no | text | One line, shown when hovering a link and read by the AI. |
| `aliases` | no | list of text | Other names. Links to them reach this page. |
| `categories` | no | list of text | Categories this page is in. |
| `infobox` | no | object | The box of facts beside the article. See below. |
| `content` | no | Markdown or ProseMirror | The article. |
| `notes` | no | Markdown or ProseMirror | The page's Talk tab. |
| `isHome` | no | true or false | This page is the wiki's main page. See below. |
| `id` | no | text | A name for this page within the file, for `pov` and `relationships` to use. Titles work too, so this is rarely needed. |
| `revealNodeId` | no | text | The `id` of the scene or chapter where this page stops being a spoiler. |
| `localOnly` | no | true or false | Never send this page to a cloud AI. See [Local only](#local-only). |
| `createdAt`, `updatedAt` | no | RFC 3339 time | When it was written. Defaults to now. |

`wordCount` also appears in exports. It is worked out from the text, so it is ignored here.

### Main page

A new project starts with an empty "Main Page". A page with `isHome` set, or one titled
"Main Page", replaces it as long as nobody has edited it. If the main page has been
edited it stays, and a page with `isHome` becomes an ordinary page, with a warning.

### Infobox

`fields` is a list, and shows in the order given. Each field has:

| Field | Required | Meaning |
|---|---|---|
| `key` | yes | The field's identity, as in the table below. Use your own for anything else. |
| `value` | no | The text. A list of titles is also accepted, which makes a `page` field into `pages`. |
| `label` | no | The name shown. Defaults from the page's type, then the table below, then the key. |
| `kind` | no | `text`, `longtext`, `date`, `number`, `page` or `pages`. Defaults from the table below, or `text`. |
| `changes` | no | How the fact changes during the story. A list of objects, each with `value` and any of `nodeId` (the `id` of the scene where it becomes true), `date` (in the story's calendar) and `note`. |

For `page`, `value` is one page title, shown as a link. For `pages`, it is titles
separated by commas, each shown as a link. A date is free text in the story's own
calendar, such as `12 Frost 1204`.

The wiki's page templates use these keys, so prefer them when one fits:

| Key | Label | Kind | | Key | Label | Kind |
|---|---|---|---|---|---|---|
| `born` | Born | date | | `end` | Ended | date |
| `died` | Died | date | | `parents` | Parents | pages |
| `age` | Age | number | | `spouse` | Spouse | pages |
| `species` | Species | page | | `children` | Children | pages |
| `gender` | Gender | text | | `leader` | Leader | page |
| `affiliation` | Affiliation | pages | | `members` | Members | pages |
| `location` | Location | page | | `owner` | Owner | page |
| `founded` | Founded | date | | `creator` | Creator | page |
| `dissolved` | Dissolved | date | | `height` | Height | text |
| `date` | Date | date | | `eyes` | Eyes | text |
| `start` | Began | date | | `hair` | Hair | text |

Some page types have their own word for a key, and a field with no `label` uses it. For
example `location` reads Home on a `character`, Part of on a `place` and Headquarters on a
`faction`. An `age` with words in it, such as `about 30`, is kept as `text`.

`caption` is the text under the infobox picture. `imageAssetId` is an `id` from `assets`.

## Books

A book holds parts and chapters, a part holds chapters, and a chapter holds scenes. Only
scenes hold text. Order in the file is order in the book.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `title` | yes | text | The book's title. |
| `subtitle`, `author` | no | text | Shown on title pages. |
| `targetWords` | no | whole number | The writer's goal. |
| `children` | no | list | Parts and chapters. |
| `publishing` | no | object | Cover, series, ISBN, front and back matter. See below. |

Each item in `children`:

| Field | Required | Type | Meaning |
|---|---|---|---|
| `kind` | yes | text | `part`, `chapter` or `scene`. |
| `title` | no | text | Its title. |
| `children` | no | list | What it holds. Not for scenes. |
| `content` | no | Markdown or ProseMirror | The prose. Scenes only. |
| `status` | no | text | `idea`, `outline`, `draft`, `revised` or `final`. Default `draft`. |
| `synopsis` | no | text | A short description. |
| `notes` | no | text | The writer's own plain text notes. |
| `pov` | no | text | The point-of-view character: a page title or alias. |
| `location` | no | text | Where the scene happens: a page title or alias. Scenes only. |
| `cast` | no | list of text | Who is in the scene: page titles or aliases. Scenes only. |
| `threads` | no | list of text | The plot threads it carries, by name or by `id`. Scenes only. |
| `storyDate` | no | text | When it happens in the story, in the story's own calendar. |
| `targetWords` | no | whole number | The writer's goal. |
| `localOnly` | no | true or false | Never send this to a cloud AI. On a chapter or part, its scenes count as marked too. See [Local only](#local-only). |
| `id` | no | text | A name within the file, for a page's `revealNodeId`. |
| `createdAt`, `updatedAt` | no | RFC 3339 time | When it was written. |

Importing the first book into a new project replaces the empty "Book One" it starts with,
as long as nobody has touched it.

### Local only

A page or scene marked local only is never sent to a cloud AI, and the AI server built into
LoreCraft hides it unless the writer shares it. `"localOnly": true` marks it. An import can add
the mark but never removes it, whatever the conflict policy, because removing it by mistake
would send private writing to a cloud provider. `false` or no value leaves things as they are.
To remove the mark, use the page or scene in the app.

What each export does with marked pages and scenes:

- **JSON, YAML, Markdown, XML and CSV** keep them and write the mark, so it comes back on import.
- **SillyTavern and JSONL**, which are made for other AI tools, leave them out unless the writer
  ticks **Include pages and scenes marked local only**. A scene in a marked chapter or part is
  left out with it.
- **EPUB, PDF, Word, plain text, the website and MediaWiki** are for people to read, so they
  keep them as usual.
- **SQLite** is an exact copy, mark included.

### Plot threads

`threads`, at the top level of the file, lists the story's plot threads. A scene joins one
through its own `threads`. A scene may also name a thread that is not listed, and it is
made with that name.

```json
{ "threads": [{ "name": "The Long Road", "color": "green", "description": "Getting home.", "position": 0 }] }
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Its name. A thread with the same name as one in the project is that thread, whatever the conflict policy, and only overwriting replaces its details. |
| `color`, `description` | no | How the thread board shows it. |
| `position` | no | Its place in the list. Default last. |
| `id` | no | A name within the file for scenes to use. Exports write this. |

### Publishing details

All of this is optional, and shows in the Publishing details screen. It goes into EPUB,
Word and PDF exports.

```json
{
  "coverAssetId": "cover1",
  "series": "The Vale Cycle",
  "seriesNumber": "2",
  "description": "A ranger rides north.",
  "language": "en",
  "publisher": "Silver Gate Press",
  "isbn": "9781234567897",
  "copyrightYear": "2026",
  "titlePage": true,
  "copyright": { "include": true },
  "dedication": "For *everyone* who kept the road.",
  "epigraph": { "include": true, "content": "Not all roads run north." },
  "acknowledgments": "My thanks to the Wardens.",
  "aboutAuthor": "Élodie Writer lives by the sea.",
  "appendices": [
    { "title": "Cast of Characters", "kind": "cast", "pageTypes": ["character"], "canonOnly": true, "hideSpoilers": true },
    { "title": "Glossary", "kind": "glossary", "categories": ["Terms"] },
    { "title": "Maps", "kind": "maps" }
  ]
}
```

| Field | Meaning |
|---|---|
| `coverAssetId` | The `id` of a picture in `assets`. |
| `seriesNumber`, `copyrightYear` | Text or a number. |
| `titlePage` | `false` leaves out the title page. |
| `copyright`, `dedication`, `epigraph`, `acknowledgments`, `aboutAuthor` | Markdown text, or an object with `include` (true or false) and `content` (Markdown or ProseMirror). A `copyright` with no `content` gets a standard notice. |
| `appendices` | Sections at the back of the book, in order. `kind` is `cast`, `glossary` or `maps`. |
| `appendices[].categories`, `pageTypes` | Pages with any of these go in, listed by title with their summary. Maps ignore both, and use every map. |
| `appendices[].canonOnly` | Only pages with status `canon`. Default true. Retconned pages never go in. |
| `appendices[].hideSpoilers` | Leaves out pages whose `revealNodeId` is in a later book. Default true. |

## Project settings

An export also has `project.meta`, the project's own settings as text. It is read back too.
Custom page types are there as `pageTypes`, a JSON list of objects with `type`, `label`,
`plural`, `description`, `fields` and `sections`.

## Relationships

```json
{ "from": "Aria Vale", "to": "Silver Vale", "kind": "born in", "note": "North side of the valley." }
```

`from` and `to` are page titles, aliases or `id`s, in this file or already in the project.
`kind` defaults to `related`. A relationship naming a page that cannot be found is left out
with a warning.

## Pictures and videos

Each entry in `assets` holds one file:

```json
{ "id": "map1", "name": "north-map.png", "mime": "image/png", "base64": "iVBORw0KGgo...", "width": 800, "height": 600 }
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Your name for it. Bodies refer to it as `asset:map1`, and infoboxes through `imageAssetId`. |
| `mime` | yes | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `video/mp4`, `video/webm`, `video/ogg` or `video/quicktime`. SVG is refused because it can carry scripts. |
| `base64` | yes | The file's bytes in base64. A file that is not really one of those types, or a picture over 256 MB, is left out with a warning. |
| `name` | no | A file name for it. Defaults to the `id`. |
| `width`, `height` | no | Its size in pixels. |

The same bytes imported twice are stored once. A body naming an asset that does not exist
gets a warning, and shows an empty space.

## If something already exists

The import screen asks what to do about pages and books with the same name as something in
the project. "The same" ignores case and spacing, as links do. The preview shows the
result for each one before anything changes.

| Choice | Pages | Books |
|---|---|---|
| **Skip** (default) | The existing page stays as it is. | The existing book stays as it is. |
| **Rename** | A new page, called "Aria Vale (2)". Links in the file to "Aria Vale" go to the new page. | A new book, called "The Silver Road (2)". |
| **Overwrite** | The page keeps its identity and history. Its current text is saved in History, then each field in the file replaces what is there. Fields the file leaves out stay. | Parts, chapters and scenes with the same kind and title are updated in place, with scene text saved in History first. New ones are added. Any the file leaves out go to the trash, where they can be restored. |

Importing the same file twice with **Skip** or **Overwrite** changes nothing further.

## Problems

An **error** refuses the whole import and nothing is written. A **warning** drops one value
or reference and the rest goes ahead. Each names the item and the field, for example:

```text
pages[3] "Silver Vale", status: "published" is not one of canon, draft, idea, retconned
books[0] "The Silver Road".children[1] "Interlude".children[0], kind: a part cannot go inside a chapter.
pages[7] "Aria", content: is not a valid document: Unknown node type: video-player
books[0] "The Silver Road".children[0].children[0] "The Gate", pov: no page is called "Aria", so the point of view was left empty
```

Fix the file and choose it again. Things that often go wrong when converting notes:

- A scene directly in a book or part. Scenes go inside chapters.
- `infobox` written as `{ "born": "1204" }`. Use `{ "fields": [{ "key": "born", "value": "1204" }] }`.
- Two pages with the same title. Merge them, or use `aliases` for the other name.
- `aliases` or `categories` written as one text value. They are lists.

## Other fields

LoreCraft's exports also write these, and they import back. There is no need to write them
by hand.

- `exportedAt`, the time of the export, and `project`, with the project's `name` and its
  `meta` settings. The name is not changed by an import.
- `maps`: `{ "title", "assetId", "pins": [{ "page", "label", "x", "y" }] }`, with `x` and `y`
  from 0 to 1 as a fraction of the picture.
- `prompts`: the project's own AI prompts.
- `writingLog` on a book: `[{ "day", "wordsAdded", "wordsRemoved" }]`.
- `omitted: true` on an asset: it was too large to include in the export.

Trash, page history, AI conversations and consistency findings are not in the format. The
SQLite export is a complete copy of the project, including those.

## A complete example

This small world uses every common feature. It imports as it stands.

```json
{
  "format": "lorebook",
  "version": 1,
  "pages": [
    {
      "title": "The Vale",
      "pageType": "home",
      "status": "canon",
      "isHome": true,
      "content": "Welcome to the wiki of **the Vale**.\n\nStart with [[Aria Vale]], or read about [[Silver Vale|the valley]] and [[The Wardens]]."
    },
    {
      "title": "Aria Vale",
      "pageType": "character",
      "status": "canon",
      "summary": "A ranger of the north, and the last of her line.",
      "aliases": ["The Ranger", "Éowyn \"Red\" Vale"],
      "categories": ["Characters", "Rangers"],
      "infobox": {
        "caption": "Aria at the Silver Gate",
        "imageAssetId": "aria-portrait",
        "fields": [
          { "key": "born", "value": "12 Frost 1204" },
          { "key": "species", "value": "Human" },
          { "key": "affiliation", "value": "The Wardens" },
          { "key": "location", "value": "Silver Vale" },
          { "key": "parents", "value": ["Marek Vale", "Sefa Vale"] },
          { "key": "eyes", "value": "Grey" },
          { "key": "favourite_blade", "label": "Favourite blade", "value": "Her mother's knife" }
        ]
      },
      "content": "**Aria Vale** is a ranger of [[Silver Vale|the Vale]] and the last of her line.^[Annals of the Vale, vol. 2]\n\n## Early life\n\n![Aria as a child, from the Warden rolls](asset:aria-portrait \"A green sketch of a girl with a bow\")\n\nAria was born in the hard winter of 1204, the second year of the [[Long Frost]]. Her parents, [[Marek Vale]] and [[Sefa Vale]], kept the north gate.\n\n## With the Wardens\n\nShe joined [[The Wardens]] at sixteen.\n\n| Year | Rank |\n|---|---|\n| 1220 | Scout |\n| 1224 | Ranger |\n\nTable: Her ranks\n\n> The north does not forgive. It only forgets.\n\n### Known companions\n\n- [[Dorn Ash]]\n- Corvin of the Reach",
      "notes": "Check her age against the timeline. Is 1204 too early?"
    },
    {
      "title": "Silver Vale",
      "pageType": "place",
      "status": "canon",
      "summary": "A cold valley in the far north.",
      "categories": ["Places"],
      "infobox": {
        "fields": [
          { "key": "leader", "value": "Dorn Ash" },
          { "key": "founded", "value": "Year 3 of the Reach" }
        ]
      },
      "content": "A cold valley in the north, home to [[The Ranger|Aria]] and the [[The Wardens|Wardens]]."
    },
    {
      "title": "The Wardens",
      "pageType": "faction",
      "status": "draft",
      "aliases": ["Wardens of the Vale"],
      "categories": ["Factions"],
      "infobox": {
        "fields": [
          { "key": "leader", "value": "Dorn Ash" },
          { "key": "members", "value": "Aria Vale, Dorn Ash" }
        ]
      },
      "content": "The rangers who keep the Vale's roads open."
    },
    {
      "title": "Dorn Ash",
      "pageType": "character",
      "status": "idea",
      "content": "Leader of [[The Wardens]]. Possibly Aria's uncle."
    },
    {
      "title": "The Old Road",
      "pageType": "place",
      "status": "retconned",
      "content": "A road through the mountains, cut from the story in the second draft."
    }
  ],
  "books": [
    {
      "title": "The Silver Road",
      "subtitle": "Book One of the Vale",
      "author": "A. N. Writer",
      "targetWords": 90000,
      "publishing": {
        "series": "The Vale Cycle",
        "seriesNumber": 1,
        "copyrightYear": 2026,
        "copyright": { "include": true },
        "dedication": "For everyone who kept the road.",
        "appendices": [{ "title": "Cast of Characters", "kind": "cast", "pageTypes": ["character"] }]
      },
      "children": [
        {
          "kind": "part",
          "title": "Part One: Homecoming",
          "children": [
            {
              "kind": "chapter",
              "title": "The Gate",
              "synopsis": "Aria comes home to find the gate unguarded.",
              "children": [
                {
                  "kind": "scene",
                  "id": "first-gate",
                  "title": "Dusk",
                  "status": "revised",
                  "pov": "Aria Vale",
                  "location": "Silver Vale",
                  "cast": ["Aria Vale", "Dorn Ash"],
                  "threads": ["The Long Road"],
                  "storyDate": "1 Frost 1220",
                  "synopsis": "She reaches the gate at nightfall.",
                  "content": "Aria reached the gate at dusk. *Nobody* stood watch, and the lamp above the arch had burned out.\n\nShe waited for the length of a long breath, then rode through."
                },
                {
                  "kind": "scene",
                  "title": "The Empty Hall",
                  "status": "draft",
                  "pov": "The Ranger",
                  "content": "The hall was empty. Dust lay on the long table, and a single chair had been pulled back."
                }
              ]
            }
          ]
        },
        {
          "kind": "chapter",
          "title": "Interlude",
          "children": [
            {
              "kind": "scene",
              "title": "A Letter",
              "status": "outline",
              "synopsis": "Dorn writes to the Reach.",
              "notes": "Decide who intercepts this."
            }
          ]
        }
      ]
    }
  ],
  "relationships": [
    { "from": "Aria Vale", "to": "Silver Vale", "kind": "born in" },
    { "from": "Aria Vale", "to": "The Wardens", "kind": "member of", "note": "Since 1220." },
    { "from": "Dorn Ash", "to": "The Wardens", "kind": "leads" }
  ],
  "assets": [
    {
      "id": "aria-portrait",
      "name": "aria.png",
      "mime": "image/png",
      "width": 1,
      "height": 1,
      "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=="
    }
  ]
}
```

## Other things LoreCraft can import

**Markdown files and folders.** Each file becomes a page. A folder may hold subfolders, and
folder names can become categories. These front matter fields are read, and all are
optional: `title`, `aliases`, `tags`, `categories`, `type`, `status`, `summary` and
`description`, the infobox keys above such as `born`, `created` and `updated`, and
`local_only: true` (also written `localOnly` or `local-only`), which marks the page or scene
[local only](#local-only). LoreCraft's export writes `local_only` on a scene whose chapter or
part is marked, since those are folders there.
`[[links]]` are kept. Without a `title`, the file name is used. For a file with a name like
`README` or `notes`, the first heading is used instead.

**Obsidian vaults.** The same, plus: `[[Page|Label]]`, `[[folder/Page]]` and `[[Page#Heading]]`
links, `#tags` as categories, `![[picture.png]]` and `![[clip.mp4]]` embeds, which bring the file
in as a figure, and callouts, which become quotes. The `.obsidian` folder is skipped. LoreCraft's own Markdown
export is a vault of this kind, and its scenes come back as books and chapters.

**Word documents.** As one wiki page, as a page for each heading, or as a book with chapters
at Heading 1 and scenes at Heading 2. Formatting LoreCraft has no use for is dropped. When a document's Heading 1s are named like "Part
One", they become parts, with chapters at Heading 2 and scenes at Heading 3. In a book, a
paragraph holding only `* * *` or `#` also starts a new scene. Footnotes become citations,
and pictures come in as figures, with the following paragraph as the label if it uses
Word's Caption style.

**Plain text.** As a wiki page or a scene. Text in any common encoding works. Blank lines
separate paragraphs.

## Prompt files

Saved AI prompts can be shared as their own small file, apart from a project export. In the
AI pane's Prompts tab, **Export…** on a prompt saves that one, **Export all custom…** saves
every prompt you made or imported, and **Import…** reads a file back. Built-in prompts are not
in "Export all custom", since every project has them.

```json
{
  "lorecraft_prompts": 1,
  "prompts": [
    {
      "name": "Darker",
      "description": "More shadow",
      "template": "Make this darker:\n\n{{selection}}",
      "scope": "selection",
      "action": "replace"
    }
  ]
}
```

- `lorecraft_prompts` is the version of the format. A file from a newer version is refused.
- `name` and `template` are required. `description` is optional.
- `scope` is `selection`, `page`, `scene` or `chat`. `action` is `replace`, `insert`, `chat`
  or `metadata`. Without an `action`, a chat prompt answers in the pane and the others replace
  the text.
- The template can use `{{selection}}`, `{{page}}` and `{{book}}`.

Import shows what will happen before anything is saved. A prompt the project already has,
with the same name and text, is skipped. A prompt whose name is taken by a different one is
added as "Name (2)". A prompt with a missing name or text, or an unknown scope or action, is
left out and listed. At most 500 prompts are read from one file.

## What the other exports contain

These describe the exports that cannot be imported back, for anyone reading them with
other tools.

**JSONL.** One JSON object per line. Pages have `kind: "page"`, `id`, `title`, `type`, `status`,
`summary`, `aliases`, `categories`, `infobox` (key to value), `links`, `figures`, `wordCount`,
`localOnly`, `updatedAt` and `text`. Scenes have `kind: "scene"`, `id`, `book`, `bookId`, `part`,
`chapter`, `title`, `order`, `status`, `pov`, `storyDate`, `synopsis`, `links`, `figures`,
`wordCount`, `localOnly`, `updatedAt` and `text`. In `text`, a figure appears as
`[Figure 2: label (description)]`. Pages and scenes marked [local only](#local-only) are left out
unless the writer asks for them, and then `localOnly` is `true` on theirs.

**XML.** Well-formed XML 1.0, in the namespace `https://github.com/CodeCat04/LoreCraft/ns/export/1`.
Characters that XML 1.0 cannot hold, such as most control characters, are removed.

```xml
<lorebook version="1" exportedAt="..." name="...">
  <pages>
    <page id="" title="" type="" status="" home="" words="" created="" updated="" revealNode="" localOnly="">
      <summary/>
      <aliases><alias/></aliases>
      <categories><category/></categories>
      <infobox image="" caption=""><field key="" label="" kind="">value</field></infobox>
      <body format="markdown or prosemirror-json"/>
      <text>plain text</text>
      <figures>
        <figure name="Figure 1" kind="" media="" align="" width="" asset="" url="">
          <caption/><description/>
        </figure>
      </figures>
      <talk><body/><text/></talk>
    </page>
  </pages>
  <books>
    <book id="" title="" subtitle="" author="" targetWords="" created="" updated="">
      <part id="" title="" status="" ...>
        <synopsis/><notes/>
        <chapter id="" title="" status="" ...>
          <scene id="" title="" status="" pov="" storyDate="" words="" targetWords="" created="" updated="" localOnly="">
            <synopsis/><notes/><body/><text/><figures/>
          </scene>
        </chapter>
      </part>
    </book>
  </books>
  <relationships>
    <relationship from="" to="" fromId="" toId="" kind="">note</relationship>
  </relationships>
</lorebook>
```

A chapter may also sit directly in a `book`. An attribute with no value is left out, so
`home` and `localOnly` appear only as `"true"`, on a page, part, chapter or scene that has them.

**CSV.** RFC 4180 with CRLF line ends and a UTF-8 byte order mark. `pages.csv` has a column for
each infobox key, named `infobox_<key>`. `is_home` and `local_only` are `true` or `false`, and in
`scenes.csv` a scene in a marked chapter or part has `local_only` set. Lists are joined with `; `. With the formula guard
on, text starting with `=`, `+`, `-` or `@` has a leading apostrophe, so that a spreadsheet
does not run it. Excel shows at most 32,767 characters in a cell, so long pages are cut off
on screen there, though the file holds them.
