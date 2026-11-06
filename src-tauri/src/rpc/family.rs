//! Two-way relationships and families. A relationship is one row, read from either end
//! through its kind's inverse. The `parents`, `spouse` and `children` infobox fields and
//! the matching relationships are kept in step here, by writing other pages' infoboxes
//! directly, so one save can never set off another.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{ok, pages, parse, revisions};
use crate::content::title_key;
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::indexing::{MentionMatcher, KIND_PAGE};

/// Kinds with a known other side. The same word twice reads the same from both ends.
const BUILTIN_KINDS: [(&str, &str); 16] = [
    ("parent of", "child of"),
    ("spouse", "spouse"),
    ("sibling", "sibling"),
    ("ally", "ally"),
    ("enemy", "enemy"),
    ("rival", "rival"),
    ("friend", "friend"),
    ("related", "related"),
    ("mentor of", "student of"),
    ("member of", "has member"),
    ("leader of", "led by"),
    ("located in", "contains"),
    ("part of", "includes"),
    ("owner of", "owned by"),
    ("creator of", "created by"),
    ("ruler of", "ruled by"),
];

const KINDS_META_KEY: &str = "relationKinds";
const PARENT_KIND: &str = "parent of";
const SPOUSE_KIND: &str = "spouse";

const MAX_KIND_CHARS: usize = 60;

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

struct KindPair {
    kind: String,
    inverse: String,
    builtin: bool,
}

/// Every kind this project knows the other side of.
pub struct KindTable {
    pairs: Vec<KindPair>,
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn same_kind(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

impl KindTable {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        let mut pairs: Vec<KindPair> = BUILTIN_KINDS
            .iter()
            .map(|(kind, inverse)| KindPair {
                kind: (*kind).to_string(),
                inverse: (*inverse).to_string(),
                builtin: true,
            })
            .collect();
        let stored: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [KINDS_META_KEY],
                |r| r.get(0),
            )
            .ok();
        if let Some(text) = stored {
            let custom: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
            for entry in custom {
                let kind = collapse(entry["kind"].as_str().unwrap_or_default());
                let inverse = collapse(entry["inverse"].as_str().unwrap_or_default());
                if !kind.is_empty() && !inverse.is_empty() {
                    pairs.push(KindPair {
                        kind,
                        inverse,
                        builtin: false,
                    });
                }
            }
        }
        Ok(Self { pairs })
    }

    /// How a kind is stored, and whether saying it this way round flips the two pages.
    /// "B child of A" is stored as "A parent of B", so a fact only ever has one row.
    pub fn normalize(&self, kind: &str) -> (String, bool) {
        for pair in &self.pairs {
            if same_kind(&pair.kind, kind) {
                return (pair.kind.clone(), false);
            }
        }
        for pair in &self.pairs {
            if same_kind(&pair.inverse, kind) {
                return (pair.kind.clone(), true);
            }
        }
        (kind.to_string(), false)
    }

    /// The name of a kind as read from the other page, if it has one.
    pub fn inverse_of(&self, kind: &str) -> Option<String> {
        self.pairs.iter().find_map(|pair| {
            if same_kind(&pair.kind, kind) {
                Some(pair.inverse.clone())
            } else if same_kind(&pair.inverse, kind) {
                Some(pair.kind.clone())
            } else {
                None
            }
        })
    }

    pub fn is_symmetric(&self, kind: &str) -> bool {
        self.inverse_of(kind)
            .is_some_and(|inverse| same_kind(&inverse, kind))
    }

    fn to_json(&self) -> Value {
        Value::Array(
            self.pairs
                .iter()
                .map(|pair| json!({ "kind": pair.kind, "inverse": pair.inverse, "builtin": pair.builtin }))
                .collect(),
        )
    }

    fn custom_json(&self) -> String {
        let custom: Vec<Value> = self
            .pairs
            .iter()
            .filter(|pair| !pair.builtin)
            .map(|pair| json!({ "kind": pair.kind, "inverse": pair.inverse }))
            .collect();
        Value::Array(custom).to_string()
    }
}

/// Declares the other side of a custom kind, or forgets it when `inverse` is empty.
/// Facts already recorded under either name are folded into one form.
fn set_kind(conn: &Connection, kind: &str, inverse: &str) -> AppResult<()> {
    let kind = collapse(kind);
    let inverse = collapse(inverse);
    if kind.is_empty() {
        return Err(AppError::invalid("Give the kind a name."));
    }
    if kind.chars().count() > MAX_KIND_CHARS || inverse.chars().count() > MAX_KIND_CHARS {
        return Err(AppError::invalid("That relationship kind is too long."));
    }
    let mut table = KindTable::load(conn)?;
    let is_builtin = |name: &str| {
        table
            .pairs
            .iter()
            .any(|pair| pair.builtin && (same_kind(&pair.kind, name) || same_kind(&pair.inverse, name)))
    };
    if is_builtin(&kind) {
        return Err(AppError::invalid(format!(
            "\"{kind}\" already has a fixed other side."
        )));
    }
    if !inverse.is_empty() && is_builtin(&inverse) {
        return Err(AppError::invalid(format!(
            "\"{inverse}\" already has a fixed other side."
        )));
    }
    // Moving a name from one pair to another would leave the facts saved under the old
    // pair meaning something else, so the old pair has to be forgotten first.
    if !inverse.is_empty() {
        let same_pair = |pair: &KindPair| {
            (same_kind(&pair.kind, &kind) && same_kind(&pair.inverse, &inverse))
                || (same_kind(&pair.kind, &inverse) && same_kind(&pair.inverse, &kind))
        };
        for pair in table.pairs.iter().filter(|pair| !pair.builtin && !same_pair(pair)) {
            for name in [&kind, &inverse] {
                if same_kind(&pair.kind, name) || same_kind(&pair.inverse, name) {
                    return Err(AppError::invalid(format!(
                        "\"{name}\" already goes with \"{}\". Clear that other side first.",
                        if same_kind(&pair.kind, name) { &pair.inverse } else { &pair.kind }
                    )));
                }
            }
        }
    }
    table.pairs.retain(|pair| {
        let names_it = |name: &str| same_kind(&pair.kind, name) || same_kind(&pair.inverse, name);
        pair.builtin || !(names_it(&kind) || (!inverse.is_empty() && names_it(&inverse)))
    });
    if !inverse.is_empty() {
        table.pairs.push(KindPair {
            kind: kind.clone(),
            inverse: inverse.clone(),
            builtin: false,
        });
    }
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![KINDS_META_KEY, table.custom_json()],
    )?;

    if inverse.is_empty() {
        return Ok(());
    }
    // Rows are compared here, because SQLite's lower() only knows ASCII.
    let rows: Vec<(String, String, String, String, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, from_page_id, to_page_id, kind, note FROM relationships")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let symmetric = same_kind(&kind, &inverse);
    let mut seen: HashMap<(String, String), String> = HashMap::new();
    for (id, from, to, stored, note) in rows {
        let (canonical, flipped) = table.normalize(&stored);
        if !same_kind(&canonical, &kind) {
            continue;
        }
        let (from, to) = if flipped { (to, from) } else { (from, to) };
        let fact = if symmetric && to < from {
            (to.clone(), from.clone())
        } else {
            (from.clone(), to.clone())
        };
        match seen.get(&fact) {
            None => {
                conn.execute(
                    "UPDATE relationships SET from_page_id = ?1, to_page_id = ?2, kind = ?3 WHERE id = ?4",
                    params![from, to, canonical, id],
                )?;
                seen.insert(fact, id);
            }
            Some(kept) => {
                // The same fact said twice. Only one row stays, but neither note is lost.
                if !note.is_empty() {
                    conn.execute(
                        "UPDATE relationships
                         SET note = CASE WHEN note = '' THEN ?1 ELSE note || '; ' || ?1 END
                         WHERE id = ?2",
                        params![note, kept],
                    )?;
                }
                conn.execute("DELETE FROM relationships WHERE id = ?1", [&id])?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Keeping infoboxes and relationships in step
// ---------------------------------------------------------------------------

const PARENTS: &str = "parents";
const CHILDREN: &str = "children";
const SPOUSE: &str = "spouse";
const FAMILY_KEYS: [&str; 3] = [PARENTS, CHILDREN, SPOUSE];

fn family_label(key: &str) -> &'static str {
    match key {
        PARENTS => "Parents",
        CHILDREN => "Children",
        _ => "Spouse",
    }
}

/// The relationship a family field stands for: who is the "from" page, and the kind.
fn relation_for<'a>(key: &str, page_id: &'a str, other_id: &'a str) -> (&'a str, &'a str, &'static str) {
    match key {
        PARENTS => (other_id, page_id, PARENT_KIND),
        CHILDREN => (page_id, other_id, PARENT_KIND),
        _ => (page_id, other_id, SPOUSE_KIND),
    }
}

fn reciprocal(key: &str) -> &'static str {
    match key {
        PARENTS => CHILDREN,
        CHILDREN => PARENTS,
        _ => SPOUSE,
    }
}

/// What a sync changed on other pages, to reload them and to tell the writer.
#[derive(Default)]
pub struct FamilyReport {
    changes: Vec<Value>,
    pages: Vec<String>,
    relationships_changed: bool,
}

/// title or alias key -> live page id. Titles win over aliases.
fn names(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut index = HashMap::new();
    let mut aliases = conn.prepare(
        "SELECT a.alias_key, a.page_id FROM page_aliases a JOIN pages p ON p.id = a.page_id
         WHERE p.deleted_at IS NULL ORDER BY p.title",
    )?;
    for row in aliases.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (key, id) = row?;
        index.entry(key).or_insert(id);
    }
    let mut titles = conn.prepare("SELECT title_key, id FROM pages WHERE deleted_at IS NULL")?;
    for row in titles.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (key, id) = row?;
        index.insert(key, id);
    }
    Ok(index)
}

