//! Turns HTML into a PDF with the browser engine, in a hidden window of its own. The
//! engine gives us what a PDF library would not: text wrapped around floated pictures,
//! every script through the system's fonts, and working links and bookmarks.
//!
//! `print.pdf` waits while the page in the print window (`src/exporters/print/page.ts`)
//! takes the document with `print.job`, loads it, and calls `print.finish`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(not(target_os = "linux"))]
use base64::Engine as _;
use regex::bytes::Regex;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{ok, parse, unknown};
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

/// How long the print window may take to ask for its document.
const START_TIMEOUT: Duration = Duration::from_secs(60);
const JOB_TIMEOUT: Duration = Duration::from_secs(20 * 60);
#[cfg(not(target_os = "linux"))]
const READ_CHUNK: usize = 4 * 1024 * 1024;

struct Job {
    title: String,
    author: String,
    language: String,
    css: String,
    html: String,
    path: PathBuf,
    /// The last measuring print, whose fonts the margin boxes are set in (Linux).
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    measured: Option<Vec<u8>>,
    /// Set when the page asks for the document, which proves it loaded.
    started: bool,
    done: Sender<Result<Value, AppError>>,
}

static JOB: Mutex<Option<Job>> = Mutex::new(None);

fn job_slot() -> std::sync::MutexGuard<'static, Option<Job>> {
    JOB.lock().unwrap_or_else(|e| e.into_inner())
}

fn finish_job(result: Result<Value, AppError>) {
    if let Some(job) = job_slot().as_ref() {
        let _ = job.done.send(result);
    }
}

/// Lays the page out and returns the PDF as bytes.
#[cfg(target_os = "linux")]
fn print_to_pdf(engine: &Engine) -> AppResult<Vec<u8>> {
    // WebKitGTK takes the paper from the print settings rather than from the page's style
    // sheet, so the sheet is read from the job's @page rule.
    let sheet = job_slot().as_ref().map_or_else(Sheet::default, |job| Sheet::from_css(&job.css));
    engine.host.print_native(&sheet)
}

/// Lays the page out and returns the PDF as bytes.
#[cfg(not(target_os = "linux"))]
fn print_to_pdf(engine: &Engine) -> AppResult<Vec<u8>> {
    let started = engine.host.print_devtools(
        "Page.printToPDF",
        &json!({
            "printBackground": true,
            "preferCSSPageSize": true,
            "generateDocumentOutline": true,
            "generateTaggedPDF": true,
            "transferMode": "ReturnAsStream",
        }),
    )?;
    let handle = started
        .get("stream")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("The browser engine returned no PDF."))?
        .to_string();
    let mut bytes = Vec::new();
    loop {
        let chunk = engine
            .host
            .print_devtools("IO.read", &json!({ "handle": handle, "size": READ_CHUNK }))?;
        let data = chunk.get("data").and_then(Value::as_str).unwrap_or("");
        if chunk.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false) {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|e| AppError::internal(e.to_string()))?;
            bytes.extend_from_slice(&decoded);
        } else {
            bytes.extend_from_slice(data.as_bytes());
        }
        if chunk.get("eof").and_then(Value::as_bool).unwrap_or(true) {
            break;
        }
    }
    let _ = engine.host.print_devtools("IO.close", &json!({ "handle": handle }));
    Ok(bytes)
}

/// The paper and margins of a document's first unnamed @page rule, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sheet {
    pub width: f64,
    pub height: f64,
    /// Top, right, bottom and left.
    pub margins: [f64; 4],
}

impl Default for Sheet {
    /// US Letter with inch margins, what an engine uses with no @page rule.
    fn default() -> Self {
        Self { width: 612.0, height: 792.0, margins: [72.0; 4] }
    }
}

/// A CSS length in points, for the units the document builder writes.
pub(super) fn points(value: &str) -> Option<f64> {
    let value = value.trim();
    let split = value.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(value.len());
    let number: f64 = value[..split].parse().ok()?;
    let scale = match &value[split..] {
        "in" => 72.0,
        "mm" => 72.0 / 25.4,
        "cm" => 72.0 / 2.54,
        "pt" => 1.0,
        "px" => 0.75,
        "pc" => 12.0,
        "" if number == 0.0 => 0.0,
        _ => return None,
    };
    Some(number * scale)
}

