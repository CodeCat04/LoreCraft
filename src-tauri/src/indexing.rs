//! Keeps links, mentions and the search index in step with content. Page and node
//! writes both call `sync_entity`, inside their own transaction.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use aho_corasick::{AhoCorasick, MatchKind};
use rusqlite::{params, Connection, OptionalExtension};

use crate::content::{is_unspaced_script, Extracted};
use crate::error::AppResult;

pub const KIND_PAGE: &str = "page";
pub const KIND_NODE: &str = "node";

thread_local! {
    static MENTIONS_DEFERRED: Cell<bool> = const { Cell::new(false) };
}

/// Runs a bulk write. Keeping mentions current after each page costs a scan of the
/// whole project, which a large import would repeat thousands of times, so inside `f`
/// they are left alone and then rebuilt once. Links and search stay current throughout.
pub fn defer_mentions<T>(conn: &Connection, f: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    struct Resume;
    impl Drop for Resume {
        fn drop(&mut self) {
            MENTIONS_DEFERRED.with(|d| d.set(false));
        }
    }
    MENTIONS_DEFERRED.with(|d| d.set(true));
    let value = {
        let _resume = Resume;
        f()?
    };
    rebuild_mentions(conn)?;
    Ok(value)
}

fn mentions_deferred() -> bool {
    MENTIONS_DEFERRED.with(Cell::get)
}

/// Finds page names in text. Names match exactly as written, so a page called
/// "Will" does not fire on the word "will". Must match `NameMatcher` in
/// `src/write/nameMatcher.ts`.
#[derive(Clone)]
pub struct MentionMatcher {
    automaton: Option<Arc<AhoCorasick>>,
    page_ids: Arc<Vec<String>>,
}

/// The last matcher built, with the file it was built for and that file's `names_stamp`.
/// Building one reads every title, so a write that changes no names reuses it.
type CachedMatcher = (String, String, MentionMatcher);
static MATCHER_CACHE: Mutex<Option<CachedMatcher>> = Mutex::new(None);

/// What identifies the names in `conn`: its file and the stamp the triggers in
/// `002_index_keys.sql` change with every title or alias. None for a database in memory.
fn names_key(conn: &Connection) -> AppResult<Option<(String, String)>> {
    let Some(path) = conn.path().filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let stamp: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'names_stamp'", [], |r| r.get(0))
        .optional()?;
    Ok(stamp.map(|stamp| (path.to_string(), stamp)))
}

const MIN_NAME_CHARS: usize = 3;
/// Chinese, Japanese and Korean names are often this short.
const MIN_UNSPACED_NAME_CHARS: usize = 2;

fn is_usable_name(name: &str) -> bool {
    let chars = name.chars().count();
    chars >= MIN_NAME_CHARS
        || (chars >= MIN_UNSPACED_NAME_CHARS && name.chars().any(is_unspaced_script))
}

/// Whether a name can end here. `inner` is the name's own character at this edge, and
/// `outer` the one beyond it. Latin and similar scripts need a word boundary, and the
/// neighbouring character of a script without spaces is one. A name in such a script needs
/// no boundary at all, since a sentence has none to offer.
fn is_name_edge(inner: Option<char>, outer: Option<char>) -> bool {
    inner.is_some_and(is_unspaced_script)
        || !outer.is_some_and(|c| c.is_alphanumeric() && !is_unspaced_script(c))
}

impl MentionMatcher {
    pub fn build(conn: &Connection) -> AppResult<Self> {
        // Nothing uses it during a bulk write, and reading every name is the cost avoided.
        if mentions_deferred() {
            return Ok(Self::empty());
        }
        let key = names_key(conn)?;
        if let Some((path, stamp)) = &key {
            let cache = MATCHER_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((p, st, matcher)) = cache.as_ref() {
                if p == path && st == stamp {
                    return Ok(matcher.clone());
                }
            }
        }
        let matcher = Self::read(conn)?;
        if let Some((path, stamp)) = key {
            *MATCHER_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((path, stamp, matcher.clone()));
        }
        Ok(matcher)
    }

    fn empty() -> Self {
        Self {
            automaton: None,
            page_ids: Arc::new(Vec::new()),
        }
    }