/// title key -> page in the trash, the most recently trashed first. A field naming one reads
/// as a red link, but taking the name out still has to undo the relationship, or restoring
/// the page would bring back a fact the writer removed.
fn trashed_names(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut index = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT title_key, id FROM pages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    )?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (key, id) = row?;
        index.entry(key).or_insert(id);
    }
    Ok(index)
}

fn is_trashed(conn: &Connection, id: &str) -> AppResult<bool> {
    let deleted: Option<String> =
        conn.query_row("SELECT deleted_at FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
    Ok(deleted.is_some())
}

// ---------------------------------------------------------------------------
// Waiting while a name is typed
// ---------------------------------------------------------------------------

/// Sent on an infobox while the writer is still typing in these family fields. It is taken
/// off before the infobox is stored.
const TYPING_KEY: &str = "familyTyping";
/// page id -> family field -> the titles it held when it was last kept in step, for fields
/// saved while the writer was still typing in them.
const WAITING_META_KEY: &str = "familyWaiting";

/// Takes the note of which family fields are still being typed in off an infobox about to be
/// saved, so that it is never stored.
pub fn take_typing(infobox: &mut Value) -> Vec<String> {
    let Some(note) = infobox.as_object_mut().and_then(|o| o.remove(TYPING_KEY)) else {
        return Vec::new();
    };
    note.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|key| FAMILY_KEYS.contains(key))
        .map(str::to_string)
        .collect()
}

type Waiting = HashMap<String, HashMap<String, Vec<String>>>;

fn load_waiting(conn: &Connection) -> AppResult<Waiting> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [WAITING_META_KEY], |r| r.get(0))
        .ok();
    Ok(stored
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

fn save_waiting(conn: &Connection, waiting: &Waiting) -> AppResult<()> {
    if waiting.is_empty() {
        conn.execute("DELETE FROM meta WHERE key = ?1", [WAITING_META_KEY])?;
    } else {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![WAITING_META_KEY, json!(waiting).to_string()],
        )?;
    }
    Ok(())
}

/// A sync wrote a field the writer is still typing in, on another page. What it last saw has
/// to follow, or the writer's next save would undo the sync.
fn follow_waiting(conn: &Connection, page_id: &str, key: &str, title: &str, added: bool) -> AppResult<()> {
    let mut waiting = load_waiting(conn)?;
    let Some(titles) = waiting.get_mut(page_id).and_then(|fields| fields.get_mut(key)) else {
        return Ok(());
    };
    let wanted = title_key(title);
    titles.retain(|t| title_key(t) != wanted);
    if added {
        titles.push(title.to_string());
    }
    save_waiting(conn, &waiting)
}

fn field_of<'a>(infobox: &'a Value, key: &str) -> Option<&'a Value> {
    infobox
        .get("fields")?
        .as_array()?
        .iter()
        .find(|field| field["key"].as_str() == Some(key))
}

fn is_link_field(field: &Value) -> bool {
    matches!(field["kind"].as_str(), Some("page" | "pages"))
}

/// What a field holds, one entry per name. A `page` field holds one title, which may have
/// a comma in it. Anything else is a comma-separated list, or free text read as one.
fn entries_in(field: &Value) -> Vec<String> {
    let value = field["value"].as_str().unwrap_or_default();
    let entries: Vec<String> = if field["kind"].as_str() == Some("page") {
        vec![value.trim().to_string()]
    } else {
        value.split(',').map(|t| t.trim().to_string()).collect()
    };
    entries.into_iter().filter(|t| !t.is_empty()).collect()
}

/// The titles a family field links to. A free-text field links to nothing.
fn link_titles(infobox: &Value, key: &str) -> Vec<String> {
    field_of(infobox, key)
        .filter(|field| is_link_field(field))
        .map(entries_in)
        .unwrap_or_default()
}

/// The live pages a family field points at, without the page itself. A red link counts
/// once its page exists: see `after_page_created`.
fn ids_in(infobox: &Value, key: &str, own_id: &str, index: &HashMap<String, String>) -> Vec<String> {
    ids_of(&link_titles(infobox, key), own_id, index, None)
}

/// The pages some titles name, without the page itself. With `trashed`, a title no live page
/// has can name a page in the trash.
fn ids_of(
    titles: &[String],
    own_id: &str,
    index: &HashMap<String, String>,
    trashed: Option<&HashMap<String, String>>,
) -> Vec<String> {
    let mut ids = Vec::new();
    for title in titles {
        let key = title_key(title);
        let found = index.get(&key).or_else(|| trashed.and_then(|t| t.get(&key)));
        if let Some(id) = found {
            if id != own_id && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }
    ids
}

struct Stored {
    title: String,
    page_type: String,
    infobox: Value,
}

fn load_page(conn: &Connection, id: &str) -> AppResult<Stored> {
    let (title, page_type, text): (String, String, String) = conn.query_row(
        "SELECT title, page_type, infobox FROM pages WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    Ok(Stored {
        title,
        page_type,
        infobox: serde_json::from_str(&text).unwrap_or_else(|_| json!({ "fields": [] })),
    })
}

/// A row saved before kinds had one form, such as "B child of A", still counts as the fact
/// "A parent of B".
fn find_relationship(
    conn: &Connection,
    table: &KindTable,
    from: &str,
    to: &str,
    kind: &str,
    symmetric: bool,
) -> AppResult<Option<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, from_page_id, to_page_id, kind, note FROM relationships
         WHERE (from_page_id = ?1 AND to_page_id = ?2) OR (from_page_id = ?2 AND to_page_id = ?1)",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    for row in rows {
        let (id, row_from, row_to, stored_kind, note) = row?;
        let (existing_kind, flipped) = table.normalize(&stored_kind);
        let existing_from = if flipped { row_to } else { row_from };
        if same_kind(&existing_kind, kind) && (symmetric || existing_from == from) {
            return Ok(Some((id, note)));
        }
    }
    Ok(None)
}

/// One run of keeping things in step. Building the name lists reads every page, so a run
/// builds them once, and only after finding it has something to do.
struct Syncer<'c> {
    conn: &'c Connection,
    table: KindTable,
    index: HashMap<String, String>,
    matcher: MentionMatcher,
    report: FamilyReport,
}

impl<'c> Syncer<'c> {
    fn new(conn: &'c Connection) -> AppResult<Self> {
        Ok(Self {
            conn,
            table: KindTable::load(conn)?,
            index: names(conn)?,
            matcher: MentionMatcher::build(conn)?,
            report: FamilyReport::default(),
        })
    }

