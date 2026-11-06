//! Maps and their pins, explicit relationships between pages, the custom dictionary, and
//! the reads behind the timeline and the graph. Pictures themselves are in `media.rs`.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Deserialize;
use serde_json::{json, Value};

use super::family::{self, KindTable};
use super::{ok, parse, unknown};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

/// Infobox keys the timeline understands. Fields of kind `date` count under any key.
const TIMELINE_KEYS: [&str; 7] = ["born", "died", "founded", "dissolved", "date", "start", "end"];

const MAX_KIND_CHARS: usize = 60;
const MAX_WORD_CHARS: usize = 100;

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strings(conn: &Connection, sql: &str, arg: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([arg], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// title or alias key -> live page id. Titles win over aliases, as in `resolve_title`.
fn name_index(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut index = HashMap::new();
    let mut aliases = conn.prepare(
        "SELECT a.alias_key, a.page_id FROM page_aliases a JOIN pages p ON p.id = a.page_id
         WHERE p.deleted_at IS NULL ORDER BY p.title",
    )?;
    let rows = aliases.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (key, id) = row?;
        index.entry(key).or_insert(id);
    }
    let mut titles = conn.prepare("SELECT title_key, id FROM pages WHERE deleted_at IS NULL")?;
    let rows = titles.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (key, id) = row?;
        index.insert(key, id);
    }
    Ok(index)
}

fn require_live_page(conn: &Connection, id: &str) -> AppResult<()> {
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("That page"))
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/// Field values are free text, so only the ones worth a place on a timeline are sent,
/// and dates are not parsed here. Ordering belongs to `parseStoryDate` in TypeScript.
fn timeline_fields(infobox: &Value) -> Vec<Value> {
    let Some(fields) = infobox.get("fields").and_then(Value::as_array) else {
        return Vec::new();
    };
    fields
        .iter()
        .filter(|field| {
            let key = field.get("key").and_then(Value::as_str).unwrap_or("");
            let kind = field.get("kind").and_then(Value::as_str).unwrap_or("");
            let value = field.get("value").and_then(Value::as_str).unwrap_or("");
            let holds_a_date = kind == "date" || TIMELINE_KEYS.contains(&key);
            // A change during the story can have a date, whatever the field holds.
            let changes = field.get("changes").and_then(Value::as_array).is_some_and(|c| !c.is_empty());
            changes || (holds_a_date && !value.trim().is_empty())
        })
        .cloned()
        .collect()
}

struct TreeNode {
    id: String,
    book_id: String,
    kind: String,
    title: String,
    story_date: String,
    pov_page_id: Option<String>,
}

/// Walks one book's tree in reading order, which `position` alone does not give.
fn walk_scenes(
    children: &HashMap<Option<String>, Vec<TreeNode>>,
    parent: Option<String>,
    parent_title: &str,
    book_titles: &HashMap<String, String>,
    book_id: &str,
    out: &mut Vec<Value>,
    order: &mut i64,
) {
    let Some(nodes) = children.get(&parent) else {
        return;
    };
    for node in nodes {
        if node.book_id != book_id {
            continue;
        }
        if node.kind == "scene" {
            *order += 1;
            if !node.story_date.trim().is_empty() {
                out.push(json!({
                    "id": node.id,
                    "title": node.title,
                    "bookId": node.book_id,
                    "bookTitle": book_titles.get(&node.book_id).cloned().unwrap_or_default(),
                    "chapterTitle": parent_title,
                    "storyDate": node.story_date,
                    "povPageId": node.pov_page_id,
                    "order": *order,
                }));
            }
        }
        walk_scenes(
            children,
            Some(node.id.clone()),
            &node.title,
            book_titles,
            book_id,
            out,
            order,
        );
    }
}

pub(crate) fn timeline_data(conn: &Connection) -> AppResult<Value> {
    let mut pages = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, page_type, status, infobox FROM pages
             WHERE deleted_at IS NULL ORDER BY title_key",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (id, title, page_type, status, infobox) = row?;
            let infobox: Value = serde_json::from_str(&infobox).unwrap_or(Value::Null);
            let fields = timeline_fields(&infobox);
            // An event page with no date still belongs in the list of things to place.
            if fields.is_empty() && page_type != "event" {
                continue;
            }
            pages.push(json!({
                "id": id, "title": title, "pageType": page_type, "status": status, "fields": fields,
            }));
        }
    }

    let mut books = Vec::new();
    let mut book_titles = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title FROM books WHERE deleted_at IS NULL ORDER BY position, created_at",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, title) = row?;
            books.push(json!({ "id": id, "title": title }));
            book_titles.insert(id, title);
        }
    }

    let mut children: HashMap<Option<String>, Vec<TreeNode>> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, book_id, parent_id, kind, title, story_date, pov_page_id FROM nodes
             WHERE deleted_at IS NULL ORDER BY position, created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(2)?,
                TreeNode {
                    id: r.get(0)?,
                    book_id: r.get(1)?,
                    kind: r.get(3)?,
                    title: r.get(4)?,
                    story_date: r.get(5)?,
                    pov_page_id: r.get(6)?,
                },
            ))
        })?;
        for row in rows {
            let (parent, node) = row?;
            children.entry(parent).or_default().push(node);
        }
    }

    let mut scenes = Vec::new();
    let mut order = 0;
    for book in &books {
        let book_id = book["id"].as_str().unwrap_or_default();
        walk_scenes(
            &children,
            None,
            "",
            &book_titles,
            book_id,
            &mut scenes,
            &mut order,
        );
    }

    Ok(json!({ "pages": pages, "scenes": scenes, "books": books }))
}

#[derive(Default)]
struct Scope {
    pages: HashSet<String>,
    scenes: HashSet<String>,
}

impl Scope {
    fn add_source(&mut self, kind: &str, id: String) {
        if kind == "node" {
            self.scenes.insert(id);
        } else {
            self.pages.insert(id);
        }
    }

    fn to_json(&self) -> Value {
        let mut pages: Vec<&String> = self.pages.iter().collect();
        let mut scenes: Vec<&String> = self.scenes.iter().collect();
        pages.sort();
        scenes.sort();
        json!({ "pageIds": pages, "sceneIds": scenes })
    }
}

