//! Short summaries of scenes, chapters, parts and books, kept up to date for the AI.
//!
//! Summaries build from the bottom up: a chapter's comes from its scenes' summaries, and a
//! book's from its chapters'. Each is stored with a hash of what it was made from, so only
//! what changed is done again, and the work picks up where it left off after a restart. The
//! model is called from the UI side. This side decides what is next and stores the results.
//!
//! Saving a summary the app made does not mark the project as changed: otherwise someone who
//! saved and paused would come back to being told they have unsaved work. It goes into the
//! file with the next save, or when the project closes.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{ok, parse, unknown};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

pub const KIND_BOOK: &str = "book";
pub const KIND_NODE: &str = "node";

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone)]
struct Stored {
    hash: String,
    summary: String,
    edited: bool,
    model: String,
    updated_at: String,
}

fn stored_map(conn: &Connection) -> AppResult<HashMap<(String, String), Stored>> {
    let mut stmt = conn.prepare(
        "SELECT entity_kind, entity_id, content_hash, summary, edited, model, updated_at FROM summaries",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
            Stored {
                hash: r.get(2)?,
                summary: r.get(3)?,
                edited: r.get::<_, i64>(4)? != 0,
                model: r.get(5)?,
                updated_at: r.get(6)?,
            },
        ))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

struct TreeNode {
    id: String,
    kind: String,
    title: String,
    local_only: bool,
    text: String,
    children: Vec<TreeNode>,
}

impl TreeNode {
    /// True if this or anything inside it is marked local only. A chapter's summary is made
    /// from its scenes' summaries, so it can carry what they say.
    fn tainted(&self) -> bool {
        self.local_only || self.children.iter().any(TreeNode::tainted)
    }

    fn count(&self) -> usize {
        1 + self.children.iter().map(TreeNode::count).sum::<usize>()
    }

    fn contains(&self, id: &str) -> bool {
        self.id == id || self.children.iter().any(|c| c.contains(id))
    }
}

struct BookTree {
    id: String,
    title: String,
    nodes: Vec<TreeNode>,
}

impl BookTree {
    fn tainted(&self) -> bool {
        self.nodes.iter().any(TreeNode::tainted)
    }
}

fn load_trees(conn: &Connection) -> AppResult<Vec<BookTree>> {
    let mut books_stmt =
        conn.prepare("SELECT id, title FROM books WHERE deleted_at IS NULL ORDER BY position, created_at")?;
    let books: Vec<(String, String)> = books_stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut nodes_stmt = conn.prepare(
        "SELECT id, parent_id, kind, title, local_only, content_text FROM nodes
         WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY position, created_at",
    )?;
    let mut out = Vec::with_capacity(books.len());
    for (id, title) in books {
        let mut by_parent: HashMap<Option<String>, Vec<TreeNode>> = HashMap::new();
        let rows = nodes_stmt.query_map([&id], |r| {
            Ok((
                r.get::<_, Option<String>>(1)?,
                TreeNode {
                    id: r.get(0)?,
                    kind: r.get(2)?,
                    title: r.get(3)?,
                    local_only: r.get::<_, i64>(4)? != 0,
                    text: r.get(5)?,
                    children: Vec::new(),
                },
            ))
        })?;
        for row in rows {
            let (parent, node) = row?;
            by_parent.entry(parent).or_default().push(node);
        }
        fn attach(parent: Option<String>, by_parent: &mut HashMap<Option<String>, Vec<TreeNode>>) -> Vec<TreeNode> {
            let mut level = by_parent.remove(&parent).unwrap_or_default();
            for node in &mut level {
                node.children = attach(Some(node.id.clone()), by_parent);
            }
            level
        }
        let nodes = attach(None, &mut by_parent);
        out.push(BookTree { id, title, nodes });
    }
    Ok(out)
}

/// What should be summarized next: the kind and id, and the text to work from.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NextWork {
    kind: String,
    id: String,
    /// `scene`, `chapter`, `part` or `book`, for the prompt.
    level: String,
    title: String,
    content_hash: String,
    input: String,
    /// How much is left, counting this one, including anything stale higher up.
    remaining: usize,
    total: usize,
}

struct Scan<'a> {
    stored: &'a HashMap<(String, String), Stored>,
    /// Scenes marked local only are not read, so that nothing from them can leave.
    include_local_only: bool,
    skip: &'a HashSet<String>,
    found: Option<NextWork>,
    remaining: usize,
    total: usize,
}