impl Sheet {
    /// The paper and margins of the first page, a right-hand page with no name.
    pub fn from_css(css: &str) -> Self {
        super::print_stamp::PageStyles::parse(css).sheet(1, "", super::print_stamp::Side::Right)
    }

    /// WebKitGTK lays a page out 1.25 layout units to the point across the paper less the
    /// CSS margins, where a CSS pixel is 4/3 of a point, then scales that onto the printable
    /// area GTK gives it. Margins that leave 16/15 of the real text area make one unit one
    /// CSS pixel, so text comes out at the size the CSS gives. Where the margins go on the
    /// paper still comes from GTK's print settings.
    pub fn layout_rule(&self) -> String {
        let k = 16.0 / 15.0;
        let [top, right, bottom, left] = self.margins;
        let across = ((self.width - (self.width - left - right) * k) / 2.0).max(0.0);
        let down = ((self.height - (self.height - top - bottom) * k) / 2.0).max(0.0);
        let body = format!("margin: {down:.3}pt {across:.3}pt;");
        format!("@page {{ {body} }} @page :left {{ {body} }} @page :right {{ {body} }} @page :first {{ {body} }}")
    }
}

fn write_file(path: &std::path::Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!("tmp-{}", crate::db::new_id()));
    let result = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        // From the main window.
        "pdf" => make_pdf(engine, params),
        "cancel" => {
            finish_job(Err(AppError::new("CANCELLED", "The PDF was cancelled.")));
            ok(true)
        }
        // From the print window.
        "job" => {
            let mut slot = job_slot();
            let job = slot.as_mut().ok_or_else(|| AppError::not_found("A print job"))?;
            job.started = true;
            ok(json!({
                "title": job.title,
                "language": job.language,
                "css": job.css,
                "html": job.html,
                // The engine draws no margin boxes and marks no destinations, so the page
                // writes markers and `finish` adds the boxes (see print_stamp.rs).
                "native": cfg!(target_os = "linux"),
                "layoutCss": if cfg!(target_os = "linux") { Sheet::from_css(&job.css).layout_rule() } else { String::new() },
            }))
        }
        #[cfg(target_os = "linux")]
        "measure" => {
            let pdf = print_to_pdf(engine)?;
            let (pages, markers) = super::print_stamp::markers(&pdf).unwrap_or_default();
            if let Some(job) = job_slot().as_mut() {
                job.measured = Some(pdf);
            }
            ok(json!({ "pages": pages, "destinations": {}, "markers": markers }))
        }
        #[cfg(not(target_os = "linux"))]
        "measure" => {
            let pdf = print_to_pdf(engine)?;
            let (pages, destinations) = pdf_layout(&pdf).unwrap_or_default();
            ok(json!({ "pages": pages, "destinations": destinations }))
        }
        "finish" => {
            let pdf = print_to_pdf(engine)?;
            let (path, title, author) = {
                let slot = job_slot();
                let job = slot.as_ref().ok_or_else(|| AppError::not_found("A print job"))?;
                (job.path.clone(), job.title.clone(), job.author.clone())
            };
            let pages = pdf_layout(&pdf).map_or(0, |(pages, _)| pages);
            #[cfg(target_os = "linux")]
            let pdf = add_margin_boxes(pdf, params);
            let pdf = with_document_info(pdf, &title, &author);
            let written = write_file(&path, &pdf);
            let size = pdf.len();
            finish_job(written.map(|()| json!({ "path": path, "pages": pages, "size": size })));
            ok(true)
        }
        "fail" => {
            #[derive(Deserialize)]
            struct P {
                message: String,
            }
            let p: P = parse(params)?;
            finish_job(Err(AppError::new("PRINT_FAILED", p.message)));
            ok(true)
        }
        _ => Err(unknown(&format!("print.{action}"))),
    }
}

