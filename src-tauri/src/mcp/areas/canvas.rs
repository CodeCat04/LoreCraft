//! Changing canvases: making, renaming and trashing them, and editing their cards and arrows.
//!
//! `edit_canvas` resolves every operation here, against what the client may see: cards
//! named by id or by what they show, new cards placed beside related ones without overlaps,
//! new ids chosen. The draft holds plain operations by id, which the app applies to the
//! canvas as it is then, through the open board if there is one (`src/mcp/kinds/canvas.tsx`).
//! Cards for local-only pages and scenes are not there for the client: naming one fails as
//! if it were missing, and so does adding one.

use std::collections::HashMap;

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use super::{write, Tool};
use crate::content::title_key;
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{node_ref, optional, reason, required, MAX_TEXT};
use crate::mcp::tools::{resolve_page, Ctx};
use crate::mcp::write::{Draft, WriteCx};

/// The most operations one call may make.
pub const MAX_OPS: usize = 200;
const GAP: f64 = 60.0;
const GROUP_PADDING: f64 = 40.0;

pub fn tools() -> Vec<Tool> {
    let canvas = json!({ "type": "string", "description": "The canvas title or id." });
    vec![
        write(
            "create_canvas",
            "Make a new, empty canvas with this title. Add cards to it with edit_canvas. Depending on the writer's setting, it waits for them to accept it, or is made at once. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": { "type": "string", "description": "The new canvas's title." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["title"] }),
            create_canvas,
        ),
        write(
            "rename_canvas",
            "Rename a canvas. Changes only its title. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "canvas": canvas,
                "new_title": { "type": "string", "description": "The new title." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["canvas", "new_title"] }),
            rename_canvas,
        ),
        write(
            "trash_canvas",
            "Move a canvas to the trash. The writer can restore it from there, and Undo brings it back. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "canvas": canvas,
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["canvas"] }),
            trash_canvas,
        ),
        write(
            "edit_canvas",
            "Change a canvas's cards and arrows, in order, as one change. Each operation has an op: add_text (a Markdown card), add_page, add_scene, add_group, move, resize, edit_text, remove, connect (an arrow, with an optional label), disconnect, color. Name cards by id or by the text, page title, scene title or group label they show; a new card's \"as\" name works in later operations. Without x and y, a new card goes beside the card in \"near\" or the one it is connected to, without overlapping others. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "canvas": canvas,
                "operations": { "type": "array", "items": { "type": "object", "properties": {
                    "op": { "type": "string", "enum": ["add_text", "add_page", "add_scene", "add_group", "move", "resize", "edit_text", "remove", "connect", "disconnect", "color"] },
                    "text": { "type": "string", "description": "add_text and edit_text: the card's Markdown." },
                    "page": { "type": "string", "description": "add_page: the page title or id." },
                    "scene": { "type": "string", "description": "add_scene: the scene title or id." },
                    "label": { "type": "string", "description": "add_group: its label. connect: the arrow's label." },
                    "around": { "type": "array", "items": { "type": "string" }, "description": "add_group: cards to put the group around." },
                    "as": { "type": "string", "description": "A name for the new card, to use in later operations." },
                    "near": { "type": "string", "description": "A card to place the new one beside." },
                    "card": { "type": "string", "description": "The card to move, resize, edit, remove or color: its id or what it shows." },
                    "arrow": { "type": "string", "description": "disconnect and color: the arrow's id or label." },
                    "from": { "type": "string", "description": "connect and disconnect: the card the arrow starts at." },
                    "to": { "type": "string", "description": "connect and disconnect: the card the arrow points at." },
                    "x": { "type": "number" }, "y": { "type": "number" },
                    "width": { "type": "number" }, "height": { "type": "number" },
                    "color": { "type": "string", "description": "1 to 6 (red, orange, yellow, green, cyan, purple), a name of one of those, #rrggbb, or empty for none." },
                }, "required": ["op"] } },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["canvas", "operations"] }),
            edit_canvas,
        ),
    ]
}

// ---------------------------------------------------------------------------
// Finding canvases
// ---------------------------------------------------------------------------

pub(crate) fn has_canvases(ctx: &Ctx) -> AppResult<bool> {
    Ok(ctx
        .conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canvases'", [], |_| Ok(()))
        .optional()?
        .is_some())
}

