//! Log files, because an installed app has no console to report problems to.
//!
//! A log must be safe to attach to a public bug report. It holds event names, codes and
//! the wording of error messages, and never prose, lore, prompts, model responses, keys or
//! file contents. Error messages can quote any of those (a JSON parser quotes its input,
//! and a slicing panic prints the whole string), so nothing is trusted to be clean:
//!
//! - Identifiers go in as `tokens`, which are dropped unless they look like identifiers.
//! - Free text goes through `scrub`, which keeps only words from a fixed technical list.
//!   Anything else becomes `…`, so a word that is not on the list cannot reach a file.
//!
//! Provider error text is left out altogether. See `ai::run_request`.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use regex::Regex;

use crate::error::AppError;
use crate::paths::Paths;

const FILE_NAME: &str = "lorecraft";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Rotated files kept beside the current one, so the folder stays under 5 MB.
const OLD_FILES: u32 = 4;
const MAX_INPUT_CHARS: usize = 4000;
const MAX_MESSAGE_CHARS: usize = 300;
const MAX_FRAMES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

// ---- Keeping content out ----------------------------------------------------

/// Words an error message may keep: what JavaScript engines, ProseMirror, SQLite, operating
/// systems and Rust panics say. Add to this when a real log turns out too blank to act on,
/// and never add a word that only makes sense as story text.
const SAFE_WORDS: &str = "
a about above access accessed accessing across after again all allocate allocation allowed already
an and any applying are argument arguments array assign assignment at attempt attempting attribute
attributes available backup bad be because been before being between bigint bind blocked body boolean
borrowed bound boundary bounds browser buffer busy but by byte bytes call callable called calling can can't
cancelled canceled cannot capacity channel char character characters check child children class
client close closed code collapse column command complete completed compile configurable conflict
connect connection constant constraint constructor contain contains content convert copy corrupt
could create created credential credentials database date decode default defined delete denied
depth descriptor destroyed did different directory disconnected disk divide do document does dom
done duplicate dynamically element elements else empty encode encoding end engine ensure entry equal
err error errors evaluating event exceeded exception execute exist exists expect expected export exporting
extra extensible failed failure false fetch field file files find finished folder for foreign format found
fragment frozen from full function given handle handler has have hidden hooks id identifier if illegal image
import imported importing in index infinity initialization initialized input inside instance
insufficient integer interrupted into invalid invoke io is it item iterable iterator json key
large last least len length let limit line list load loading lock locked long loop lost malformed
map mark marks match max maximum may memory message method minified minimum mismatched missing
module more must mutably mutex name nan need network no node nodes none not notifications null
number object observer of offset ok on once only open operation option or os other out output over
overflow page pages panicked parameter parse parsing part path pdf pending permission permissions plugin
poisoned position positions previous primary print process project promise properties property quota range
re-renders react read reading readonly reason receive received reduce reference refused reject rejected
remove rename render rendered request requests required reset resize resource response result retry
returned root row rows run running runtime same save saved saving schema script selection send sending
serialize server service session set settings should shared size some space specified sql sqlite stack
start state statement
step stopped storage store stream string subtract such symbol syntax system table task text than
that the there this thread timed timeout to token tokens too transaction true try type types unable
undefined undelivered underflow unexpected unique unknown unreachable unsupported unwrap update url
used valid value values variable version view visit was when while window with within without worker
would write writing wrong zero
";

static SAFE: LazyLock<HashSet<&'static str>> = LazyLock::new(|| SAFE_WORDS.split_whitespace().collect());

fn pattern(text: &str) -> Regex {
    Regex::new(text).expect("a valid built-in pattern")
}