impl Scan<'_> {
    fn consider(&mut self, kind: &str, id: &str, level: &str, title: &str, input: String) {
        self.total += 1;
        if input.trim().is_empty() || self.skip.contains(id) {
            return;
        }
        let content_hash = hash(&input);
        let current = self
            .stored
            .get(&(kind.to_string(), id.to_string()))
            .is_some_and(|row| row.edited || row.hash == content_hash);
        if current {
            return;
        }
        self.remaining += 1;
        if self.found.is_none() {
            self.found = Some(NextWork {
                kind: kind.to_string(),
                id: id.to_string(),
                level: level.to_string(),
                title: title.to_string(),
                content_hash,
                input,
                remaining: 0,
                total: 0,
            });
        }
    }

    /// What is known of a child so far, for its parent's summary to be made from.
    fn summary_of(&self, kind: &str, id: &str) -> Option<&str> {
        self.stored
            .get(&(kind.to_string(), id.to_string()))
            .map(|row| row.summary.as_str())
            .filter(|text| !text.trim().is_empty())
    }

    fn visit(&mut self, node: &TreeNode) {
        if node.kind == "scene" {
            if node.local_only && !self.include_local_only {
                return;
            }
            self.consider(KIND_NODE, &node.id, "scene", &node.title, node.text.clone());
            return;
        }
        for child in &node.children {
            self.visit(child);
        }
        // Children first. A parent waits until all of them are done.
        if self.found.is_some() {
            self.total += 1;
            self.remaining += 1;
            return;
        }
        let input = self.children_text(&node.children);
        self.consider(KIND_NODE, &node.id, &node.kind, &node.title, input);
    }

    fn children_text(&self, children: &[TreeNode]) -> String {
        let mut parts = Vec::new();
        for child in children {
            if !self.include_local_only && child.tainted() {
                // A chapter holding something local only: what can still be said of it.
                let inner = self.children_text(&child.children);
                if !inner.is_empty() {
                    parts.push(inner);
                }
                continue;
            }
            if child.kind == "scene" && child.text.trim().is_empty() {
                continue;
            }
            if let Some(summary) = self.summary_of(KIND_NODE, &child.id) {
                parts.push(format!("{}: {}", child.title, summary));
            }
        }
        parts.join("\n\n")
    }
}

fn next_work(conn: &Connection, include_local_only: bool, skip: &HashSet<String>) -> AppResult<Option<NextWork>> {
    let stored = stored_map(conn)?;
    let trees = load_trees(conn)?;
    let mut scan = Scan { stored: &stored, include_local_only, skip, found: None, remaining: 0, total: 0 };
    for book in &trees {
        for node in &book.nodes {
            scan.visit(node);
        }
        if scan.found.is_some() {
            scan.total += 1;
            scan.remaining += 1;
            continue;
        }
        let input = scan.children_text(&book.nodes);
        scan.consider(KIND_BOOK, &book.id, "book", &book.title, input);
    }
    let (remaining, total) = (scan.remaining, scan.total);
    Ok(scan.found.map(|mut work| {
        work.remaining = remaining;
        work.total = total;
        work
    }))
}

// ---------------------------------------------------------------------------
// The story so far
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoryEntry {
    kind: String,
    id: String,
    level: String,
    title: String,
    summary: String,
    /// The text changed since this was written, and it has not been redone yet.
    stale: bool,
    edited: bool,
    /// It is marked local only, or was made from something that is.
    local_only: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Withheld {
    kind: String,
    id: String,
    title: String,
}

#[derive(Default)]
struct Story {
    entries: Vec<StoryEntry>,
    withheld: Vec<Withheld>,
    missing: usize,
}

struct StoryWalk<'a> {
    stored: &'a HashMap<(String, String), Stored>,
    include_local_only: bool,
    /// Reading position of each node across the whole series.
    index: &'a HashMap<String, usize>,
    /// The first position that may not be used.
    end: usize,
    out: Story,
}