/// A live canvas by id or title, as (id, title, data).
fn find_canvas(ctx: &Ctx, wanted: &str) -> AppResult<(String, String, Value)> {
    let missing = || AppError::not_found(format!("A canvas called \"{wanted}\""));
    if wanted.trim().is_empty() {
        return Err(AppError::invalid("Give a canvas title or id."));
    }
    if !has_canvases(ctx)? {
        return Err(missing());
    }
    let row: Option<(String, String, String)> = ctx
        .conn
        .query_row(
            "SELECT id, title, data FROM canvases WHERE deleted_at IS NULL AND (id = ?1 OR title_key = ?2)
             ORDER BY id = ?1 DESC, updated_at DESC",
            rusqlite::params![wanted.trim(), title_key(wanted)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (id, title, data) = row.ok_or_else(missing)?;
    let data: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({ "nodes": [], "edges": [] }));
    Ok((id, title, data))
}

fn canvas_title(args: &Value, name: &str) -> AppResult<String> {
    let title = optional(args, name).split_whitespace().collect::<Vec<_>>().join(" ");
    crate::rpc::canvas::clean_title(&title)
}

fn create_canvas(_cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let title = canvas_title(args, "title")?;
    let payload = json!({ "title": title, "reason": reason(args) });
    Ok(Draft::new("canvasCreate", title.clone(), payload)
        .suggested(format!(
            "Suggested a new canvas \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("made the canvas \"{title}\". Add cards to it with edit_canvas.")))
}

fn rename_canvas(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let new_title = canvas_title(args, "new_title")?;
    let (id, title, _) = cx.read(|ctx| find_canvas(ctx, required(args, "canvas")?))?;
    if title == new_title {
        return Err(AppError::invalid("Nothing would change."));
    }
    let payload = json!({ "canvasId": id, "title": new_title, "before": title, "reason": reason(args) });
    Ok(Draft::new("canvasRename", title.clone(), payload)
        .done(format!("renamed the canvas \"{title}\" to \"{new_title}\".")))
}

fn trash_canvas(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let (id, title, _) = cx.read(|ctx| find_canvas(ctx, required(args, "canvas")?))?;
    let payload = json!({ "canvasId": id, "reason": reason(args) });
    Ok(Draft::new("canvasTrash", title.clone(), payload)
        .suggested(format!(
            "Suggested moving the canvas \"{title}\" to the trash (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("moved the canvas \"{title}\" to the trash.")))
}

// ---------------------------------------------------------------------------
// Cards as the client sees them
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn of(node: &Value) -> Self {
        let n = |k: &str, d: f64| node.get(k).and_then(Value::as_f64).unwrap_or(d);
        Self { x: n("x", 0.0), y: n("y", 0.0), w: n("width", 250.0), h: n("height", 60.0) }
    }

    fn overlaps(&self, o: &Rect) -> bool {
        self.x < o.x + o.w && o.x < self.x + self.w && self.y < o.y + o.h && o.y < self.y + self.h
    }
}

/// One card on the board.
struct Card {
    id: String,
    kind: String,
    /// What the card shows: its text, the page or scene title, the group label.
    shows: String,
    rect: Rect,
    hidden: bool,
}

/// `lorecraft:<kind>/<id>` as (kind, id).
fn parse_ref(file: &str) -> Option<(String, String)> {
    let rest = file.strip_prefix("lorecraft:")?;
    let (kind, id) = rest.split_once('/')?;
    let id = id.split('#').next().unwrap_or("");
    Some((kind.to_string(), percent_decode(id)))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Some(byte) = text.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn title_of(ctx: &Ctx, table: &str, id: &str) -> AppResult<Option<String>> {
    Ok(ctx
        .conn
        .query_row(&format!("SELECT title FROM {table} WHERE id = ?1"), [id], |r| r.get::<_, String>(0))
        .optional()?)
}

/// True if a card names a page or scene this client may not see.
pub(crate) fn card_is_hidden(ctx: &Ctx, node: &Value) -> bool {
    match node.get("file").and_then(Value::as_str).and_then(parse_ref) {
        Some((kind, id)) if kind == "page" => ctx.page_hidden(&id),
        Some((kind, id)) if kind == "scene" || kind == "node" => ctx.node_hidden(&id),
        _ => false,
    }
}

fn cards_of(ctx: &Ctx, data: &Value) -> AppResult<Vec<Card>> {
    let mut out = Vec::new();
    for node in data["nodes"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let Some(id) = node["id"].as_str() else { continue };
        let kind = node["type"].as_str().unwrap_or("").to_string();
        let hidden = card_is_hidden(ctx, node);
        let shows = if hidden {
            String::new()
        } else {
            match kind.as_str() {
                "text" => node["text"].as_str().unwrap_or("").to_string(),
                "group" => node["label"].as_str().unwrap_or("").to_string(),
                "link" => node["url"].as_str().unwrap_or("").to_string(),
                _ => match node["file"].as_str().and_then(parse_ref) {
                    Some((k, ref_id)) if k == "page" => title_of(ctx, "pages", &ref_id)?.unwrap_or_default(),
                    Some((k, ref_id)) if k == "scene" || k == "node" => title_of(ctx, "nodes", &ref_id)?.unwrap_or_default(),
                    Some((k, ref_id)) if k == "asset" => title_of_asset(ctx, &ref_id)?,
                    Some((k, ref_id)) if k == "canvas" => title_of(ctx, "canvases", &ref_id)?.unwrap_or_default(),
                    _ => node["file"].as_str().unwrap_or("").to_string(),
                },
            }
        };
        out.push(Card { id: id.to_string(), kind, shows, rect: Rect::of(node), hidden });
    }
    Ok(out)
}

fn title_of_asset(ctx: &Ctx, id: &str) -> AppResult<String> {
    Ok(ctx
        .conn
        .query_row("SELECT CASE WHEN label != '' THEN label ELSE name END FROM assets WHERE id = ?1", [id], |r| r.get::<_, String>(0))
        .optional()?
        .unwrap_or_default())
}

fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn first_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    squash(line.trim_start_matches('#').trim())
}

// ---------------------------------------------------------------------------
// edit_canvas
// ---------------------------------------------------------------------------

