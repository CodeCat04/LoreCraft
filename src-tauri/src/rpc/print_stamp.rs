//! For browser engines that print without @page margin boxes or named destinations
//! (WebKitGTK on Linux). Two things the PDF otherwise lacks are worked out here:
//!
//! - where things fell: the print page writes marker text (`LCMK<n>Q`) at each element it
//!   needs a page for, and `markers` finds which page each marker landed on;
//! - the page numbers and running heads: `stamp` reads the @page rules the document asked
//!   for and draws their margin boxes onto each page, as an update added to the end of the
//!   PDF. It also moves left-hand pages over to their own margins, since the engine prints
//!   every page with the first page's margins.
//!
//! The text is set in the document's own fonts, copied from a measuring print in which the
//! print page wrote out every letter the margin boxes need. A font that cannot be found
//! falls back to Times.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read as _;

use regex::bytes::Regex;

use super::print::{find_from, page_objects, points, PdfIndex, Sheet};

// ---------------------------------------------------------------------------
// The @page rules
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

impl Side {
    /// In a left-to-right book the first page is a right-hand page.
    pub fn of(page: usize) -> Self {
        if page % 2 == 1 {
            Side::Right
        } else {
            Side::Left
        }
    }
}

type Declarations = Vec<(String, String)>;

#[derive(Debug, Clone)]
struct PageRule {
    name: String,
    side: Option<Side>,
    declarations: Declarations,
    boxes: Vec<(String, Declarations)>,
}

#[derive(Debug, Clone)]
enum System {
    Cyclic(Vec<String>),
    Extends(String),
    Other,
}

#[derive(Debug, Clone)]
struct CounterStyle {
    system: System,
    range_start: Option<i64>,
    fallback: Option<String>,
}

/// The margin boxes this draws, in the order the spec lists them.
pub const BOXES: [&str; 6] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

#[derive(Debug, Default)]
pub struct PageStyles {
    rules: Vec<PageRule>,
    counters: HashMap<String, CounterStyle>,
}

/// One margin box on one page, with its text worked out.
#[derive(Debug, Clone, PartialEq)]
pub struct MarginBox {
    pub at: &'static str,
    pub text: String,
    pub families: Vec<String>,
    pub size: f64,
    pub italic: bool,
    pub bold: bool,
    pub color: [f64; 3],
}

struct Item {
    prelude: String,
    body: Option<String>,
}

fn string_end(chars: &[char], at: usize) -> usize {
    let quote = chars[at];
    let mut i = at + 1;
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i] == quote {
            return i + 1;
        }
        i += 1;
    }
    chars.len()
}

/// The top-level items of a style sheet or block: declarations, and rules with bodies.
fn items(css: &str) -> Vec<Item> {
    let chars: Vec<char> = css.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    let flush = |current: &mut String, out: &mut Vec<Item>| {
        if !current.trim().is_empty() {
            out.push(Item { prelude: current.trim().to_string(), body: None });
        }
        current.clear();
    };
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            continue;
        }
        match c {
            '"' | '\'' => {
                let end = string_end(&chars, i);
                current.extend(&chars[i..end]);
                i = end;
                continue;
            }
            ';' => flush(&mut current, &mut out),
            '{' => {
                let mut depth = 0;
                let mut j = i + 1;
                while j < chars.len() {
                    match chars[j] {
                        '"' | '\'' => {
                            j = string_end(&chars, j);
                            continue;
                        }
                        '{' => depth += 1,
                        '}' if depth == 0 => break,
                        '}' => depth -= 1,
                        _ => {}
                    }
                    j += 1;
                }
                let body: String = chars[i + 1..j.min(chars.len())].iter().collect();
                out.push(Item { prelude: current.trim().to_string(), body: Some(body) });
                current.clear();
                i = j + 1;
                continue;
            }
            '}' => {}
            _ => current.push(c),
        }
        i += 1;
    }
    flush(&mut current, &mut out);
    out
}

fn declaration(text: &str) -> Option<(String, String)> {
    let (name, value) = text.split_once(':')?;
    Some((name.trim().to_ascii_lowercase(), value.trim().trim_end_matches("!important").trim().to_string()))
}