/// Keys in the forms providers issue them, and whatever follows a label naming one.
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    pattern(concat!(
        r"(?i)\b(?:bearer|basic)\s+[a-z0-9._~+/=\-]+",
        r"|\b(?:x-api-key|api[-_ ]?key|authorization|auth|token|secret|password|passwd|pwd)\s*[:=]\s*\S+",
        r"|\b(?:sk|pk|rk|ghp|gho|ghs|gsk|xai|hf)[-_][a-z0-9_\-]{6,}",
        r"|\b[a-z0-9+/_\-]{24,}={0,2}",
    ))
});
/// Anything in quotes. An apostrophe inside a word does not open a quotation.
static QUOTED: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r#"(?s)"[^"]*(?:"|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|\B'[^']*(?:'|$)"#)
});
static URL: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)\b[a-z][a-z0-9+.\-]*://\S*"));
static WINDOWS_PATH: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)\b[a-z]:[\\/]\S*|\\\\\S+"));
static UNIX_PATH: LazyLock<Regex> = LazyLock::new(|| pattern(r"(^|[\s(=])~?\.{0,2}/[^\s)]+"));
/// One frame of a JavaScript stack, as `src/support/errorReporting.ts` sends it.
static FRAME: LazyLock<Regex> = LazyLock::new(|| pattern(r"^(?:[\w$.<>\-]{1,80} )?[\w.\-]{1,80}:\d{1,7}:\d{1,7}$"));

/// A count, a position or an OS error code. Not an address or anything else long enough to
/// identify something.
fn is_number(word: &str) -> bool {
    let digits = word.strip_prefix("0x").unwrap_or(word);
    let hex = word.starts_with("0x");
    !digits.is_empty()
        && word.len() <= 12
        && digits.matches('.').count() <= 1
        && digits
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || (hex && c.is_ascii_hexdigit()))
}

fn keep_word(word: &str) -> bool {
    let core = word.trim_matches(|c: char| !c.is_alphanumeric());
    if core.is_empty() {
        return word.chars().count() <= 3;
    }
    is_number(core) || SAFE.contains(core.to_lowercase().as_str())
}

/// Makes free text safe to write: one line of known technical words and placeholders.
pub fn scrub(text: &str) -> String {
    // Nothing useful is this far in, and a whole document could be.
    let text: String = text.chars().take(MAX_INPUT_CHARS).collect();
    let text = SECRET.replace_all(&text, "[hidden]");
    let text = QUOTED.replace_all(&text, "[text]");
    let text = URL.replace_all(&text, "[url]");
    let text = WINDOWS_PATH.replace_all(&text, "[path]");
    let text = UNIX_PATH.replace_all(&text, "${1}[path]");
    let mut out: Vec<&str> = Vec::new();
    for word in text.split_whitespace() {
        if keep_word(word) {
            out.push(word);
        } else if out.last() != Some(&"…") {
            out.push("…");
        }
    }
    let line = out.join(" ");
    if line.chars().count() > MAX_MESSAGE_CHARS {
        let cut: String = line.chars().take(MAX_MESSAGE_CHARS).collect();
        format!("{cut} …")
    } else {
        line
    }
}

/// A short identifier such as an RPC method, an error code or a version number.
fn token(value: &str) -> &str {
    let plain = !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "._:/+-".contains(c));
    if plain {
        value
    } else {
        "?"
    }
}

/// `src\rpc\pages.rs:12:3` from a full build path, which can name the person who built it.
fn short_location(file: &str, line: u32, column: u32) -> String {
    let parts: Vec<&str> = file.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    let tail = parts[parts.len().saturating_sub(2)..].join("/");
    format!("{tail}:{line}:{column}")
}

fn format_line(level: Level, event: &str, tokens: &[(&str, &str)], message: Option<&str>) -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut line = format!("{now} {} {}", level.name(), token(event));
    for (key, value) in tokens {
        line.push_str(&format!(" {}={}", token(key), token(value)));
    }
    if let Some(message) = message {
        line.push_str(&format!(" message=\"{}\"", scrub(message).replace('"', "'")));
    }
    line.push('\n');
    line
}

// ---- Files ------------------------------------------------------------------