/// What a page touches: itself, what links to or names it, what it links to or names,
/// its explicit relationships, and the scenes told from its point of view.
fn page_scope(conn: &Connection, page_id: &str) -> AppResult<Scope> {
    let mut scope = Scope::default();
    scope.pages.insert(page_id.to_string());
    let names = name_index(conn)?;

    let mut keys = strings(
        conn,
        "SELECT title_key FROM pages WHERE id = ?1",
        page_id,
    )?;
    keys.extend(strings(
        conn,
        "SELECT alias_key FROM page_aliases WHERE page_id = ?1",
        page_id,
    )?);

    {
        let mut stmt = conn.prepare("SELECT source_kind, source_id FROM mentions WHERE page_id = ?1")?;
        let rows = stmt.query_map([page_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (kind, id) = row?;
            scope.add_source(&kind, id);
        }
        let mut stmt = conn.prepare("SELECT source_kind, source_id FROM links WHERE target_key = ?1")?;
        for key in &keys {
            let rows = stmt.query_map([key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (kind, id) = row?;
                scope.add_source(&kind, id);
            }
        }
    }

    scope.pages.extend(strings(
        conn,
        "SELECT page_id FROM mentions WHERE source_kind = 'page' AND source_id = ?1",
        page_id,
    )?);
    for key in strings(
        conn,
        "SELECT target_key FROM links WHERE source_kind = 'page' AND source_id = ?1",
        page_id,
    )? {
        if let Some(target) = names.get(&key) {
            scope.pages.insert(target.clone());
        }
    }
    scope.pages.extend(strings(
        conn,
        "SELECT to_page_id FROM relationships WHERE from_page_id = ?1",
        page_id,
    )?);
    scope.pages.extend(strings(
        conn,
        "SELECT from_page_id FROM relationships WHERE to_page_id = ?1",
        page_id,
    )?);
    scope.scenes.extend(strings(
        conn,
        "SELECT id FROM nodes WHERE pov_page_id = ?1 AND deleted_at IS NULL",
        page_id,
    )?);
    Ok(scope)
}

/// What a book touches: its scenes and the pages those scenes name, link to or are
/// told from.
fn book_scope(conn: &Connection, book_id: &str) -> AppResult<Scope> {
    let mut scope = Scope::default();
    scope.scenes.extend(strings(
        conn,
        "SELECT id FROM nodes WHERE book_id = ?1 AND kind = 'scene' AND deleted_at IS NULL",
        book_id,
    )?);
    scope.pages.extend(strings(
        conn,
        "SELECT DISTINCT m.page_id FROM mentions m JOIN nodes n ON n.id = m.source_id
         WHERE m.source_kind = 'node' AND n.book_id = ?1 AND n.deleted_at IS NULL",
        book_id,
    )?);
    scope.pages.extend(strings(
        conn,
        "SELECT DISTINCT pov_page_id FROM nodes
         WHERE book_id = ?1 AND pov_page_id IS NOT NULL AND deleted_at IS NULL",
        book_id,
    )?);
    let names = name_index(conn)?;
    for key in strings(
        conn,
        "SELECT DISTINCT l.target_key FROM links l JOIN nodes n ON n.id = l.source_id
         WHERE l.source_kind = 'node' AND n.book_id = ?1 AND n.deleted_at IS NULL",
        book_id,
    )? {
        if let Some(target) = names.get(&key) {
            scope.pages.insert(target.clone());
        }
    }
    Ok(scope)
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

const RELATIONSHIP_SELECT: &str =
    "SELECT r.id, r.from_page_id, f.title, r.to_page_id, t.title, r.kind, r.note, r.created_at
     FROM relationships r
     JOIN pages f ON f.id = r.from_page_id AND f.deleted_at IS NULL
     JOIN pages t ON t.id = r.to_page_id AND t.deleted_at IS NULL";

fn relationship_from_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "fromPageId": r.get::<_, String>(1)?,
        "fromTitle": r.get::<_, String>(2)?,
        "toPageId": r.get::<_, String>(3)?,
        "toTitle": r.get::<_, String>(4)?,
        "kind": r.get::<_, String>(5)?,
        "note": r.get::<_, String>(6)?,
        "createdAt": r.get::<_, String>(7)?,
    }))
}

/// Adds how a relationship reads from its other end, which is not stored.
fn with_inverse(table: &KindTable, mut row: Value) -> Value {
    let inverse = table.inverse_of(row["kind"].as_str().unwrap_or_default());
    row["inverse"] = json!(inverse);
    row
}

/// Pages, resolved wiki links between pages, and relationships. Pages in the trash and
/// red links are left out, so every edge has a node at both ends.
fn graph_data(conn: &Connection) -> AppResult<Value> {
    let mut categories: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT pc.page_id, pc.category FROM page_categories pc
             JOIN pages p ON p.id = pc.page_id
             WHERE p.deleted_at IS NULL ORDER BY pc.category",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, category) = row?;
            categories.entry(id).or_default().push(category);
        }
    }

    let mut nodes = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, page_type, status, is_home FROM pages
             WHERE deleted_at IS NULL ORDER BY title_key",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (id, title, page_type, status, is_home) = row?;
            let cats = categories.remove(&id).unwrap_or_default();
            nodes.push(json!({
                "id": id, "title": title, "pageType": page_type, "status": status,
                "isHome": is_home != 0, "categories": cats,
            }));
        }
    }

    let names = name_index(conn)?;
    let mut links = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT l.source_id, l.target_key FROM links l JOIN pages p ON p.id = l.source_id
             WHERE l.source_kind = 'page' AND p.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut seen = HashSet::new();
        for row in rows {
            let (source, key) = row?;
            let Some(target) = names.get(&key) else {
                continue;
            };
            if *target != source && seen.insert((source.clone(), target.clone())) {
                links.push(json!({ "from": source, "to": target }));
            }
        }
    }

    let mut relationships = Vec::new();
    {
        let table = KindTable::load(conn)?;
        let mut stmt = conn.prepare(&format!("{RELATIONSHIP_SELECT} ORDER BY r.created_at"))?;
        let rows = stmt.query_map([], relationship_from_row)?;
        for row in rows {
            relationships.push(with_inverse(&table, row?));
        }
    }

    Ok(json!({ "nodes": nodes, "links": links, "relationships": relationships }))
}

fn get_relationship(conn: &Connection, id: &str) -> AppResult<Value> {
    let row = conn
        .query_row(
            &format!("{RELATIONSHIP_SELECT} WHERE r.id = ?1"),
            [id],
            relationship_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("That relationship"))?;
    Ok(with_inverse(&KindTable::load(conn)?, row))
}

fn clean_kind(kind: &str) -> AppResult<String> {
    let cleaned = collapse(kind);
    if cleaned.is_empty() {
        return Err(AppError::invalid("A relationship needs a kind, such as ally or parent of."));
    }
    if cleaned.chars().count() > MAX_KIND_CHARS {
        return Err(AppError::invalid("That relationship kind is too long."));
    }
    Ok(cleaned)
}

