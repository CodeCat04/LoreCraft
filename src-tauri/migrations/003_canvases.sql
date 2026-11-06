-- Canvases: boards of cards and arrows in the JSON Canvas format. Cards point at pages,
-- scenes and assets only by `lorecraft:<kind>/<id>` strings, so purging those leaves the
-- card showing a missing link rather than breaking the canvas.
CREATE TABLE canvases (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  title_key   TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX canvases_title ON canvases(title_key);