    fn read(conn: &Connection) -> AppResult<Self> {
        let mut names: Vec<(String, String)> = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT id, title FROM pages WHERE deleted_at IS NULL
             UNION ALL
             SELECT a.page_id, a.alias FROM page_aliases a
               JOIN pages p ON p.id = a.page_id WHERE p.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, name) = row?;
            if is_usable_name(&name) {
                names.push((id, name));
            }
        }
        if names.is_empty() {
            return Ok(Self::empty());
        }
        let automaton = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(names.iter().map(|(_, name)| name.as_str()))
            .map_err(|e| crate::error::AppError::internal(e.to_string()))?;
        Ok(Self {
            automaton: Some(Arc::new(automaton)),
            page_ids: Arc::new(names.into_iter().map(|(id, _)| id).collect()),
        })
    }

    /// page id -> number of occurrences in `text`, as whole words where the script has them.
    pub fn count(&self, text: &str) -> HashMap<String, i64> {
        let mut counts = HashMap::new();
        let Some(automaton) = &self.automaton else {
            return counts;
        };
        for m in automaton.find_iter(text) {
            let name = &text[m.start()..m.end()];
            let before = text[..m.start()].chars().next_back();
            let after = text[m.end()..].chars().next();
            if is_name_edge(name.chars().next(), before)
                && is_name_edge(name.chars().next_back(), after)
            {
                *counts
                    .entry(self.page_ids[m.pattern().as_usize()].clone())
                    .or_insert(0) += 1;
            }
        }
        counts
    }
}

/// Rewrites the derived rows for one page or node.
pub fn sync_entity(
    conn: &Connection,
    kind: &str,
    id: &str,
    title: &str,
    extracted: &Extracted,
) -> AppResult<()> {
    let matcher = MentionMatcher::build(conn)?;
    sync_with(conn, &matcher, kind, id, title, extracted, &extracted.text)
}

/// `sync_entity` with a matcher the caller already built, for bulk changes where the
/// set of names stays the same, and a search body that can hold more than the text.
pub fn sync_with(
    conn: &Connection,
    matcher: &MentionMatcher,
    kind: &str,
    id: &str,
    title: &str,
    extracted: &Extracted,
    search_body: &str,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM links WHERE source_kind = ?1 AND source_id = ?2",
        params![kind, id],
    )?;
    let mut insert = conn.prepare_cached(
        "INSERT OR REPLACE INTO links (source_kind, source_id, target_key, target_title)
         VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (key, target) in &extracted.links {
        insert.execute(params![kind, id, key, target])?;
    }
    drop(insert);

    // Text can move between documents, as when a scene is split, and its comments go too.
    crate::rpc::comments::follow_text(conn, kind, id, &extracted.comments)?;

    if !mentions_deferred() {
        write_mentions(conn, matcher, kind, id, &extracted.text)?;
    }
    write_search(conn, kind, id, title, search_body)
}

fn write_mentions(
    conn: &Connection,
    matcher: &MentionMatcher,
    kind: &str,
    id: &str,
    text: &str,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM mentions WHERE source_kind = ?1 AND source_id = ?2",
        params![kind, id],
    )?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO mentions (source_kind, source_id, page_id, count) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (page_id, count) in matcher.count(text) {
        // A page naming itself is not a useful backlink.
        if kind == KIND_PAGE && page_id == id {
            continue;
        }
        insert.execute(params![kind, id, page_id, count])?;
    }
    Ok(())
}

/// Goes between characters in the search index. FTS5 reads a run of Chinese as one token,
/// which only a search for the whole run could find. With this around each character, every
/// character is a token and a search is a phrase of them, which finds a word anywhere in a
/// sentence. `search_display_text` keeps it out of what people see.
const SEARCH_BREAK: char = '\u{1F}';

/// Hebrew points, Arabic vowel marks and the Arabic stretching mark. Most text is written
/// without them, so a search without them must still find text that has them, and FTS5 would
/// otherwise end a token at each one.
fn is_left_out_of_search(c: char) -> bool {
    matches!(c as u32,
        0x0591..=0x05BD
        | 0x05BF
        | 0x05C1..=0x05C2
        | 0x05C4..=0x05C5
        | 0x05C7
        | 0x0610..=0x061A
        | 0x0640
        | 0x064B..=0x065F
        | 0x0670
        | 0x06D6..=0x06DC
        | 0x06DF..=0x06E4
        | 0x06E7..=0x06E8
        | 0x06EA..=0x06ED)
}