    /// Writes a page's infobox and what depends on it, without going through a page save,
    /// which is what keeps this from syncing itself.
    fn store_infobox(&mut self, id: &str, infobox: &Value) -> AppResult<()> {
        // The writer did not ask for this edit, so it must be easy to go back on.
        revisions::auto_checkpoint(self.conn, KIND_PAGE, id)?;
        self.conn.execute(
            "UPDATE pages SET infobox = ?1, updated_at = ?2 WHERE id = ?3",
            params![infobox.to_string(), db::now(), id],
        )?;
        // A page in the trash is kept out of links and search until it is restored.
        if !is_trashed(self.conn, id)? {
            pages::reindex_page(self.conn, &self.matcher, id)?;
        }
        if !self.report.pages.iter().any(|page| page == id) {
            self.report.pages.push(id.to_string());
        }
        Ok(())
    }

    fn change(&mut self, kind: &str, page_id: &str, title: &str, field: &str, other: &str, alongside: &[String]) {
        self.report.changes.push(json!({
            "type": kind,
            "pageId": page_id,
            "title": title,
            "field": field,
            "other": other,
            "alongside": alongside,
        }));
    }

    /// Adds a page to a family field. Never replaces what is there: another value stays,
    /// and the writer is told. A page without the field only gains it if it is a character.
    fn add_to_field(&mut self, page_id: &str, key: &str, other_id: &str) -> AppResult<()> {
        let other_title = load_page(self.conn, other_id)?.title;
        let mut page = load_page(self.conn, page_id)?;
        let Some(field) = field_of(&page.infobox, key) else {
            if page.page_type != "character" {
                return Ok(());
            }
            // A title with a comma in it can only be held by a single-page field.
            let kind = if other_title.contains(',') { "page" } else { "pages" };
            let label = family_label(key);
            if !page.infobox["fields"].is_array() {
                page.infobox["fields"] = json!([]);
            }
            if let Some(fields) = page.infobox["fields"].as_array_mut() {
                fields.push(json!({ "key": key, "label": label, "kind": kind, "value": other_title }));
            }
            self.store_infobox(page_id, &page.infobox)?;
            follow_waiting(self.conn, page_id, key, &other_title, true)?;
            self.change("added", page_id, &page.title, label, &other_title, &[]);
            return Ok(());
        };

        let existing = entries_in(field);
        let lists_other = existing
            .iter()
            .any(|t| self.index.get(&title_key(t)).is_some_and(|id| id == other_id));
        if lists_other {
            return Ok(());
        }
        let label = field["label"].as_str().unwrap_or(family_label(key)).to_string();
        let was_page = field["kind"].as_str() == Some("page");
        // Free text stays free text. An empty field is free to become a list of links.
        let links = is_link_field(field) || existing.is_empty();
        let mut all = existing.clone();
        all.push(other_title.clone());
        if links && all.len() > 1 && all.iter().any(|t| t.contains(',')) {
            self.change("noRoom", page_id, &page.title, &label, &other_title, &existing);
            return Ok(());
        }
        let single = all.len() == 1 && (was_page || other_title.contains(','));
        let new_kind = if single { "page" } else { "pages" };
        let fields = page.infobox["fields"].as_array_mut();
        if let Some(target) = fields.and_then(|f| f.iter_mut().find(|f| f["key"].as_str() == Some(key))) {
            target["value"] = json!(all.join(", "));
            if links {
                target["kind"] = json!(new_kind);
            }
        }
        self.store_infobox(page_id, &page.infobox)?;
        if links {
            follow_waiting(self.conn, page_id, key, &other_title, true)?;
        }
        self.change("added", page_id, &page.title, &label, &other_title, &existing);
        Ok(())
    }

    fn remove_from_field(&mut self, page_id: &str, key: &str, other_id: &str) -> AppResult<()> {
        let mut page = load_page(self.conn, page_id)?;
        let Some(field) = field_of(&page.infobox, key) else {
            return Ok(());
        };
        let existing = entries_in(field);
        let kept: Vec<String> = existing
            .iter()
            .filter(|t| !self.index.get(&title_key(t)).is_some_and(|id| id == other_id))
            .cloned()
            .collect();
        if kept.len() == existing.len() {
            return Ok(());
        }
        let label = field["label"].as_str().unwrap_or(family_label(key)).to_string();
        let removed = load_page(self.conn, other_id)?.title;
        let fields = page.infobox["fields"].as_array_mut();
        if let Some(target) = fields.and_then(|f| f.iter_mut().find(|f| f["key"].as_str() == Some(key))) {
            target["value"] = json!(kept.join(", "));
        }
        self.store_infobox(page_id, &page.infobox)?;
        follow_waiting(self.conn, page_id, key, &removed, false)?;
        self.change("removed", page_id, &page.title, &label, &removed, &kept);
        Ok(())
    }

    /// A family field on `page_id` now names `other_id`.
    fn link(&mut self, page_id: &str, key: &str, other_id: &str) -> AppResult<()> {
        let (from, to, kind) = relation_for(key, page_id, other_id);
        if find_relationship(self.conn, &self.table, from, to, kind, kind == SPOUSE_KIND)?.is_none() {
            self.conn.execute(
                "INSERT INTO relationships (id, from_page_id, to_page_id, kind, note, created_at)
                 VALUES (?1, ?2, ?3, ?4, '', ?5)",
                params![db::new_id(), from, to, kind, db::now()],
            )?;
            self.report.relationships_changed = true;
        }
        self.add_to_field(other_id, reciprocal(key), page_id)
    }

    /// A family field on `page_id` no longer names `other_id`. A relationship with a note
    /// holds something the field never did, so it stays until the writer deletes it.
    fn unlink(&mut self, page_id: &str, key: &str, other_id: &str) -> AppResult<()> {
        let (from, to, kind) = relation_for(key, page_id, other_id);
        if let Some((id, note)) = find_relationship(self.conn, &self.table, from, to, kind, kind == SPOUSE_KIND)? {
            if note.is_empty() {
                self.conn
                    .execute("DELETE FROM relationships WHERE id = ?1", [&id])?;
                self.report.relationships_changed = true;
            } else {
                let saved = load_page(self.conn, page_id)?.title;
                let other = load_page(self.conn, other_id)?.title;
                self.change("kept", page_id, &saved, family_label(key), &other, &[]);
                return Ok(());
            }
        }
        self.remove_from_field(other_id, reciprocal(key), page_id)
    }
}

/// Call after a page's infobox was saved, with the infobox it had before. Differences in
/// its family fields become relationships and entries in the other page's infobox.
///
/// `typing` names the family fields the writer is still typing in. Their sync waits, since
/// a pause in the middle of a name must not link to a page that happens to be called what
/// was typed so far. What they held when last in step is kept in project meta, so the save
/// that ends the wait, or `settle`, compares with that rather than with a half-typed name.
pub fn after_infobox_save(
    conn: &Connection,
    page_id: &str,
    before: &Value,
    typing: &[String],
) -> AppResult<FamilyReport> {
    let after = load_page(conn, page_id)?.infobox;
    let mut waiting = load_waiting(conn)?;
    let held = waiting.remove(page_id).unwrap_or_default();
    let mut still_held: HashMap<String, Vec<String>> = HashMap::new();
    let mut work: Vec<(&str, Vec<String>, Vec<String>)> = Vec::new();
    for key in FAMILY_KEYS {
        let saved = link_titles(before, key);
        let now = link_titles(&after, key);
        let in_step = held.get(key).cloned().unwrap_or_else(|| saved.clone());
        // A note left over from typing earlier only counts while that field is changing.
        let typed = now != saved || held.contains_key(key);
        if typed && typing.iter().any(|k| k == key) {
            still_held.insert(key.to_string(), in_step);
        } else if in_step != now {
            work.push((key, in_step, now));
        }
    }
    if !held.is_empty() || !still_held.is_empty() {
        if !still_held.is_empty() {
            waiting.insert(page_id.to_string(), still_held);
        }
        save_waiting(conn, &waiting)?;
    }
    // Most saves are of other fields, and the checks below read every page's name.
    if work.is_empty() {
        return Ok(FamilyReport::default());
    }
    let mut sync = Syncer::new(conn)?;
    let trashed = trashed_names(conn)?;
    for (key, old_titles, new_titles) in work {
        let old = ids_of(&old_titles, page_id, &sync.index, Some(&trashed));
        let new = ids_of(&new_titles, page_id, &sync.index, Some(&trashed));
        for other in new.iter().filter(|id| !old.contains(id)) {
            // A page in the trash is linked when it is restored: see `after_page_restored`.
            if !is_trashed(conn, other)? {
                sync.link(page_id, key, other)?;
            }
        }
        for other in old.iter().filter(|id| !new.contains(id)) {
            sync.unlink(page_id, key, other)?;
        }
    }
    Ok(sync.report)
}