/// The quoted strings in a CSS value, unescaped.
fn css_strings(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '"' || chars[i] == '\'' {
            let end = string_end(&chars, i);
            out.push(unescape(&chars[i + 1..end.saturating_sub(1).max(i + 1)]));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

fn unescape(chars: &[char]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let hex: String = chars[i + 1..].iter().take(6).take_while(|c| c.is_ascii_hexdigit()).collect();
            if hex.is_empty() {
                out.push(chars[i + 1]);
                i += 2;
            } else {
                if let Some(c) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    out.push(c);
                }
                i += 1 + hex.len();
                if chars.get(i) == Some(&' ') {
                    i += 1;
                }
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn split_declarations(body: &str) -> (Declarations, Vec<(String, Declarations)>) {
    let mut declarations = Vec::new();
    let mut boxes = Vec::new();
    for item in items(body) {
        match item.body {
            None => declarations.extend(declaration(&item.prelude)),
            Some(inner) => {
                if let Some(name) = item.prelude.strip_prefix('@') {
                    let inner_declarations = items(&inner)
                        .into_iter()
                        .filter(|i| i.body.is_none())
                        .filter_map(|i| declaration(&i.prelude))
                        .collect();
                    boxes.push((name.trim().to_ascii_lowercase(), inner_declarations));
                }
            }
        }
    }
    (declarations, boxes)
}

fn color(value: &str) -> [f64; 3] {
    let hex = value.trim().trim_start_matches('#');
    let channel = |s: &str| u8::from_str_radix(s, 16).map(|v| f64::from(v) / 255.0).unwrap_or(0.0);
    match (value.trim().starts_with('#'), hex.len()) {
        (true, 3) => [channel(&hex[0..1].repeat(2)), channel(&hex[1..2].repeat(2)), channel(&hex[2..3].repeat(2))],
        (true, 6) => [channel(&hex[0..2]), channel(&hex[2..4]), channel(&hex[4..6])],
        _ if value.trim() == "white" => [1.0; 3],
        _ => [0.0; 3],
    }
}

impl PageStyles {
    pub fn parse(css: &str) -> Self {
        let mut styles = Self::default();
        for item in items(css) {
            let Some(body) = item.body else { continue };
            if let Some(selector) = item.prelude.strip_prefix("@page") {
                let selector = selector.trim();
                let (name, pseudo) = selector.split_once(':').unwrap_or((selector, ""));
                let side = match pseudo.trim() {
                    "" => None,
                    "left" => Some(Side::Left),
                    "right" => Some(Side::Right),
                    // :first and :blank are not used by the document builder.
                    _ => continue,
                };
                let (declarations, boxes) = split_declarations(&body);
                styles.rules.push(PageRule { name: name.trim().to_string(), side, declarations, boxes });
            } else if let Some(name) = item.prelude.strip_prefix("@counter-style") {
                let (declarations, _) = split_declarations(&body);
                let get = |key: &str| declarations.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone());
                let system = match get("system") {
                    Some(s) if s.trim() == "cyclic" => System::Cyclic(css_strings(&get("symbols").unwrap_or_default())),
                    Some(s) if s.trim().starts_with("extends") => {
                        System::Extends(s.trim()["extends".len()..].trim().to_string())
                    }
                    _ => System::Other,
                };
                let range_start = get("range").and_then(|r| r.split_whitespace().next()?.parse().ok());
                let fallback = get("fallback").map(|f| f.trim().to_string());
                styles
                    .counters
                    .insert(name.trim().to_string(), CounterStyle { system, range_start, fallback });
            }
        }
        styles
    }

    /// The rules that apply to a page, from the weakest to the strongest.
    fn matching(&self, name: &str, side: Side) -> Vec<&PageRule> {
        let mut rules: Vec<(usize, usize, &PageRule)> = self
            .rules
            .iter()
            .enumerate()
            .filter(|(_, r)| (r.name.is_empty() || r.name == name) && r.side.is_none_or(|s| s == side))
            .map(|(order, r)| ((!r.name.is_empty()) as usize * 2 + r.side.is_some() as usize, order, r))
            .collect();
        rules.sort_by_key(|(specificity, order, _)| (*specificity, *order));
        rules.into_iter().map(|(_, _, r)| r).collect()
    }

    pub fn sheet(&self, _page: usize, name: &str, side: Side) -> Sheet {
        let mut sheet = Sheet::default();
        for rule in self.matching(name, side) {
            for (key, value) in &rule.declarations {
                let lengths: Option<Vec<f64>> = value.split_whitespace().map(points).collect();
                let Some(lengths) = lengths.filter(|l| !l.is_empty()) else { continue };
                match key.as_str() {
                    "size" if lengths.len() == 2 => {
                        sheet.width = lengths[0];
                        sheet.height = lengths[1];
                    }
                    "margin" => {
                        let at = |i: usize| lengths[i.min(lengths.len() - 1)];
                        sheet.margins = match lengths.len() {
                            1 => [at(0); 4],
                            2 => [at(0), at(1), at(0), at(1)],
                            3 => [at(0), at(1), at(2), at(1)],
                            _ => [at(0), at(1), at(2), at(3)],
                        };
                    }
                    "margin-top" => sheet.margins[0] = lengths[0],
                    "margin-right" => sheet.margins[1] = lengths[0],
                    "margin-bottom" => sheet.margins[2] = lengths[0],
                    "margin-left" => sheet.margins[3] = lengths[0],
                    _ => {}
                }
            }
        }
        sheet
    }

    fn represent(&self, page: usize, style: &str, depth: usize) -> String {
        let style = style.trim();
        if style == "none" {
            return String::new();
        }
        let Some(counter) = self.counters.get(style).filter(|_| depth < 16) else {
            return page.to_string();
        };
        if counter.range_start.is_some_and(|start| (page as i64) < start) {
            return self.represent(page, counter.fallback.as_deref().unwrap_or("decimal"), depth + 1);
        }
        match &counter.system {
            System::Cyclic(symbols) if symbols.is_empty() => String::new(),
            System::Cyclic(symbols) => symbols[(page.max(1) - 1) % symbols.len()].clone(),
            System::Extends(base) => self.represent(page, base, depth + 1),
            System::Other => page.to_string(),
        }
    }

    /// The text of a `content` value. Only the page counters are known here.
    fn content(&self, value: &str, page: usize, pages: usize) -> Option<String> {
        let value = value.trim();
        if value.is_empty() || value == "none" || value == "normal" {
            return None;
        }
        let chars: Vec<char> = value.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '"' | '\'' => {
                    let end = string_end(&chars, i);
                    out.push_str(&unescape(&chars[i + 1..end.saturating_sub(1).max(i + 1)]));
                    i = end;
                }
                _ if chars[i..].starts_with(&['c', 'o', 'u', 'n', 't', 'e', 'r', '(']) => {
                    let close = chars[i..].iter().position(|&c| c == ')').map_or(chars.len(), |p| p + i);
                    let inner: String = chars[i + 8..close].iter().collect();
                    let mut args = inner.split(',');
                    let counter = args.next().unwrap_or("").trim();
                    let style = args.next().unwrap_or("decimal");
                    match counter {
                        "page" => out.push_str(&self.represent(page, style, 0)),
                        "pages" => out.push_str(&self.represent(pages, style, 0)),
                        _ => {}
                    }
                    i = close + 1;
                }
                _ => i += 1,
            }
        }
        Some(out)
    }

    /// The margin boxes with something to show on a page.
    pub fn boxes(&self, page: usize, pages: usize, name: &str) -> Vec<MarginBox> {
        let mut merged: BTreeMap<&str, HashMap<String, String>> = BTreeMap::new();
        for rule in self.matching(name, Side::of(page)) {
            for (at, declarations) in &rule.boxes {
                let Some(at) = BOXES.iter().find(|b| *b == at) else { continue };
                let entry = merged.entry(*at).or_default();
                for (key, value) in declarations {
                    entry.insert(key.clone(), value.clone());
                }
            }
        }
        BOXES
            .iter()
            .filter_map(|at| {
                let declarations = merged.get(at)?;
                let text = self.content(declarations.get("content")?, page, pages)?;
                if text.trim().is_empty() {
                    return None;
                }
                let families = declarations
                    .get("font-family")
                    .map(|f| {
                        f.split(',')
                            .map(|name| name.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                let size = declarations
                    .get("font-size")
                    .and_then(|s| points(s))
                    .unwrap_or(12.0);
                let style = declarations.get("font-style").map_or("", String::as_str);
                let weight = declarations.get("font-weight").map_or("", String::as_str);
                Some(MarginBox {
                    at: *at,
                    text,
                    families,
                    size,
                    italic: style == "italic" || style == "oblique",
                    bold: weight == "bold" || weight.parse::<u32>().is_ok_and(|w| w >= 600),
                    color: declarations.get("color").map_or([0.0; 3], |c| color(c)),
                })
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Reading the PDF
// ---------------------------------------------------------------------------

fn is_delimiter(b: u8) -> bool {
    b.is_ascii_whitespace() || b"/<>[]()%".contains(&b)
}

/// Where a key's value sits in a dictionary, as a byte range.
fn value_span(dict: &[u8], key: &str) -> Option<(usize, usize)> {
    let key = key.as_bytes();
    let mut from = 0;
    let at = loop {
        let at = find_from(dict, key, from)?;
        if dict.get(at + key.len()).is_none_or(|&b| is_delimiter(b)) {
            break at + key.len();
        }
        from = at + 1;
    };
    let mut i = at;
    while dict.get(i)?.is_ascii_whitespace() {
        i += 1;
    }
    let start = i;
    if dict[i..].starts_with(b"<<") {
        let mut depth = 0;
        while i + 1 < dict.len() {
            if dict[i..].starts_with(b"<<") {
                depth += 1;
                i += 2;
            } else if dict[i..].starts_with(b">>") {
                depth -= 1;
                i += 2;
                if depth == 0 {
                    return Some((start, i));
                }
            } else {
                i += 1;
            }
        }
        return None;
    }
    if dict[i] == b'[' {
        let mut depth = 0;
        while i < dict.len() {
            match dict[i] {
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some((start, i + 1));
                    }
                }
                _ => {}
            }
            i += 1;
        }
        return None;
    }
    let reference = Regex::new(r"^\d+\s+\d+\s+R").ok()?;
    if let Some(m) = reference.find(&dict[i..]) {
        return Some((start, start + m.end()));
    }
    if dict[i] == b'/' {
        i += 1;
    }
    while i < dict.len() && !is_delimiter(dict[i]) {
        i += 1;
    }
    Some((start, i))
}

fn value<'a>(dict: &'a [u8], key: &str) -> Option<&'a [u8]> {
    value_span(dict, key).map(|(s, e)| &dict[s..e])
}

fn as_ref(value: &[u8]) -> Option<u32> {
    let text = std::str::from_utf8(value).ok()?;
    let mut parts = text.split_whitespace();
    let number = parts.next()?.parse().ok()?;
    (parts.next()?.parse::<u32>().is_ok() && parts.next()? == "R").then_some(number)
}

fn as_number(value: &[u8]) -> Option<f64> {
    std::str::from_utf8(value).ok()?.trim().parse().ok()
}

fn references(text: &[u8]) -> Vec<u32> {
    let pattern = Regex::new(r"(\d+)\s+0\s+R").expect("valid");
    pattern
        .captures_iter(text)
        .filter_map(|c| std::str::from_utf8(&c[1]).ok()?.parse().ok())
        .collect()
}

impl<'a> PdfIndex<'a> {
    /// The dictionary of an object, without its `N 0 obj` header.
    fn dict(&self, number: u32) -> Option<&'a [u8]> {
        let object = self.object(number)?;
        let at = find_from(object, b"obj", 0)? + 3;
        Some(&object[at..])
    }

    /// A value that may be given directly or as a reference.
    fn resolve(&self, value: &'a [u8]) -> Option<&'a [u8]> {
        match as_ref(value) {
            Some(n) => self.dict(n).map(|d| d.trim_ascii()),
            None => Some(value),
        }
    }

    /// An object's stream, inflated if it is compressed.
    fn stream(&self, number: u32) -> Option<Vec<u8>> {
        let start = *self.offsets.get(&number)?;
        let end = find_from(self.bytes, b"endobj", start)?;
        let at = find_from(self.bytes, b"stream", start).filter(|&s| s < end)?;
        let dict = &self.bytes[start..at];
        let length = self.resolve(value(dict, "/Length")?).and_then(as_number)? as usize;
        let mut data = at + 6;
        if self.bytes.get(data) == Some(&b'\r') {
            data += 1;
        }
        if self.bytes.get(data) == Some(&b'\n') {
            data += 1;
        }
        let raw = self.bytes.get(data..data + length)?;
        if find_from(dict, b"/FlateDecode", 0).is_some() {
            let mut out = Vec::new();
            flate2::read::ZlibDecoder::new(raw).read_to_end(&mut out).ok()?;
            Some(out)
        } else {
            Some(raw.to_vec())
        }
    }
}

/// What a font's codes mean, and how wide each is.
#[derive(Debug, Default)]
struct Font {
    base: String,
    code_bytes: usize,
    unicode: HashMap<Vec<u8>, String>,
    widths: HashMap<Vec<u8>, f64>,
    default_width: f64,
    flipped: bool,
}

fn hex_bytes(hex: &[u8]) -> Vec<u8> {
    let digits: Vec<u8> = hex.iter().copied().filter(u8::is_ascii_hexdigit).collect();
    digits
        .chunks(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).unwrap_or("0");
            let text = if text.len() == 1 { format!("{text}0") } else { text.to_string() };
            u8::from_str_radix(&text, 16).unwrap_or(0)
        })
        .collect()
}

fn utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes.chunks(2).map(|p| u16::from_be_bytes([p[0], *p.get(1).unwrap_or(&0)])).collect();
    String::from_utf16_lossy(&units)
}