/// Refuses a page related to itself or a fact that is already recorded. `kind` is the
/// stored form, so saying a fact from its other side counts as the same fact.
fn check_relationship(
    conn: &Connection,
    from: &str,
    to: &str,
    kind: &str,
    except: Option<&str>,
) -> AppResult<()> {
    if from == to {
        return Err(AppError::invalid("A page cannot have a relationship with itself."));
    }
    require_live_page(conn, from)?;
    require_live_page(conn, to)?;
    let lowered = kind.to_lowercase();
    let table = KindTable::load(conn)?;
    let symmetric = table.is_symmetric(kind);
    // Kinds are compared here, because SQLite's lower() only knows ASCII. A row saved
    // before kinds had one form, such as "child of", is read in that form first.
    let mut stmt = conn.prepare(
        "SELECT id, from_page_id, to_page_id, kind FROM relationships
         WHERE (from_page_id = ?1 AND to_page_id = ?2) OR (from_page_id = ?2 AND to_page_id = ?1)",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (id, row_from, row_to, stored_kind) = row?;
        let (existing_kind, flipped) = table.normalize(&stored_kind);
        let existing_from = if flipped { row_to } else { row_from };
        if existing_kind.to_lowercase() != lowered || Some(id.as_str()) == except {
            continue;
        }
        if existing_from == from || symmetric {
            return Err(AppError::new(
                "EXISTS",
                format!("These pages already have the relationship \"{kind}\"."),
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

const MAP_SELECT: &str =
    "SELECT m.id, m.title, m.asset_id, m.created_at, m.updated_at, m.deleted_at,
            (SELECT COUNT(*) FROM map_pins p WHERE p.map_id = m.id)
     FROM maps m";

fn map_from_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "title": r.get::<_, String>(1)?,
        "assetId": r.get::<_, Option<String>>(2)?,
        "createdAt": r.get::<_, String>(3)?,
        "updatedAt": r.get::<_, String>(4)?,
        "deletedAt": r.get::<_, Option<String>>(5)?,
        "pinCount": r.get::<_, i64>(6)?,
    }))
}

const PIN_SELECT: &str =
    "SELECT pin.id, pin.map_id, pin.page_id, pin.label, pin.x, pin.y, pin.created_at, p.title, p.page_type
     FROM map_pins pin LEFT JOIN pages p ON p.id = pin.page_id AND p.deleted_at IS NULL";

/// `pageTitle` is null when the page is in the trash. `pageId` stays set, so the pin
/// links up again if the page is restored.
fn pin_from_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "mapId": r.get::<_, String>(1)?,
        "pageId": r.get::<_, Option<String>>(2)?,
        "label": r.get::<_, String>(3)?,
        "x": r.get::<_, f64>(4)?,
        "y": r.get::<_, f64>(5)?,
        "createdAt": r.get::<_, String>(6)?,
        "pageTitle": r.get::<_, Option<String>>(7)?,
        "pageType": r.get::<_, Option<String>>(8)?,
    }))
}

fn get_map(conn: &Connection, id: &str) -> AppResult<Value> {
    conn.query_row(&format!("{MAP_SELECT} WHERE m.id = ?1"), [id], map_from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("That map"))
}

fn require_live_map(conn: &Connection, id: &str) -> AppResult<()> {
    let map = get_map(conn, id)?;
    if map["deletedAt"].is_null() {
        Ok(())
    } else {
        Err(AppError::not_found("That map"))
    }
}

fn pins_of(conn: &Connection, map_id: &str) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(&format!(
        "{PIN_SELECT} WHERE pin.map_id = ?1 ORDER BY pin.created_at, pin.id"
    ))?;
    let rows = stmt.query_map([map_id], pin_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn get_pin(conn: &Connection, id: &str) -> AppResult<Value> {
    conn.query_row(&format!("{PIN_SELECT} WHERE pin.id = ?1"), [id], pin_from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("That pin"))
}

fn clean_map_title(title: &str) -> AppResult<String> {
    let cleaned = collapse(title);
    if cleaned.is_empty() {
        return Err(AppError::invalid("A map needs a name."));
    }
    Ok(cleaned)
}

fn check_fraction(value: f64) -> AppResult<f64> {
    if (0.0..=1.0).contains(&value) {
        Ok(value)
    } else {
        Err(AppError::invalid("A pin's position must be between 0 and 1."))
    }
}

/// Whether anything still needs this image. Stored documents name their images by id
/// in JSON, so a text search finds them, including old revisions that could be restored.
fn asset_in_use(conn: &Connection, asset_id: &str) -> AppResult<bool> {
    let used: i64 = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM maps WHERE asset_id = ?1)
             OR EXISTS (SELECT 1 FROM pages WHERE instr(content, ?1) > 0 OR instr(infobox, ?1) > 0 OR instr(notes, ?1) > 0)
             OR EXISTS (SELECT 1 FROM nodes WHERE instr(content, ?1) > 0)
             OR EXISTS (SELECT 1 FROM revisions WHERE instr(content, ?1) > 0)",
        [asset_id],
        |r| r.get(0),
    )?;
    Ok(used != 0)
}