/// A text as the search index and search queries hold it.
pub fn search_index_text(text: &str) -> Cow<'_, str> {
    if !text.chars().any(|c| is_unspaced_script(c) || is_left_out_of_search(c)) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + text.len() / 2);
    let mut previous_unspaced = false;
    for c in text.chars() {
        if is_left_out_of_search(c) {
            continue;
        }
        let unspaced = is_unspaced_script(c);
        if (unspaced || previous_unspaced) && !out.is_empty() {
            out.push(SEARCH_BREAK);
        }
        out.push(c);
        previous_unspaced = unspaced;
    }
    Cow::Owned(out)
}

/// Text from the search index as it was written, so it reads properly in a result.
pub fn search_display_text(text: &str) -> String {
    text.replace(SEARCH_BREAK, "")
}

pub fn write_search(
    conn: &Connection,
    kind: &str,
    id: &str,
    title: &str,
    body: &str,
) -> AppResult<()> {
    remove_search(conn, kind, id)?;
    conn.prepare_cached(
        "INSERT INTO search_fts (entity_kind, entity_id, title, body) VALUES (?1, ?2, ?3, ?4)",
    )?
    .execute(params![
        kind,
        id,
        search_index_text(title).as_ref(),
        search_index_text(body).as_ref()
    ])?;
    conn.prepare_cached(
        "INSERT OR REPLACE INTO search_fts_keys (entity_kind, entity_id, fts_rowid)
         VALUES (?1, ?2, ?3)",
    )?
    .execute(params![kind, id, conn.last_insert_rowid()])?;
    Ok(())
}

/// Removes the search row of one page or node. `search_fts_keys` says which row it is, so
/// this does not scan the index, whose kind and id columns have no index of their own.
pub fn remove_search(conn: &Connection, kind: &str, id: &str) -> AppResult<()> {
    let row: Option<i64> = conn
        .prepare_cached(
            "SELECT fts_rowid FROM search_fts_keys WHERE entity_kind = ?1 AND entity_id = ?2",
        )?
        .query_row(params![kind, id], |r| r.get(0))
        .optional()?;
    let Some(row) = row else {
        return Ok(());
    };
    let removed = conn
        .prepare_cached(
            "DELETE FROM search_fts WHERE rowid = ?1 AND entity_kind = ?2 AND entity_id = ?3",
        )?
        .execute(params![row, kind, id])?;
    if removed == 0 {
        // The key was out of date, so the row is found the slow way.
        conn.execute(
            "DELETE FROM search_fts WHERE entity_kind = ?1 AND entity_id = ?2",
            params![kind, id],
        )?;
    }
    conn.prepare_cached("DELETE FROM search_fts_keys WHERE entity_kind = ?1 AND entity_id = ?2")?
        .execute(params![kind, id])?;
    Ok(())
}

/// Removes everything derived from a deleted page or node.
pub fn remove_entity(conn: &Connection, kind: &str, id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM links WHERE source_kind = ?1 AND source_id = ?2",
        params![kind, id],
    )?;
    conn.execute(
        "DELETE FROM mentions WHERE source_kind = ?1 AND source_id = ?2",
        params![kind, id],
    )?;
    remove_search(conn, kind, id)
}

/// Recomputes the mentions that can have changed when the names of `page_ids` changed:
/// in every text that mentioned one of them, and in every text holding one of their names
/// now. A new name can also take a match from a shorter one inside it, and that text holds
/// the new name. The search index finds those texts, and it matches loosely, so it can
/// only find too many. `matcher` must be built after the change.
pub fn refresh_mentions_of(
    conn: &Connection,
    matcher: &MentionMatcher,
    page_ids: &[&str],
) -> AppResult<()> {
    if mentions_deferred() {
        return Ok(());
    }
    let mut targets: HashSet<(String, String)> = HashSet::new();
    let mut names: Vec<String> = Vec::new();
    {
        let mut mentioned = conn
            .prepare_cached("SELECT source_kind, source_id FROM mentions WHERE page_id = ?1")?;
        let mut named = conn.prepare_cached(
            "SELECT title FROM pages WHERE id = ?1 AND deleted_at IS NULL
             UNION ALL
             SELECT a.alias FROM page_aliases a JOIN pages p ON p.id = a.page_id
              WHERE a.page_id = ?1 AND p.deleted_at IS NULL",
        )?;
        for id in page_ids {
            for row in mentioned.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))? {
                targets.insert(row?);
            }
            for row in named.query_map([id], |r| r.get::<_, String>(0))? {
                let name = row?;
                if is_usable_name(&name) {
                    names.push(name);
                }
            }
        }
    }
    {
        let mut found = conn.prepare_cached(
            "SELECT entity_kind, entity_id FROM search_fts WHERE search_fts MATCH ?1",
        )?;
        for name in &names {
            let phrase: Vec<String> = name
                .split_whitespace()
                .map(|t| format!("\"{}\"", search_index_text(t).replace('"', "\"\"")))
                .collect();
            if phrase.is_empty() {
                continue;
            }
            let query = format!("body : ({})", phrase.join(" + "));
            for row in found.query_map([query], |r| Ok((r.get(0)?, r.get(1)?)))? {
                targets.insert(row?);
            }
        }
    }
    let mut page_text = conn
        .prepare_cached("SELECT content_text FROM pages WHERE id = ?1 AND deleted_at IS NULL")?;
    let mut node_text = conn.prepare_cached(
        "SELECT n.content_text FROM nodes n JOIN books b ON b.id = n.book_id
         WHERE n.id = ?1 AND n.deleted_at IS NULL AND b.deleted_at IS NULL AND n.kind = 'scene'",
    )?;
    for (kind, id) in targets {
        let text: Option<String> = if kind == KIND_PAGE {
            page_text.query_row([&id], |r| r.get(0)).optional()?
        } else {
            node_text.query_row([&id], |r| r.get(0)).optional()?
        };
        match text {
            Some(text) => write_mentions(conn, matcher, &kind, &id, &text)?,
            None => {
                conn.execute(
                    "DELETE FROM mentions WHERE source_kind = ?1 AND source_id = ?2",
                    params![kind, id],
                )?;
            }
        }
    }
    Ok(())
}