fn to_unicode(cmap: &[u8]) -> HashMap<Vec<u8>, String> {
    let mut table = HashMap::new();
    let hex = Regex::new(r"<([0-9A-Fa-f]*)>").expect("valid");
    let block = Regex::new(r"(?s)beginbf(char|range)(.*?)endbf(char|range)").expect("valid");
    for section in block.captures_iter(cmap) {
        let body = &section[2];
        if &section[1] == b"char" {
            let values: Vec<Vec<u8>> = hex.captures_iter(body).map(|c| hex_bytes(&c[1])).collect();
            for pair in values.chunks(2) {
                if let [code, text] = pair {
                    table.insert(code.clone(), utf16(text));
                }
            }
            continue;
        }
        // Each range is `<lo> <hi> <start>` or `<lo> <hi> [<a> <b> ...]`.
        let line = Regex::new(r"(?s)<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])").expect("valid");
        for range in line.captures_iter(body) {
            let low = hex_bytes(&range[1]);
            let high = hex_bytes(&range[2]);
            let width = low.len();
            let as_number = |b: &[u8]| b.iter().fold(0u32, |n, &x| (n << 8) | u32::from(x));
            let (lo, hi) = (as_number(&low), as_number(&high));
            let code = |n: u32| n.to_be_bytes()[4 - width..].to_vec();
            if range[3].starts_with(b"[") {
                for (i, text) in hex.captures_iter(&range[3]).enumerate() {
                    table.insert(code(lo + i as u32), utf16(&hex_bytes(&text[1])));
                }
            } else {
                let start = hex_bytes(&range[3]);
                let mut units: Vec<u16> =
                    start.chunks(2).map(|p| u16::from_be_bytes([p[0], *p.get(1).unwrap_or(&0)])).collect();
                for n in lo..=hi.min(lo + 0xFFFF) {
                    table.insert(code(n), String::from_utf16_lossy(&units));
                    if let Some(last) = units.last_mut() {
                        *last = last.wrapping_add(1);
                    }
                }
            }
        }
    }
    table
}

/// The numbers in a PDF array, with nested arrays flattened into their own lists.
fn array_items(text: &[u8]) -> Vec<Result<f64, Vec<f64>>> {
    let text = String::from_utf8_lossy(text);
    let inner = text.trim().trim_start_matches('[');
    let inner = inner.strip_suffix(']').unwrap_or(inner);
    let mut out = Vec::new();
    let mut nested: Option<Vec<f64>> = None;
    for token in inner.replace('[', " [ ").replace(']', " ] ").split_whitespace() {
        match token {
            "[" => nested = Some(Vec::new()),
            "]" => out.extend(nested.take().map(Err)),
            n => {
                if let Ok(n) = n.parse() {
                    match nested.as_mut() {
                        Some(list) => list.push(n),
                        None => out.push(Ok(n)),
                    }
                }
            }
        }
    }
    out
}