fn purge_map(conn: &Connection, id: &str) -> AppResult<()> {
    let map = get_map(conn, id)?;
    if map["deletedAt"].is_null() {
        return Err(AppError::invalid("Move a map to the trash first."));
    }
    // Pins go with it, through ON DELETE CASCADE.
    conn.execute("DELETE FROM maps WHERE id = ?1", [id])?;
    if let Some(asset_id) = map["assetId"].as_str() {
        if !asset_in_use(conn, asset_id)? {
            conn.execute("DELETE FROM assets WHERE id = ?1", [asset_id])?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

fn clean_word(word: &str) -> AppResult<(String, String)> {
    let cleaned = word.trim().replace('\u{2019}', "'");
    if cleaned.is_empty() {
        return Err(AppError::invalid("There is no word to add."));
    }
    if cleaned.chars().any(char::is_whitespace) {
        return Err(AppError::invalid("Add one word at a time."));
    }
    if cleaned.chars().count() > MAX_WORD_CHARS {
        return Err(AppError::invalid("That word is too long."));
    }
    let key = cleaned.to_lowercase();
    Ok((key, cleaned))
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct IdParam {
    id: String,
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        // ---- Timeline ------------------------------------------------------
        "timelineData" => engine.read(timeline_data),
        "timelineScope" => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct P {
                page_id: Option<String>,
                book_id: Option<String>,
            }
            let p: P = parse(params)?;
            engine.read(|c| {
                let scope = match (&p.page_id, &p.book_id) {
                    (Some(id), _) => page_scope(c, id)?,
                    (None, Some(id)) => book_scope(c, id)?,
                    (None, None) => {
                        return Err(AppError::invalid("Give a page or a book."));
                    }
                };
                Ok(scope.to_json())
            })
        }

        // ---- Graph and relationships ---------------------------------------
        "graphData" => engine.read(graph_data),
        "relationshipList" => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct P {
                page_id: Option<String>,
            }
            let p: P = parse(params)?;
            engine.read(|c| {
                let table = KindTable::load(c)?;
                let mut out = Vec::new();
                match &p.page_id {
                    Some(id) => {
                        let mut stmt = c.prepare(&format!(
                            "{RELATIONSHIP_SELECT}
                             WHERE r.from_page_id = ?1 OR r.to_page_id = ?1 ORDER BY r.created_at"
                        ))?;
                        for row in stmt.query_map([id], relationship_from_row)? {
                            out.push(with_inverse(&table, row?));
                        }
                    }
                    None => {
                        let mut stmt = c.prepare(&format!(
                            "{RELATIONSHIP_SELECT} ORDER BY f.title_key, t.title_key"
                        ))?;
                        for row in stmt.query_map([], relationship_from_row)? {
                            out.push(with_inverse(&table, row?));
                        }
                    }
                }
                ok(out)
            })
        }
        "relationshipAdd" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                from_page_id: String,
                to_page_id: String,
                kind: String,
                #[serde(default)]
                note: String,
            }
            let p: P = parse(params)?;
            let kind = clean_kind(&p.kind)?;
            let (row, report) = engine.write(|tx| {
                let (kind, flipped) = KindTable::load(tx)?.normalize(&kind);
                let (from, to) = if flipped {
                    (&p.to_page_id, &p.from_page_id)
                } else {
                    (&p.from_page_id, &p.to_page_id)
                };
                check_relationship(tx, from, to, &kind, None)?;
                let id = db::new_id();
                tx.execute(
                    "INSERT INTO relationships (id, from_page_id, to_page_id, kind, note, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, from, to, kind, p.note.trim(), db::now()],
                )?;
                let row = get_relationship(tx, &id)?;
                let report = family::after_relationship_change(tx, None, Some(&row))?;
                Ok((row, report))
            })?;
            family::announce(engine, &report);
            engine.notify("extras");
            Ok(row)
        }
        "relationshipUpdate" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                from_page_id: Option<String>,
                to_page_id: Option<String>,
                kind: Option<String>,
                note: Option<String>,
            }
            let p: P = parse(params)?;
            let (row, report) = engine.write(|tx| {
                let current = get_relationship(tx, &p.id)?;
                let text = |field: &str| current[field].as_str().unwrap_or_default().to_string();
                let from = p.from_page_id.clone().unwrap_or_else(|| text("fromPageId"));
                let to = p.to_page_id.clone().unwrap_or_else(|| text("toPageId"));
                let kind = match &p.kind {
                    Some(value) => clean_kind(value)?,
                    None => text("kind"),
                };
                let note = p
                    .note
                    .as_deref()
                    .map_or_else(|| text("note"), |n| n.trim().to_string());
                let (kind, flipped) = KindTable::load(tx)?.normalize(&kind);
                let (from, to) = if flipped { (to, from) } else { (from, to) };
                check_relationship(tx, &from, &to, &kind, Some(&p.id))?;
                tx.execute(
                    "UPDATE relationships SET from_page_id = ?1, to_page_id = ?2, kind = ?3, note = ?4
                     WHERE id = ?5",
                    params![from, to, kind, note, p.id],
                )?;
                let row = get_relationship(tx, &p.id)?;
                let report = family::after_relationship_change(tx, Some(&current), Some(&row))?;
                Ok((row, report))
            })?;
            family::announce(engine, &report);
            engine.notify("extras");
            Ok(row)
        }
        "relationshipDelete" => {
            let p: IdParam = parse(params)?;
            let report = engine.write(|tx| {
                // Its pages may be in the trash, which is no reason to keep the row.
                let current = get_relationship(tx, &p.id).ok();
                let removed = tx.execute("DELETE FROM relationships WHERE id = ?1", [&p.id])?;
                if removed == 0 {
                    return Err(AppError::not_found("That relationship"));
                }
                family::after_relationship_change(tx, current.as_ref(), None)
            })?;
            family::announce(engine, &report);
            engine.notify("extras");
            ok(true)
        }

        // ---- Maps ----------------------------------------------------------
        "mapList" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                deleted: bool,
            }
            let p: P = parse(params)?;
            engine.read(|c| {
                let filter = if p.deleted {
                    "m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC"
                } else {
                    "m.deleted_at IS NULL ORDER BY lower(m.title), m.created_at"
                };
                let mut stmt = c.prepare(&format!("{MAP_SELECT} WHERE {filter}"))?;
                let rows = stmt.query_map([], map_from_row)?;
                let maps: Vec<Value> = rows.collect::<Result<_, _>>()?;
                ok(maps)
            })
        }
        "mapGet" => {
            let p: IdParam = parse(params)?;
            engine.read(|c| {
                let mut map = get_map(c, &p.id)?;
                map["pins"] = Value::Array(pins_of(c, &p.id)?);
                Ok(map)
            })
        }
        "mapCreate" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                title: String,
                asset_id: String,
            }
            let p: P = parse(params)?;
            let title = clean_map_title(&p.title)?;
            let map = engine.write(|tx| {
                let asset: Option<String> = tx
                    .query_row("SELECT id FROM assets WHERE id = ?1", [&p.asset_id], |r| r.get(0))
                    .optional()?;
                if asset.is_none() {
                    return Err(AppError::not_found("That image"));
                }
                let id = db::new_id();
                let now = db::now();
                tx.execute(
                    "INSERT INTO maps (id, title, asset_id, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, title, p.asset_id, now],
                )?;
                get_map(tx, &id)
            })?;
            engine.notify("extras");
            Ok(map)
        }
        "mapRename" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                title: String,
            }
            let p: P = parse(params)?;
            let title = clean_map_title(&p.title)?;
            engine.write(|tx| {
                require_live_map(tx, &p.id)?;
                tx.execute(
                    "UPDATE maps SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![title, db::now(), p.id],
                )?;
                Ok(())
            })?;
            engine.notify("extras");
            ok(true)
        }
        "mapDelete" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| {
                require_live_map(tx, &p.id)?;
                let now = db::now();
                tx.execute(
                    "UPDATE maps SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
                    params![now, p.id],
                )?;
                Ok(())
            })?;
            engine.notify("extras");
            ok(true)
        }
        "mapRestore" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| {
                get_map(tx, &p.id)?;
                tx.execute(
                    "UPDATE maps SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                    params![db::now(), p.id],
                )?;
                Ok(())
            })?;
            engine.notify("extras");
            ok(true)
        }
        "mapPurge" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| purge_map(tx, &p.id))?;
            engine.notify("extras");
            ok(true)
        }
        "pinAdd" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                map_id: String,
                page_id: Option<String>,
                #[serde(default)]
                label: String,
                x: f64,
                y: f64,
            }
            let p: P = parse(params)?;
            let x = check_fraction(p.x)?;
            let y = check_fraction(p.y)?;
            let label = collapse(&p.label);
            let page_id = p.page_id.filter(|id| !id.is_empty());
            if page_id.is_none() && label.is_empty() {
                return Err(AppError::invalid("A pin needs a page or a label."));
            }
            let pin = engine.write(|tx| {
                require_live_map(tx, &p.map_id)?;
                if let Some(id) = &page_id {
                    require_live_page(tx, id)?;
                }
                let id = db::new_id();
                tx.execute(
                    "INSERT INTO map_pins (id, map_id, page_id, label, x, y, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, p.map_id, page_id, label, x, y, db::now()],
                )?;
                get_pin(tx, &id)
            })?;
            engine.notify("extras");
            Ok(pin)
        }
        "pinUpdate" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                /// An empty string turns the pin into a free label.
                page_id: Option<String>,
                label: Option<String>,
                x: Option<f64>,
                y: Option<f64>,
            }
            let p: P = parse(params)?;
            let x = p.x.map(check_fraction).transpose()?;
            let y = p.y.map(check_fraction).transpose()?;
            let pin = engine.write(|tx| {
                let current = get_pin(tx, &p.id)?;
                let page_id = match &p.page_id {
                    Some(value) if value.is_empty() => None,
                    Some(value) => {
                        require_live_page(tx, value)?;
                        Some(value.clone())
                    }
                    None => current["pageId"].as_str().map(str::to_string),
                };
                let label = p.label.as_deref().map_or_else(
                    || current["label"].as_str().unwrap_or_default().to_string(),
                    collapse,
                );
                if page_id.is_none() && label.is_empty() {
                    return Err(AppError::invalid("A pin needs a page or a label."));
                }
                tx.execute(
                    "UPDATE map_pins SET page_id = ?1, label = ?2, x = ?3, y = ?4 WHERE id = ?5",
                    params![
                        page_id,
                        label,
                        x.unwrap_or_else(|| current["x"].as_f64().unwrap_or(0.0)),
                        y.unwrap_or_else(|| current["y"].as_f64().unwrap_or(0.0)),
                        p.id
                    ],
                )?;
                get_pin(tx, &p.id)
            })?;
            engine.notify("extras");
            Ok(pin)
        }
        "pinDelete" => {
            let p: IdParam = parse(params)?;
            let removed =
                engine.write(|tx| Ok(tx.execute("DELETE FROM map_pins WHERE id = ?1", [&p.id])?))?;
            if removed == 0 {
                return Err(AppError::not_found("That pin"));
            }
            engine.notify("extras");
            ok(true)
        }
        "pageMaps" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                page_id: String,
            }
            let p: P = parse(params)?;
            engine.read(|c| {
                let mut stmt = c.prepare(
                    "SELECT m.id, m.title, pin.id, pin.x, pin.y FROM map_pins pin
                     JOIN maps m ON m.id = pin.map_id
                     WHERE pin.page_id = ?1 AND m.deleted_at IS NULL
                     ORDER BY lower(m.title), pin.created_at",
                )?;
                let rows = stmt.query_map([&p.page_id], |r| {
                    Ok(json!({
                        "mapId": r.get::<_, String>(0)?,
                        "mapTitle": r.get::<_, String>(1)?,
                        "pinId": r.get::<_, String>(2)?,
                        "x": r.get::<_, f64>(3)?,
                        "y": r.get::<_, f64>(4)?,
                    }))
                })?;
                let found: Vec<Value> = rows.collect::<Result<_, _>>()?;
                ok(found)
            })
        }

        // ---- Dictionary ----------------------------------------------------
        "dictionaryList" => engine.read(|c| {
            let mut stmt = c.prepare("SELECT word FROM dictionary ORDER BY word_key")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let words: Vec<String> = rows.collect::<Result<_, _>>()?;
            ok(words)
        }),
        "dictionaryAdd" => {
            #[derive(Deserialize)]
            struct P {
                word: String,
            }
            let p: P = parse(params)?;
            let (key, word) = clean_word(&p.word)?;
            engine.write(|tx| {
                tx.execute(
                    "INSERT INTO dictionary (word_key, word) VALUES (?1, ?2)
                     ON CONFLICT(word_key) DO UPDATE SET word = excluded.word",
                    params![key, word],
                )?;
                Ok(())
            })?;
            engine.notify("dictionary");
            ok(true)
        }
        "dictionaryRemove" => {
            #[derive(Deserialize)]
            struct P {
                word: String,
            }
            let p: P = parse(params)?;
            let (key, _) = clean_word(&p.word)?;
            engine.write(|tx| {
                tx.execute("DELETE FROM dictionary WHERE word_key = ?1", [&key])?;
                Ok(())
            })?;
            engine.notify("dictionary");
            ok(true)
        }
        "relationKinds" | "relationKindSet" | "familyData" => family::handle(engine, action, params),
        _ => Err(unknown(&format!("extras.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::engine::{Engine, TestDir};
    use crate::rpc::media::test_support::{unique_png, upload};
    use crate::rpc::{call, dispatch};
    use serde_json::{json, Value};

    fn project() -> (Arc<Engine>, TestDir) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "T" }));
        (engine, dir)
    }

    fn page(engine: &Engine, title: &str) -> String {
        let created = call(engine, "pages.create", json!({ "title": title }));
        created["id"].as_str().unwrap().to_string()
    }

    fn linked_doc(targets: &[&str]) -> Value {
        let marks: Vec<Value> = targets
            .iter()
            .map(|target| {
                json!({ "type": "text", "text": target, "marks": [
                    { "type": "wikiLink", "attrs": { "target": target } }
                ]})
            })
            .collect();
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": marks }] })
    }

    fn new_map(engine: &Engine, title: &str) -> (String, String) {
        let asset = upload(engine, "m.png", "image/png", &unique_png());
        let map = call(
            engine,
            "extras.mapCreate",
            json!({ "title": title, "assetId": asset["id"] }),
        );
        (
            map["id"].as_str().unwrap().to_string(),
            asset["id"].as_str().unwrap().to_string(),
        )
    }

    fn list_len(value: &Value) -> usize {
        value.as_array().unwrap().len()
    }

    // ---- Maps -----------------------------------------------------------------

    #[test]
    fn maps_are_listed_renamed_and_keep_their_pins() {
        let (engine, _dir) = project();
        assert_eq!(list_len(&call(&engine, "extras.mapList", json!({}))), 0);
        let (map, asset) = new_map(&engine, "  The   Vale ");
        let vale = page(&engine, "Silver Vale");

        let got = call(&engine, "extras.mapGet", json!({ "id": map }));
        assert_eq!(got["title"], "The Vale");
        assert_eq!(got["assetId"], asset);

        let linked = call(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "pageId": vale, "x": 0.25, "y": 0.75 }),
        );
        assert_eq!(linked["pageTitle"], "Silver Vale");
        let free = call(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "label": " Here  be dragons ", "x": 1.0, "y": 0.0 }),
        );
        assert_eq!(free["label"], "Here be dragons");
        assert!(free["pageId"].is_null());

        call(&engine, "extras.mapRename", json!({ "id": map, "title": "Old Vale" }));
        let listed = call(&engine, "extras.mapList", json!({}));
        assert_eq!(listed[0]["title"], "Old Vale");
        assert_eq!(listed[0]["pinCount"], 2);

        let moved = call(
            &engine,
            "extras.pinUpdate",
            json!({ "id": linked["id"], "x": 0.5 }),
        );
        assert_eq!(moved["x"], 0.5);
        assert_eq!(moved["y"], 0.75);
        assert_eq!(moved["pageId"], vale);

        let relabeled = call(
            &engine,
            "extras.pinUpdate",
            json!({ "id": linked["id"], "pageId": "", "label": "A ford" }),
        );
        assert!(relabeled["pageId"].is_null());
        assert_eq!(relabeled["label"], "A ford");

        call(&engine, "extras.pinDelete", json!({ "id": free["id"] }));
        let pins = call(&engine, "extras.mapGet", json!({ "id": map }));
        assert_eq!(list_len(&pins["pins"]), 1);
        let gone = dispatch(&engine, "extras.pinDelete", json!({ "id": free["id"] }));
        assert_eq!(gone.unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn pins_must_be_inside_the_map_and_name_something() {
        let (engine, _dir) = project();
        let (map, _) = new_map(&engine, "M");
        for (x, y) in [(-0.1, 0.5), (0.5, 1.5)] {
            let err = dispatch(
                &engine,
                "extras.pinAdd",
                json!({ "mapId": map, "label": "x", "x": x, "y": y }),
            )
            .unwrap_err();
            assert_eq!(err.code, "INVALID");
        }
        let nameless = dispatch(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "label": "  ", "x": 0.5, "y": 0.5 }),
        );
        assert_eq!(nameless.unwrap_err().code, "INVALID");
        let no_page = dispatch(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "pageId": "nope", "x": 0.5, "y": 0.5 }),
        );
        assert_eq!(no_page.unwrap_err().code, "NOT_FOUND");
        let no_map = dispatch(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": "nope", "label": "x", "x": 0.5, "y": 0.5 }),
        );
        assert_eq!(no_map.unwrap_err().code, "NOT_FOUND");
        let pin = call(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "label": "x", "x": 0.5, "y": 0.5 }),
        );
        let emptied = dispatch(
            &engine,
            "extras.pinUpdate",
            json!({ "id": pin["id"], "label": "" }),
        );
        assert_eq!(emptied.unwrap_err().code, "INVALID");
    }

    #[test]
    fn pins_follow_their_map_through_the_trash_and_a_purge_cleans_up() {
        let (engine, _dir) = project();
        let (map, asset) = new_map(&engine, "Lost Coast");
        let town = page(&engine, "Harbor");
        let pin = call(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "pageId": town, "x": 0.1, "y": 0.2 }),
        );
        let appears = call(&engine, "extras.pageMaps", json!({ "pageId": town }));
        assert_eq!(appears[0]["mapTitle"], "Lost Coast");
        assert_eq!(appears[0]["pinId"], pin["id"]);

        let not_yet = dispatch(&engine, "extras.mapPurge", json!({ "id": map }));
        assert_eq!(not_yet.unwrap_err().code, "INVALID", "purge needs the trash first");

        call(&engine, "extras.mapDelete", json!({ "id": map }));
        assert_eq!(list_len(&call(&engine, "extras.mapList", json!({}))), 0);
        let trash = call(&engine, "extras.mapList", json!({ "deleted": true }));
        assert_eq!(trash[0]["id"], map);
        assert_eq!(
            list_len(&call(&engine, "extras.pageMaps", json!({ "pageId": town }))),
            0,
            "a trashed map is not somewhere a page appears"
        );
        let edit_in_trash = dispatch(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "label": "x", "x": 0.5, "y": 0.5 }),
        );
        assert_eq!(edit_in_trash.unwrap_err().code, "NOT_FOUND");

        call(&engine, "extras.mapRestore", json!({ "id": map }));
        let back = call(&engine, "extras.mapGet", json!({ "id": map }));
        assert_eq!(back["pins"][0]["id"], pin["id"], "pins return with the map");
        assert_eq!(back["pins"][0]["x"], 0.1);

        call(&engine, "extras.mapDelete", json!({ "id": map }));
        call(&engine, "extras.mapPurge", json!({ "id": map }));
        assert_eq!(
            dispatch(&engine, "extras.mapGet", json!({ "id": map })).unwrap_err().code,
            "NOT_FOUND"
        );
        assert_eq!(
            dispatch(&engine, "extras.pinDelete", json!({ "id": pin["id"] }))
                .unwrap_err()
                .code,
            "NOT_FOUND",
            "pins are deleted with the map"
        );
        assert_eq!(
            dispatch(&engine, "media.get", json!({ "id": asset }))
                .unwrap_err()
                .code,
            "NOT_FOUND",
            "an image nothing else uses is removed"
        );
    }

    #[test]
    fn purging_a_map_keeps_an_image_something_else_uses() {
        let (engine, _dir) = project();
        let (map, asset) = new_map(&engine, "One");
        let second = call(
            &engine,
            "extras.mapCreate",
            json!({ "title": "Two", "assetId": asset }),
        );
        call(&engine, "extras.mapDelete", json!({ "id": map }));
        call(&engine, "extras.mapPurge", json!({ "id": map }));
        call(&engine, "media.get", json!({ "id": asset }));

        // Now only a document uses it.
        let host = page(&engine, "Atlas");
        call(
            &engine,
            "pages.update",
            json!({ "id": host, "patch": { "content": {
                "type": "doc",
                "content": [{ "type": "image", "attrs": { "assetId": asset, "alt": "x" } }]
            }}}),
        );
        call(&engine, "extras.mapDelete", json!({ "id": second["id"] }));
        call(&engine, "extras.mapPurge", json!({ "id": second["id"] }));
        call(&engine, "media.get", json!({ "id": asset }));
    }

    #[test]
    fn deleting_a_page_leaves_pins_and_relationships_sound() {
        let (engine, _dir) = project();
        let (map, _) = new_map(&engine, "M");
        let aria = page(&engine, "Aria");
        let vale = page(&engine, "Vale");
        let pin = call(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "pageId": aria, "x": 0.3, "y": 0.4 }),
        );
        let named = call(
            &engine,
            "extras.pinAdd",
            json!({ "mapId": map, "pageId": aria, "label": "Aria's camp", "x": 0.6, "y": 0.4 }),
        );
        let rel = call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": aria, "toPageId": vale, "kind": "located in" }),
        );

        // In the trash: hidden, but ready to come back.
        call(&engine, "pages.delete", json!({ "id": aria }));
        let pins = call(&engine, "extras.mapGet", json!({ "id": map }))["pins"].clone();
        assert!(pins[0]["pageTitle"].is_null(), "no title for a trashed page");
        assert_eq!(pins[0]["pageId"], aria, "the link is kept for a restore");
        assert_eq!(list_len(&call(&engine, "extras.relationshipList", json!({}))), 0);
        let graph = call(&engine, "extras.graphData", json!({}));
        assert_eq!(list_len(&graph["relationships"]), 0);
        let blocked = dispatch(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": aria, "toPageId": vale, "kind": "ally" }),
        );
        assert_eq!(blocked.unwrap_err().code, "NOT_FOUND");

        call(&engine, "pages.restore", json!({ "id": aria }));
        let pins = call(&engine, "extras.mapGet", json!({ "id": map }))["pins"].clone();
        assert_eq!(pins[0]["pageTitle"], "Aria");
        assert_eq!(
            call(&engine, "extras.relationshipList", json!({ "pageId": aria }))[0]["id"],
            rel["id"]
        );

        // Purged: relationships go, pins remain as labels.
        call(&engine, "pages.delete", json!({ "id": aria }));
        call(&engine, "pages.purge", json!({ "id": aria }));
        let pins = call(&engine, "extras.mapGet", json!({ "id": map }))["pins"].clone();
        assert_eq!(list_len(&pins), 2);
        assert_eq!(pins[0]["id"], pin["id"]);
        assert!(pins[0]["pageId"].is_null());
        assert_eq!(pins[0]["label"], "Aria", "keeps the page's last title");
        assert_eq!(pins[0]["x"], 0.3);
        assert_eq!(pins[1]["id"], named["id"]);
        assert_eq!(pins[1]["label"], "Aria's camp", "keeps its own label");
        assert_eq!(list_len(&call(&engine, "extras.relationshipList", json!({}))), 0);
        let rows: i64 = engine
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM relationships", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(rows, 0, "no rows left pointing at nothing");
    }

    // ---- Relationships --------------------------------------------------------

    #[test]
    fn relationships_are_added_edited_and_deleted() {
        let (engine, _dir) = project();
        let a = page(&engine, "Aria");
        let b = page(&engine, "Bran");
        let c = page(&engine, "Cara");
        let rel = call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": a, "toPageId": b, "kind": " parent  of ", "note": " Adopted. " }),
        );
        assert_eq!(rel["kind"], "parent of");
        assert_eq!(rel["note"], "Adopted.");
        assert_eq!(rel["fromTitle"], "Aria");
        assert_eq!(rel["toTitle"], "Bran");

        for page_id in [&a, &b] {
            let list = call(&engine, "extras.relationshipList", json!({ "pageId": page_id }));
            assert_eq!(list[0]["id"], rel["id"], "either end lists it");
        }
        assert_eq!(
            list_len(&call(&engine, "extras.relationshipList", json!({ "pageId": c }))),
            0
        );

        let edited = call(
            &engine,
            "extras.relationshipUpdate",
            json!({ "id": rel["id"], "kind": "ally", "toPageId": c }),
        );
        assert_eq!(edited["kind"], "ally");
        assert_eq!(edited["toTitle"], "Cara");
        assert_eq!(edited["note"], "Adopted.", "untouched fields stay");

        call(&engine, "extras.relationshipDelete", json!({ "id": rel["id"] }));
        assert_eq!(list_len(&call(&engine, "extras.relationshipList", json!({}))), 0);
        let again = dispatch(&engine, "extras.relationshipDelete", json!({ "id": rel["id"] }));
        assert_eq!(again.unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn relationships_refuse_nonsense_and_duplicates() {
        let (engine, _dir) = project();
        let a = page(&engine, "Aria");
        let b = page(&engine, "Bran");
        let add = |from: &String, to: &String, kind: &str| {
            dispatch(
                &engine,
                "extras.relationshipAdd",
                json!({ "fromPageId": from, "toPageId": to, "kind": kind }),
            )
        };
        assert_eq!(add(&a, &a, "ally").unwrap_err().code, "INVALID");
        assert_eq!(add(&a, &b, "  ").unwrap_err().code, "INVALID");
        assert_eq!(add(&a, &"nope".to_string(), "ally").unwrap_err().code, "NOT_FOUND");

        add(&a, &b, "ally").unwrap();
        assert_eq!(add(&a, &b, "Ally").unwrap_err().code, "EXISTS");
        add(&a, &b, "\u{c9}l\u{e8}ve de").unwrap();
        assert_eq!(
            add(&a, &b, "\u{e9}L\u{c8}VE DE").unwrap_err().code,
            "EXISTS",
            "capitals outside ASCII count too"
        );
        assert_eq!(
            add(&b, &a, "ally").unwrap_err().code,
            "EXISTS",
            "an alliance runs both ways"
        );

        // A direction that means something is a different fact when reversed.
        add(&a, &b, "parent of").unwrap();
        add(&b, &a, "parent of").unwrap();
        let rel = add(&a, &b, "enemy").unwrap();
        let clash = dispatch(
            &engine,
            "extras.relationshipUpdate",
            json!({ "id": rel["id"], "kind": "ally" }),
        );
        assert_eq!(clash.unwrap_err().code, "EXISTS");
        call(
            &engine,
            "extras.relationshipUpdate",
            json!({ "id": rel["id"], "note": "It is complicated." }),
        );
    }

    // ---- Graph ----------------------------------------------------------------

    #[test]
    fn graph_data_holds_only_edges_with_a_page_at_both_ends() {
        let (engine, _dir) = project();
        let a = page(&engine, "Aria");
        let vale = call(
            &engine,
            "pages.create",
            json!({ "title": "Silver Vale", "aliases": ["The Vale"], "pageType": "place", "categories": ["North"] }),
        );
        let gone = page(&engine, "Gone");
        call(
            &engine,
            "pages.update",
            json!({ "id": a, "patch": { "content": linked_doc(&["the vale", "Silver Vale", "Aria", "Nowhere", "Gone"]) } }),
        );
        call(
            &engine,
            "pages.update",
            json!({ "id": gone, "patch": { "content": linked_doc(&["Aria"]) } }),
        );
        call(&engine, "pages.delete", json!({ "id": gone }));

        let graph = call(&engine, "extras.graphData", json!({}));
        let titles: Vec<&str> = graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["Aria", "Main Page", "Silver Vale"]);
        assert_eq!(graph["nodes"][1]["isHome"], true);
        assert_eq!(graph["nodes"][2]["pageType"], "place");
        assert_eq!(graph["nodes"][2]["categories"][0], "North");

        // The alias and the title are one edge. The self link, the red link and the
        // deleted page add nothing.
        assert_eq!(list_len(&graph["links"]), 1);
        assert_eq!(graph["links"][0]["from"], a);
        assert_eq!(graph["links"][0]["to"], vale["id"]);
    }

    // ---- Timeline -------------------------------------------------------------

    #[test]
    fn timeline_data_reads_dates_and_scenes_in_reading_order() {
        let (engine, _dir) = project();
        let field = |key: &str, kind: &str, value: &str| {
            json!({ "key": key, "label": key, "kind": kind, "value": value })
        };
        let hero = call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "pageType": "character", "infobox": { "fields": [
                field("born", "date", "312"),
                field("died", "date", ""),
                field("occupation", "text", "Smith"),
            ]}}),
        );
        call(
            &engine,
            "pages.create",
            json!({ "title": "Fall of Vale", "pageType": "event", "infobox": { "fields": [
                field("start", "date", "340"),
                field("end", "date", "341"),
            ]}}),
        );
        call(&engine, "pages.create", json!({ "title": "Plain page" }));
        call(&engine, "pages.create", json!({ "title": "Undated battle", "pageType": "event" }));

        let books = call(&engine, "books.list", json!({}));
        let book = books[0]["id"].clone();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let first_chapter = tree
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["kind"] == "chapter")
            .unwrap()["id"]
            .clone();
        let second_chapter = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "kind": "chapter", "title": "Chapter 2" }),
        );
        let later = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": second_chapter["id"], "kind": "scene", "title": "Later" }),
        );
        let earlier = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": first_chapter, "kind": "scene", "title": "Earlier" }),
        );
        let undated = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": first_chapter, "kind": "scene", "title": "No date" }),
        );
        let dropped = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": first_chapter, "kind": "scene", "title": "Dropped" }),
        );
        for (node, date) in [(&later, "350"), (&earlier, "350"), (&dropped, "351")] {
            call(
                &engine,
                "nodes.update",
                json!({ "id": node["id"], "patch": { "storyDate": date } }),
            );
        }
        call(&engine, "nodes.delete", json!({ "id": dropped["id"] }));
        assert!(undated["storyDate"] == "");

        let data = call(&engine, "extras.timelineData", json!({}));
        let pages = data["pages"].as_array().unwrap();
        let titles: Vec<&str> = pages.iter().map(|p| p["title"].as_str().unwrap()).collect();
        assert_eq!(titles, ["Aria", "Fall of Vale", "Undated battle"]);
        assert_eq!(pages[0]["id"], hero["id"]);
        assert_eq!(list_len(&pages[0]["fields"]), 1, "only filled date fields");
        assert_eq!(pages[0]["fields"][0]["key"], "born");
        assert_eq!(list_len(&pages[2]["fields"]), 0);

        let scenes = data["scenes"].as_array().unwrap();
        let names: Vec<&str> = scenes.iter().map(|s| s["title"].as_str().unwrap()).collect();
        assert_eq!(names, ["Earlier", "Later"], "reading order, not creation order");
        assert_eq!(scenes[0]["chapterTitle"], "Chapter 1");
        assert_eq!(scenes[1]["chapterTitle"], "Chapter 2");
        assert_eq!(scenes[0]["bookTitle"], "Book One");
        assert!(scenes[0]["order"].as_i64() < scenes[1]["order"].as_i64());
        assert_eq!(data["books"][0]["title"], "Book One");
    }

    #[test]
    fn timeline_data_includes_a_field_that_changes_whatever_it_holds() {
        let (engine, _dir) = project();
        call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "infobox": { "fields": [
                { "key": "rank", "label": "Rank", "kind": "text", "value": "Squire",
                  "changes": [{ "date": "312", "value": "Knight" }] },
                { "key": "title", "label": "Title", "kind": "text", "value": "" ,
                  "changes": [{ "date": "320", "value": "Lady" }] },
                { "key": "hair", "label": "Hair", "kind": "text", "value": "blonde" },
                { "key": "eyes", "label": "Eyes", "kind": "text", "value": "grey", "changes": [] },
            ]}}),
        );
        let data = call(&engine, "extras.timelineData", json!({}));
        let fields = data["pages"][0]["fields"].as_array().unwrap();
        let keys: Vec<&str> = fields.iter().map(|f| f["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["rank", "title"]);
        assert_eq!(fields[0]["changes"][0]["value"], "Knight");
    }

    #[test]
    fn timeline_scope_finds_what_a_page_or_book_touches() {
        let (engine, _dir) = project();
        let aria = page(&engine, "Aria");
        let battle = page(&engine, "Battle of Reeds");
        let vale = page(&engine, "Silver Vale");
        let stranger = page(&engine, "Stranger");
        let spouse = page(&engine, "Bran");
        call(
            &engine,
            "pages.update",
            json!({ "id": battle, "patch": { "content": linked_doc(&["Aria"]) } }),
        );
        call(
            &engine,
            "pages.update",
            json!({ "id": aria, "patch": { "content": linked_doc(&["Silver Vale"]) } }),
        );
        call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": spouse, "toPageId": aria, "kind": "spouse" }),
        );

        let book = call(&engine, "books.list", json!({}))[0]["id"].clone();
        let chapter = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "kind": "chapter", "title": "C" }),
        );
        let scene = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": chapter["id"], "kind": "scene", "title": "S" }),
        );
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": linked_doc(&["Aria"]) } }),
        );
        let told = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": chapter["id"], "kind": "scene", "title": "T" }),
        );
        call(
            &engine,
            "nodes.update",
            json!({ "id": told["id"], "patch": { "povPageId": aria } }),
        );

        let scope = call(&engine, "extras.timelineScope", json!({ "pageId": aria }));
        let has = |list: &Value, id: &Value| list.as_array().unwrap().contains(id);
        for id in [&aria, &battle, &vale, &spouse] {
            assert!(has(&scope["pageIds"], &json!(id)), "page in scope");
        }
        assert!(!has(&scope["pageIds"], &json!(stranger)));
        assert!(has(&scope["sceneIds"], &scene["id"]));
        assert!(has(&scope["sceneIds"], &told["id"]), "point of view counts");

        let scope = call(&engine, "extras.timelineScope", json!({ "bookId": book }));
        assert!(has(&scope["sceneIds"], &scene["id"]));
        assert!(has(&scope["pageIds"], &json!(aria)));
        assert!(!has(&scope["pageIds"], &json!(stranger)));

        let neither = dispatch(&engine, "extras.timelineScope", json!({}));
        assert_eq!(neither.unwrap_err().code, "INVALID");
    }

    // ---- Dictionary -----------------------------------------------------------

    #[test]
    fn the_dictionary_stores_one_copy_of_each_word_and_survives_reopening() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "D" }));
        assert_eq!(list_len(&call(&engine, "extras.dictionaryList", json!({}))), 0);

        call(&engine, "extras.dictionaryAdd", json!({ "word": " Zephyrine " }));
        call(&engine, "extras.dictionaryAdd", json!({ "word": "zephyrine" }));
        call(&engine, "extras.dictionaryAdd", json!({ "word": "Kel\u{2019}Thuzad" }));
        let words = call(&engine, "extras.dictionaryList", json!({}));
        assert_eq!(words, json!(["Kel'Thuzad", "zephyrine"]));

        let two = dispatch(&engine, "extras.dictionaryAdd", json!({ "word": "two words" }));
        assert_eq!(two.unwrap_err().code, "INVALID");
        let none = dispatch(&engine, "extras.dictionaryAdd", json!({ "word": "  " }));
        assert_eq!(none.unwrap_err().code, "INVALID");

        call(&engine, "extras.dictionaryRemove", json!({ "word": "KEL'THUZAD" }));
        assert_eq!(call(&engine, "extras.dictionaryList", json!({})), json!(["zephyrine"]));
        // Removing what is not there is not an error.
        call(&engine, "extras.dictionaryRemove", json!({ "word": "absent" }));

        let target = dir.0.join("d.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "project.close", json!({}));
        call(&engine, "project.open", json!({ "path": target }));
        assert_eq!(call(&engine, "extras.dictionaryList", json!({})), json!(["zephyrine"]));
    }

    #[test]
    fn dictionary_changes_are_announced_under_their_own_name() {
        let (engine, host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "D" }));
        call(&engine, "extras.dictionaryAdd", json!({ "word": "mithril" }));
        let events = host.events.lock().unwrap();
        assert!(events
            .iter()
            .any(|(name, payload)| name == "data://changed" && payload["entity"] == "dictionary"));
    }
}