struct LogFile {
    dir: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    size: u64,
}

impl LogFile {
    fn new(dir: PathBuf, max_bytes: u64) -> Self {
        Self { dir, max_bytes, file: None, size: 0 }
    }

    fn path(&self, age: u32) -> PathBuf {
        if age == 0 {
            self.dir.join(format!("{FILE_NAME}.log"))
        } else {
            self.dir.join(format!("{FILE_NAME}.{age}.log"))
        }
    }

    fn open(&mut self) {
        let _ = fs::create_dir_all(&self.dir);
        self.file = OpenOptions::new().create(true).append(true).open(self.path(0)).ok();
        self.size = self.file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
    }

    fn rotate(&mut self) {
        // Windows cannot rename a file that is open.
        self.file = None;
        let _ = fs::remove_file(self.path(OLD_FILES));
        for age in (0..OLD_FILES).rev() {
            let _ = fs::rename(self.path(age), self.path(age + 1));
        }
        self.open();
    }

    /// A problem writing the log must never become a problem for the writer's work.
    fn append(&mut self, line: &str) {
        if self.file.is_none() {
            self.open();
        }
        let length = line.len() as u64;
        if self.size > 0 && self.size + length > self.max_bytes {
            self.rotate();
        }
        if let Some(file) = &mut self.file {
            if file.write_all(line.as_bytes()).is_ok() {
                self.size += length;
            }
        }
    }
}

static LOG: Mutex<Option<LogFile>> = Mutex::new(None);

fn log_lock() -> MutexGuard<'static, Option<LogFile>> {
    LOG.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts writing to the data folder. Until this runs, records go nowhere.
pub fn init(paths: &Paths) {
    *log_lock() = Some(LogFile::new(paths.logs(), MAX_FILE_BYTES));
}

#[cfg(test)]
thread_local! {
    static CAPTURED: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
}

/// Returns what `run` logged on this thread instead of writing it anywhere.
#[cfg(test)]
pub fn capture(run: impl FnOnce()) -> Vec<String> {
    CAPTURED.with(|c| *c.borrow_mut() = Some(Vec::new()));
    run();
    CAPTURED.with(|c| c.borrow_mut().take()).unwrap_or_default()
}

fn write_line(line: &str) {
    #[cfg(test)]
    {
        let caught = CAPTURED.with(|c| match c.borrow_mut().as_mut() {
            Some(lines) => {
                lines.push(line.to_string());
                true
            }
            None => false,
        });
        if caught {
            return;
        }
    }
    if let Some(log) = log_lock().as_mut() {
        log.append(line);
    }
}

/// Writes one record. `tokens` must be identifiers, and `message` is scrubbed here, so a
/// caller cannot forget to.
pub fn record(level: Level, event: &str, tokens: &[(&str, &str)], message: Option<&str>) {
    write_line(&format_line(level, event, tokens, message));
}

pub fn info(event: &str, tokens: &[(&str, &str)]) {
    record(Level::Info, event, tokens, None);
}

pub fn warn(event: &str, tokens: &[(&str, &str)], message: Option<&str>) {
    record(Level::Warn, event, tokens, message);
}

pub fn error(event: &str, tokens: &[(&str, &str)], message: Option<&str>) {
    record(Level::Error, event, tokens, message);
}

// ---- What gets recorded ------------------------------------------------------

/// Codes for failures of the program or the machine, whose wording helps with a diagnosis.
/// Every other code is about a request, and its message is written for the person using
/// the app, so it may well name their pages.
const SYSTEM_CODES: [&str; 6] = ["INTERNAL", "DATABASE", "IO", "JSON", "KEY_STORE", "PRINT_FAILED"];