fn read_font(pdf: &PdfIndex, number: u32) -> Option<Font> {
    let dict = pdf.dict(number)?;
    if value(dict, "/Type") != Some(b"/Font".as_slice()) {
        return None;
    }
    // Cairo embeds Type3 fonts, which name themselves only in their descriptor.
    let name = value(dict, "/BaseFont").or_else(|| {
        let descriptor = pdf.dict(value(dict, "/FontDescriptor").and_then(as_ref)?)?;
        value(descriptor, "/FontName")
    })?;
    let base = String::from_utf8_lossy(name).trim_start_matches('/').to_string();
    let unicode = value(dict, "/ToUnicode")
        .and_then(as_ref)
        .and_then(|n| pdf.stream(n))
        .map(|cmap| to_unicode(&cmap))
        .unwrap_or_default();
    // Cairo's Type3 glyphs are drawn upside down, for its flipped page.
    let flipped = value(dict, "/FontMatrix").is_some_and(|m| matches!(array_items(m).get(3), Some(Ok(d)) if *d < 0.0));
    let mut font = Font { base, code_bytes: 1, unicode, default_width: 500.0, flipped, ..Font::default() };
    let subtype = value(dict, "/Subtype").unwrap_or(b"");
    if subtype == b"/Type0" {
        font.code_bytes = 2;
        let descendant = value(dict, "/DescendantFonts").and_then(|v| pdf.resolve(v))?;
        let descendant = pdf.dict(*references(descendant).first()?)?;
        font.default_width = value(descendant, "/DW").and_then(as_number).unwrap_or(1000.0);
        if let Some(widths) = value(descendant, "/W").and_then(|v| pdf.resolve(v)) {
            let items = array_items(widths);
            let mut i = 0;
            while i < items.len() {
                match (&items[i], items.get(i + 1), items.get(i + 2)) {
                    (Ok(first), Some(Err(list)), _) => {
                        for (k, w) in list.iter().enumerate() {
                            font.widths.insert(((*first as u32 + k as u32) as u16).to_be_bytes().to_vec(), *w);
                        }
                        i += 2;
                    }
                    (Ok(first), Some(Ok(last)), Some(Ok(w))) => {
                        for c in (*first as u32)..=(*last as u32).min(*first as u32 + 0xFFFF) {
                            font.widths.insert((c as u16).to_be_bytes().to_vec(), *w);
                        }
                        i += 3;
                    }
                    _ => i += 1,
                }
            }
        }
    } else {
        let first = value(dict, "/FirstChar").and_then(as_number).unwrap_or(0.0) as u32;
        if let Some(widths) = value(dict, "/Widths").and_then(|v| pdf.resolve(v)) {
            for (k, w) in array_items(widths).into_iter().enumerate() {
                if let Ok(w) = w {
                    font.widths.insert(vec![(first + k as u32) as u8], w);
                }
            }
        }
    }
    Some(font)
}

/// The fonts a page uses, by resource name.
fn page_fonts(pdf: &PdfIndex, page: u32) -> HashMap<Vec<u8>, Font> {
    let mut fonts = HashMap::new();
    let Some(resources) = pdf.dict(page).and_then(|d| value(d, "/Resources")).and_then(|v| pdf.resolve(v)) else {
        return fonts;
    };
    let Some(font_dict) = value(resources, "/Font").and_then(|v| pdf.resolve(v)) else {
        return fonts;
    };
    let entry = Regex::new(r"/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R").expect("valid");
    for capture in entry.captures_iter(font_dict) {
        let number = std::str::from_utf8(&capture[2]).ok().and_then(|n| n.parse().ok());
        if let Some(font) = number.and_then(|n| read_font(pdf, n)) {
            fonts.insert(capture[1].to_vec(), font);
        }
    }
    fonts
}

fn literal_string(bytes: &[u8], at: usize) -> (Vec<u8>, usize) {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut i = at + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => {
                i += 1;
                match bytes.get(i) {
                    Some(b'n') => out.push(b'\n'),
                    Some(b'r') => out.push(b'\r'),
                    Some(b't') => out.push(b'\t'),
                    Some(b'b') => out.push(8),
                    Some(b'f') => out.push(12),
                    Some(d) if (b'0'..=b'7').contains(d) => {
                        let digits: Vec<u8> = bytes[i..].iter().take(3).take_while(|b| (b'0'..=b'7').contains(b)).copied().collect();
                        out.push(u8::from_str_radix(std::str::from_utf8(&digits).unwrap_or("0"), 8).unwrap_or(0));
                        i += digits.len() - 1;
                    }
                    Some(&other) => out.push(other),
                    None => {}
                }
            }
            b'(' => {
                depth += 1;
                out.push(b'(');
            }
            b')' if depth == 0 => return (out, i + 1),
            b')' => {
                depth -= 1;
                out.push(b')');
            }
            b => out.push(b),
        }
        i += 1;
    }
    (out, i)
}

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `first` then `second`.
fn multiply(first: &Matrix, second: &Matrix) -> Matrix {
    let [a, b, c, d, e, f] = *first;
    let [a2, b2, c2, d2, e2, f2] = *second;
    [a * a2 + b * c2, a * b2 + b * d2, c * a2 + d * c2, c * b2 + d * d2, e * a2 + f * c2 + e2, e * b2 + f * d2 + f2]
}

fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// A box on the page, as left, bottom, right and top.
type Rect = [f64; 4];

fn intersect(a: Option<Rect>, b: Rect) -> Option<Rect> {
    Some(match a {
        None => b,
        Some(a) => [a[0].max(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].min(b[3])],
    })
}