/// The page numbers and running heads the engine left out, from the style sheet and named
/// pages the print page sends. A PDF that cannot be read is kept as it is.
#[cfg(target_os = "linux")]
fn add_margin_boxes(pdf: Vec<u8>, params: Value) -> Vec<u8> {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct P {
        #[serde(default)]
        css: Option<String>,
        #[serde(default)]
        page_names: Vec<String>,
    }
    let p: P = serde_json::from_value(params).unwrap_or_default();
    let (css, measured) = {
        let mut slot = job_slot();
        let Some(job) = slot.as_mut() else { return pdf };
        (p.css.unwrap_or_else(|| job.css.clone()), job.measured.take())
    };
    let layout = super::print_stamp::Layout { css: &css, names: &p.page_names, printed: Sheet::from_css(&css) };
    match super::print_stamp::stamp(pdf.clone(), measured.as_deref(), &layout) {
        Some(stamped) => stamped,
        None => {
            crate::logs::info("print.margin_boxes_skipped", &[]);
            pdf
        }
    }
}

fn make_pdf(engine: &Engine, params: Value) -> AppResult<Value> {
    #[derive(Deserialize)]
    struct P {
        title: String,
        #[serde(default)]
        author: String,
        #[serde(default)]
        language: String,
        #[serde(default)]
        css: String,
        html: String,
        path: PathBuf,
    }
    let p: P = parse(params)?;
    engine.check_allowed(&p.path)?;
    if !engine.host.supports_pdf() {
        return Err(crate::engine::pdf_not_supported());
    }
    let (done, result) = mpsc::channel();
    {
        let mut slot = job_slot();
        if slot.is_some() {
            return Err(AppError::new("BUSY", "A PDF is already being made."));
        }
        *slot = Some(Job {
            title: p.title,
            author: p.author,
            language: p.language,
            css: p.css,
            html: p.html,
            path: p.path,
            started: false,
            measured: None,
            done,
        });
    }
    let outcome = engine.host.print_window_open().and_then(|()| wait_for_job(&result));
    engine.host.print_window_close();
    *job_slot() = None;
    outcome
}