impl StoryWalk<'_> {
    fn entry(&self, kind: &str, id: &str, level: &str, title: &str, stale: bool, local_only: bool) -> Option<StoryEntry> {
        let row = self.stored.get(&(kind.to_string(), id.to_string()))?;
        if row.summary.trim().is_empty() {
            return None;
        }
        Some(StoryEntry {
            kind: kind.to_string(),
            id: id.to_string(),
            level: level.to_string(),
            title: title.to_string(),
            summary: row.summary.clone(),
            stale,
            edited: row.edited,
            local_only,
        })
    }

    fn last_of(&self, node: &TreeNode) -> usize {
        let own = self.index.get(&node.id).copied().unwrap_or(0);
        node.children.iter().map(|c| self.last_of(c)).max().unwrap_or(own).max(own)
    }

    fn walk(&mut self, nodes: &[TreeNode]) {
        for node in nodes {
            let start = self.index.get(&node.id).copied().unwrap_or(usize::MAX);
            if start >= self.end {
                return;
            }
            if self.last_of(node) < self.end {
                self.whole(node);
            } else {
                // The point falls inside this one, so only what comes before it is used.
                self.walk(&node.children);
            }
        }
    }

    /// One finished thing, at the highest level there is a summary for.
    fn whole(&mut self, node: &TreeNode) {
        let blocked = !self.include_local_only && node.tainted();
        if node.kind == "scene" {
            if node.text.trim().is_empty() {
                return;
            }
            if blocked {
                self.out.withheld.push(Withheld { kind: KIND_NODE.into(), id: node.id.clone(), title: node.title.clone() });
                return;
            }
            let stale = self
                .stored
                .get(&(KIND_NODE.to_string(), node.id.clone()))
                .is_some_and(|row| row.hash != hash(&node.text));
            match self.entry(KIND_NODE, &node.id, "scene", &node.title, stale, node.local_only) {
                Some(entry) => self.out.entries.push(entry),
                None => self.out.missing += 1,
            }
            return;
        }
        if !blocked {
            if let Some(entry) = self.entry(KIND_NODE, &node.id, &node.kind, &node.title, false, node.tainted()) {
                self.out.entries.push(entry);
                return;
            }
        }
        let children: &[TreeNode] = &node.children;
        for child in children {
            self.whole(child);
        }
    }
}

fn number(nodes: &[TreeNode], next: &mut usize, index: &mut HashMap<String, usize>) {
    for node in nodes {
        index.insert(node.id.clone(), *next);
        *next += 1;
        number(&node.children, next, index);
    }
}

fn last_position(node: &TreeNode, index: &HashMap<String, usize>) -> usize {
    let own = index.get(&node.id).copied().unwrap_or(0);
    node.children.iter().map(|c| last_position(c, index)).max().unwrap_or(own).max(own)
}

/// Rough, the same as the UI's: about four characters to a token.
fn tokens_of(text: &str) -> usize {
    text.len().div_ceil(4)
}