/// The text a content stream shows, decoded through each font's ToUnicode map. With
/// `visible_only`, text that starts outside the clip is left out: the engine draws what
/// reaches over a page's edge on both pages, and clips it away on one of them.
fn stream_text(content: &[u8], fonts: &HashMap<Vec<u8>, Font>, visible_only: bool) -> String {
    let mut text = String::new();
    let mut font: Option<&Font> = None;
    let mut last_name: Vec<u8> = Vec::new();
    let mut operands: Vec<f64> = Vec::new();
    let mut ctm = IDENTITY;
    let mut clip: Option<Rect> = None;
    let mut saved: Vec<(Matrix, Option<Rect>)> = Vec::new();
    let mut path: Option<Rect> = None;
    let mut clipping = false;
    let (mut tm, mut tlm) = (IDENTITY, IDENTITY);
    let mut leading = 0.0;
    let mut i = 0;
    let decode = |bytes: &[u8], font: Option<&Font>, text: &mut String, tm: &Matrix, ctm: &Matrix, clip: &Option<Rect>| {
        let Some(font) = font else { return };
        if visible_only {
            if let Some([left, bottom, right, top]) = *clip {
                let (x, y) = apply(&multiply(tm, ctm), 0.0, 0.0);
                if x < left - 0.5 || x > right + 0.5 || y < bottom - 0.5 || y > top + 0.5 {
                    return;
                }
            }
        }
        for code in bytes.chunks(font.code_bytes) {
            if let Some(t) = font.unicode.get(code) {
                text.push_str(t);
            }
        }
    };
    while i < content.len() {
        let b = content[i];
        match b {
            b'%' => {
                while i < content.len() && content[i] != b'\n' {
                    i += 1;
                }
            }
            b'(' => {
                let (bytes, end) = literal_string(content, i);
                decode(&bytes, font, &mut text, &tm, &ctm, &clip);
                i = end;
                continue;
            }
            b'<' if content.get(i + 1) == Some(&b'<') => i += 1,
            b'<' => {
                let end = find_from(content, b">", i).unwrap_or(content.len());
                decode(&hex_bytes(&content[i + 1..end]), font, &mut text, &tm, &ctm, &clip);
                i = end + 1;
                continue;
            }
            b'/' => {
                let start = i + 1;
                i += 1;
                while i < content.len() && !is_delimiter(content[i]) {
                    i += 1;
                }
                last_name = content[start..i].to_vec();
                continue;
            }
            b'[' | b']' => {}
            _ if b.is_ascii_digit() || b == b'-' || b == b'+' || b == b'.' => {
                let start = i;
                while i < content.len() && !is_delimiter(content[i]) {
                    i += 1;
                }
                if let Some(n) = std::str::from_utf8(&content[start..i]).ok().and_then(|t| t.parse().ok()) {
                    operands.push(n);
                }
                continue;
            }
            _ if b.is_ascii_alphabetic() || b == b'\'' || b == b'"' || b == b'*' => {
                let start = i;
                while i < content.len() && !is_delimiter(content[i]) {
                    i += 1;
                }
                let six = |o: &[f64]| -> Option<Matrix> {
                    let o = o.get(o.len().checked_sub(6)?..)?;
                    Some([o[0], o[1], o[2], o[3], o[4], o[5]])
                };
                let two = |o: &[f64]| -> Option<(f64, f64)> { Some((o[o.len().checked_sub(2)?], o[o.len() - 1])) };
                match &content[start..i] {
                    b"q" => saved.push((ctm, clip)),
                    b"Q" => {
                        if let Some((m, c)) = saved.pop() {
                            ctm = m;
                            clip = c;
                        }
                    }
                    b"cm" => {
                        if let Some(m) = six(&operands) {
                            ctm = multiply(&m, &ctm);
                        }
                    }
                    b"re" => {
                        if let Some(o) = operands.get(operands.len().saturating_sub(4)..).filter(|o| o.len() == 4) {
                            let corners = [(o[0], o[1]), (o[0] + o[2], o[1] + o[3])].map(|(x, y)| apply(&ctm, x, y));
                            let rect = [
                                corners[0].0.min(corners[1].0),
                                corners[0].1.min(corners[1].1),
                                corners[0].0.max(corners[1].0),
                                corners[0].1.max(corners[1].1),
                            ];
                            path = Some(match path {
                                None => rect,
                                Some(p) => [p[0].min(rect[0]), p[1].min(rect[1]), p[2].max(rect[2]), p[3].max(rect[3])],
                            });
                        }
                    }
                    b"W" | b"W*" => clipping = true,
                    b"n" | b"f" | b"F" | b"f*" | b"S" | b"s" | b"B" | b"B*" | b"b" | b"b*" => {
                        if clipping {
                            if let Some(p) = path {
                                clip = intersect(clip, p);
                            }
                        }
                        clipping = false;
                        path = None;
                    }
                    b"BT" => {
                        tm = IDENTITY;
                        tlm = IDENTITY;
                    }
                    b"Tm" => {
                        if let Some(m) = six(&operands) {
                            tm = m;
                            tlm = m;
                        }
                    }
                    b"Td" | b"TD" => {
                        if let Some((x, y)) = two(&operands) {
                            if &content[start..i] == b"TD" {
                                leading = -y;
                            }
                            tlm = multiply(&[1.0, 0.0, 0.0, 1.0, x, y], &tlm);
                            tm = tlm;
                        }
                        text.push(' ');
                    }
                    b"TL" => leading = operands.last().copied().unwrap_or(leading),
                    b"T*" | b"'" | b"\"" => {
                        tlm = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -leading], &tlm);
                        tm = tlm;
                        text.push(' ');
                    }
                    b"Tf" => font = fonts.get(&last_name),
                    // Inline images hold raw bytes, which must not be read as text.
                    b"ID" => i = find_from(content, b"EI", i).unwrap_or(content.len()),
                    b"ET" => text.push(' '),
                    _ => {}
                }
                operands.clear();
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    text
}

fn page_text_where(pdf: &PdfIndex, page: u32, visible_only: bool) -> String {
    let fonts = page_fonts(pdf, page);
    let Some(contents) = pdf.dict(page).and_then(|d| value(d, "/Contents")) else {
        return String::new();
    };
    // A page's streams run on as one, so the drawing state carries across them.
    let mut all = Vec::new();
    for number in references(contents) {
        if let Some(stream) = pdf.stream(number) {
            all.extend_from_slice(&stream);
            all.push(b'\n');
        }
    }
    stream_text(&all, &fonts, visible_only)
}

#[cfg(test)]
fn page_text(pdf: &PdfIndex, page: u32) -> String {
    page_text_where(pdf, page, false)
}

/// The page count, and the 1-based page each `LCMK<n>Q` marker is on, by `n`.
pub fn markers(bytes: &[u8]) -> Option<(usize, HashMap<String, usize>)> {
    let pdf = PdfIndex::read(bytes)?;
    let pages = page_objects(&pdf)?;
    let pattern = regex::Regex::new(r"LCMK(\d+)Q").ok()?;
    let mut found = HashMap::new();
    for (index, &page) in pages.iter().enumerate() {
        // Letters can be spaced apart in the text, so spaces are dropped first.
        let text: String = page_text_where(&pdf, page, true).chars().filter(|c| !c.is_whitespace()).collect();
        for capture in pattern.captures_iter(&text) {
            found.entry(capture[1].to_string()).or_insert(index + 1);
        }
    }
    Some((pages.len(), found))
}

// ---------------------------------------------------------------------------
// Adding the margin boxes
// ---------------------------------------------------------------------------

fn normalized(name: &str) -> String {
    name.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase()
}

fn is_italic(base: &str) -> bool {
    let base = base.to_ascii_lowercase();
    base.contains("italic") || base.contains("oblique") || base.ends_with("-it") || base.ends_with("it") && base.contains('-')
}

fn is_bold(base: &str) -> bool {
    let base = base.to_ascii_lowercase();
    ["bold", "semibold", "black", "heavy", "medium"].iter().any(|w| base.contains(w))
}

/// A font from the measuring print that can set `text`.
struct Source {
    number: u32,
    font: Font,
}

fn find_font<'f>(fonts: &'f [Source], wanted: &MarginBox) -> Option<&'f Source> {
    let reverse = |font: &Font| -> HashSet<String> { font.unicode.values().cloned().collect() };
    let generic = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"];
    for family in wanted.families.iter().filter(|f| !generic.contains(&f.as_str())) {
        let family = normalized(family);
        let found = fonts.iter().find(|source| {
            let base = source.font.base.split_once('+').map_or(source.font.base.as_str(), |(_, b)| b);
            let has = reverse(&source.font);
            normalized(base).starts_with(&family)
                && is_italic(base) == wanted.italic
                && is_bold(base) == wanted.bold
                && wanted.text.chars().filter(|c| *c != ' ').all(|c| has.contains(&c.to_string()))
        });
        if found.is_some() {
            return found;
        }
    }
    None
}

/// Copies objects from one PDF into the update for another, numbering them anew.
struct Copier<'a> {
    from: &'a PdfIndex<'a>,
    next: u32,
    map: HashMap<u32, u32>,
    out: Vec<(u32, Vec<u8>)>,
}

impl Copier<'_> {
    fn copy(&mut self, number: u32) -> Option<u32> {
        if let Some(&n) = self.map.get(&number) {
            return Some(n);
        }
        let new = self.next;
        self.next += 1;
        self.map.insert(number, new);
        let start = *self.from.offsets.get(&number)?;
        let end = find_from(self.from.bytes, b"endobj", start)?;
        let object = &self.from.bytes[start..end];
        let header = find_from(object, b"obj", 0)? + 3;
        let split = find_from(object, b"stream", header).unwrap_or(object.len());
        let dict = &object[header..split];
        let pattern = Regex::new(r"(\d+)\s+0\s+R").expect("valid");
        let mut rewritten = Vec::new();
        let mut last = 0;
        for capture in pattern.captures_iter(dict) {
            let whole = capture.get(0)?;
            let old: u32 = std::str::from_utf8(&capture[1]).ok()?.parse().ok()?;
            let renumbered = self.copy(old)?;
            rewritten.extend_from_slice(&dict[last..whole.start()]);
            rewritten.extend_from_slice(format!("{renumbered} 0 R").as_bytes());
            last = whole.end();
        }
        rewritten.extend_from_slice(&dict[last..]);
        let mut body = format!("{new} 0 obj").into_bytes();
        body.extend_from_slice(&rewritten);
        body.extend_from_slice(&object[split..]);
        body.extend_from_slice(b"endobj\n");
        self.out.push((new, body));
        Some(new)
    }
}

