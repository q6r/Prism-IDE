//! A terminal's output history: PTY bytes decoded to UTF-8 as they stream,
//! and the tail of that text kept in a ring addressed by absolute offsets.

use std::collections::VecDeque;

/// How far past the cut a trim looks for a line start, so a replay rarely
/// opens in the middle of a line (or of an escape sequence).
const LINE_SLACK: usize = 4096;

/// The last `cap` bytes of a terminal's output. Offsets (`seq`) count every
/// byte ever pushed, so they stay valid while the front is dropped.
#[derive(Debug)]
pub struct Scrollback {
    buf: VecDeque<u8>,
    /// Offset of `buf[0]`.
    start: u64,
    cap: usize,
}

impl Scrollback {
    pub fn new(cap: usize) -> Self {
        Self { buf: VecDeque::new(), start: 0, cap: cap.max(1) }
    }

    /// Offset just past the newest byte.
    pub fn end(&self) -> u64 {
        self.start + self.buf.len() as u64
    }

    pub fn push(&mut self, text: &str) {
        self.buf.extend(text.as_bytes());
        if self.buf.len() > self.cap {
            let cut = self.trim_point(self.buf.len() - self.cap);
            self.buf.drain(..cut);
            self.start += cut as u64;
        }
    }

    /// Text from `since` (all that is kept when absent) to the end, and
    /// whether part of the requested range was already dropped.
    pub fn since(&self, since: Option<u64>) -> (String, bool) {
        let from = since.unwrap_or(0);
        let truncated = from < self.start;
        let from = from.clamp(self.start, self.end());
        let mut index = (from - self.start) as usize;
        // An offset we never handed out may land inside a character.
        while index < self.buf.len() && is_continuation(self.buf[index]) {
            index += 1;
        }
        let bytes: Vec<u8> = self.buf.range(index..).copied().collect();
        let text = String::from_utf8(bytes).unwrap_or_else(|err| String::from_utf8_lossy(err.as_bytes()).into_owned());
        (text, truncated)
    }

    /// The first index at or after `min` that starts a line (looking a little
    /// ahead), else the first that starts a character.
    fn trim_point(&self, min: usize) -> usize {
        let len = self.buf.len();
        let line = (min.max(1)..=(min + LINE_SLACK).min(len)).find(|&i| self.buf[i - 1] == b'\n');
        line.unwrap_or_else(|| (min..len).find(|&i| !is_continuation(self.buf[i])).unwrap_or(len))
    }
}

fn is_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

/// Decodes a byte stream whose chunks may split characters: an incomplete
/// tail waits for the next chunk; invalid bytes become U+FFFD.
#[derive(Debug, Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut out = String::with_capacity(bytes.len());
        let mut rest: &[u8] = &bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(err) => {
                    let (valid, after) = rest.split_at(err.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match err.error_len() {
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[bad..];
                        }
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// Whatever is left when the stream ends.
    pub fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&rest).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_survive_trimming() {
        let mut ring = Scrollback::new(10);
        ring.push("abcdef");
        ring.push("ghijkl");
        assert_eq!(ring.end(), 12);
        let (all, truncated) = ring.since(None);
        assert!(truncated, "the first bytes were dropped");
        assert_eq!(all.len(), 10);
        assert_eq!(ring.since(Some(8)), ("ijkl".to_string(), false));
        assert_eq!(ring.since(Some(12)), (String::new(), false));
        assert_eq!(ring.since(Some(99)), (String::new(), false), "a future offset yields nothing");
    }

    #[test]
    fn trimming_prefers_line_starts() {
        let mut ring = Scrollback::new(12);
        ring.push("line one\nline two\n");
        let (kept, _) = ring.since(None);
        assert_eq!(kept, "line two\n");
    }

    #[test]
    fn trimming_never_splits_a_character() {
        let mut ring = Scrollback::new(5);
        ring.push("ééé"); // 6 bytes, no newline to align on
        let (kept, truncated) = ring.since(None);
        assert!(truncated);
        assert_eq!(kept, "éé");
        assert_eq!(ring.end(), 6);
        // An offset inside a character skips to the next one.
        assert_eq!(ring.since(Some(3)).0, "é");
    }

    #[test]
    fn replay_matches_what_was_streamed() {
        let mut ring = Scrollback::new(1 << 20);
        let mut streamed = String::new();
        for i in 0..1000 {
            let chunk = format!("{i}: olá\r\n");
            streamed.push_str(&chunk);
            ring.push(&chunk);
        }
        assert_eq!(ring.since(Some(0)), (streamed.clone(), false));
        let mid = streamed[..streamed.len() / 2].rfind('\n').unwrap() as u64 + 1;
        assert_eq!(ring.since(Some(mid)).0, streamed[mid as usize..]);
    }

    #[test]
    fn decoder_joins_split_characters() {
        let mut stream = Utf8Stream::default();
        let bytes = "aé€😀".as_bytes();
        let mut out = String::new();
        for byte in bytes {
            out.push_str(&stream.push(std::slice::from_ref(byte)));
        }
        assert_eq!(out, "aé€😀");
        assert_eq!(stream.finish(), "");
    }

    #[test]
    fn decoder_replaces_invalid_bytes() {
        let mut stream = Utf8Stream::default();
        assert_eq!(stream.push(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(stream.push(b"c\xe2\x82"), "c", "incomplete tail waits");
        assert_eq!(stream.finish(), "\u{FFFD}");
    }
}