/// Keeps in step what a page's family fields say now, for fields whose sync was waiting for
/// the writer to finish typing. Called when they leave the field.
pub fn settle(conn: &Connection, page_id: &str) -> AppResult<FamilyReport> {
    if !load_waiting(conn)?.contains_key(page_id) {
        return Ok(FamilyReport::default());
    }
    let current = match load_page(conn, page_id) {
        Ok(page) => page.infobox,
        Err(_) => {
            // Gone for good, so there is nothing left to wait for.
            let mut waiting = load_waiting(conn)?;
            waiting.remove(page_id);
            save_waiting(conn, &waiting)?;
            return Ok(FamilyReport::default());
        }
    };
    after_infobox_save(conn, page_id, &current, &[])
}

/// Call after creating a page. Its own family fields count, and so do fields elsewhere
/// that were already naming it, which until now were red links.
pub fn after_page_created(conn: &Connection, id: &str) -> AppResult<FamilyReport> {
    let mut report = after_infobox_save(conn, id, &json!({ "fields": [] }), &[])?;
    let mut waiting = link_waiting_fields(conn, id)?;
    report.changes.append(&mut waiting.changes);
    report.pages.append(&mut waiting.pages);
    report.relationships_changed |= waiting.relationships_changed;
    Ok(report)
}

/// Call after restoring a page from the trash. While it was there, fields naming it were red
/// links and could change, and so could the pages its own fields name, so it is kept in step
/// as if it were new. Relationships it had are still there, so nothing is said twice.
pub fn after_page_restored(conn: &Connection, id: &str) -> AppResult<FamilyReport> {
    after_page_created(conn, id)
}

/// Call after renaming a page, once links to its old title point at the new one. A field
/// that already named the new title was a red link until now.
pub fn after_page_renamed(conn: &Connection, id: &str) -> AppResult<FamilyReport> {
    link_waiting_fields(conn, id)
}

/// Fields on other pages that name this page's title or an alias of it, as red links until
/// now, become relationships.
fn link_waiting_fields(conn: &Connection, id: &str) -> AppResult<FamilyReport> {
    let waiting: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT l.source_id FROM links l
             JOIN pages p ON p.id = l.source_id AND p.deleted_at IS NULL
             WHERE l.source_kind = ?1 AND l.source_id <> ?2 AND l.target_key IN (
               SELECT title_key FROM pages WHERE id = ?2
               UNION SELECT alias_key FROM page_aliases WHERE page_id = ?2)",
        )?;
        let rows = stmt.query_map(params![KIND_PAGE, id], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    if waiting.is_empty() {
        return Ok(FamilyReport::default());
    }
    let mut sync = Syncer::new(conn)?;
    let typing = load_waiting(conn)?;
    for source in waiting {
        let infobox = load_page(conn, &source)?.infobox;
        for key in FAMILY_KEYS {
            // A field still being typed in is linked when the writer leaves it.
            if typing.get(&source).is_some_and(|fields| fields.contains_key(key)) {
                continue;
            }
            if ids_in(&infobox, key, &source, &sync.index).iter().any(|other| other == id) {
                sync.link(&source, key, id)?;
            }
        }
    }
    Ok(sync.report)
}

/// One fact, as stored.
struct Fact {
    from: String,
    to: String,
    kind: String,
}

impl Fact {
    /// In its one form, whatever form the row was saved in.
    fn from_row(row: &Value, table: &KindTable) -> Self {
        let text = |name: &str| row[name].as_str().unwrap_or_default().to_string();
        let (kind, flipped) = table.normalize(&text("kind"));
        let (from, to) = if flipped {
            (text("toPageId"), text("fromPageId"))
        } else {
            (text("fromPageId"), text("toPageId"))
        };
        Self { from, to, kind }
    }

    fn same_as(&self, other: &Self) -> bool {
        self.from == other.from && self.to == other.to && same_kind(&self.kind, &other.kind)
    }

    /// The fields this fact shows up in: (page, field, other page).
    fn fields(&self) -> Vec<(&str, &'static str, &str)> {
        if same_kind(&self.kind, PARENT_KIND) {
            vec![(&self.from, CHILDREN, &self.to), (&self.to, PARENTS, &self.from)]
        } else if same_kind(&self.kind, SPOUSE_KIND) {
            vec![(&self.from, SPOUSE, &self.to), (&self.to, SPOUSE, &self.from)]
        } else {
            Vec::new()
        }
    }
}

/// Call after a relationship was added, edited or deleted, with the row as it was and
/// as it is now, so that infoboxes keep saying the same thing.
pub fn after_relationship_change(
    conn: &Connection,
    before: Option<&Value>,
    after: Option<&Value>,
) -> AppResult<FamilyReport> {
    let table = KindTable::load(conn)?;
    let before = before.map(|row| Fact::from_row(row, &table));
    let after = after.map(|row| Fact::from_row(row, &table));
    if let (Some(a), Some(b)) = (&before, &after) {
        if a.same_as(b) {
            return Ok(FamilyReport::default());
        }
    }
    let family_kind = |fact: &Option<Fact>| fact.as_ref().is_some_and(|f| !f.fields().is_empty());
    if !family_kind(&before) && !family_kind(&after) {
        return Ok(FamilyReport::default());
    }
    let mut sync = Syncer::new(conn)?;
    if let Some(fact) = &before {
        for (page, key, other) in fact.fields() {
            sync.remove_from_field(page, key, other)?;
        }
    }
    if let Some(fact) = &after {
        for (page, key, other) in fact.fields() {
            sync.add_to_field(page, key, other)?;
        }
    }
    Ok(sync.report)
}

/// Reloads what a sync touched and tells the writer what happened elsewhere.
pub fn announce(engine: &Engine, report: &FamilyReport) {
    if report.relationships_changed {
        engine.notify("extras");
    }
    if !report.pages.is_empty() {
        let documents: Vec<(String, String)> = report
            .pages
            .iter()
            .map(|id| (KIND_PAGE.to_string(), id.clone()))
            .collect();
        pages::notify_replaced(engine, &documents);
    }
    if !report.changes.is_empty() {
        engine
            .host
            .emit("family://synced", json!({ "changes": report.changes }));
    }
}

// ---------------------------------------------------------------------------
// The family tree
// ---------------------------------------------------------------------------