fn story_text(entries: &[StoryEntry]) -> String {
    entries
        .iter()
        .map(|e| format!("{} ({}): {}", e.title, e.level, e.summary))
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StoryParams {
    book_id: Option<String>,
    /// The story up to, and not including, this node. Absent means the whole book.
    node_id: Option<String>,
    /// A spoiler limit: nothing past the end of this node is used.
    as_of_node_id: Option<String>,
    /// Off unless asked for, since the reader may be a cloud model.
    include_local_only: bool,
    max_tokens: Option<usize>,
}

fn story_so_far(conn: &Connection, p: StoryParams) -> AppResult<Value> {
    let stored = stored_map(conn)?;
    let trees = load_trees(conn)?;
    let mut index = HashMap::new();
    let mut next = 0;
    for book in &trees {
        number(&book.nodes, &mut next, &mut index);
    }

    let book_end = |book: &BookTree, fallback: usize| -> usize {
        book.nodes.iter().map(|n| last_position(n, &index) + 1).max().unwrap_or(fallback)
    };
    let mut end = next;
    if let Some(id) = p.node_id.as_deref() {
        end = *index.get(id).ok_or_else(|| AppError::not_found("That item"))?;
    } else if let Some(id) = p.book_id.as_deref() {
        let mut fallback = 0;
        let mut found = false;
        for book in &trees {
            if book.id == id {
                end = book_end(book, fallback);
                found = true;
                break;
            }
            fallback = book_end(book, fallback);
        }
        if !found {
            return Err(AppError::not_found("That book"));
        }
    }
    if let Some(id) = p.as_of_node_id.as_deref() {
        let limit = trees
            .iter()
            .flat_map(|book| book.nodes.iter())
            .find_map(|node| find_end(node, id, &index));
        if let Some(limit) = limit {
            end = end.min(limit);
        }
    }

    let mut walk = StoryWalk { stored: &stored, include_local_only: p.include_local_only, index: &index, end, out: Story::default() };
    for book in &trees {
        let first = book.nodes.iter().filter_map(|n| index.get(&n.id)).min().copied();
        let Some(first) = first else { continue };
        if first >= end {
            break;
        }
        let finished = book_end(book, 0) <= end;
        let usable = finished && (p.include_local_only || !book.tainted());
        if usable {
            if let Some(entry) = walk.entry(KIND_BOOK, &book.id, "book", &book.title, false, book.tainted()) {
                walk.out.entries.push(entry);
                continue;
            }
        }
        if finished {
            for node in &book.nodes {
                walk.whole(node);
            }
        } else {
            walk.walk(&book.nodes);
        }
    }

    let Story { mut entries, withheld, missing } = walk.out;
    // Over budget, the oldest goes first: what just happened matters most.
    let mut omitted = 0;
    if let Some(max) = p.max_tokens {
        while entries.len() > 1 && tokens_of(&story_text(&entries)) > max {
            entries.remove(0);
            omitted += 1;
        }
        if entries.len() == 1 && tokens_of(&entries[0].summary) > max {
            entries.clear();
            omitted += 1;
        }
    }
    Ok(json!({
        "text": story_text(&entries),
        "holdsLocalOnly": entries.iter().any(|e| e.local_only),
        "entries": entries,
        "withheld": withheld,
        "missing": missing,
        "omitted": omitted,
    }))
}

/// The position just past the end of the node with this id, if it is in here.
fn find_end(node: &TreeNode, id: &str, index: &HashMap<String, usize>) -> Option<usize> {
    if node.id == id {
        return Some(last_position(node, index) + 1);
    }
    if node.contains(id) {
        return node.children.iter().find_map(|c| find_end(c, id, index));
    }
    None
}

// ---------------------------------------------------------------------------
// Listing, for the writer to read and edit
// ---------------------------------------------------------------------------

fn list_book(conn: &Connection, book_id: &str) -> AppResult<Value> {
    let stored = stored_map(conn)?;
    let trees = load_trees(conn)?;
    let book = trees.iter().find(|b| b.id == book_id).ok_or_else(|| AppError::not_found("That book"))?;
    fn row_json(kind: &str, id: &str, level: &str, title: &str, depth: usize, local_only: bool, row: Option<&Stored>, stale: bool, empty: bool) -> Value {
        json!({
            "kind": kind,
            "id": id,
            "level": level,
            "title": title,
            "depth": depth,
            "localOnly": local_only,
            "summary": row.map(|r| r.summary.as_str()).unwrap_or(""),
            "edited": row.is_some_and(|r| r.edited),
            "model": row.map(|r| r.model.as_str()).unwrap_or(""),
            "updatedAt": row.map(|r| r.updated_at.as_str()).unwrap_or(""),
            "stale": stale,
            "empty": empty,
        })
    }
    fn add(out: &mut Vec<Value>, nodes: &[TreeNode], depth: usize, stored: &HashMap<(String, String), Stored>) {
        for node in nodes {
            let row = stored.get(&(KIND_NODE.to_string(), node.id.clone()));
            let is_scene = node.kind == "scene";
            let stale = is_scene && row.is_some_and(|r| r.hash != hash(&node.text));
            let empty = is_scene && node.text.trim().is_empty();
            out.push(row_json(KIND_NODE, &node.id, &node.kind, &node.title, depth, node.tainted(), row, stale, empty));
            add(out, &node.children, depth + 1, stored);
        }
    }
    let mut out = Vec::with_capacity(book.nodes.iter().map(TreeNode::count).sum::<usize>() + 1);
    let row = stored.get(&(KIND_BOOK.to_string(), book.id.clone()));
    out.push(row_json(KIND_BOOK, &book.id, "book", &book.title, 0, book.tainted(), row, false, false));
    add(&mut out, &book.nodes, 1, &stored);
    Ok(Value::Array(out))
}

fn check_kind(kind: &str) -> AppResult<()> {
    if kind == KIND_BOOK || kind == KIND_NODE {
        Ok(())
    } else {
        Err(AppError::invalid(format!("Unknown kind: {kind}")))
    }
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        // What to do next, or null if everything is up to date.
        "next" => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct P {
                include_local_only: bool,
                skip: Vec<String>,
            }
            let p: P = parse(params)?;
            let skip: HashSet<String> = p.skip.into_iter().collect();
            ok(engine.read(|c| next_work(c, p.include_local_only, &skip))?)
        }
        // A summary the app made. An edited one stays, whatever this says.
        "save" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                kind: String,
                id: String,
                content_hash: String,
                summary: String,
                #[serde(default)]
                model: String,
            }
            let p: P = parse(params)?;
            check_kind(&p.kind)?;
            let saved = engine.read(|c| {
                let edited: Option<i64> = c
                    .query_row(
                        "SELECT edited FROM summaries WHERE entity_kind = ?1 AND entity_id = ?2",
                        params![p.kind, p.id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if edited.unwrap_or(0) != 0 {
                    return Ok(false);
                }
                c.execute(
                    "INSERT OR REPLACE INTO summaries (entity_kind, entity_id, content_hash, summary, edited, model, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
                    params![p.kind, p.id, p.content_hash, p.summary, p.model, db::now()],
                )?;
                Ok(true)
            })?;
            if let Some(session) = engine.session().as_mut() {
                session.quiet_changes = true;
            }
            engine.notify("summaries");
            ok(saved)
        }
        // The writer's own words. These stay until the writer asks for a new one.
        "edit" => {
            #[derive(Deserialize)]
            struct P {
                kind: String,
                id: String,
                summary: String,
            }
            let p: P = parse(params)?;
            check_kind(&p.kind)?;
            engine.write(|tx| {
                tx.execute(
                    "INSERT INTO summaries (entity_kind, entity_id, content_hash, summary, edited, model, updated_at)
                     VALUES (?1, ?2, '', ?3, 1, '', ?4)
                     ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
                       summary = excluded.summary, edited = 1, updated_at = excluded.updated_at",
                    params![p.kind, p.id, p.summary, db::now()],
                )?;
                Ok(())
            })?;
            engine.notify("summaries");
            ok(true)
        }
        // Forgets one, edited or not, so that it gets made again.
        "regenerate" => {
            #[derive(Deserialize)]
            struct P {
                kind: String,
                id: String,
            }
            let p: P = parse(params)?;
            check_kind(&p.kind)?;
            engine.write(|tx| {
                tx.execute(
                    "DELETE FROM summaries WHERE entity_kind = ?1 AND entity_id = ?2",
                    params![p.kind, p.id],
                )?;
                Ok(())
            })?;
            engine.notify("summaries");
            ok(true)
        }
        "list" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                book_id: String,
            }
            let p: P = parse(params)?;
            engine.read(|c| list_book(c, &p.book_id))
        }
        "storySoFar" => {
            let p: StoryParams = parse(params)?;
            engine.read(|c| story_so_far(c, p))
        }
        _ => Err(unknown(&format!("summaries.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::engine::Engine;
    use crate::rpc::call;

    fn doc(text: &str) -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }] })
    }

    /// One book: chapter A with scenes 1 and 2, chapter B with scene 3.
    fn project() -> (std::sync::Arc<Engine>, String, [String; 2], [String; 3], crate::engine::TestDir) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "S" }));
        let book = call(&engine, "books.list", json!({}))[0]["id"].as_str().unwrap().to_string();
        for node in call(&engine, "nodes.tree", json!({ "bookId": book })).as_array().unwrap() {
            call(&engine, "nodes.delete", json!({ "id": node["id"] }));
        }
        let add = |parent: Option<&str>, kind: &str, title: &str| -> String {
            call(&engine, "nodes.create", json!({ "bookId": book, "parentId": parent, "kind": kind, "title": title }))["id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let a = add(None, "chapter", "Chapter A");
        let s1 = add(Some(&a), "scene", "One");
        let s2 = add(Some(&a), "scene", "Two");
        let b = add(None, "chapter", "Chapter B");
        let s3 = add(Some(&b), "scene", "Three");
        for (id, text) in [(&s1, "Aria arrives."), (&s2, "Aria leaves."), (&s3, "Bram returns.")] {
            call(&engine, "nodes.update", json!({ "id": id, "patch": { "content": doc(text) } }));
        }
        (engine, book, [a, b], [s1, s2, s3], dir)
    }

    /// Does what the background worker does, with a made-up model.
    fn run_all(engine: &Engine, include_local_only: bool) -> Vec<String> {
        let mut done = Vec::new();
        loop {
            let next = call(engine, "summaries.next", json!({ "includeLocalOnly": include_local_only }));
            if next.is_null() {
                return done;
            }
            done.push(next["title"].as_str().unwrap().to_string());
            assert!(done.len() < 30, "it keeps coming back: {done:?}");
            let summary = format!("Summary of {}", next["title"].as_str().unwrap());
            let saved = call(engine, "summaries.save", json!({
                "kind": next["kind"], "id": next["id"], "contentHash": next["contentHash"], "summary": summary, "model": "m",
            }));
            assert_eq!(saved, true);
        }
    }

    #[test]
    fn builds_from_the_bottom_up_and_only_redoes_what_changed() {
        let (engine, _book, _chapters, scenes, _dir) = project();
        let first = call(&engine, "summaries.next", json!({ "includeLocalOnly": true }));
        assert_eq!(first["title"], "One");
        assert_eq!(first["input"], "Aria arrives.");
        assert_eq!(first["total"], 6, "three scenes, two chapters, a book");
        assert_eq!(first["remaining"], 6);
        assert_eq!(run_all(&engine, true), ["One", "Two", "Chapter A", "Three", "Chapter B", "Book One"]);
        assert!(call(&engine, "summaries.next", json!({ "includeLocalOnly": true })).is_null());

        // A change to one scene redoes it and what is above it, and nothing else.
        call(&engine, "nodes.update", json!({ "id": scenes[1], "patch": { "content": doc("Aria stays.") } }));
        // Its summary comes out the same here, so the parents have nothing new to work from.
        assert_eq!(run_all(&engine, true), ["Two"]);
        // A real change in what it says goes all the way up.
        call(&engine, "nodes.update", json!({ "id": scenes[1], "patch": { "content": doc("Aria stays longer.") } }));
        let next = call(&engine, "summaries.next", json!({ "includeLocalOnly": true }));
        call(&engine, "summaries.save", json!({ "kind": next["kind"], "id": next["id"], "contentHash": next["contentHash"], "summary": "Different now." }));
        // The chapter's made-up summary comes out the same again, so the book stays.
        assert_eq!(run_all(&engine, true), ["Chapter A"]);
    }

    #[test]
    fn saving_a_made_summary_does_not_mark_the_project_changed() {
        let (engine, _book, _chapters, _scenes, _dir) = project();
        engine.session().as_mut().unwrap().set_dirty(false).unwrap();
        run_all(&engine, true);
        assert!(!engine.status().dirty);
    }

    #[test]
    fn made_summaries_reach_the_file_on_closing_so_the_work_is_not_repeated() {
        let (engine, _book, _chapters, scenes, dir) = project();
        let path = dir.0.join("story.lorecraft");
        engine.allow_path(&path);
        call(&engine, "project.saveAs", json!({ "path": path }));
        run_all(&engine, true);
        assert!(!engine.status().dirty, "nobody is told they have unsaved work");
        call(&engine, "project.close", json!({}));

        call(&engine, "project.open", json!({ "path": path }));
        assert!(call(&engine, "summaries.next", json!({ "includeLocalOnly": true })).is_null(), "nothing is left to do");
        let story = call(&engine, "summaries.storySoFar", json!({ "nodeId": scenes[1], "includeLocalOnly": true }));
        assert_eq!(story["entries"][0]["summary"], "Summary of One");
    }

    #[test]
    fn summaries_never_change_the_file_without_a_save() {
        let (engine, _book, _chapters, _scenes, dir) = project();
        let path = dir.0.join("story.lorecraft");
        engine.allow_path(&path);
        call(&engine, "project.saveAs", json!({ "path": path }));
        let saved = std::fs::read(&path).unwrap();

        // Made and closed with no save: the file is exactly as it was, and nothing is lost.
        run_all(&engine, true);
        call(&engine, "project.close", json!({}));
        assert_eq!(std::fs::read(&path).unwrap(), saved);
        call(&engine, "project.open", json!({ "path": path }));
        assert!(!engine.status().dirty, "bringing them back is not an edit");
        assert!(call(&engine, "summaries.next", json!({ "includeLocalOnly": true })).is_null());
        call(&engine, "project.close", json!({}));
        assert_eq!(std::fs::read(&path).unwrap(), saved);

        // A real save puts them in the file, and they need nothing beside it after that.
        call(&engine, "project.open", json!({ "path": path }));
        call(&engine, "project.save", json!({}));
        assert_ne!(std::fs::read(&path).unwrap(), saved);
        let pending = dir.0.join("pending-summaries");
        assert_eq!(std::fs::read_dir(&pending).unwrap().count(), 0);
        call(&engine, "project.close", json!({}));
        call(&engine, "project.open", json!({ "path": path }));
        assert!(call(&engine, "summaries.next", json!({ "includeLocalOnly": true })).is_null());
    }

    #[test]
    fn picks_up_where_it_left_off_after_closing_partway() {
        let (engine, _book, _chapters, _scenes, dir) = project();
        let path = dir.0.join("story.lorecraft");
        engine.allow_path(&path);
        call(&engine, "project.saveAs", json!({ "path": path }));
        let next = call(&engine, "summaries.next", json!({ "includeLocalOnly": true }));
        call(&engine, "summaries.save", json!({ "kind": next["kind"], "id": next["id"], "contentHash": next["contentHash"], "summary": "Done." }));
        call(&engine, "project.close", json!({}));

        call(&engine, "project.open", json!({ "path": path }));
        assert_eq!(run_all(&engine, true), ["Two", "Chapter A", "Three", "Chapter B", "Book One"]);
    }

    #[test]
    fn discarding_changes_does_not_store_summaries_over_the_file() {
        let (engine, _book, _chapters, scenes, dir) = project();
        let path = dir.0.join("story.lorecraft");
        engine.allow_path(&path);
        call(&engine, "project.saveAs", json!({ "path": path }));
        run_all(&engine, true);
        // An edit the writer then throws away must not reach the file by this route.
        call(&engine, "nodes.update", json!({ "id": scenes[0], "patch": { "content": doc("A change they discard.") } }));
        call(&engine, "project.close", json!({}));
        call(&engine, "project.open", json!({ "path": path }));
        let text = call(&engine, "nodes.get", json!({ "id": scenes[0] }))["content"].to_string();
        assert!(text.contains("Aria arrives"), "{text}");
    }

    #[test]
    fn an_edited_summary_stays_until_the_writer_asks() {
        let (engine, _book, _chapters, scenes, _dir) = project();
        run_all(&engine, true);
        call(&engine, "summaries.edit", json!({ "kind": "node", "id": scenes[0], "summary": "My words." }));
        call(&engine, "nodes.update", json!({ "id": scenes[0], "patch": { "content": doc("Something else entirely.") } }));

        // Its parent is redone from the writer's words. It is not.
        assert_eq!(run_all(&engine, true), ["Chapter A"]);
        let refused = call(&engine, "summaries.save", json!({ "kind": "node", "id": scenes[0], "contentHash": "x", "summary": "Overwrite" }));
        assert_eq!(refused, false);
        let story = call(&engine, "summaries.storySoFar", json!({ "nodeId": scenes[1], "includeLocalOnly": true }));
        assert_eq!(story["entries"][0]["summary"], "My words.");
        assert_eq!(story["entries"][0]["edited"], true);

        // Asked for, it is made again.
        call(&engine, "summaries.regenerate", json!({ "kind": "node", "id": scenes[0] }));
        assert_eq!(run_all(&engine, true)[0], "One");
    }

    #[test]
    fn the_story_so_far_stops_at_the_point_and_uses_the_highest_level() {
        let (engine, book, chapters, scenes, _dir) = project();
        run_all(&engine, true);
        let titles = |params: Value| -> Vec<String> {
            call(&engine, "summaries.storySoFar", params)["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["title"].as_str().unwrap().to_string())
                .collect()
        };
        let all = json!({ "bookId": book, "includeLocalOnly": true });
        assert_eq!(titles(all), ["Book One"], "a whole book is its own summary");
        let at_first = json!({ "bookId": book, "nodeId": scenes[0], "includeLocalOnly": true });
        assert!(titles(at_first).is_empty(), "nothing comes before the first scene");
        let at_second = json!({ "bookId": book, "nodeId": scenes[1], "includeLocalOnly": true });
        assert_eq!(titles(at_second), ["One"]);
        let at_third = json!({ "bookId": book, "nodeId": scenes[2], "includeLocalOnly": true });
        assert_eq!(titles(at_third), ["Chapter A"], "a finished chapter stands for its scenes");

        // A spoiler limit can only make it shorter.
        let limited = json!({ "bookId": book, "nodeId": scenes[2], "asOfNodeId": scenes[0], "includeLocalOnly": true });
        assert_eq!(titles(limited), ["One"]);
        let whole_chapter = json!({ "bookId": book, "asOfNodeId": chapters[0], "includeLocalOnly": true });
        assert_eq!(titles(whole_chapter), ["Chapter A"]);
    }

    #[test]
    fn the_budget_keeps_what_is_most_recent() {
        let (engine, _book, _chapters, scenes, _dir) = project();
        run_all(&engine, true);
        let story = call(&engine, "summaries.storySoFar", json!({ "nodeId": scenes[2], "includeLocalOnly": true, "maxTokens": 1 }));
        assert_eq!(story["entries"].as_array().unwrap().len(), 0);
        assert_eq!(story["omitted"], 1);
    }

    #[test]
    fn local_only_scenes_do_not_reach_a_cloud_reader_by_any_route() {
        let (engine, book, chapters, scenes, _dir) = project();
        run_all(&engine, true);
        call(&engine, "nodes.update", json!({ "id": scenes[0], "patch": { "localOnly": true } }));
        assert_eq!(call(&engine, "nodes.get", json!({ "id": scenes[0] }))["localOnly"], true);

        // The story: not the scene, nor the chapter and book made from it.
        let story = call(&engine, "summaries.storySoFar", json!({ "bookId": book }));
        let titles: Vec<&str> = story["entries"].as_array().unwrap().iter().map(|e| e["title"].as_str().unwrap()).collect();
        assert_eq!(titles, ["Two", "Chapter B"], "{story}");
        assert_eq!(story["withheld"][0]["title"], "One");
        assert!(!story["text"].as_str().unwrap().contains("Summary of One"));
        assert!(!story["text"].as_str().unwrap().contains("Summary of Chapter A"));

        // For a local reader, everything.
        let local = call(&engine, "summaries.storySoFar", json!({ "bookId": book, "includeLocalOnly": true }));
        assert_eq!(local["entries"][0]["title"], "Book One");
        assert_eq!(local["holdsLocalOnly"], true);
        assert_eq!(story["holdsLocalOnly"], false);

        // The worker, on a cloud profile: never offered the scene, and its parent's text
        // for the model holds only the other scene.
        call(&engine, "summaries.regenerate", json!({ "kind": "node", "id": chapters[0] }));
        let next = call(&engine, "summaries.next", json!({ "includeLocalOnly": false }));
        assert_eq!(next["title"], "Chapter A");
        assert_eq!(next["input"], "Two: Summary of Two");
    }

    #[test]
    fn a_skipped_item_does_not_stop_the_rest() {
        let (engine, _book, _chapters, scenes, _dir) = project();
        let next = call(&engine, "summaries.next", json!({ "includeLocalOnly": true, "skip": [scenes[0]] }));
        assert_eq!(next["title"], "Two");
    }

    #[test]
    fn snapshot_and_pages_carry_the_flag() {
        let (engine, _book, _chapters, scenes, _dir) = project();
        let home = call(&engine, "pages.home", json!({}));
        assert_eq!(home["localOnly"], false);
        call(&engine, "pages.update", json!({ "id": home["id"], "patch": { "localOnly": true } }));
        call(&engine, "nodes.update", json!({ "id": scenes[2], "patch": { "localOnly": true } }));
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["pages"][0]["localOnly"], true);
        let flagged: Vec<&Value> = snap["nodes"].as_array().unwrap().iter().filter(|n| n["localOnly"] == true).collect();
        assert_eq!(flagged.len(), 1);
        assert_eq!(flagged[0]["id"], scenes[2].as_str());
    }

    #[test]
    fn list_shows_every_level_for_the_writer() {
        let (engine, book, _chapters, scenes, _dir) = project();
        run_all(&engine, true);
        call(&engine, "nodes.update", json!({ "id": scenes[0], "patch": { "content": doc("Changed.") } }));
        let list = call(&engine, "summaries.list", json!({ "bookId": book }));
        let rows = list.as_array().unwrap();
        assert_eq!(rows.len(), 6);
        assert_eq!(rows[0]["level"], "book");
        assert_eq!(rows[2]["title"], "One");
        assert_eq!(rows[2]["stale"], true);
        assert_eq!(rows[2]["summary"], "Summary of One");
    }
}
