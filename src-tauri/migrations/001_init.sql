-- LoreCraft schema, version 1. Released files use it, so it never changes again: change the
-- schema with a new migration (002_*.sql) listed in MIGRATIONS in src/db.rs. See "Upgrades"
-- in docs/ARCHITECTURE.md. Timestamps are RFC 3339 UTC.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ===========================================================================
-- Wiki
-- ===========================================================================
CREATE TABLE pages (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  title_key     TEXT NOT NULL,
  page_type     TEXT NOT NULL DEFAULT 'article',
  status        TEXT NOT NULL DEFAULT 'draft',  -- canon | draft | idea | retconned
  summary       TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,                  -- ProseMirror JSON
  content_text  TEXT NOT NULL DEFAULT '',
  infobox       TEXT NOT NULL DEFAULT '{"fields":[]}',
  notes         TEXT NOT NULL DEFAULT '',       -- Talk tab, ProseMirror JSON or empty
  word_count    INTEGER NOT NULL DEFAULT 0,
  reveal_node_id TEXT,                          -- spoiler control: first revealed at this node
  is_home       INTEGER NOT NULL DEFAULT 0,
  local_only    INTEGER NOT NULL DEFAULT 0,     -- never sent to a cloud AI
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX pages_title_key ON pages(title_key) WHERE deleted_at IS NULL;
CREATE INDEX pages_updated ON pages(updated_at);

CREATE TABLE page_aliases (
  page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  PRIMARY KEY (page_id, alias_key)
);
CREATE INDEX page_aliases_key ON page_aliases(alias_key);

CREATE TABLE page_categories (
  page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (page_id, category)
);
CREATE INDEX page_categories_cat ON page_categories(category);

-- Explicit wiki links, derived from content. source_kind: page | node.
CREATE TABLE links (
  source_kind  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  target_key   TEXT NOT NULL,
  target_title TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id, target_key)
);
CREATE INDEX links_target ON links(target_key);

-- Automatic name detection in text, derived from content.
CREATE TABLE mentions (
  source_kind TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_id, page_id)
);
CREATE INDEX mentions_page ON mentions(page_id);

-- ===========================================================================
-- Manuscript
-- ===========================================================================
CREATE TABLE books (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  subtitle     TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  target_words INTEGER NOT NULL DEFAULT 0,
  publishing   TEXT NOT NULL DEFAULT '{}',     -- cover, series, ISBN, front and back matter, appendices. JSON: BookPublishing in src/lib/types.ts
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

-- A book's tree: part > chapter > scene. Chapters may sit directly under a book.
CREATE TABLE nodes (
  id           TEXT PRIMARY KEY,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  parent_id    TEXT,
  kind         TEXT NOT NULL,                  -- part | chapter | scene
  title        TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'draft',  -- idea | outline | draft | revised | final
  pov_page_id  TEXT,
  synopsis     TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '',       -- ProseMirror JSON, scenes only
  content_text TEXT NOT NULL DEFAULT '',
  word_count   INTEGER NOT NULL DEFAULT 0,
  target_words INTEGER NOT NULL DEFAULT 0,
  story_date   TEXT NOT NULL DEFAULT '',       -- in-world date, free text
  location_page_id TEXT,                       -- where the scene happens
  local_only   INTEGER NOT NULL DEFAULT 0,     -- never sent to a cloud AI
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX nodes_tree ON nodes(book_id, parent_id, position);

-- Who is present in a scene, as the writer recorded it.
CREATE TABLE node_cast (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  PRIMARY KEY (node_id, page_id)
);
CREATE INDEX node_cast_page ON node_cast(page_id);

-- Plot threads run through the whole project, so a series can share them, and the
-- scenes that carry them. color names a theme token, such as accent or success.
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE node_threads (
  node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, thread_id)
);
CREATE INDEX node_threads_thread ON node_threads(thread_id);

-- Daily word progress. Day is local YYYY-MM-DD.
CREATE TABLE writing_log (
  day           TEXT NOT NULL,
  book_id       TEXT NOT NULL,
  words_added   INTEGER NOT NULL DEFAULT 0,
  words_removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, book_id)
);