fn pdf_number(n: f64) -> String {
    let text = format!("{n:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" || text.is_empty() {
        "0".to_string()
    } else {
        text.to_string()
    }
}

/// Times' widths for the letters people use most, in thousandths of an em.
fn times_width(c: char) -> f64 {
    match c {
        ' ' => 250.0,
        '0'..='9' => 500.0,
        'i' | 'j' | 'l' | 't' | 'f' | 'r' | '.' | ',' | ':' | ';' | '\'' | '!' | '/' => 300.0,
        'm' | 'w' | 'M' | 'W' => 800.0,
        'A'..='Z' => 680.0,
        _ => 480.0,
    }
}

/// The text of a margin box as a PDF string in a font, with its width in points.
fn set_text(text: &str, size: f64, font: Option<&Font>) -> (String, f64) {
    let Some(font) = font else {
        // Times takes WinAnsi codes, which for these letters are Latin-1.
        let mut hex = String::new();
        let mut width = 0.0;
        for c in text.chars() {
            let code = if (c as u32) < 256 { c as u32 } else { u32::from(b'?') };
            hex.push_str(&format!("{code:02X}"));
            width += times_width(c);
        }
        return (format!("<{hex}>"), width * size / 1000.0);
    };
    let mut reverse: HashMap<&str, &Vec<u8>> = HashMap::new();
    for (code, unicode) in &font.unicode {
        reverse.entry(unicode.as_str()).or_insert(code);
    }
    let mut hex = String::new();
    let mut width = 0.0;
    for c in text.chars() {
        let key = c.to_string();
        let Some(code) = reverse.get(key.as_str()).copied().or_else(|| (c == ' ').then(|| reverse.get("\u{a0}").copied()).flatten())
        else {
            // A space the subset lacks is left as a gap.
            width += 250.0;
            hex.push_str(&format!("> {} <", pdf_number(-250.0)));
            continue;
        };
        for byte in code {
            hex.push_str(&format!("{byte:02X}"));
        }
        width += font.widths.get(code).copied().unwrap_or(font.default_width);
    }
    (format!("[<{hex}>] TJ"), width * size / 1000.0)
}

/// What the print page tells `stamp`.
pub struct Layout<'a> {
    pub css: &'a str,
    /// The named page each page belongs to, empty for none.
    pub names: &'a [String],
    /// The margins the engine printed every page with.
    pub printed: Sheet,
}