/// The board while operations are worked out: what is there now, and what has been added.
struct Board<'a> {
    ctx: &'a Ctx<'a>,
    cards: Vec<Card>,
    /// Arrows as (id, from, to, label).
    arrows: Vec<(String, String, String, String)>,
    names: HashMap<String, String>,
    taken: Vec<Rect>,
}

impl<'a> Board<'a> {
    fn card(&self, wanted: &str) -> AppResult<String> {
        let wanted = wanted.trim();
        if wanted.is_empty() {
            return Err(AppError::invalid("Name a card by its id or by what it shows."));
        }
        if let Some(id) = self.names.get(&squash(wanted)) {
            return Ok(id.clone());
        }
        let missing = || AppError::not_found(format!("A card showing \"{wanted}\""));
        let visible: Vec<&Card> = self.cards.iter().filter(|c| !c.hidden).collect();
        if let Some(card) = visible.iter().find(|c| c.id == wanted) {
            return Ok(card.id.clone());
        }
        let key = squash(wanted);
        let tests: [&dyn Fn(&Card) -> bool; 3] = [
            &|c| squash(&c.shows) == key,
            &|c| first_line(&c.shows) == key,
            &|c| squash(&c.shows).contains(&key),
        ];
        for test in tests {
            let found: Vec<&&Card> = visible.iter().filter(|c| test(c)).collect();
            match found.len() {
                0 => continue,
                1 => return Ok(found[0].id.clone()),
                _ => {
                    return Err(AppError::invalid(format!(
                        "More than one card shows \"{wanted}\". Use an id: {}.",
                        found.iter().take(8).map(|c| c.id.as_str()).collect::<Vec<_>>().join(", ")
                    )))
                }
            }
        }
        Err(missing())
    }

    fn rect_of(&self, id: &str) -> Option<Rect> {
        self.cards.iter().find(|c| c.id == id).map(|c| c.rect)
    }

    fn arrow(&self, op: &Value) -> AppResult<String> {
        let wanted = optional(op, "arrow");
        let visible = |a: &&(String, String, String, String)| {
            !self.is_hidden(&a.1) && !self.is_hidden(&a.2)
        };
        if !wanted.is_empty() {
            if let Some(a) = self.arrows.iter().filter(visible).find(|a| a.0 == wanted) {
                return Ok(a.0.clone());
            }
            let found: Vec<_> = self.arrows.iter().filter(visible).filter(|a| squash(&a.3) == squash(wanted)).collect();
            return match found.len() {
                1 => Ok(found[0].0.clone()),
                0 => Err(AppError::not_found(format!("An arrow labelled \"{wanted}\""))),
                _ => Err(AppError::invalid(format!("More than one arrow is labelled \"{wanted}\". Use an id or from and to."))),
            };
        }
        let from = self.card(required(op, "from")?)?;
        let to = self.card(required(op, "to")?)?;
        let found: Vec<_> = self
            .arrows
            .iter()
            .filter(|a| (a.1 == from && a.2 == to) || (a.1 == to && a.2 == from))
            .collect();
        match found.len() {
            0 => Err(AppError::not_found("An arrow between those cards")),
            1 => Ok(found[0].0.clone()),
            _ => Err(AppError::invalid("More than one arrow joins those cards. Use its id or label.")),
        }
    }

    fn is_hidden(&self, id: &str) -> bool {
        self.cards.iter().any(|c| c.id == id && c.hidden)
    }

    /// A free spot for a card of this size: beside `anchor` if given, else right of everything.
    fn place(&self, w: f64, h: f64, anchor: Option<Rect>) -> (f64, f64) {
        let free = |r: &Rect| !self.taken.iter().any(|t| t.overlaps(r));
        if let Some(a) = anchor {
            let starts = [
                (a.x + a.w + GAP, a.y, 0.0, h + GAP / 2.0),
                (a.x, a.y + a.h + GAP, w + GAP / 2.0, 0.0),
                (a.x - w - GAP, a.y, 0.0, h + GAP / 2.0),
                (a.x, a.y - h - GAP, w + GAP / 2.0, 0.0),
            ];
            for step in 0..12 {
                for (x, y, dx, dy) in starts {
                    let r = Rect { x: x + dx * step as f64, y: y + dy * step as f64, w, h };
                    if free(&r) {
                        return (r.x.round(), r.y.round());
                    }
                }
            }
        }
        let solid: Vec<&Rect> = self.taken.iter().collect();
        if solid.is_empty() {
            return (0.0, 0.0);
        }
        let right = solid.iter().map(|r| r.x + r.w).fold(f64::MIN, f64::max);
        let top = solid.iter().map(|r| r.y).fold(f64::MAX, f64::min);
        let mut r = Rect { x: right + GAP, y: top, w, h };
        while !free(&r) {
            r.y += h + GAP / 2.0;
        }
        (r.x.round(), r.y.round())
    }
}

fn new_card_id() -> String {
    let id = crate::db::new_id().replace('-', "");
    id[id.len() - 16..].to_string()
}

fn number(op: &Value, key: &str) -> Option<f64> {
    op.get(key).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))).filter(|n| n.is_finite())
}