-- ===========================================================================
-- History and search
-- ===========================================================================
-- entity_kind: page | node. reason: auto | save | ai | restore | manual.
CREATE TABLE revisions (
  id           TEXT PRIMARY KEY,
  entity_kind  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  extra        TEXT NOT NULL DEFAULT '{}',
  reason       TEXT NOT NULL,
  word_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX revisions_entity ON revisions(entity_kind, entity_id, created_at);

CREATE VIRTUAL TABLE search_fts USING fts5(
  entity_kind UNINDEXED,
  entity_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ===========================================================================
-- AI
-- ===========================================================================
CREATE TABLE ai_conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  context    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,   -- JSON: normalized content blocks
  profile_id      TEXT,
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TEXT NOT NULL
);
CREATE INDEX ai_messages_conv ON ai_messages(conversation_id, created_at);

CREATE TABLE ai_usage (
  id            TEXT PRIMARY KEY,
  day           TEXT NOT NULL,
  profile_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  task          TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX ai_usage_day ON ai_usage(day);

-- Short summaries of scenes, chapters and books, so an AI can follow a long story.
-- entity_kind: node | book. `edited` means the writer changed it, so it is not replaced.
CREATE TABLE summaries (
  entity_kind  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary      TEXT NOT NULL,
  edited       INTEGER NOT NULL DEFAULT 0,
  model        TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id)
);

CREATE TABLE prompts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  template    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'selection',  -- selection | page | scene | chat
  action      TEXT NOT NULL DEFAULT 'replace',    -- replace | insert | metadata | chat
  builtin     INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ===========================================================================
-- Comments and to-dos
-- ===========================================================================
-- Notes on a stretch of text. The anchor is a `comment` mark in the document, so it moves
-- with the text. `quote` keeps the words it was first attached to, for when they go.
-- source_kind: page | node. author: you | ai | the name of a tool.
CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT 'you',
  quote       TEXT NOT NULL DEFAULT '',
  is_todo     INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX comments_source ON comments(source_kind, source_id);

-- Purging a document takes its comments with it. In the trash they stay, for a restore.
CREATE TRIGGER pages_purge_comments BEFORE DELETE ON pages BEGIN
  DELETE FROM comments WHERE source_kind = 'page' AND source_id = OLD.id;
END;
CREATE TRIGGER nodes_purge_comments BEFORE DELETE ON nodes BEGIN
  DELETE FROM comments WHERE source_kind = 'node' AND source_id = OLD.id;
END;

-- ===========================================================================
-- Consistency
-- ===========================================================================
CREATE TABLE findings (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,  -- rule | ai
  rule        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning',  -- info | warning | error
  status      TEXT NOT NULL DEFAULT 'open',     -- open | fixed | intentional | ignored
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  evidence    TEXT NOT NULL DEFAULT '[]',       -- JSON: [{sourceKind, sourceId, title, quote}]
  fingerprint TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX findings_status ON findings(status);

-- Claims extracted by AI, cached by content hash so unchanged text is not re-read.
CREATE TABLE claims_cache (
  source_kind  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  claims       TEXT NOT NULL,
  model        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);

-- ===========================================================================
-- Media
-- ===========================================================================
-- A picture or video. Its bytes are in asset_chunks, or on disk at external_path for
-- a linked file. A row with complete = 0 is an upload in progress, and any left behind
-- by a crash are removed when the project opens.
CREATE TABLE assets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT '',  -- image | video, known from the first chunk
  size          INTEGER NOT NULL,          -- bytes
  chunk_size    INTEGER NOT NULL,          -- bytes in every chunk but the last
  sha256        TEXT,                      -- null while uploading and for linked files
  width         INTEGER,
  height        INTEGER,
  duration      REAL,                      -- seconds
  complete      INTEGER NOT NULL DEFAULT 0,
  external_path TEXT,
  created_at    TEXT NOT NULL,
  -- Set in the media library. A figure's own caption comes first, so these only show when
  -- no figure has words of its own, and start off any new figure of this asset.
  label         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT ''
);
-- Identical content is stored once.
CREATE UNIQUE INDEX assets_sha256 ON assets(sha256) WHERE complete = 1 AND external_path IS NULL;

-- Chunks let an asset exceed SQLite's 1 GB value limit, and let a range read touch
-- only what it needs.
CREATE TABLE asset_chunks (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  bytes    BLOB NOT NULL,
  PRIMARY KEY (asset_id, idx)
);

-- ===========================================================================
-- Extras
-- ===========================================================================
CREATE TABLE maps (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  asset_id   TEXT REFERENCES assets(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE map_pins (
  id         TEXT PRIMARY KEY,
  map_id     TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  page_id    TEXT,
  label      TEXT NOT NULL DEFAULT '',
  x          REAL NOT NULL,  -- 0 to 1, fraction of image width
  y          REAL NOT NULL,  -- 0 to 1, fraction of image height
  created_at TEXT NOT NULL
);
CREATE INDEX map_pins_map ON map_pins(map_id);
CREATE INDEX map_pins_page ON map_pins(page_id);

CREATE TABLE relationships (
  id           TEXT PRIMARY KEY,
  from_page_id TEXT NOT NULL,
  to_page_id   TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'related',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX relationships_from ON relationships(from_page_id);
CREATE INDEX relationships_to ON relationships(to_page_id);

-- Purging a page must not leave anything pointing at nothing. Relationships go with
-- it. A pin stays where it is, under the page's last title, as a free label. Pages in
-- the trash keep both, so restoring a page brings them back.
CREATE TRIGGER pages_purge_extras BEFORE DELETE ON pages BEGIN
  UPDATE map_pins
     SET label = CASE WHEN label = '' THEN OLD.title ELSE label END,
         page_id = NULL
   WHERE page_id = OLD.id;
  DELETE FROM relationships WHERE from_page_id = OLD.id OR to_page_id = OLD.id;
END;

-- Words the spellchecker accepts, in addition to page titles and aliases.
CREATE TABLE dictionary (
  word_key TEXT PRIMARY KEY,
  word     TEXT NOT NULL
);

-- ===========================================================================
-- Suggestions from AI tools outside the app (MCP)
-- ===========================================================================
-- Nothing an outside tool does changes a document. It leaves a row here, and the writer
-- accepts or rejects it. kind: edit | newPage. status: pending | accepted | rejected.
CREATE TABLE proposals (
  id          TEXT PRIMARY KEY,
  client      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  title       TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX proposals_status ON proposals(status, created_at);

-- ===========================================================================
-- Idea inbox
-- ===========================================================================
-- Quick notes captured from anywhere. source_kind is page or node, and with source_id
-- says where the writer was. Both are empty when they were on neither.
CREATE TABLE ideas (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  source_kind TEXT,
  source_id   TEXT,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | done
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX ideas_status ON ideas(status, created_at);

-- An idea outlives the place it was written. A trashed page or scene can still be
-- restored, so it stays linked until the place is gone for good.
CREATE TRIGGER pages_purge_ideas BEFORE DELETE ON pages BEGIN
  UPDATE ideas SET source_kind = NULL, source_id = NULL
   WHERE source_kind = 'page' AND source_id = OLD.id;
END;
CREATE TRIGGER nodes_purge_ideas BEFORE DELETE ON nodes BEGIN
  UPDATE ideas SET source_kind = NULL, source_id = NULL
   WHERE source_kind = 'node' AND source_id = OLD.id;
END;

-- Search by meaning
-- ===========================================================================
-- One row per passage of a page or scene. Derived from the text and rebuilt freely, so
-- writing here does not mark the project as changed. See src-tauri/src/embeddings/index.rs.
-- vector: little-endian 32-bit floats, length 1. model: which model made it.
CREATE TABLE embeddings (
  entity_kind  TEXT NOT NULL,     -- page | node
  entity_id    TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  content_hash TEXT NOT NULL,     -- of the passage as given to the model
  model        TEXT NOT NULL,
  vector       BLOB NOT NULL,
  snippet      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (entity_kind, entity_id, chunk_index)
);
CREATE INDEX embeddings_model ON embeddings(model);