/// Adds the margin boxes, and moves pages to their own left margin. Returns `None` if the
/// PDF cannot be read, in which case the caller keeps the PDF as it was.
pub fn stamp(bytes: Vec<u8>, measured: Option<&[u8]>, layout: &Layout) -> Option<Vec<u8>> {
    let styles = PageStyles::parse(layout.css);
    let pdf = PdfIndex::read(&bytes)?;
    let pages = page_objects(&pdf)?;
    let measured_index = measured.and_then(PdfIndex::read);
    let sources: Vec<Source> = measured_index
        .as_ref()
        .map(|m| {
            let mut numbers: Vec<u32> = m.offsets.keys().copied().collect();
            numbers.sort_unstable();
            numbers
                .into_iter()
                .filter_map(|n| {
                    let font = read_font(m, n)?;
                    Some(Source { number: n, font })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut next = pdf.size.max(pdf.offsets.keys().max().map_or(0, |m| m + 1));
    let mut objects: Vec<(u32, Vec<u8>)> = Vec::new();
    let add = |objects: &mut Vec<(u32, Vec<u8>)>, next: &mut u32, body: Vec<u8>| -> u32 {
        let n = *next;
        *next += 1;
        let mut object = format!("{n} 0 obj\n").into_bytes();
        object.extend_from_slice(&body);
        object.extend_from_slice(b"\nendobj\n");
        objects.push((n, object));
        n
    };
    let stream_body = |content: &[u8]| -> Vec<u8> {
        let mut body = format!("<</Length {}>>\nstream\n", content.len()).into_bytes();
        body.extend_from_slice(content);
        body.extend_from_slice(b"\nendstream");
        body
    };

    // Fonts are copied the first time a box needs them: resource name and copied number.
    let mut copied: HashMap<u32, (String, u32)> = HashMap::new();
    let mut times: Option<u32> = None;
    let close = add(&mut objects, &mut next, stream_body(b"Q\n"));
    let mut opens: HashMap<String, u32> = HashMap::new();
    let mut page_updates = Vec::new();

    for (index, &page) in pages.iter().enumerate() {
        let number = index + 1;
        let name = layout.names.get(index).map_or("", String::as_str);
        let sheet = styles.sheet(number, name, Side::of(number));
        let dict = pdf.dict(page)?;
        let media = value(dict, "/MediaBox").map(array_items).unwrap_or_default();
        let size = |i: usize, fallback: f64| match media.get(i) {
            Some(Ok(v)) => *v,
            _ => fallback,
        };
        let (width, height) = (size(2, sheet.width) - size(0, 0.0), size(3, sheet.height) - size(1, 0.0));

        let mut content = String::new();
        let mut fonts_used: Vec<(String, u32)> = Vec::new();
        for margin_box in styles.boxes(number, pages.len(), name) {
            let source = find_font(&sources, &margin_box);
            let (resource, font) = match (source, measured_index.as_ref()) {
                (Some(source), Some(from)) => {
                    let entry = match copied.get(&source.number) {
                        Some(entry) => entry.clone(),
                        None => {
                            let mut copier = Copier { from, next, map: HashMap::new(), out: Vec::new() };
                            let new = copier.copy(source.number)?;
                            next = copier.next;
                            objects.extend(copier.out);
                            let entry = (format!("LCF{}", copied.len()), new);
                            copied.insert(source.number, entry.clone());
                            entry
                        }
                    };
                    (entry, Some(&source.font))
                }
                _ => {
                    let n = *times.get_or_insert_with(|| {
                        add(
                            &mut objects,
                            &mut next,
                            b"<</Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding>>".to_vec(),
                        )
                    });
                    (("LCFT".to_string(), n), None)
                }
            };
            let (shown, text_width) = set_text(&margin_box.text, margin_box.size, font);
            let [top, right, bottom, left] = sheet.margins;
            let x = match margin_box.at {
                "top-left" | "bottom-left" => left,
                "top-right" | "bottom-right" => width - right - text_width,
                _ => (left + width - right - text_width) / 2.0,
            };
            // Centred in the margin, as a margin box's text is by default.
            let middle = if margin_box.at.starts_with("top") { height - top / 2.0 } else { bottom / 2.0 };
            let y = middle - margin_box.size * 0.35;
            let [r, g, b] = margin_box.color;
            let shown = if shown.ends_with("TJ") { shown } else { format!("{shown} Tj") };
            let flip = if font.is_some_and(|f| f.flipped) { "-1" } else { "1" };
            content.push_str(&format!(
                "BT /{} {} Tf {} {} {} rg 1 0 0 {flip} {} {} Tm {} ET\n",
                resource.0,
                pdf_number(margin_box.size),
                pdf_number(r),
                pdf_number(g),
                pdf_number(b),
                pdf_number(x),
                pdf_number(y),
                shown
            ));
            if !fonts_used.contains(&resource) {
                fonts_used.push(resource);
            }
        }

        let shift = sheet.margins[3] - layout.printed.margins[3];
        if content.is_empty() && shift.abs() < 0.01 {
            continue;
        }
        let shift_text = pdf_number(shift);
        let open = match opens.get(&shift_text) {
            Some(&n) => n,
            None => {
                let n = add(&mut objects, &mut next, stream_body(format!("q 1 0 0 1 {shift_text} 0 cm\n").as_bytes()));
                opens.insert(shift_text, n);
                n
            }
        };
        let mut contents = format!("[{open} 0 R ");
        for n in references(value(dict, "/Contents").unwrap_or(b"")) {
            contents.push_str(&format!("{n} 0 R "));
        }
        contents.push_str(&format!("{close} 0 R"));
        if !content.is_empty() {
            let stamp = add(&mut objects, &mut next, stream_body(content.as_bytes()));
            contents.push_str(&format!(" {stamp} 0 R"));
        }
        contents.push(']');
        page_updates.push((page, dict, contents, fonts_used));
    }

    for (page, dict, contents, fonts_used) in page_updates {
        let mut dict = dict.to_vec();
        if !fonts_used.is_empty() {
            let entries: String = fonts_used.iter().map(|(name, n)| format!("/{name} {n} 0 R ")).collect();
            let resources = value(&dict, "/Resources").and_then(|v| pdf.resolve(v)).unwrap_or(b"<<>>").to_vec();
            let resources = match value_span(&resources, "/Font") {
                Some((start, end)) => {
                    let fonts = pdf.resolve(&resources[start..end]).unwrap_or(b"<<>>").to_vec();
                    let mut merged = fonts.clone();
                    let at = find_from(&merged, b"<<", 0).map_or(0, |a| a + 2);
                    merged.splice(at..at, entries.bytes());
                    let mut out = resources[..start].to_vec();
                    out.extend_from_slice(&merged);
                    out.extend_from_slice(&resources[end..]);
                    out
                }
                None => {
                    let at = find_from(&resources, b"<<", 0).map_or(0, |a| a + 2);
                    let mut out = resources.clone();
                    out.splice(at..at, format!("/Font <<{entries}>> ").bytes());
                    out
                }
            };
            match value_span(&dict, "/Resources") {
                Some((start, end)) => {
                    dict.splice(start..end, resources);
                }
                None => {
                    let at = find_from(&dict, b"<<", 0).map_or(0, |a| a + 2);
                    let mut entry = b"/Resources ".to_vec();
                    entry.extend_from_slice(&resources);
                    entry.push(b' ');
                    dict.splice(at..at, entry);
                }
            }
        }
        match value_span(&dict, "/Contents") {
            Some((start, end)) => {
                dict.splice(start..end, contents.bytes());
            }
            None => {
                let at = find_from(&dict, b"<<", 0).map_or(0, |a| a + 2);
                dict.splice(at..at, format!("/Contents {contents} ").bytes());
            }
        }
        let mut object = format!("{page} 0 obj").into_bytes();
        object.extend_from_slice(&dict);
        object.extend_from_slice(b"endobj\n");
        objects.push((page, object));
    }

    if objects.is_empty() {
        return Some(bytes);
    }
    let mut out = bytes.clone();
    if !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    let mut offsets = Vec::new();
    for (number, object) in &objects {
        offsets.push((*number, out.len()));
        out.extend_from_slice(object);
    }
    offsets.sort_unstable();
    let xref_at = out.len();
    out.extend_from_slice(b"xref\n");
    for (number, offset) in &offsets {
        out.extend_from_slice(format!("{number} 1\n{offset:010} 00000 n \n").as_bytes());
    }
    let size = next.max(pdf.size);
    let mut trailer = format!("trailer\n<</Size {size}\n/Root {} 0 R", pdf.root);
    if let Some(info) = pdf.info {
        trailer.push_str(&format!("\n/Info {info} 0 R"));
    }
    trailer.push_str(&format!("\n/Prev {}>>\nstartxref\n{xref_at}\n%%EOF\n", pdf.start_xref));
    out.extend_from_slice(trailer.as_bytes());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOK: &str = r#"
@page { size: 6in 9in; margin-top: 0.8in; margin-bottom: 0.8in; }
@page :left { margin-left: 0.625in; margin-right: 0.875in; @bottom-left { content: counter(page); font-family: 'Source Serif 4', serif; font-size: 9pt; } }
@page :right { margin-left: 0.875in; margin-right: 0.625in; @bottom-right { content: counter(page); font-family: 'Source Serif 4', serif; font-size: 9pt; } }
@page :left { @top-left { content: "The \"Salt\" march"; font-family: 'Source Serif 4', serif; font-size: 9pt; font-style: italic; } }
@counter-style lc-no-head { system: cyclic; symbols: ""; }
@counter-style running-1-left-words { system: cyclic; symbols: "Book"; }
@counter-style running-1-right-words { system: cyclic; symbols: "Chapter One"; }
@counter-style running-1-left { system: extends running-1-left-words; }
@counter-style running-1-right { system: extends running-1-right-words; }
@page running-1:left { @top-left { content: counter(page, running-1-left); font-style: italic; } }
@page running-1:right { @top-right { content: counter(page, running-1-right); font-style: italic; } }
@page title-page:left { @top-left { content: none; } @bottom-left { content: none; } }
@page title-page:right { @top-right { content: none; } @bottom-right { content: none; } }
@counter-style running-1-right { system: extends running-1-right-words; range: 5 infinite; fallback: lc-no-head; }
"#;

    fn texts(styles: &PageStyles, page: usize, name: &str) -> Vec<(&'static str, String)> {
        styles.boxes(page, 10, name).into_iter().map(|b| (b.at, b.text)).collect()
    }

    #[test]
    fn page_rules_cascade_by_name_then_side_then_order() {
        let styles = PageStyles::parse(BOOK);
        assert_eq!(texts(&styles, 1, "title-page"), vec![]);
        assert_eq!(texts(&styles, 2, ""), vec![("top-left", "The \"Salt\" march".into()), ("bottom-left", "2".into())]);
        assert_eq!(texts(&styles, 3, ""), vec![("bottom-right", "3".into())]);
        // The later counter style narrows the chapter's head to the pages after its first.
        assert_eq!(texts(&styles, 3, "running-1"), vec![("bottom-right", "3".into())]);
        assert_eq!(texts(&styles, 5, "running-1"), vec![("top-right", "Chapter One".into()), ("bottom-right", "5".into())]);
        assert_eq!(texts(&styles, 4, "running-1")[0], ("top-left", "Book".into()));
        let head = &styles.boxes(4, 10, "running-1")[0];
        assert!(head.italic && head.families[0] == "Source Serif 4" && (head.size - 9.0).abs() < 1e-9);
    }

    #[test]
    fn each_side_has_its_own_margins() {
        let styles = PageStyles::parse(BOOK);
        let right = styles.sheet(1, "", Side::Right);
        let left = styles.sheet(2, "", Side::Left);
        assert_eq!((right.width, right.height), (432.0, 648.0));
        assert_eq!((right.margins[3], right.margins[1]), (63.0, 45.0));
        assert_eq!((left.margins[3], left.margins[1]), (45.0, 63.0));
        assert!((left.margins[0] - 57.6).abs() < 1e-9);
    }

    #[test]
    fn manuscript_heads_join_words_and_numbers() {
        let styles = PageStyles::parse(
            "@page { size: 8.5in 11in; margin: 1in; @top-right { content: \"Doe / Book / \" counter(page); font-size: 12pt; color: #555; } }\n@page title-page { @top-right { content: none; } }",
        );
        let boxes = styles.boxes(3, 9, "");
        assert_eq!(boxes[0].text, "Doe / Book / 3");
        assert!((boxes[0].color[0] - 0x55 as f64 / 255.0).abs() < 1e-9);
        assert!(styles.boxes(1, 9, "title-page").is_empty());
    }

    /// A PDF the way cairo writes them: a simple font with a ToUnicode map, one content
    /// stream per page, resources by reference.
    fn sample(pages: &[&str], font_name: &str) -> Vec<u8> {
        // Codes 1.. stand for these letters, in order.
        let alphabet: Vec<char> = "LCMKQ0123456789 ThecapCrOn\"Slt".chars().collect();
        let encode = |text: &str| -> String {
            text.chars().map(|c| format!("{:02X}", alphabet.iter().position(|&a| a == c).unwrap() + 1)).collect()
        };
        let mut cmap = String::from("begincmap\n1 begincodespacerange <00> <FF> endcodespacerange\n");
        cmap.push_str(&format!("{} beginbfchar\n", alphabet.len()));
        for (i, c) in alphabet.iter().enumerate() {
            cmap.push_str(&format!("<{:02X}> <{:04X}>\n", i + 1, *c as u32));
        }
        cmap.push_str("endbfchar\nendcmap\n");
        let widths: Vec<String> = alphabet.iter().map(|_| "500".to_string()).collect();
        let mut objects: Vec<String> = vec![
            String::new(), // 1: catalog, filled below
            String::new(), // 2: pages
            format!("<</Length {}>>\nstream\n{cmap}\nendstream", cmap.len() + 1),
            format!("<</Type /Font /Subtype /TrueType /BaseFont /ABCDEF+{font_name} /FirstChar 1 /LastChar {} /Widths [{}] /ToUnicode 3 0 R>>", alphabet.len(), widths.join(" ")),
            "<</Font <</f-0-0 4 0 R>>>>".to_string(),
        ];
        let mut kids = Vec::new();
        for text in pages {
            let content = format!("BT /f-0-0 10 Tf 72 72 Td <{}> Tj ET", encode(text));
            objects.push(format!("<</Length {}>>\nstream\n{content}\nendstream", content.len() + 1));
            let content_number = objects.len();
            objects.push(format!("<</Type /Page /Parent 2 0 R /MediaBox [0 0 432 648] /Resources 5 0 R /Contents {content_number} 0 R>>"));
            kids.push(format!("{} 0 R", objects.len()));
        }
        objects[0] = "<</Type /Catalog /Pages 2 0 R>>".to_string();
        objects[1] = format!("<</Type /Pages /Count {} /Kids [{}]>>", kids.len(), kids.join(" "));
        let mut out = String::from("%PDF-1.5\n");
        let mut offsets = Vec::new();
        for (i, object) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{object}\nendobj\n", i + 1));
        }
        let xref = out.len();
        out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
        for offset in offsets {
            out.push_str(&format!("{offset:010} 00000 n \n"));
        }
        out.push_str(&format!("trailer\n<</Size {}\n/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1));
        out.into_bytes()
    }

    #[test]
    fn text_drawn_outside_the_clip_does_not_count() {
        let mut font = Font { code_bytes: 1, ..Font::default() };
        for (code, letter) in [(1u8, "A"), (2, "B")] {
            font.unicode.insert(vec![code], letter.to_string());
        }
        let fonts = HashMap::from([(b"f".to_vec(), font)]);
        // Cairo's way: a flipped page, a clip for the page's area, then the long strip of
        // the whole document moved so this page shows through.
        let content = b"1 0 0 -1 0 648 cm q 72 72 288 504 re W* n q .8 0 0 .8 72 -936 cm BT /f 10 Tf 1 0 0 -1 0 1500 Tm <01> Tj ET BT 1 0 0 -1 0 1900 Tm <02> Tj ET Q Q BT /f 10 Tf 0 0 Td <02> Tj ET";
        assert_eq!(stream_text(content, &fonts, true).replace(' ', ""), "AB", "B outside the clip is dropped, then drawn once unclipped");
        assert_eq!(stream_text(content, &fonts, false).replace(' ', ""), "ABB");
    }

    #[test]
    fn markers_are_found_on_their_pages() {
        let pdf = sample(&["The cap", "LCMK1Q LC MK 2Q", "LCMK3Q"], "SourceSerif4-Regular");
        let (pages, found) = markers(&pdf).unwrap();
        assert_eq!(pages, 3);
        assert_eq!(found.get("1"), Some(&2));
        assert_eq!(found.get("2"), Some(&2), "spacing inside a marker does not hide it");
        assert_eq!(found.get("3"), Some(&3));
        assert!(markers(b"not a pdf").is_none());
    }

    #[test]
    fn stamping_adds_numbers_in_the_documents_font_and_moves_left_pages() {
        let css = "@page { size: 6in 9in; margin: 1in; }\n@page :left { margin-left: 0.5in; @bottom-left { content: counter(page); font-family: 'Source Serif 4'; font-size: 9pt; } }\n@page :right { @bottom-right { content: counter(page); font-family: 'Source Serif 4'; font-size: 9pt; } }\n@page quiet:right { @bottom-right { content: none; } }";
        let printed = sample(&["The cap", "The cap", "The cap"], "SourceSerif4-Regular");
        // The measuring print wrote out the digits the boxes need.
        let measured = sample(&["0123456789"], "SourceSerif4Roman-Regular");
        let names = vec!["quiet".to_string(), String::new(), String::new()];
        let layout = Layout { css, names: &names, printed: PageStyles::parse(css).sheet(1, "", Side::Right) };
        let stamped = stamp(printed.clone(), Some(&measured), &layout).unwrap();
        assert!(stamped.starts_with(&printed), "the update only adds to the end");

        let index = PdfIndex::read(&stamped).unwrap();
        let pages = page_objects(&index).unwrap();
        assert_eq!(pages.len(), 3);
        let text = |i: usize| page_text(&index, pages[i]).chars().filter(|c| !c.is_whitespace()).collect::<String>();
        assert_eq!(text(0), "Thecap", "a quiet page gets no number and is not moved");
        assert_eq!(text(1), "Thecap2");
        assert_eq!(text(2), "Thecap3");
        let left = String::from_utf8_lossy(index.dict(pages[1]).unwrap()).to_string();
        let shift = references(value(left.as_bytes(), "/Contents").unwrap())[0];
        assert_eq!(index.stream(shift).unwrap(), b"q 1 0 0 1 -36 0 cm\n".to_vec());
        assert!(left.contains("/LCF0"), "{left}");
        // The copied font is the measured one, with its own ToUnicode map.
        let fonts = page_fonts(&index, pages[1]);
        assert!(fonts.values().any(|f| f.base.ends_with("SourceSerif4Roman-Regular")));
        // Page numbers still come out right once the document info is added after.
        let finished = super::super::print::with_document_info(stamped, "T", "");
        assert_eq!(page_objects(&PdfIndex::read(&finished).unwrap()).unwrap().len(), 3);
    }

    #[test]
    fn without_a_measured_font_it_falls_back_to_times() {
        let css = "@page { size: 6in 9in; margin: 1in; @bottom-center { content: counter(page); font-family: 'Inter'; font-size: 9pt; } }";
        let printed = sample(&["The cap"], "SourceSerif4-Regular");
        let layout = Layout { css, names: &[], printed: PageStyles::parse(css).sheet(1, "", Side::Right) };
        let stamped = stamp(printed, None, &layout).unwrap();
        let text = String::from_utf8_lossy(&stamped).to_string();
        assert!(text.contains("/BaseFont /Times-Roman"));
        assert!(text.contains("/LCFT 9 Tf"));
    }
}