fn size(op: &Value, key: &str, default: f64) -> AppResult<f64> {
    match number(op, key) {
        None => Ok(default),
        Some(n) if (20.0..=20000.0).contains(&n) => Ok(n.round()),
        Some(_) => Err(AppError::invalid(format!("{key} must be between 20 and 20000."))),
    }
}

/// A canvas color: a preset 1 to 6, its name, a hex color, or empty for none.
fn color(value: &str) -> AppResult<Option<String>> {
    let v = value.trim().to_lowercase();
    let preset = match v.as_str() {
        "" | "none" => return Ok(None),
        "1" | "red" => "1",
        "2" | "orange" => "2",
        "3" | "yellow" => "3",
        "4" | "green" => "4",
        "5" | "cyan" | "blue" => "5",
        "6" | "purple" | "violet" => "6",
        hex if hex.starts_with('#') && (hex.len() == 7 || hex.len() == 4) && hex[1..].chars().all(|c| c.is_ascii_hexdigit()) => {
            return Ok(Some(hex.to_string()))
        }
        _ => return Err(AppError::invalid(format!("\"{value}\" is not a canvas color. Use 1 to 6, red, orange, yellow, green, cyan, purple, or #rrggbb."))),
    };
    Ok(Some(preset.to_string()))
}

fn text_height(text: &str) -> f64 {
    let lines: usize = text.lines().map(|l| 1 + l.chars().count() / 32).sum::<usize>().max(1);
    (40.0 + lines as f64 * 22.0).min(400.0)
}

/// The card a new one is about: `near`, or the existing card a later operation connects it to.
fn anchor_for(board: &Board, op: &Value, name: &str, rest: &[Value]) -> AppResult<Option<Rect>> {
    let near = optional(op, "near");
    if !near.is_empty() {
        let id = board.card(near)?;
        return Ok(board.rect_of(&id));
    }
    if name.is_empty() {
        return Ok(None);
    }
    for later in rest.iter().filter(|o| optional(o, "op") == "connect") {
        let (from, to) = (squash(optional(later, "from")), squash(optional(later, "to")));
        let other = if from == name { optional(later, "to") } else if to == name { optional(later, "from") } else { continue };
        if let Ok(id) = board.card(other) {
            if let Some(r) = board.rect_of(&id) {
                return Ok(Some(r));
            }
        }
    }
    Ok(None)
}