/// A failed RPC, by method and code. `ai.*` never includes wording, whatever the code, since
/// a provider's error text can echo the prompt.
pub fn rpc_failed(method: &str, error: &AppError) {
    let tokens = [("method", method), ("code", error.code.as_str())];
    let worded = SYSTEM_CODES.contains(&error.code.as_str()) && !method.starts_with("ai.");
    let level = if worded { Level::Error } else { Level::Warn };
    record(level, "rpc.failed", &tokens, worded.then_some(error.message.as_str()));
}

const JS_ERROR_NAMES: [&str; 11] = [
    "AbortError",
    "AggregateError",
    "DOMException",
    "Error",
    "EvalError",
    "NotAllowedError",
    "RangeError",
    "ReferenceError",
    "RpcError",
    "SyntaxError",
    "TypeError",
];

/// An uncaught error from the web view. Only frames in the exact form `FRAME` allows are
/// kept, because the first line of a browser's stack is the error message itself.
pub fn client_error(origin: &str, name: &str, code: Option<&str>, message: &str, frames: &[String]) {
    let origin = if ["error", "rejection", "react"].contains(&origin) { origin } else { "other" };
    let name = if JS_ERROR_NAMES.contains(&name) { name } else { "Error" };
    let mut tokens = vec![("origin", origin), ("name", name)];
    // The app's codes look like `NOT_FOUND`. Anything else on an error object could be data.
    if let Some(code) = code.filter(|c| c.chars().all(|c| c.is_ascii_uppercase() || c == '_')) {
        tokens.push(("code", code));
    }
    let stack = frames
        .iter()
        .filter(|f| FRAME.is_match(f))
        .take(MAX_FRAMES)
        .map(|f| f.replace(' ', "@"))
        .collect::<Vec<_>>()
        .join("<");
    // The native side has already logged a failed RPC, and its message is for people.
    let message = (name != "RpcError").then_some(message);
    let mut line = format_line(Level::Error, "js.uncaught", &tokens, message);
    if !stack.is_empty() {
        line.truncate(line.trim_end().len());
        line.push_str(&format!(" stack={stack}\n"));
    }
    write_line(&line);
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("")
}