fn wait_for_job(result: &mpsc::Receiver<Result<Value, AppError>>) -> AppResult<Value> {
    let began = Instant::now();
    loop {
        match result.recv_timeout(Duration::from_millis(500)) {
            Ok(outcome) => return outcome,
            Err(RecvTimeoutError::Disconnected) => {
                return Err(AppError::internal("The print job ended unexpectedly."))
            }
            Err(RecvTimeoutError::Timeout) => {
                let started = job_slot().as_ref().is_some_and(|job| job.started);
                let elapsed = began.elapsed();
                if (!started && elapsed > START_TIMEOUT) || elapsed > JOB_TIMEOUT {
                    return Err(AppError::new("PRINT_FAILED", "The PDF took too long and was stopped."));
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Reading the engine's PDF. It writes a classic cross-reference table and plain
// dictionaries, which is all this needs, and anything else just means no page numbers.
// ---------------------------------------------------------------------------

pub(super) struct PdfIndex<'a> {
    pub(super) bytes: &'a [u8],
    pub(super) offsets: HashMap<u32, usize>,
    pub(super) root: u32,
    pub(super) info: Option<u32>,
    pub(super) size: u32,
    pub(super) start_xref: usize,
}

fn find_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

pub(super) fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|at| at + from)
}

pub(super) fn number_after(bytes: &[u8], at: usize) -> Option<usize> {
    let text = bytes.get(at..)?;
    let start = text.iter().position(u8::is_ascii_digit)?;
    let end = text[start..].iter().position(|b| !b.is_ascii_digit()).map_or(text.len(), |e| e + start);
    std::str::from_utf8(&text[start..end]).ok()?.parse().ok()
}

pub(super) fn dict_ref(dict: &[u8], key: &str) -> Option<u32> {
    let at = find_from(dict, key.as_bytes(), 0)? + key.len();
    number_after(dict, at).map(|n| n as u32)
}

impl<'a> PdfIndex<'a> {
    pub(super) fn read(bytes: &'a [u8]) -> Option<Self> {
        let marker = find_last(bytes, b"startxref")?;
        let start_xref = number_after(bytes, marker)?;
        let mut offsets = HashMap::new();
        let mut newest: Option<&[u8]> = None;
        // Updates added to the end chain back through /Prev, and newer entries win.
        let mut section = Some(start_xref);
        let mut sections = 0;
        while let Some(at) = section.take() {
            sections += 1;
            if sections > 64 {
                break;
            }
            let mut cursor = find_from(bytes, b"xref", at)? + 4;
            loop {
                while bytes.get(cursor)?.is_ascii_whitespace() {
                    cursor += 1;
                }
                if bytes.get(cursor..cursor + 7)? == b"trailer" {
                    break;
                }
                let first = number_after(bytes, cursor)?;
                let line_end = find_from(bytes, b"\n", cursor)?;
                let count = {
                    let line = std::str::from_utf8(&bytes[cursor..line_end]).ok()?;
                    line.split_whitespace().nth(1)?.parse::<usize>().ok()?
                };
                cursor = line_end + 1;
                for i in 0..count {
                    let entry = bytes.get(cursor..cursor + 20)?;
                    if entry.get(17) == Some(&b'n') {
                        let offset = std::str::from_utf8(&entry[..10]).ok()?.parse().ok()?;
                        offsets.entry((first + i) as u32).or_insert(offset);
                    }
                    cursor += 20;
                }
            }
            let trailer_end = find_from(bytes, b">>", cursor)?;
            let trailer = &bytes[cursor..trailer_end];
            newest.get_or_insert(trailer);
            section = find_from(trailer, b"/Prev", 0).and_then(|p| number_after(trailer, p + 5)).filter(|&p| p < at);
        }
        let trailer = newest?;
        Some(Self {
            bytes,
            offsets,
            root: dict_ref(trailer, "/Root")?,
            info: dict_ref(trailer, "/Info"),
            size: dict_ref(trailer, "/Size")?,
            start_xref,
        })
    }

    /// The dictionary part of an object, leaving out any stream.
    pub(super) fn object(&self, number: u32) -> Option<&'a [u8]> {
        let start = *self.offsets.get(&number)?;
        let end = find_from(self.bytes, b"endobj", start)?;
        let body = &self.bytes[start..end];
        Some(find_from(body, b"stream", 0).map_or(body, |s| &body[..s]))
    }
}

/// The page count, and the 1-based page each named destination falls on.
fn pdf_layout(bytes: &[u8]) -> Option<(usize, HashMap<String, usize>)> {
    let pdf = PdfIndex::read(bytes)?;
    let catalog = pdf.object(pdf.root)?;
    let pages = page_objects(&pdf)?;
    let page_numbers: HashMap<u32, usize> = pages.iter().enumerate().map(|(i, &n)| (n, i + 1)).collect();

    let mut destinations = HashMap::new();
    if let Some(dests) = dict_ref(catalog, "/Dests").and_then(|n| pdf.object(n)) {
        let entry = Regex::new(r"/([^\s/\[\]<>()]+)\s*\[\s*(\d+) 0 R").ok()?;
        for capture in entry.captures_iter(dests) {
            let name = String::from_utf8_lossy(&capture[1]).to_string();
            let target: Option<u32> = std::str::from_utf8(&capture[2]).ok().and_then(|t| t.parse().ok());
            if let Some(page) = target.and_then(|t| page_numbers.get(&t)) {
                destinations.insert(name, *page);
            }
        }
    }
    Some((pages.len(), destinations))
}

/// The page objects, in page order.
pub(super) fn page_objects(pdf: &PdfIndex) -> Option<Vec<u32>> {
    let catalog = pdf.object(pdf.root)?;
    let kids = Regex::new(r"(\d+) 0 R").ok()?;
    let mut pages = Vec::new();
    let mut stack = vec![dict_ref(catalog, "/Pages")?];
    while let Some(number) = stack.pop() {
        let object = pdf.object(number)?;
        if find_from(object, b"/Kids", 0).is_none() {
            pages.push(number);
            continue;
        }
        let list_start = find_from(object, b"/Kids", 0)?;
        let list_end = find_from(object, b"]", list_start)?;
        let children: Vec<u32> = kids
            .captures_iter(&object[list_start..list_end])
            .filter_map(|c| std::str::from_utf8(&c[1]).ok()?.parse().ok())
            .collect();
        // Pushed in reverse, so pages come off the stack in order.
        stack.extend(children.into_iter().rev());
    }
    Some(pages)
}

fn pdf_text_string(text: &str) -> String {
    let mut out = String::from("<FEFF");
    for unit in text.encode_utf16() {
        out.push_str(&format!("{unit:04X}"));
    }
    out.push('>');
    out
}

/// Records the title and author, and that LoreCraft made the file, as an update added to
/// the end of the PDF, which every reader understands.
pub(super) fn with_document_info(mut bytes: Vec<u8>, title: &str, author: &str) -> Vec<u8> {
    let Some((root, info, size, previous)) = PdfIndex::read(&bytes).map(|pdf| (pdf.root, pdf.info, pdf.size, pdf.start_xref)) else {
        return bytes;
    };
    let number = info.unwrap_or(size);
    let new_size = size.max(number + 1);
    let offset = bytes.len() + 1;
    let date = chrono::Utc::now().format("D:%Y%m%d%H%M%S+00'00'");
    let mut object = format!(
        "\n{number} 0 obj\n<</Title {}\n/Creator (LoreCraft)\n/Producer (LoreCraft)\n/CreationDate ({date})\n/ModDate ({date})",
        pdf_text_string(title),
    );
    if !author.is_empty() {
        object.push_str(&format!("\n/Author {}", pdf_text_string(author)));
    }
    object.push_str(">>\nendobj\n");
    let xref_at = bytes.len() + object.len();
    bytes.extend_from_slice(object.as_bytes());
    bytes.extend_from_slice(
        format!(
            "xref\n{number} 1\n{offset:010} 00000 n \ntrailer\n<</Size {new_size}\n/Root {root} 0 R\n/Info {number} 0 R\n/Prev {previous}>>\nstartxref\n{xref_at}\n%%EOF\n"
        )
        .as_bytes(),
    );
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::dispatch;

    /// A small PDF laid out the way the browser engine writes them.
    fn sample_pdf() -> Vec<u8> {
        let objects = [
            "<</Title (x)>>",
            "<</Type /Catalog\n/Pages 3 0 R\n/Dests 4 0 R>>",
            "<</Type /Pages\n/Count 3\n/Kids [5 0 R 6 0 R]>>",
            "<</sec-1 [7 0 R /XYZ 6 600 0]\n/page-9 [8 0 R /XYZ 6 600 0]\n/unknown [99 0 R /XYZ 0 0 0]>>",
            "<</Type /Pages\n/Count 2\n/Parent 3 0 R\n/Kids [7 0 R 9 0 R]>>",
            "<</Type /Pages\n/Count 1\n/Parent 3 0 R\n/Kids [8 0 R]>>",
            "<</Type /Page\n/Parent 5 0 R>>",
            "<</Type /Page\n/Parent 6 0 R>>",
            "<</Type /Page\n/Parent 5 0 R>>",
        ];
        let mut out = String::from("%PDF-1.4\n");
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
        out.push_str(&format!(
            "trailer\n<</Size {}\n/Root 2 0 R\n/Info 1 0 R>>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        ));
        out.into_bytes()
    }

    #[test]
    fn finds_pages_and_where_each_destination_falls() {
        let (pages, destinations) = pdf_layout(&sample_pdf()).unwrap();
        assert_eq!(pages, 3);
        assert_eq!(destinations.get("sec-1"), Some(&1));
        assert_eq!(destinations.get("page-9"), Some(&3), "the page tree decides the order");
        assert_eq!(destinations.get("unknown"), None);
    }

    #[test]
    fn anything_unreadable_means_no_numbers_rather_than_a_failure() {
        assert!(pdf_layout(b"not a pdf").is_none());
        assert!(pdf_layout(b"%PDF-1.4\nstartxref\n5\n%%EOF").is_none());
    }

    #[test]
    fn document_info_is_added_as_a_valid_update() {
        let updated = with_document_info(sample_pdf(), "Éowyn", "A. Writer");
        let text = String::from_utf8_lossy(&updated).to_string();
        assert!(text.contains("/Title <FEFF00C9006F00770079006E>"));
        assert!(text.contains("/Creator (LoreCraft)"));
        assert!(text.contains("/Prev "));
        // The newest cross-reference table is what a reader follows, so it must lead to
        // the new object and to the same pages as before.
        let index = PdfIndex::read(&updated).unwrap();
        assert_eq!(index.root, 2);
        let info = index.object(index.info.unwrap()).unwrap();
        assert!(String::from_utf8_lossy(info).contains("/Creator (LoreCraft)"));
    }

    #[test]
    fn the_sheet_comes_from_the_first_plain_page_rule() {
        let css = "@page title-page { size: 1in 1in; }\n@page { size: 6in 9in; margin-top: 0.8in; margin-bottom: 0.8in; @bottom-center { margin: 3in; } }\n@page :left { margin-left: 1in; }";
        let sheet = Sheet::from_css(css);
        assert_eq!((sheet.width, sheet.height), (432.0, 648.0));
        assert!((sheet.margins[0] - 57.6).abs() < 1e-9 && (sheet.margins[2] - 57.6).abs() < 1e-9);
        assert_eq!(sheet.margins[1], 72.0, "a side the rule leaves alone keeps its default");

        let sheet = Sheet::from_css("@page { size: 210mm 297mm; margin: 0.85in 0.8in 0.9in 0.8in; }");
        assert!((sheet.width - 595.2756).abs() < 1e-3 && (sheet.height - 841.8898).abs() < 1e-3);
        assert!((sheet.margins[0] - 61.2).abs() < 1e-9 && (sheet.margins[3] - 57.6).abs() < 1e-9);
        assert_eq!(Sheet::from_css("@page { margin: 0 }").margins, [0.0; 4]);
        assert_eq!(Sheet::from_css("p { color: red }"), Sheet::default());
    }

    #[test]
    fn the_layout_rule_leaves_a_text_area_16_15_the_size() {
        let sheet = Sheet::from_css("@page { size: 6in 9in; margin: 0.8in 0.625in 0.8in 0.875in; }");
        let rule = sheet.layout_rule();
        // Across, 432 - 324 * 16/15 = 86.4pt of margin; down, 648 - 532.8 * 16/15 = 79.68pt.
        assert!(rule.starts_with("@page { margin: 39.840pt 43.200pt; }"), "{rule}");
        assert!(rule.contains("@page :first"));
        let full_bleed = Sheet::from_css("@page { size: 6in 9in; margin: 0; }").layout_rule();
        assert!(full_bleed.starts_with("@page { margin: 0.000pt 0.000pt; }"), "{full_bleed}");
    }

    #[test]
    fn a_host_without_a_browser_engine_says_so() {
        let (engine, _host, dir) = Engine::for_test();
        let path = dir.0.join("out.pdf");
        engine.allow_path(&path);
        let error = dispatch(&engine, "print.pdf", json!({ "title": "T", "html": "<p>x</p>", "path": path })).unwrap_err();
        assert_eq!(error.code, "NOT_SUPPORTED");
        assert!(!path.exists());
        // The failure must not leave the slot taken.
        let again = dispatch(&engine, "print.pdf", json!({ "title": "T", "html": "<p>x</p>", "path": path })).unwrap_err();
        assert_eq!(again.code, "NOT_SUPPORTED");
    }

    #[test]
    fn a_pdf_can_only_go_where_the_user_chose() {
        let (engine, _host, dir) = Engine::for_test();
        let path = dir.0.join("not-chosen.pdf");
        let error = dispatch(&engine, "print.pdf", json!({ "title": "T", "html": "x", "path": path })).unwrap_err();
        assert_eq!(error.code, "PATH_NOT_ALLOWED");
    }
}