fn edit_canvas(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let operations = args
        .get("operations")
        .and_then(Value::as_array)
        .filter(|ops| !ops.is_empty())
        .ok_or_else(|| AppError::invalid("Give a list of operations."))?;
    if operations.len() > MAX_OPS {
        return Err(AppError::invalid(format!("Give at most {MAX_OPS} operations at a time.")));
    }
    cx.read(|ctx| {
        let (canvas_id, canvas_title, data) = find_canvas(ctx, required(args, "canvas")?)?;
        let cards = cards_of(ctx, &data)?;
        let arrows = data["edges"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter_map(|e| {
                Some((
                    e["id"].as_str()?.to_string(),
                    e["fromNode"].as_str()?.to_string(),
                    e["toNode"].as_str()?.to_string(),
                    e["label"].as_str().unwrap_or("").to_string(),
                ))
            })
            .collect();
        let taken = cards.iter().filter(|c| c.kind != "group").map(|c| c.rect).collect();
        let mut board = Board { ctx, cards, arrows, names: HashMap::new(), taken };
        let mut ops: Vec<Value> = Vec::new();
        let mut said: Vec<String> = Vec::new();
        for (index, op) in operations.iter().enumerate() {
            let step = |e: AppError| AppError::new(&e.code, format!("Operation {}: {}", index + 1, e.message));
            resolve_op(&mut board, op, &operations[index + 1..], &mut ops, &mut said).map_err(step)?;
        }
        let payload = json!({
            "canvasId": canvas_id,
            "ops": ops,
            "summary": said,
            "reason": reason(args),
        });
        let count = said.len();
        Ok(Draft::new("canvasEdit", canvas_title.clone(), payload)
            .suggested(format!(
                "Suggested {count} change{} to the canvas \"{canvas_title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions.",
                if count == 1 { "" } else { "s" }
            ))
            .done(format!("changed the canvas \"{canvas_title}\": {}.", said.join("; "))))
    })
}

fn resolve_op(board: &mut Board, op: &Value, rest: &[Value], ops: &mut Vec<Value>, said: &mut Vec<String>) -> AppResult<()> {
    let kind = optional(op, "op");
    let name = squash(optional(op, "as"));
    let add = |board: &mut Board, ops: &mut Vec<Value>, said: &mut Vec<String>, node, anchor, what| {
        add_card(board, op, &name, ops, said, node, anchor, what)
    };
    let base = |kind: &str, w: f64, h: f64| -> AppResult<Map<String, Value>> {
        let mut node = Map::new();
        node.insert("id".into(), json!(new_card_id()));
        node.insert("type".into(), json!(kind));
        node.insert("width".into(), json!(size(op, "width", w)?));
        node.insert("height".into(), json!(size(op, "height", h)?));
        Ok(node)
    };
    match kind {
        "add_text" => {
            let text = required(op, "text")?.trim().to_string();
            if text.len() > MAX_TEXT {
                return Err(AppError::invalid("That text is too long."));
            }
            let mut node = base("text", 260.0, text_height(&text))?;
            node.insert("text".into(), json!(text));
            let anchor = anchor_for(board, op, &name, rest)?;
            add(board, ops, said, node, anchor, format!("added a text card \"{}\"", crate::mcp::text::cut(&first_line(&text), 60)))
        }
        "add_page" => {
            let wanted = required(op, "page")?;
            let id = resolve_page(board.ctx, &json!({ "title": wanted }))
                .or_else(|_| resolve_page(board.ctx, &json!({ "id": wanted })))?;
            let title = title_of(board.ctx, "pages", &id)?.unwrap_or_default();
            let mut node = base("file", 400.0, 300.0)?;
            node.insert("file".into(), json!(format!("lorecraft:page/{}", encode(&id))));
            let anchor = anchor_for(board, op, &name, rest)?;
            add(board, ops, said, node, anchor, format!("added the page \"{title}\""))?;
            if let Some(card) = board.cards.last_mut() {
                card.shows = title;
            }
            Ok(())
        }
        "add_scene" => {
            let scene = node_ref(board.ctx, required(op, "scene")?, &["scene"])?;
            let title = scene.meta.title.clone();
            let mut node = base("file", 400.0, 300.0)?;
            node.insert("file".into(), json!(format!("lorecraft:scene/{}", encode(&scene.meta.id))));
            let anchor = anchor_for(board, op, &name, rest)?;
            add(board, ops, said, node, anchor, format!("added the scene \"{title}\""))?;
            if let Some(card) = board.cards.last_mut() {
                card.shows = title;
            }
            Ok(())
        }
        "add_group" => {
            let label = optional(op, "label").trim().to_string();
            let around: Vec<String> = crate::mcp::suggest::string_list(op, "around");
            let mut node = base("group", 600.0, 400.0)?;
            node.insert("label".into(), json!(label));
            if !around.is_empty() {
                let rects = around
                    .iter()
                    .map(|c| board.card(c).map(|id| board.rect_of(&id).expect("a known card")))
                    .collect::<AppResult<Vec<_>>>()?;
                let left = rects.iter().map(|r| r.x).fold(f64::MAX, f64::min) - GROUP_PADDING;
                let top = rects.iter().map(|r| r.y).fold(f64::MAX, f64::min) - GROUP_PADDING;
                let right = rects.iter().map(|r| r.x + r.w).fold(f64::MIN, f64::max) + GROUP_PADDING;
                let bottom = rects.iter().map(|r| r.y + r.h).fold(f64::MIN, f64::max) + GROUP_PADDING;
                node.insert("width".into(), json!((right - left).round()));
                node.insert("height".into(), json!((bottom - top).round()));
                node.insert("x".into(), json!(left.round()));
                node.insert("y".into(), json!(top.round()));
                // Placed already: it goes around them.
                let id = node["id"].as_str().unwrap_or("").to_string();
                if !name.is_empty() {
                    board.names.insert(name.clone(), id.clone());
                }
                let rect = Rect { x: left, y: top, w: right - left, h: bottom - top };
                if let Some(c) = color(optional(op, "color"))? {
                    node.insert("color".into(), json!(c));
                }
                board.cards.push(Card { id, kind: "group".into(), shows: label.clone(), rect, hidden: false });
                ops.push(json!({ "type": "add", "node": Value::Object(node) }));
                said.push(format!("added a group \"{label}\""));
                return Ok(());
            }
            let anchor = anchor_for(board, op, &name, rest)?;
            add(board, ops, said, node, anchor, format!("added a group \"{label}\""))
        }
        "move" => {
            let id = board.card(required(op, "card")?)?;
            let (Some(x), Some(y)) = (number(op, "x"), number(op, "y")) else {
                return Err(AppError::invalid("move needs x and y."));
            };
            let (x, y) = (x.round(), y.round());
            if let Some(card) = board.cards.iter_mut().find(|c| c.id == id) {
                card.rect.x = x;
                card.rect.y = y;
            }
            ops.push(json!({ "type": "update", "id": id, "patch": { "x": x, "y": y } }));
            said.push(format!("moved card {id}"));
            Ok(())
        }
        "resize" => {
            let id = board.card(required(op, "card")?)?;
            let rect = board.rect_of(&id).expect("a known card");
            let (w, h) = (size(op, "width", rect.w)?, size(op, "height", rect.h)?);
            if number(op, "width").is_none() && number(op, "height").is_none() {
                return Err(AppError::invalid("resize needs width or height."));
            }
            if let Some(card) = board.cards.iter_mut().find(|c| c.id == id) {
                card.rect.w = w;
                card.rect.h = h;
            }
            ops.push(json!({ "type": "update", "id": id, "patch": { "width": w, "height": h } }));
            said.push(format!("resized card {id}"));
            Ok(())
        }
        "edit_text" => {
            let id = board.card(required(op, "card")?)?;
            let card = board.cards.iter_mut().find(|c| c.id == id).expect("a known card");
            let text = required(op, "text")?.trim().to_string();
            if text.len() > MAX_TEXT {
                return Err(AppError::invalid("That text is too long."));
            }
            let patch = match card.kind.as_str() {
                "text" => json!({ "text": text }),
                "group" => json!({ "label": text }),
                _ => return Err(AppError::invalid("Only text cards and group labels have text to edit.")),
            };
            card.shows = text;
            ops.push(json!({ "type": "update", "id": id, "patch": patch }));
            said.push(format!("edited card {id}"));
            Ok(())
        }
        "remove" => {
            let id = board.card(required(op, "card")?)?;
            board.cards.retain(|c| c.id != id);
            board.arrows.retain(|a| a.1 != id && a.2 != id);
            board.names.retain(|_, v| *v != id);
            ops.push(json!({ "type": "remove", "id": id }));
            said.push(format!("removed card {id}"));
            Ok(())
        }
        "connect" => {
            let from = board.card(required(op, "from")?)?;
            let to = board.card(required(op, "to")?)?;
            if from == to {
                return Err(AppError::invalid("An arrow needs two different cards."));
            }
            let id = new_card_id();
            let label = optional(op, "label").trim().to_string();
            let mut edge = json!({ "id": id, "fromNode": from, "toNode": to, "toEnd": "arrow" });
            if !label.is_empty() {
                edge["label"] = json!(label);
            }
            if let Some(c) = color(optional(op, "color"))? {
                edge["color"] = json!(c);
            }
            board.arrows.push((id, from.clone(), to.clone(), label));
            ops.push(json!({ "type": "addEdge", "edge": edge }));
            said.push(format!("connected {from} to {to}"));
            Ok(())
        }
        "disconnect" => {
            let id = board.arrow(op)?;
            board.arrows.retain(|a| a.0 != id);
            ops.push(json!({ "type": "removeEdge", "id": id }));
            said.push(format!("removed arrow {id}"));
            Ok(())
        }
        "color" => {
            let value = color(optional(op, "color"))?;
            if !optional(op, "card").is_empty() {
                let id = board.card(optional(op, "card"))?;
                ops.push(json!({ "type": "update", "id": id, "patch": { "color": value } }));
                said.push(format!("colored card {id}"));
            } else {
                let id = board.arrow(op)?;
                ops.push(json!({ "type": "updateEdge", "id": id, "patch": { "color": value } }));
                said.push(format!("colored arrow {id}"));
            }
            Ok(())
        }
        "" => Err(AppError::invalid("Each operation needs an op.")),
        other => Err(AppError::invalid(format!("\"{other}\" is not an operation. Use add_text, add_page, add_scene, add_group, move, resize, edit_text, remove, connect, disconnect or color."))),
    }
}

#[allow(clippy::too_many_arguments)]
fn add_card(
    board: &mut Board,
    op: &Value,
    name: &str,
    ops: &mut Vec<Value>,
    said: &mut Vec<String>,
    mut node: Map<String, Value>,
    anchor: Option<Rect>,
    what: String,
) -> AppResult<()> {
    let w = node["width"].as_f64().unwrap_or(260.0);
    let h = node["height"].as_f64().unwrap_or(80.0);
    let (x, y) = match (number(op, "x"), number(op, "y")) {
        (Some(x), Some(y)) => (x.round(), y.round()),
        _ => board.place(w, h, anchor),
    };
    node.insert("x".into(), json!(x));
    node.insert("y".into(), json!(y));
    if let Some(c) = color(optional(op, "color"))? {
        node.insert("color".into(), json!(c));
    }
    let id = node["id"].as_str().unwrap_or("").to_string();
    let rect = Rect { x, y, w, h };
    let card_kind = node["type"].as_str().unwrap_or("").to_string();
    if card_kind != "group" {
        board.taken.push(rect);
    }
    if !name.is_empty() {
        if board.names.contains_key(name) {
            return Err(AppError::invalid(format!("The name \"{}\" is used twice.", optional(op, "as"))));
        }
        board.names.insert(name.to_string(), id.clone());
    }
    let shows = node.get("text").or(node.get("label")).and_then(Value::as_str).unwrap_or("").to_string();
    board.cards.push(Card { id, kind: card_kind, shows, rect, hidden: false });
    ops.push(json!({ "type": "add", "node": Value::Object(node) }));
    said.push(what);
    Ok(())
}

/// As `formatRef` writes ids: `encodeURIComponent`.
fn encode(id: &str) -> String {
    let mut out = String::new();
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, TestDir};
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{self, call, call_as, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO, STATUS_PENDING};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;
    use std::sync::Arc;
    use std::time::Duration;

    pub(crate) fn quick() -> Waits {
        Waits { claim: Duration::from_millis(600), apply: Duration::from_millis(1500), poll: Duration::from_millis(20) }
    }

    /// Plays the app's window: picks up one change and marks it applied.
    pub(crate) fn window(engine: &Arc<Engine>) -> std::thread::JoinHandle<()> {
        let engine = engine.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| suggest::list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| suggest::resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    let mut extra = Map::new();
                    extra.insert("undo".into(), json!({ "report": "Found 2 things." }));
                    assert!(engine.write(|tx| suggest::resolve_with(tx, &id, STATUS_APPLIED, &extra)).unwrap());
                    return;
                }
            }
        })
    }

    struct Project {
        engine: Arc<Engine>,
        _dir: TestDir,
        page: String,
        secret: String,
        scene: String,
        canvas: String,
    }

    fn project() -> Project {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Ashfall" }));
        let page = rpc(&engine, "pages.create", json!({ "title": "Aria" }))["id"].as_str().unwrap().to_string();
        let secret = rpc(&engine, "pages.create", json!({ "title": "Hidden Twist" }))["id"].as_str().unwrap().to_string();
        rpc(&engine, "pages.update", json!({ "id": secret, "patch": { "localOnly": true } }));
        let books = rpc(&engine, "books.list", json!({}));
        let tree = rpc(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap()["id"].as_str().unwrap().to_string();
        rpc(&engine, "nodes.update", json!({ "id": scene, "patch": { "title": "At the gate" } }));
        let data = json!({ "nodes": [
            { "id": "a1", "type": "text", "text": "# The war\nIt starts in spring.", "x": 0, "y": 0, "width": 260, "height": 120 },
            { "id": "s1", "type": "file", "file": format!("lorecraft:page/{secret}"), "x": 0, "y": 400, "width": 400, "height": 300 },
            { "id": "p1", "type": "file", "file": format!("lorecraft:page/{page}"), "x": 600, "y": 0, "width": 400, "height": 300 },
        ], "edges": [
            { "id": "e1", "fromNode": "a1", "toNode": "p1", "label": "causes" },
            { "id": "e2", "fromNode": "a1", "toNode": "s1", "label": "hides" },
        ]});
        let canvas = rpc(&engine, "canvases.create", json!({ "title": "War board", "data": data }))["id"].as_str().unwrap().to_string();
        Project { engine, _dir: dir, page, secret, scene, canvas }
    }

    fn last(engine: &Engine) -> Value {
        engine.read(|c| suggest::list(c, STATUS_PENDING)).unwrap().pop().unwrap()
    }

    fn edit(p: &Project, ops: Value) -> AppResult<String> {
        call(&p.engine, "c", "edit_canvas", &json!({ "canvas": "War board", "operations": ops }), false)
    }

    #[test]
    fn create_rename_and_trash_queue_at_the_suggest_level() {
        let p = project();
        let said = call(&p.engine, "c", "create_canvas", &json!({ "title": "  Map   of  the  north " }), false).unwrap();
        assert!(said.contains("Nothing has changed yet"), "{said}");
        let row = last(&p.engine);
        assert_eq!(row["kind"], "canvasCreate");
        assert_eq!(row["payload"]["title"], "Map of the north");
        assert_eq!(call(&p.engine, "c", "create_canvas", &json!({ "title": " " }), false).unwrap_err().code, "INVALID");

        call(&p.engine, "c", "rename_canvas", &json!({ "canvas": "war BOARD", "new_title": "The war" }), false).unwrap();
        let row = last(&p.engine);
        assert_eq!(row["kind"], "canvasRename");
        assert_eq!(row["payload"]["canvasId"], p.canvas);
        assert_eq!(row["payload"]["before"], "War board");
        let missing = call(&p.engine, "c", "rename_canvas", &json!({ "canvas": "Nope", "new_title": "x" }), false).unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");

        call(&p.engine, "c", "trash_canvas", &json!({ "canvas": p.canvas }), false).unwrap();
        assert_eq!(last(&p.engine)["kind"], "canvasTrash");
        assert_eq!(call(&p.engine, "c", "trash_canvas", &json!({ "canvas": "Nope" }), false).unwrap_err().code, "NOT_FOUND");
        // Nothing changed: all of it waits for the writer.
        assert_eq!(rpc(&p.engine, "canvases.list", json!({})).as_array().unwrap().len(), 1);
        assert_eq!(p.engine.read(suggest::pending_count).unwrap(), 3);
    }

    #[test]
    fn edits_resolve_cards_by_what_they_show_and_place_new_ones_without_overlaps() {
        let p = project();
        let ops = json!([
            { "op": "add_text", "text": "Spring thaw", "as": "thaw" },
            { "op": "connect", "from": "thaw", "to": "the war", "label": "leads to" },
            { "op": "add_page", "page": "Aria", "near": "The war" },
            { "op": "add_scene", "scene": "At the gate" },
            { "op": "move", "card": "a1", "x": -400, "y": 0 },
            { "op": "edit_text", "card": "Spring thaw", "text": "Late spring thaw" },
            { "op": "color", "card": "thaw", "color": "green" },
            { "op": "color", "arrow": "causes", "color": "#FF8800" },
            { "op": "disconnect", "from": "The war", "to": "p1" },
            { "op": "add_group", "label": "Act one", "around": ["thaw", "The war"] },
            { "op": "resize", "card": "p1", "width": 300 },
        ]);
        assert!(edit(&p, ops).unwrap().contains("Nothing has changed yet"));
        let row = last(&p.engine);
        assert_eq!(row["kind"], "canvasEdit");
        assert_eq!(row["payload"]["canvasId"], p.canvas);
        let ops = row["payload"]["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 11);
        let thaw = &ops[0]["node"];
        assert_eq!(thaw["type"], "text");
        assert_eq!(ops[1]["edge"]["fromNode"], thaw["id"]);
        assert_eq!(ops[1]["edge"]["toNode"], "a1");
        assert_eq!(ops[1]["edge"]["label"], "leads to");
        assert_eq!(ops[2]["node"]["file"], format!("lorecraft:page/{}", p.page));
        assert_eq!(ops[3]["node"]["file"], format!("lorecraft:scene/{}", p.scene));
        assert_eq!(ops[5]["patch"]["text"], "Late spring thaw");
        assert_eq!(ops[6]["patch"]["color"], "4");
        assert_eq!(ops[7]["type"], "updateEdge");
        assert_eq!(ops[7]["patch"]["color"], "#ff8800");
        assert_eq!(ops[8], json!({ "type": "removeEdge", "id": "e1" }));
        assert_eq!(ops[9]["node"]["type"], "group");
        // No new card overlaps another, the hidden one included.
        let mut rects: Vec<Rect> = vec![
            Rect { x: 0.0, y: 0.0, w: 260.0, h: 120.0 },
            Rect { x: 0.0, y: 400.0, w: 400.0, h: 300.0 },
            Rect { x: 600.0, y: 0.0, w: 400.0, h: 300.0 },
        ];
        for op in ops.iter().take(4).filter(|o| o["type"] == "add") {
            let r = Rect::of(&op["node"]);
            assert!(!rects.iter().any(|o| o.overlaps(&r)), "{r:?} overlaps");
            rects.push(r);
        }
        // The thaw card sits beside the card it connects to.
        let r = Rect::of(thaw);
        assert!(r.x < 1000.0 && r.y < 700.0, "{r:?}");
    }

    #[test]
    fn missing_and_ambiguous_cards_are_errors_and_nothing_is_stored() {
        let p = project();
        let err = edit(&p, json!([{ "op": "remove", "card": "Nowhere" }])).unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
        assert!(err.message.starts_with("Operation 1"), "{}", err.message);
        let two = json!([{ "op": "add_text", "text": "Twin" }, { "op": "add_text", "text": "Twin" }, { "op": "remove", "card": "Twin" }]);
        assert_eq!(edit(&p, two).unwrap_err().code, "INVALID");
        assert_eq!(edit(&p, json!([{ "op": "fly" }])).unwrap_err().code, "INVALID");
        assert_eq!(edit(&p, json!([])).unwrap_err().code, "INVALID");
        assert_eq!(edit(&p, json!([{ "op": "color", "card": "a1", "color": "mauve" }])).unwrap_err().code, "INVALID");
        let other = call(&p.engine, "c", "edit_canvas", &json!({ "canvas": "Nope", "operations": [{ "op": "add_text", "text": "x" }] }), false);
        assert_eq!(other.unwrap_err().code, "NOT_FOUND");
        assert_eq!(p.engine.read(suggest::pending_count).unwrap(), 0);
    }

    #[test]
    fn local_only_cards_cannot_be_named_added_or_revealed() {
        let p = project();
        for ops in [
            json!([{ "op": "remove", "card": "s1" }]),
            json!([{ "op": "remove", "card": "Hidden Twist" }]),
            json!([{ "op": "move", "card": "s1", "x": 1, "y": 1 }]),
            json!([{ "op": "add_page", "page": "Hidden Twist" }]),
            json!([{ "op": "add_page", "page": p.secret }]),
            json!([{ "op": "disconnect", "arrow": "e2" }]),
            json!([{ "op": "disconnect", "arrow": "hides" }]),
            json!([{ "op": "connect", "from": "a1", "to": "s1" }]),
        ] {
            let err = edit(&p, ops.clone()).unwrap_err();
            assert_eq!(err.code, "NOT_FOUND", "{ops}");
            // It says no more than the client already gave.
            assert!(ops.to_string().contains("Twist") || !err.message.contains("Twist"), "{}", err.message);
        }
        // A wide match never lands on the hidden card, whose title it would give away.
        assert_eq!(edit(&p, json!([{ "op": "remove", "card": "Twist" }])).unwrap_err().code, "NOT_FOUND");
        // With sharing on, the writer allows it.
        let shared = call(&p.engine, "c", "edit_canvas", &json!({ "canvas": "War board", "operations": [{ "op": "remove", "card": "Hidden Twist" }] }), true);
        assert!(shared.is_ok(), "{shared:?}");
        // The read tool says how many are hidden, never what they are.
        let read = p.engine.read(|conn| {
            let ctx = Ctx::new(conn, "Ashfall".into(), true, false)?;
            super::super::canvases::get_canvas(&ctx, &json!({ "title": "War board" }))
        }).unwrap();
        assert!(read.contains("1 card is hidden"), "{read}");
        assert!(!read.contains("Hidden Twist") && !read.contains(&p.secret), "{read}");
    }

    #[test]
    fn at_the_edit_level_it_waits_for_the_window_and_says_done() {
        let p = project();
        let helper = window(&p.engine);
        let args = json!({ "canvas": "War board", "operations": [{ "op": "add_text", "text": "Thaw" }] });
        let said = call_as(&p.engine, "c", "edit_canvas", &args, false, PERMISSION_EDIT, quick()).unwrap();
        helper.join().unwrap();
        assert!(said.starts_with("Done: changed the canvas \"War board\": added a text card"), "{said}");
        assert_eq!(p.engine.read(suggest::pending_count).unwrap(), 0);
    }
}