/// Another thread may be mid-write, or the panic may have come from this module while
/// holding the lock, so this gives up rather than waiting forever.
fn write_during_panic(line: &str) {
    for _ in 0..50 {
        match LOG.try_lock() {
            Ok(mut guard) => {
                if let Some(log) = guard.as_mut() {
                    log.append(line);
                }
                return;
            }
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                if let Some(log) = poisoned.into_inner().as_mut() {
                    log.append(line);
                }
                return;
            }
            Err(std::sync::TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
}

fn panic_line(info: &std::panic::PanicHookInfo<'_>) -> String {
    let location = info
        .location()
        .map(|l| short_location(l.file(), l.line(), l.column()))
        .unwrap_or_default();
    let thread = std::thread::current();
    let tokens = [("thread", thread.name().unwrap_or("unnamed")), ("at", location.as_str())];
    format_line(Level::Error, "app.panic", &tokens, Some(panic_text(info.payload())))
}

/// Records panics, then carries on with the usual behaviour.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_during_panic(&panic_line(info));
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::TestDir;

    const STORY: &str = "Vaelthrix the Unforgiven burned Ashmoor while Queen Isolde wept";

    fn read_all(dir: &std::path::Path) -> String {
        let log = LogFile::new(dir.to_path_buf(), MAX_FILE_BYTES);
        (0..=OLD_FILES)
            .filter_map(|age| fs::read_to_string(log.path(age)).ok())
            .collect::<Vec<_>>()
            .join("")
    }

    fn assert_no_story(text: &str) {
        for word in ["Vaelthrix", "Unforgiven", "burned", "Ashmoor", "Isolde", "wept", "Queen"] {
            assert!(!text.contains(word), "{word} reached: {text}");
        }
    }

    #[test]
    fn a_sample_error_with_a_key_in_it_is_scrubbed() {
        let samples = [
            ("invalid x-api-key sk-ant-api03-AbCdEf123456 was sent", "sk-ant-api03-AbCdEf123456"),
            ("Authorization: Bearer abc.def-ghi_jkl", "abc.def-ghi_jkl"),
            ("request failed: api_key=gsk_livekey99 rejected", "gsk_livekey99"),
            ("x-api-key: plainsecretvalue", "plainsecretvalue"),
            ("token AIzaSyD4ExampleExampleExampleExample is bad", "AIzaSyD4ExampleExampleExampleExample"),
            ("sent key shortkey1", "shortkey1"),
        ];
        for (sample, key) in samples {
            let out = scrub(sample);
            assert!(!out.contains(key), "{sample} became {out}");
        }
        let line = format_line(Level::Error, "ai.failed", &[("code", "BAD_KEY")], Some(samples[0].0));
        assert!(line.contains("code=BAD_KEY"));
        assert!(!line.contains("sk-ant"), "{line}");
    }

    #[test]
    fn prose_does_not_survive_in_any_form_an_error_can_carry_it() {
        let samples = [
            STORY.to_string(),
            format!("Could not export {STORY}"),
            format!("Unexpected token 'V', \"{STORY}\" is not valid JSON"),
            format!("byte index 5 is not a char boundary; it is inside 'é' (bytes 4..6) of `{STORY}`"),
            format!("invalid value: string \"{STORY}\", expected a boolean"),
            format!("Invalid content for node paragraph: <paragraph(\"{STORY}\")>"),
            format!("he said `{STORY}` and `{STORY}"),
            format!("line one\n{STORY}\nline three"),
        ];
        for sample in samples {
            let out = scrub(&sample);
            assert_no_story(&out);
            assert!(!out.contains('\n'), "one record is one line: {out}");
        }
    }

    #[test]
    fn messages_stay_useful() {
        assert_eq!(scrub("database is locked"), "database is locked");
        assert_eq!(scrub("Access is denied. (os error 5)"), "Access is denied. (os error 5)");
        assert_eq!(
            scrub("Cannot read properties of undefined (reading 'title')"),
            "Cannot read properties of undefined (reading [text])"
        );
        assert_eq!(scrub("x.map is not a function"), "… is not a function");
        assert_eq!(scrub("called `Option::unwrap()` on a `None` value"), "called [text] on a [text] value");
        assert_eq!(
            scrub("index out of bounds: the len is 3 but the index is 5"),
            "index out of bounds: the len is 3 but the index is 5"
        );
    }

    #[test]
    fn paths_and_addresses_are_removed() {
        let cases = [
            r"Cannot open C:\Users\someone\Novels\Secret.lorecraft",
            "Cannot open /home/someone/Novels/Secret.lorecraft",
            "Could not reach http://user:pass@example.com/v1?key=abc",
            r"\\server\share\Secret.lorecraft is missing",
        ];
        for case in cases {
            let out = scrub(case);
            for leak in ["someone", "Novels", "Secret", "example.com", "server", "abc"] {
                assert!(!out.contains(leak), "{case} became {out}");
            }
        }
    }

    #[test]
    fn long_messages_are_cut_and_tokens_must_be_identifiers() {
        let long = "error ".repeat(200);
        assert!(scrub(&long).chars().count() < MAX_MESSAGE_CHARS + 5);
        assert_eq!(token("pages.update"), "pages.update");
        assert_eq!(token("BAD_KEY"), "BAD_KEY");
        assert_eq!(token("two words"), "?");
        assert_eq!(token(""), "?");
    }

    #[test]
    fn locations_do_not_name_whoever_built_the_app() {
        assert_eq!(
            short_location(r"C:\Users\someone\.cargo\registry\src\foo-1.0\src\lib.rs", 3, 9),
            "src/lib.rs:3:9"
        );
        assert_eq!(short_location("src/rpc/pages.rs", 1, 2), "rpc/pages.rs:1:2");
    }

    #[test]
    fn files_rotate_and_the_oldest_is_dropped() {
        let dir = TestDir::new();
        let mut log = LogFile::new(dir.0.join("logs"), 100);
        for i in 0..40 {
            log.append(&format!("line {i:02} {}\n", "x".repeat(40)));
        }
        let names: Vec<String> = fs::read_dir(dir.0.join("logs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), OLD_FILES as usize + 1, "{names:?}");
        assert!(fs::metadata(log.path(0)).unwrap().len() <= 100);
        let all = read_all(&dir.0.join("logs"));
        assert!(all.contains("line 39"), "the newest line is kept");
        assert!(!all.contains("line 00"), "the oldest file is gone");
    }

    #[test]
    fn logging_to_a_folder_that_cannot_be_created_is_harmless() {
        let dir = TestDir::new();
        let blocked = dir.0.join("not-a-folder");
        fs::write(&blocked, b"x").unwrap();
        let mut log = LogFile::new(blocked.join("logs"), 100);
        log.append("line\n");
        assert!(log.file.is_none());
    }

    #[test]
    fn javascript_errors_keep_their_shape_and_lose_their_content() {
        let frames = vec![
            "render index-abc123.js:10:20".to_string(),
            "index-abc123.js:1:2".to_string(),
            format!("{STORY} index.js:1:2"),
            "Error: something".to_string(),
        ];
        let lines = capture(|| {
            client_error("error", "TypeError", None, &format!("Cannot read {STORY}"), &frames);
            client_error("rejection", "SomethingElse", None, STORY, &[]);
            client_error("rejection", "RpcError", Some("NOT_FOUND"), STORY, &[]);
        });
        let text = lines.join("");
        assert_no_story(&text);
        assert!(lines[0].contains("js.uncaught origin=error name=TypeError"), "{}", lines[0]);
        assert!(lines[0].contains("stack=render@index-abc123.js:10:20<index-abc123.js:1:2\n"), "{}", lines[0]);
        assert!(lines[1].contains("name=Error"), "{}", lines[1]);
        assert!(lines[2].contains("name=RpcError code=NOT_FOUND"), "{}", lines[2]);
        assert!(!lines[2].contains("message="), "{}", lines[2]);
    }

    #[test]
    fn a_failed_rpc_records_its_code_and_only_system_wording() {
        let lines = capture(|| {
            rpc_failed("pages.get", &AppError::not_found(STORY));
            rpc_failed("pages.update", &AppError::new("DATABASE", "database is locked"));
            rpc_failed("ai.test", &AppError::new("INTERNAL", "database is locked"));
        });
        assert_no_story(&lines.join(""));
        assert!(lines[0].contains("WARN rpc.failed method=pages.get code=NOT_FOUND"), "{}", lines[0]);
        assert!(!lines[0].contains("message="));
        assert!(lines[1].contains("ERROR rpc.failed method=pages.update code=DATABASE message=\"database is locked\""), "{}", lines[1]);
        assert!(!lines[2].contains("message="), "{}", lines[2]);
    }

    #[test]
    fn a_panic_records_where_it_happened_and_not_what_it_quoted() {
        // Runs the real hook logic against a real panic, on this thread so it is captured.
        let previous = std::panic::take_hook();
        let seen = std::sync::Arc::new(Mutex::new(String::new()));
        let line = seen.clone();
        let this_test = std::thread::current().id();
        std::panic::set_hook(Box::new(move |info| {
            if std::thread::current().id() == this_test {
                *line.lock().unwrap() = panic_line(info);
            }
        }));
        let caught = std::panic::catch_unwind(|| {
            panic!("byte index 5 is not a char boundary of `{STORY}`");
        });
        std::panic::set_hook(previous);
        assert!(caught.is_err());
        let line = seen.lock().unwrap().clone();
        assert!(line.contains("ERROR app.panic"), "{line}");
        assert!(line.contains("at=src/logs.rs:"), "{line}");
        assert_no_story(&line);
    }
}