fn date_field(infobox: &Value, key: &str) -> Value {
    field_of(infobox, key)
        .and_then(|field| field["value"].as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map_or(Value::Null, |value| json!(value))
}

/// What a writer puts in a family field to say there is no name to give. Everyone with
/// "Unknown" for a parent is not one family. A page by that name still counts as a page.
const NOT_A_NAME: [&str; 9] = ["unknown", "none", "n/a", "na", "?", "??", "???", "-", "unnamed"];

#[derive(Default)]
struct FamilyEdges {
    parents: Vec<(String, String)>,
    spouses: Vec<(String, String)>,
    seen_parents: HashSet<(String, String)>,
    seen_spouses: HashSet<(String, String)>,
}

impl FamilyEdges {
    fn add_parent(&mut self, parent: &str, child: &str) {
        let edge = (parent.to_string(), child.to_string());
        if parent != child && self.seen_parents.insert(edge.clone()) {
            self.parents.push(edge);
        }
    }

    fn add_spouse(&mut self, a: &str, b: &str) {
        let edge = if a < b { (a, b) } else { (b, a) };
        let edge = (edge.0.to_string(), edge.1.to_string());
        if a != b && self.seen_spouses.insert(edge.clone()) {
            self.spouses.push(edge);
        }
    }
}

/// Everyone with a recorded parent, child or spouse. Reads relationships and infobox
/// fields both, since a project can hold fields that were never synced, such as an import.
/// A name with no page yet still counts as a person: a writer often names a mother long
/// before writing her page.
fn family_data(conn: &Connection) -> AppResult<Value> {
    let index = names(conn)?;
    let trashed = trashed_names(conn)?;
    let table = KindTable::load(conn)?;
    let mut edges = FamilyEdges::default();
    let mut people: HashMap<String, Value> = HashMap::new();
    let mut ghosts: HashMap<String, String> = HashMap::new();

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
        let (id, title, page_type, status, text) = row?;
        let infobox: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        for key in FAMILY_KEYS {
            for name in link_titles(&infobox, key) {
                let name_key = title_key(&name);
                let other = match index.get(&name_key) {
                    Some(found) => found.clone(),
                    None if NOT_A_NAME.contains(&name_key.as_str()) => continue,
                    None => {
                        let ghost = format!("missing:{name_key}");
                        ghosts.entry(ghost.clone()).or_insert(name);
                        ghost
                    }
                };
                match key {
                    PARENTS => edges.add_parent(&other, &id),
                    CHILDREN => edges.add_parent(&id, &other),
                    _ => edges.add_spouse(&id, &other),
                }
            }
        }
        people.insert(
            id.clone(),
            json!({
                "id": id,
                "title": title,
                "pageType": page_type,
                "status": status,
                "born": date_field(&infobox, "born"),
                "died": date_field(&infobox, "died"),
                "missing": false,
            }),
        );
    }
    let mut stmt = conn.prepare("SELECT from_page_id, to_page_id, kind FROM relationships")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (from, to, kind) = row?;
        if !people.contains_key(&from) || !people.contains_key(&to) {
            continue;
        }
        let (kind, flipped) = table.normalize(&kind);
        let (from, to) = if flipped { (to, from) } else { (from, to) };
        if same_kind(&kind, PARENT_KIND) {
            edges.add_parent(&from, &to);
        } else if same_kind(&kind, SPOUSE_KIND) {
            edges.add_spouse(&from, &to);
        }
    }
    for (id, title) in ghosts {
        // Shown as missing, the way a link to it reads, but not as a page still to write.
        let in_trash = trashed.contains_key(&title_key(&title));
        people.insert(
            id.clone(),
            json!({
                "id": id,
                "title": title,
                "pageType": "",
                "status": "",
                "born": null,
                "died": null,
                "missing": true,
                "trashed": in_trash,
            }),
        );
    }

    let mut members = HashSet::new();
    for (a, b) in edges.parents.iter().chain(edges.spouses.iter()) {
        members.insert(a.clone());
        members.insert(b.clone());
    }
    let mut listed: Vec<Value> = members
        .iter()
        .filter_map(|id| people.get(id).cloned())
        .collect();
    listed.sort_by_key(|person| person["title"].as_str().unwrap_or_default().to_lowercase());
    Ok(json!({
        "people": listed,
        "parents": edges.parents.iter().map(|(parent, child)| json!({ "parent": parent, "child": child })).collect::<Vec<_>>(),
        "spouses": edges.spouses.iter().map(|(a, b)| json!({ "a": a, "b": b })).collect::<Vec<_>>(),
    }))
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "relationKinds" => engine.read(|c| Ok(KindTable::load(c)?.to_json())),
        "relationKindSet" => {
            #[derive(Deserialize)]
            struct P {
                kind: String,
                #[serde(default)]
                inverse: String,
            }
            let p: P = parse(params)?;
            engine.write(|tx| set_kind(tx, &p.kind, &p.inverse))?;
            engine.notify("extras");
            ok(true)
        }
        "familyData" => engine.read(family_data),
        _ => Err(super::unknown(&format!("extras.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::engine::{Engine, TestDir, TestHost};
    use crate::rpc::{call, dispatch};
    use serde_json::{json, Value};

    fn project() -> (Arc<Engine>, Arc<TestHost>, TestDir) {
        let (engine, host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "T" }));
        (engine, host, dir)
    }

    fn character(engine: &Engine, title: &str) -> String {
        let page = call(
            engine,
            "pages.create",
            json!({ "title": title, "pageType": "character", "infobox": { "fields": [
                { "key": "parents", "label": "Parents", "kind": "pages", "value": "" },
                { "key": "spouse", "label": "Spouse", "kind": "pages", "value": "" },
                { "key": "children", "label": "Children", "kind": "pages", "value": "" },
            ]}}),
        );
        page["id"].as_str().unwrap().to_string()
    }

    fn set_field(engine: &Engine, id: &str, key: &str, value: &str) {
        let page = call(engine, "pages.get", json!({ "id": id }));
        let mut infobox = page["infobox"].clone();
        let fields = infobox["fields"].as_array_mut().unwrap();
        match fields.iter_mut().find(|f| f["key"] == key) {
            Some(field) => field["value"] = json!(value),
            None => fields.push(json!({ "key": key, "label": key, "kind": "pages", "value": value })),
        }
        call(
            engine,
            "pages.update",
            json!({ "id": id, "patch": { "infobox": infobox }, "fromEditor": true }),
        );
    }

    /// A save from the editor while the writer is still typing in the field.
    fn type_into(engine: &Engine, id: &str, key: &str, value: &str) {
        let page = call(engine, "pages.get", json!({ "id": id }));
        let mut infobox = page["infobox"].clone();
        let fields = infobox["fields"].as_array_mut().unwrap();
        fields.iter_mut().find(|f| f["key"] == key).unwrap()["value"] = json!(value);
        infobox["familyTyping"] = json!([key]);
        call(
            engine,
            "pages.update",
            json!({ "id": id, "patch": { "infobox": infobox }, "fromEditor": true }),
        );
    }

    fn leave_field(engine: &Engine, id: &str) {
        call(engine, "pages.settleFamily", json!({ "id": id }));
    }

    fn field(engine: &Engine, id: &str, key: &str) -> String {
        let page = call(engine, "pages.get", json!({ "id": id }));
        page["infobox"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == key)
            .map_or(String::new(), |f| f["value"].as_str().unwrap().to_string())
    }

    fn relationships(engine: &Engine) -> Vec<Value> {
        call(engine, "extras.relationshipList", json!({}))
            .as_array()
            .unwrap()
            .clone()
    }

    fn synced_events(host: &TestHost) -> Vec<Value> {
        host.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "family://synced")
            .map(|(_, payload)| payload.clone())
            .collect()
    }

    fn last_change(host: &TestHost) -> Value {
        synced_events(host).last().unwrap()["changes"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone()
    }

    // ---- Kinds --------------------------------------------------------------

    #[test]
    fn a_fact_said_from_either_side_is_stored_once() {
        let (engine, _host, _dir) = project();
        let a = call(&engine, "pages.create", json!({ "title": "Aria" }))["id"].clone();
        let b = call(&engine, "pages.create", json!({ "title": "Bran" }))["id"].clone();

        let row = call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": b, "toPageId": a, "kind": "Child of" }),
        );
        assert_eq!(row["kind"], "parent of", "stored in its one form");
        assert_eq!(row["fromPageId"], a);
        assert_eq!(row["toPageId"], b);
        assert_eq!(row["inverse"], "child of");

        let again = dispatch(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": a, "toPageId": b, "kind": "parent of" }),
        );
        assert_eq!(again.unwrap_err().code, "EXISTS");
        let flipped = dispatch(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": b, "toPageId": a, "kind": "child of" }),
        );
        assert_eq!(flipped.unwrap_err().code, "EXISTS");
        assert_eq!(relationships(&engine).len(), 1);

        // Both pages see the same row, and deleting it clears both.
        for page in [&a, &b] {
            let list = call(&engine, "extras.relationshipList", json!({ "pageId": page }));
            assert_eq!(list[0]["id"], row["id"]);
        }
        let edited = call(
            &engine,
            "extras.relationshipUpdate",
            json!({ "id": row["id"], "kind": "student of" }),
        );
        assert_eq!(edited["kind"], "mentor of");
        assert_eq!(edited["fromPageId"], b, "the two pages swap with the wording");
        assert_eq!(edited["inverse"], "student of");
        call(&engine, "extras.relationshipDelete", json!({ "id": row["id"] }));
        assert!(relationships(&engine).is_empty());
    }

    #[test]
    fn custom_kinds_can_declare_an_inverse() {
        let (engine, _host, _dir) = project();
        let a = call(&engine, "pages.create", json!({ "title": "Aria" }))["id"].clone();
        let b = call(&engine, "pages.create", json!({ "title": "Bran" }))["id"].clone();
        let c = call(&engine, "pages.create", json!({ "title": "Cara" }))["id"].clone();

        let unknown = call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": a, "toPageId": b, "kind": "vassal of", "note": "Sworn young" }),
        );
        assert!(unknown["inverse"].is_null(), "no other side is known yet");
        // Recorded the other way round under its other name, which is now the same fact.
        call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": b, "toPageId": a, "kind": "liege of", "note": "Reluctantly" }),
        );
        call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": c, "toPageId": a, "kind": "liege of" }),
        );

        call(
            &engine,
            "extras.relationKindSet",
            json!({ "kind": " liege  of ", "inverse": "vassal of" }),
        );
        let rows = relationships(&engine);
        assert_eq!(rows.len(), 2, "the two wordings of one fact became one row");
        assert!(rows.iter().all(|r| r["kind"] == "liege of" && r["inverse"] == "vassal of"));
        let merged = rows.iter().find(|r| r["fromPageId"] == b && r["toPageId"] == a).unwrap();
        assert_eq!(merged["note"], "Sworn young; Reluctantly", "neither note is lost");

        let flipped = call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": c, "toPageId": b, "kind": "vassal of" }),
        );
        assert_eq!(flipped["kind"], "liege of");
        assert_eq!(flipped["fromPageId"], b);

        let kinds = call(&engine, "extras.relationKinds", json!({}));
        let declared = kinds
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["kind"] == "liege of")
            .unwrap();
        assert_eq!(declared["builtin"], false);

        let fixed = dispatch(
            &engine,
            "extras.relationKindSet",
            json!({ "kind": "parent of", "inverse": "heir of" }),
        );
        assert_eq!(fixed.unwrap_err().code, "INVALID");

        // A declared word that means the same both ways is one fact in either direction.
        call(&engine, "extras.relationKindSet", json!({ "kind": "cousin", "inverse": "cousin" }));
        call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": a, "toPageId": c, "kind": "cousin" }),
        );
        let same = dispatch(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": c, "toPageId": a, "kind": "cousin" }),
        );
        assert_eq!(same.unwrap_err().code, "EXISTS");

        // Forgetting a declaration leaves the facts as they are.
        call(&engine, "extras.relationKindSet", json!({ "kind": "liege of" }));
        let after = relationships(&engine);
        assert!(after.iter().filter(|r| r["kind"] == "liege of").all(|r| r["inverse"].is_null()));
    }

    #[test]
    fn a_name_cannot_move_from_one_pair_to_another() {
        let (engine, _host, _dir) = project();
        call(&engine, "extras.relationKindSet", json!({ "kind": "liege of", "inverse": "vassal of" }));
        for (kind, inverse) in [("vassal of", "lord of"), ("ward of", "Liege Of")] {
            let moved = dispatch(&engine, "extras.relationKindSet", json!({ "kind": kind, "inverse": inverse }));
            assert_eq!(moved.unwrap_err().code, "INVALID", "{kind} / {inverse}");
        }
        // The same pair the other way round is fine, and so is forgetting it.
        call(&engine, "extras.relationKindSet", json!({ "kind": "vassal of", "inverse": "liege of" }));
        call(&engine, "extras.relationKindSet", json!({ "kind": "vassal of" }));
        call(&engine, "extras.relationKindSet", json!({ "kind": "vassal of", "inverse": "lord of" }));
    }

    #[test]
    fn a_row_saved_the_other_way_round_is_still_the_same_fact() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        // As an older version, or an import, would have saved it.
        engine
            .write(|tx| {
                tx.execute(
                    "INSERT INTO relationships (id, from_page_id, to_page_id, kind, note, created_at)
                     VALUES ('old', ?1, ?2, 'child of', '', '2026-01-01T00:00:00Z')",
                    rusqlite::params![bran, aria],
                )?;
                Ok(())
            })
            .unwrap();
        let again = dispatch(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": aria, "toPageId": bran, "kind": "parent of" }),
        );
        assert_eq!(again.unwrap_err().code, "EXISTS");

        set_field(&engine, &bran, "parents", "Aria");
        assert_eq!(relationships(&engine).len(), 1, "no second row");
        set_field(&engine, &bran, "parents", "");
        assert!(relationships(&engine).is_empty(), "clearing the field clears the old row");
    }

    // ---- Infoboxes ----------------------------------------------------------

    #[test]
    fn saving_a_family_field_updates_the_other_page_and_the_relationship() {
        let (engine, host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        let cara = character(&engine, "Cara");

        set_field(&engine, &aria, "spouse", "Bran");
        assert_eq!(field(&engine, &bran, "spouse"), "Aria");
        let rows = relationships(&engine);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["kind"], "spouse");

        set_field(&engine, &cara, "parents", "Aria, Bran");
        assert_eq!(field(&engine, &aria, "children"), "Cara");
        assert_eq!(field(&engine, &bran, "children"), "Cara");
        let parents: Vec<Value> = relationships(&engine)
            .into_iter()
            .filter(|r| r["kind"] == "parent of")
            .collect();
        assert_eq!(parents.len(), 2);
        assert!(parents.iter().all(|r| r["toPageId"] == json!(cara)));

        // Saying the same thing from the other side adds nothing, and the sync's own
        // writes do not set off more of them.
        let before = synced_events(&host).len();
        set_field(&engine, &bran, "spouse", "Aria");
        set_field(&engine, &aria, "children", "Cara");
        assert_eq!(relationships(&engine).len(), 3);
        assert_eq!(synced_events(&host).len(), before, "nothing else changed");

        // Taking it away takes it away on both sides.
        set_field(&engine, &aria, "spouse", "");
        assert_eq!(field(&engine, &bran, "spouse"), "");
        assert_eq!(relationships(&engine).len(), 2);
    }

    #[test]
    fn the_other_page_reloads_and_the_saved_page_does_not() {
        let (engine, host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        host.events.lock().unwrap().clear();
        set_field(&engine, &aria, "spouse", "Bran");
        let changed: Vec<String> = host
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "data://changed")
            .map(|(_, payload)| payload["entity"].as_str().unwrap().to_string())
            .collect();
        assert!(changed.contains(&format!("doc:page:{bran}")), "{changed:?}");
        assert!(!changed.contains(&format!("doc:page:{aria}")), "{changed:?}");
        assert!(changed.contains(&"extras".to_string()), "{changed:?}");
    }

    #[test]
    fn another_value_is_kept_and_the_writer_is_told() {
        let (engine, host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        let cara = character(&engine, "Cara");

        set_field(&engine, &bran, "spouse", "Cara");
        assert_eq!(field(&engine, &cara, "spouse"), "Bran");
        set_field(&engine, &aria, "spouse", "Bran");
        assert_eq!(field(&engine, &bran, "spouse"), "Cara, Aria", "added, not replaced");

        let last = last_change(&host);
        assert_eq!(last["type"], "added");
        assert_eq!(last["title"], "Bran");
        assert_eq!(last["other"], "Aria");
        assert_eq!(last["alongside"], json!(["Cara"]));
    }

    #[test]
    fn a_single_page_field_with_a_value_becomes_a_list_rather_than_lose_it() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = call(
            &engine,
            "pages.create",
            json!({ "title": "Bran", "pageType": "character", "infobox": { "fields": [
                { "key": "spouse", "label": "Wife", "kind": "page", "value": "Somebody Else" },
            ]}}),
        )["id"]
            .as_str()
            .unwrap()
            .to_string();
        set_field(&engine, &aria, "spouse", "Bran");
        let page = call(&engine, "pages.get", json!({ "id": bran }));
        let spouse = &page["infobox"]["fields"][0];
        assert_eq!(spouse["value"], "Somebody Else, Aria");
        assert_eq!(spouse["kind"], "pages");
        assert_eq!(spouse["label"], "Wife", "its label is left alone");
    }

    #[test]
    fn free_text_in_a_family_field_stays_and_is_not_added_to_twice() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = call(
            &engine,
            "pages.create",
            json!({ "title": "Bran", "pageType": "character", "infobox": { "fields": [
                { "key": "spouse", "label": "Spouse", "kind": "text", "value": "Widowed young" },
            ]}}),
        )["id"]
            .as_str()
            .unwrap()
            .to_string();
        set_field(&engine, &aria, "spouse", "Bran");
        assert_eq!(field(&engine, &bran, "spouse"), "Widowed young, Aria");

        // The writer is free to retype the name on the saved page. The field is left tidy.
        set_field(&engine, &aria, "spouse", "");
        assert_eq!(field(&engine, &bran, "spouse"), "Widowed young");
        set_field(&engine, &aria, "spouse", "Bran");
        set_field(&engine, &bran, "spouse", "Widowed young, Aria");
        assert_eq!(field(&engine, &bran, "spouse"), "Widowed young, Aria");
    }

    #[test]
    fn a_title_with_a_comma_is_not_split_across_a_list() {
        let (engine, host, _dir) = project();
        let bran = character(&engine, "Bran");
        // A field can hold this title only on its own, as a single page.
        let lord = call(&engine, "pages.create", json!({ "title": "Tomas, Lord of Reeds", "pageType": "character" }))["id"]
            .as_str()
            .unwrap()
            .to_string();
        call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": lord, "toPageId": bran, "kind": "spouse" }),
        );
        let page = call(&engine, "pages.get", json!({ "id": bran }));
        let spouse = page["infobox"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == "spouse")
            .unwrap()
            .clone();
        assert_eq!(spouse["value"], "Tomas, Lord of Reeds");
        assert_eq!(spouse["kind"], "page");

        // With something already there, it stays out and the writer hears why.
        let cara = character(&engine, "Cara");
        set_field(&engine, &cara, "spouse", "Dov");
        call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": lord, "toPageId": cara, "kind": "spouse" }),
        );
        assert_eq!(field(&engine, &cara, "spouse"), "Dov");
        let events = synced_events(&host);
        let changes = events.last().unwrap()["changes"].as_array().unwrap().clone();
        assert!(changes.iter().any(|c| c["type"] == "noRoom" && c["title"] == "Cara"), "{changes:?}");
    }

    #[test]
    fn pages_that_are_not_characters_do_not_gain_family_fields() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let order = call(&engine, "pages.create", json!({ "title": "The Order" }))["id"]
            .as_str()
            .unwrap()
            .to_string();
        set_field(&engine, &aria, "parents", "The Order");
        let page = call(&engine, "pages.get", json!({ "id": order }));
        assert_eq!(page["infobox"]["fields"].as_array().unwrap().len(), 0);
        assert_eq!(relationships(&engine).len(), 1, "the fact is still recorded");
    }

    #[test]
    fn a_page_naming_itself_is_left_alone() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        set_field(&engine, &aria, "spouse", "Aria");
        assert!(relationships(&engine).is_empty());
        assert_eq!(field(&engine, &aria, "spouse"), "Aria", "as the writer put it");
    }

    #[test]
    fn a_red_link_counts_once_its_page_is_created() {
        let (engine, host, _dir) = project();
        let aria = character(&engine, "Aria");
        set_field(&engine, &aria, "spouse", "Nobody Yet");
        assert!(relationships(&engine).is_empty());

        let created = call(
            &engine,
            "pages.create",
            json!({ "title": "Nobody Yet", "pageType": "character", "infobox": { "fields": [
                { "key": "spouse", "label": "Spouse", "kind": "pages", "value": "" },
            ]}}),
        );
        assert_eq!(created["infobox"]["fields"][0]["value"], "Aria", "the page comes back filled in");
        assert_eq!(relationships(&engine).len(), 1);
        assert_eq!(last_change(&host)["title"], "Nobody Yet");
    }

    #[test]
    fn aliases_count_as_the_page() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        call(
            &engine,
            "pages.update",
            json!({ "id": bran, "patch": { "aliases": ["Bran the Bold"] } }),
        );
        set_field(&engine, &bran, "spouse", "Aria");
        set_field(&engine, &aria, "spouse", "Bran the Bold");
        assert_eq!(relationships(&engine).len(), 1, "one fact");
        assert_eq!(field(&engine, &bran, "spouse"), "Aria", "and no second entry");
    }

    #[test]
    fn a_relationship_with_a_note_outlives_the_field_and_the_writer_is_told() {
        let (engine, host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        set_field(&engine, &aria, "spouse", "Bran");
        let row = relationships(&engine)[0].clone();
        call(
            &engine,
            "extras.relationshipUpdate",
            json!({ "id": row["id"], "note": "Married in secret" }),
        );

        set_field(&engine, &aria, "spouse", "");
        assert_eq!(relationships(&engine)[0]["note"], "Married in secret");
        let last = last_change(&host);
        assert_eq!(last["type"], "kept");
        assert_eq!(last["other"], "Bran");
        assert_eq!(field(&engine, &bran, "spouse"), "Aria", "it still holds, so the other page says so");
    }

    #[test]
    fn restoring_an_old_infobox_keeps_things_in_step() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        call(
            &engine,
            "revisions.checkpoint",
            json!({ "kind": "page", "id": aria }),
        );
        let old = call(
            &engine,
            "revisions.list",
            json!({ "kind": "page", "id": aria }),
        )[0]["id"]
            .clone();
        set_field(&engine, &aria, "spouse", "Bran");
        assert_eq!(field(&engine, &bran, "spouse"), "Aria");

        call(&engine, "revisions.restore", json!({ "id": old }));
        assert_eq!(field(&engine, &aria, "spouse"), "");
        assert_eq!(field(&engine, &bran, "spouse"), "");
        assert!(relationships(&engine).is_empty());
    }

    #[test]
    fn a_pause_in_the_middle_of_a_name_links_nothing() {
        let (engine, host, _dir) = project();
        let bran = character(&engine, "Bran");
        let brannoc = character(&engine, "Brannoc");
        let cara = character(&engine, "Cara");
        character(&engine, "Arden");

        // Each pause saves what was typed so far, and "Bran" is somebody else's name.
        host.events.lock().unwrap().clear();
        for typed in ["Ar", "Bran", "Brann", "Brannoc"] {
            type_into(&engine, &cara, "spouse", typed);
            assert!(relationships(&engine).is_empty(), "nothing links at {typed:?}");
        }
        assert_eq!(field(&engine, &cara, "spouse"), "Brannoc", "every pause is still saved");
        assert_eq!(field(&engine, &bran, "spouse"), "");
        assert_eq!(field(&engine, &brannoc, "spouse"), "");
        assert!(synced_events(&host).is_empty(), "and nobody is told about a name half typed");
        let stored = call(&engine, "pages.get", json!({ "id": cara }));
        assert!(stored["infobox"].get("familyTyping").is_none(), "the note is never stored");

        // Leaving the field keeps the name the writer settled on, and only that one.
        leave_field(&engine, &cara);
        let rows = relationships(&engine);
        assert_eq!(rows.len(), 1);
        assert!(rows[0]["fromPageId"] == json!(brannoc) || rows[0]["toPageId"] == json!(brannoc));
        assert_eq!(field(&engine, &brannoc, "spouse"), "Cara");
        assert_eq!(field(&engine, &bran, "spouse"), "", "never touched");
        assert_eq!(last_change(&host)["other"], "Cara", "and the writer is told");

        // Leaving it again has nothing left to do.
        let told = synced_events(&host).len();
        leave_field(&engine, &cara);
        assert_eq!(synced_events(&host).len(), told);
    }

    #[test]
    fn a_name_typed_away_is_unlinked_when_the_writer_leaves_the_field() {
        let (engine, _host, _dir) = project();
        let bran = character(&engine, "Bran");
        let cara = character(&engine, "Cara");
        set_field(&engine, &cara, "spouse", "Bran");
        assert_eq!(relationships(&engine).len(), 1);

        // Deleting it a letter at a time, past a pause, then typing it back.
        for typed in ["Bra", "", "Br", "Bran"] {
            type_into(&engine, &cara, "spouse", typed);
            assert_eq!(relationships(&engine).len(), 1, "still married at {typed:?}");
            assert_eq!(field(&engine, &bran, "spouse"), "Cara");
        }
        leave_field(&engine, &cara);
        assert_eq!(relationships(&engine).len(), 1, "back where it started");

        type_into(&engine, &cara, "spouse", "");
        leave_field(&engine, &cara);
        assert!(relationships(&engine).is_empty());
        assert_eq!(field(&engine, &bran, "spouse"), "");
    }

    #[test]
    fn any_save_that_is_not_typing_ends_the_wait() {
        let (engine, _host, _dir) = project();
        let bran = character(&engine, "Bran");
        let cara = character(&engine, "Cara");
        type_into(&engine, &cara, "spouse", "Bran");
        assert!(relationships(&engine).is_empty());
        // Such as the app closing before the writer left the field, and the page saved later.
        set_field(&engine, &cara, "parents", "");
        assert_eq!(relationships(&engine).len(), 1);
        assert_eq!(field(&engine, &bran, "spouse"), "Cara");
    }

    #[test]
    fn a_sync_into_a_field_being_typed_in_counts_as_what_it_said() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        let cara = character(&engine, "Cara");
        type_into(&engine, &bran, "spouse", "Ca");
        // Another page names Bran meanwhile, and its sync writes Bran's field. The open
        // editor reloads and shows it, and the writer takes Aria out again as they type on.
        set_field(&engine, &aria, "spouse", "Bran");
        assert_eq!(field(&engine, &bran, "spouse"), "Ca, Aria");
        type_into(&engine, &bran, "spouse", "Cara");
        leave_field(&engine, &bran);
        assert_eq!(field(&engine, &aria, "spouse"), "", "both pages agree again");
        assert_eq!(field(&engine, &cara, "spouse"), "Bran");
        let rows = relationships(&engine);
        assert_eq!(rows.len(), 1);
        assert!(rows.iter().all(|r| r["fromPageId"] != json!(aria) && r["toPageId"] != json!(aria)));
    }

    #[test]
    fn a_field_naming_a_page_in_the_trash_links_once_it_is_restored() {
        let (engine, host, _dir) = project();
        let bran = character(&engine, "Bran");
        let cara = character(&engine, "Cara");
        call(&engine, "pages.delete", json!({ "id": bran }));
        set_field(&engine, &cara, "parents", "Bran");
        assert!(relationships(&engine).is_empty(), "a red link, as for any link to the trash");

        call(&engine, "pages.restore", json!({ "id": bran }));
        let rows = relationships(&engine);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["fromPageId"], json!(bran));
        assert_eq!(field(&engine, &bran, "children"), "Cara");
        assert_eq!(last_change(&host)["title"], "Bran", "and the writer is told");
    }

    #[test]
    fn a_name_taken_out_while_its_page_is_in_the_trash_stays_out_after_restoring() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        set_field(&engine, &aria, "spouse", "Bran");
        call(&engine, "pages.delete", json!({ "id": bran }));
        assert_eq!(field(&engine, &aria, "spouse"), "Bran", "kept as a red link while in the trash");
        let data = call(&engine, "extras.familyData", json!({}));
        let shown = data["people"].as_array().unwrap().iter().find(|p| p["title"] == "Bran").unwrap().clone();
        assert_eq!(shown["missing"], true);
        assert_eq!(shown["trashed"], true, "the tree can say where it went");

        set_field(&engine, &aria, "spouse", "");
        assert!(relationships(&engine).is_empty());
        call(&engine, "pages.restore", json!({ "id": bran }));
        assert!(relationships(&engine).is_empty(), "the fact the writer removed stays removed");
        assert_eq!(field(&engine, &bran, "spouse"), "");
        assert_eq!(field(&engine, &aria, "spouse"), "");

        // Untouched, a restored page comes back as it was.
        set_field(&engine, &aria, "spouse", "Bran");
        call(&engine, "pages.delete", json!({ "id": bran }));
        call(&engine, "pages.restore", json!({ "id": bran }));
        assert_eq!(relationships(&engine).len(), 1);
        assert_eq!(field(&engine, &aria, "spouse"), "Bran");
        assert_eq!(field(&engine, &bran, "spouse"), "Aria");
    }

    #[test]
    fn a_rename_shows_the_new_title_and_links_fields_waiting_for_it() {
        let (engine, host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        let cara = character(&engine, "Cara");
        set_field(&engine, &aria, "spouse", "Bran");
        // Written before anyone was called that.
        set_field(&engine, &cara, "parents", "Brannoc");
        assert_eq!(relationships(&engine).len(), 1);

        host.events.lock().unwrap().clear();
        call(&engine, "pages.rename", json!({ "id": bran, "newTitle": "Brannoc", "keepAlias": false }));
        assert_eq!(field(&engine, &aria, "spouse"), "Brannoc", "other pages show the new title");
        assert_eq!(relationships(&engine).len(), 2);
        assert_eq!(field(&engine, &bran, "children"), "Cara");
        assert_eq!(last_change(&host)["title"], "Brannoc");
        let replaced: Vec<String> = host
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "data://changed")
            .map(|(_, payload)| payload["entity"].as_str().unwrap().to_string())
            .collect();
        assert!(replaced.contains(&format!("doc:page:{aria}")), "open editors reload: {replaced:?}");
        assert!(replaced.contains(&format!("doc:page:{bran}")), "{replaced:?}");
    }

    #[test]
    fn relationships_keep_infoboxes_in_step() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");

        let row = call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": bran, "toPageId": aria, "kind": "child of" }),
        );
        assert_eq!(field(&engine, &aria, "children"), "Bran");
        assert_eq!(field(&engine, &bran, "parents"), "Aria");

        let spouse = call(
            &engine,
            "extras.relationshipUpdate",
            json!({ "id": row["id"], "kind": "spouse" }),
        );
        assert_eq!(field(&engine, &aria, "children"), "");
        assert_eq!(field(&engine, &bran, "parents"), "");
        assert_eq!(field(&engine, &aria, "spouse"), "Bran");
        assert_eq!(field(&engine, &bran, "spouse"), "Aria");

        call(&engine, "extras.relationshipDelete", json!({ "id": spouse["id"] }));
        assert_eq!(field(&engine, &aria, "spouse"), "");
        assert_eq!(field(&engine, &bran, "spouse"), "");
    }

    // ---- The tree -----------------------------------------------------------

    #[test]
    fn family_data_reads_relationships_and_fields_and_shows_names_without_pages() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        let gone = character(&engine, "Gone");
        call(&engine, "pages.create", json!({ "title": "Stranger", "pageType": "character" }));

        // Written straight in, as an import would, so nothing has been synced.
        engine
            .write(|tx| {
                tx.execute(
                    "UPDATE pages SET infobox = ?1 WHERE id = ?2",
                    rusqlite::params![
                        json!({ "fields": [
                            { "key": "children", "label": "Children", "kind": "pages", "value": "Bran, Nobody" },
                            { "key": "born", "label": "Born", "kind": "date", "value": "312" },
                        ]})
                        .to_string(),
                        aria
                    ],
                )?;
                Ok(())
            })
            .unwrap();
        call(
            &engine,
            "extras.relationshipAdd",
            json!({ "fromPageId": gone, "toPageId": bran, "kind": "spouse" }),
        );
        let data = call(&engine, "extras.familyData", json!({}));
        let titles: Vec<&str> = data["people"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["Aria", "Bran", "Gone", "Nobody"]);
        assert_eq!(data["people"][0]["born"], "312");
        assert_eq!(data["people"][0]["missing"], false);
        assert_eq!(data["people"][3]["missing"], true);
        let edge = |child: &Value| {
            data["parents"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["parent"] == json!(aria) && e["child"] == *child)
        };
        assert!(edge(&json!(bran)));
        assert!(edge(&data["people"][3]["id"]));
        assert_eq!(data["spouses"].as_array().unwrap().len(), 1);

        // In the trash, a page is one more name without a page: its row stays hidden, and
        // the field naming it reads as a red link, here as on the page.
        call(&engine, "pages.delete", json!({ "id": gone }));
        let data = call(&engine, "extras.familyData", json!({}));
        let shown = data["people"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["title"] == "Gone")
            .unwrap()
            .clone();
        assert_eq!(shown["missing"], true);
        assert_eq!(data["spouses"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn saying_a_parent_is_unknown_does_not_make_people_siblings() {
        let (engine, _host, _dir) = project();
        let aria = character(&engine, "Aria");
        let bran = character(&engine, "Bran");
        set_field(&engine, &aria, "parents", "Unknown, Cara");
        set_field(&engine, &bran, "parents", "unknown");
        let data = call(&engine, "extras.familyData", json!({}));
        let titles: Vec<&str> = data["people"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["Aria", "Cara"]);

        // Unless that is what a page is actually called.
        call(&engine, "pages.create", json!({ "title": "Unknown", "pageType": "character" }));
        let data = call(&engine, "extras.familyData", json!({}));
        assert_eq!(data["parents"].as_array().unwrap().len(), 3);
    }
}
