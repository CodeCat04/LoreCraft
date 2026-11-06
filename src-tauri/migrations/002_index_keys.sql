-- Which search row belongs to which page or scene, so a write can replace its own row
-- without scanning the whole index for it.
CREATE TABLE search_fts_keys (
  entity_kind TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  fts_rowid   INTEGER NOT NULL,
  PRIMARY KEY (entity_kind, entity_id)
) WITHOUT ROWID;

INSERT OR REPLACE INTO search_fts_keys (entity_kind, entity_id, fts_rowid)
  SELECT entity_kind, entity_id, MAX(rowid) FROM search_fts GROUP BY entity_kind, entity_id;

-- A new random value whenever a page title or alias changes. The name matcher is kept
-- between writes and built again only when this differs. Random rather than counted, so a
-- rolled-back change can never come back with a value that was already used.
INSERT OR REPLACE INTO meta (key, value) VALUES ('names_stamp', lower(hex(randomblob(8))));

CREATE TRIGGER names_stamp_page_insert AFTER INSERT ON pages BEGIN
  UPDATE meta SET value = lower(hex(randomblob(8))) WHERE key = 'names_stamp';
END;
CREATE TRIGGER names_stamp_page_delete AFTER DELETE ON pages BEGIN
  UPDATE meta SET value = lower(hex(randomblob(8))) WHERE key = 'names_stamp';
END;
CREATE TRIGGER names_stamp_page_update AFTER UPDATE OF id, title, deleted_at ON pages BEGIN
  UPDATE meta SET value = lower(hex(randomblob(8))) WHERE key = 'names_stamp';
END;
CREATE TRIGGER names_stamp_alias_insert AFTER INSERT ON page_aliases BEGIN
  UPDATE meta SET value = lower(hex(randomblob(8))) WHERE key = 'names_stamp';
END;
CREATE TRIGGER names_stamp_alias_delete AFTER DELETE ON page_aliases BEGIN
  UPDATE meta SET value = lower(hex(randomblob(8))) WHERE key = 'names_stamp';
END;
CREATE TRIGGER names_stamp_alias_update AFTER UPDATE ON page_aliases BEGIN
  UPDATE meta SET value = lower(hex(randomblob(8))) WHERE key = 'names_stamp';
END;