/// Recomputes every mention. Needed when the set of names changes.
pub fn rebuild_mentions(conn: &Connection) -> AppResult<()> {
    let matcher = MentionMatcher::build(conn)?;
    rebuild_mentions_with(conn, &matcher)
}

/// `rebuild_mentions` with a matcher built after the names last changed.
pub fn rebuild_mentions_with(conn: &Connection, matcher: &MentionMatcher) -> AppResult<()> {
    if mentions_deferred() {
        return Ok(());
    }
    conn.execute("DELETE FROM mentions", [])?;
    let mut rows: Vec<(&str, String, String)> = Vec::new();
    {
        let mut pages =
            conn.prepare("SELECT id, content_text FROM pages WHERE deleted_at IS NULL")?;
        for row in pages.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, text) = row?;
            rows.push((KIND_PAGE, id, text));
        }
        // A book in the trash stays out, or the next change of names would bring it back.
        let mut nodes = conn.prepare(
            "SELECT n.id, n.content_text FROM nodes n JOIN books b ON b.id = n.book_id
             WHERE n.deleted_at IS NULL AND b.deleted_at IS NULL AND n.kind = 'scene'",
        )?;
        for row in nodes.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, text) = row?;
            rows.push((KIND_NODE, id, text));
        }
    }
    for (kind, id, text) in rows {
        write_mentions(conn, matcher, kind, &id, &text)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn_with_pages(names: &[(&str, &str)]) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        db::migrate(&mut conn).unwrap();
        for (id, title) in names {
            conn.execute(
                "INSERT INTO pages (id, title, title_key, content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '{}', 'now', 'now')",
                params![id, title, title.to_lowercase()],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn matches_whole_words_exactly_and_prefers_longest() {
        let conn = conn_with_pages(&[("a", "Aria"), ("b", "Aria Vale"), ("c", "Will")]);
        let m = MentionMatcher::build(&conn).unwrap();
        let counts = m.count("Aria Vale met Aria. Ariadne will go. Will went.");
        assert_eq!(counts.get("a"), Some(&1), "Aria alone, not Ariadne");
        assert_eq!(counts.get("b"), Some(&1), "the longer name wins");
        assert_eq!(counts.get("c"), Some(&1), "only capitalised Will");
    }

    #[test]
    fn ignores_very_short_names() {
        let conn = conn_with_pages(&[("a", "Ed")]);
        let m = MentionMatcher::build(&conn).unwrap();
        assert!(m.count("Ed went home").is_empty());
    }

    #[test]
    fn chinese_names_match_inside_a_sentence_and_may_be_two_characters() {
        let conn = conn_with_pages(&[("a", "林黛玉"), ("b", "李白"), ("c", "秦"), ("d", "大观园")]);
        let m = MentionMatcher::build(&conn).unwrap();
        let counts = m.count("那天林黛玉和李白一起去了大观园，林黛玉笑了。秦王不在。");
        assert_eq!(counts.get("a"), Some(&2));
        assert_eq!(counts.get("b"), Some(&1));
        assert_eq!(counts.get("c"), None, "one character is too short to be sure of");
        assert_eq!(counts.get("d"), Some(&1));
    }

    #[test]
    fn japanese_and_korean_names_match_with_their_particles_attached() {
        let conn = conn_with_pages(&[("a", "夏目漱石"), ("b", "철수"), ("c", "สมชาย")]);
        let m = MentionMatcher::build(&conn).unwrap();
        let counts = m.count("夏目漱石は猫が好きだ。철수가 학교에 갔다. สมชายไปโรงเรียน");
        assert_eq!(counts.get("a"), Some(&1));
        assert_eq!(counts.get("b"), Some(&1));
        assert_eq!(counts.get("c"), Some(&1));
    }

    #[test]
    fn english_names_still_need_word_boundaries_except_beside_unspaced_scripts() {
        let conn = conn_with_pages(&[("a", "Aria")]);
        let m = MentionMatcher::build(&conn).unwrap();
        assert!(m.count("Ariadne Ariaé ÉAria Aria1 2Aria").is_empty());
        assert_eq!(m.count("我看到Aria走了").get("a"), Some(&1));
        assert_eq!(m.count("Aria's (Aria) Aria-like").get("a"), Some(&3));
    }

    #[test]
    fn index_text_separates_characters_and_comes_back_unchanged() {
        assert!(matches!(search_index_text("Plain Latin, Привет"), Cow::Borrowed(_)));
        let text = "abc世界 def。한글";
        let indexed = search_index_text(text);
        assert_eq!(
            indexed,
            "abc\u{1F}世\u{1F}界\u{1F} def。\u{1F}한\u{1F}글"
        );
        assert_eq!(search_display_text(&indexed), text);
    }

    #[test]
    fn renames_and_new_pages_keep_mentions_and_search_current() {
        use crate::engine::Engine;
        use crate::rpc::call;
        use serde_json::json;
        fn doc(text: &str) -> serde_json::Value {
            json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }] })
        }
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "M" }));
        let aria = call(&engine, "pages.create", json!({ "title": "Aria" }))["id"].as_str().unwrap().to_string();
        let note = call(&engine, "pages.create", json!({ "title": "Notes", "content": doc("Bryn met Aria by the Cora gate.") }))["id"]
            .as_str().unwrap().to_string();
        let mentioned = |engine: &Engine| -> Vec<String> {
            engine.read(|c| {
                let mut stmt = c.prepare("SELECT p.title FROM mentions m JOIN pages p ON p.id = m.page_id WHERE m.source_id = ?1 ORDER BY 1")?;
                let rows = stmt.query_map([&note], |r| r.get(0))?;
                Ok(rows.collect::<Result<Vec<String>, _>>()?)
            }).unwrap()
        };
        assert_eq!(mentioned(&engine), ["Aria"]);
        // Writes in between keep the matcher, and a new name must still reach it.
        call(&engine, "pages.update", json!({ "id": note, "patch": { "content": doc("Bryn met Aria by the Cora gate.") } }));
        call(&engine, "pages.create", json!({ "title": "Bryn" }));
        assert_eq!(mentioned(&engine), ["Aria", "Bryn"], "existing text finds a new page");
        call(&engine, "pages.rename", json!({ "id": aria, "newTitle": "Cora", "keepAlias": false, "updateLinks": false }));
        assert_eq!(mentioned(&engine), ["Bryn", "Cora"], "the old name stops matching and the new one starts");
        call(&engine, "pages.update", json!({ "id": note, "patch": { "content": doc("Only Bryn now.") } }));
        assert_eq!(mentioned(&engine), ["Bryn"]);

        let rows: i64 = engine.read(|c| Ok(c.query_row(
            "SELECT count(*) FROM search_fts WHERE entity_id = ?1", [&note], |r| r.get(0))?)).unwrap();
        assert_eq!(rows, 1, "a write replaces its search row");
        let found = call(&engine, "search.query", json!({ "q": "gate" }));
        assert_eq!(found.as_array().unwrap().len(), 0, "the old text is gone from search");
    }

    #[test]
    fn index_text_leaves_out_hebrew_and_arabic_vowel_marks() {
        assert_eq!(search_index_text("שָׁלוֹם"), "שלום");
        assert_eq!(search_index_text("كَتَبَ"), "كتب");
        assert!(matches!(search_index_text("שלום كتب"), Cow::Borrowed(_)));
    }
}

#[cfg(test)]
#[path = "indexing_bench.rs"]
mod bench;
