//! A tolerant, incremental Server-Sent Events parser.
//!
//! Network chunks can split an event, a line, or a multi-byte character anywhere, so
//! this works on bytes and only decodes a line once all of it has arrived.

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    /// The `event:` field, or empty if the server sent none.
    pub event: String,
    pub data: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    /// Bytes of `buf` already searched for a line ending.
    scanned: usize,
    event: String,
    data: String,
    has_data: bool,
    /// The last line ended in `\r`, so a `\n` arriving next belongs to it.
    skip_lf: bool,
}

/// A line this long means something is badly wrong, not that a large event is arriving.
const MAX_BUFFER: usize = 64 * 1024 * 1024;

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a chunk and returns every event it completed.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let mut bytes = chunk;
        if self.skip_lf && !bytes.is_empty() {
            self.skip_lf = false;
            if bytes[0] == b'\n' {
                bytes = &bytes[1..];
            }
        }
        self.buf.extend_from_slice(bytes);

        let mut out = Vec::new();
        let mut line_start = 0;
        let mut i = self.scanned;
        while i < self.buf.len() {
            let byte = self.buf[i];
            if byte == b'\n' || byte == b'\r' {
                let line = String::from_utf8_lossy(&self.buf[line_start..i]).into_owned();
                if let Some(event) = self.take_line(&line) {
                    out.push(event);
                }
                i += 1;
                if byte == b'\r' {
                    if i == self.buf.len() {
                        self.skip_lf = true;
                    } else if self.buf[i] == b'\n' {
                        i += 1;
                    }
                }
                line_start = i;
            } else {
                i += 1;
            }
        }
        self.buf.drain(..line_start);
        self.scanned = self.buf.len();
        if self.buf.len() > MAX_BUFFER {
            self.buf.clear();
            self.scanned = 0;
        }
        out
    }

    /// Ends the stream. A server that closes without a final blank line still gets its
    /// last event delivered.
    pub fn finish(&mut self) -> Option<SseEvent> {
        if !self.buf.is_empty() {
            let line = String::from_utf8_lossy(&self.buf).into_owned();
            self.buf.clear();
            self.scanned = 0;
            if let Some(event) = self.take_line(&line) {
                return Some(event);
            }
        }
        self.dispatch()
    }

    fn take_line(&mut self, line: &str) -> Option<SseEvent> {
        let line = line.strip_prefix('\u{FEFF}').unwrap_or(line);
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None; // A comment, often used as a keep-alive.
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "event" => self.event = value.to_string(),
            _ => {} // `id`, `retry` and anything unknown.
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        if !self.has_data {
            self.event.clear();
            return None;
        }
        self.has_data = false;
        Some(SseEvent {
            event: std::mem::take(&mut self.event),
            data: std::mem::take(&mut self.data),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut parser = SseParser::new();
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(parser.feed(chunk));
        }
        out.extend(parser.finish());
        out
    }

    fn ev(event: &str, data: &str) -> SseEvent {
        SseEvent {
            event: event.to_string(),
            data: data.to_string(),
        }
    }

    #[test]
    fn parses_events_with_and_without_a_name() {
        let got = parse_all(&[b"event: a\ndata: 1\n\ndata: 2\n\n"]);
        assert_eq!(got, vec![ev("a", "1"), ev("", "2")]);
    }

    #[test]
    fn any_split_point_gives_the_same_events() {
        let text = "event: message_start\ndata: {\"a\":\"caf\u{e9} \u{1F409} \u{6F22}\"}\n\n: ping\n\ndata: x\ndata: y\n\n";
        let whole = parse_all(&[text.as_bytes()]);
        assert_eq!(whole.len(), 2);
        assert_eq!(whole[1].data, "x\ny");

        // Every two-chunk split, which includes splitting inside each multi-byte character.
        let bytes = text.as_bytes();
        for split in 0..=bytes.len() {
            assert_eq!(parse_all(&[&bytes[..split], &bytes[split..]]), whole, "split at {split}");
        }
        // One byte at a time.
        let chunks: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(parse_all(&chunks), whole);
    }

    #[test]
    fn handles_every_line_ending_even_when_split() {
        assert_eq!(parse_all(&[b"data: 1\r\n\r\n"]), vec![ev("", "1")]);
        assert_eq!(parse_all(&[b"data: 1\r\n", b"\r\ndata: 2\r\n\r\n"]), vec![ev("", "1"), ev("", "2")]);
        assert_eq!(parse_all(&[b"data: 1\r", b"\n\r", b"\n"]), vec![ev("", "1")]);
        assert_eq!(parse_all(&[b"data: 1\r\rdata: 2\r\r"]), vec![ev("", "1"), ev("", "2")]);
    }

    #[test]
    fn tolerates_missing_space_comments_unknown_fields_and_a_byte_order_mark() {
        let got = parse_all(&[b"\xEF\xBB\xBFdata:1\nid: 7\nretry: 100\nunknown: x\n: keep alive\n\n"]);
        assert_eq!(got, vec![ev("", "1")]);
    }

    #[test]
    fn a_name_without_data_is_not_an_event_and_does_not_leak_into_the_next() {
        let got = parse_all(&[b"event: ping\n\ndata: 1\n\n"]);
        assert_eq!(got, vec![ev("", "1")]);
    }

    #[test]
    fn delivers_a_final_event_with_no_trailing_blank_line() {
        assert_eq!(parse_all(&[b"event: a\ndata: 1"]), vec![ev("a", "1")]);
        assert_eq!(parse_all(&[b"data: 1\n"]), vec![ev("", "1")]);
    }

    #[test]
    fn data_may_contain_colons_and_keeps_inner_spaces() {
        assert_eq!(parse_all(&[b"data:  {\"a\": 1}\n\n"]), vec![ev("", " {\"a\": 1}")]);
    }
}
