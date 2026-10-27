//! Binary FBX 7.x (32-bit and 7.5+ 64-bit records) and ASCII FBX decoding.

use byteorder::{ByteOrder, LittleEndian as LE};
use regex::bytes::Regex;
use std::sync::LazyLock;

use super::node::*;

fn primitive_size(t: u8) -> Option<usize> {
    match t {
        b'Y' => Some(2),
        b'C' => Some(1),
        b'I' | b'F' => Some(4),
        b'D' | b'L' => Some(8),
        _ => None,
    }
}

fn slice(buf: &[u8], start: usize, len: usize) -> FbxResult<&[u8]> {
    start
        .checked_add(len)
        .and_then(|end| buf.get(start..end))
        .ok_or_else(|| FbxError(format!("Unexpected end of file at offset {start} (truncated file?)")))
}

fn u32_at(buf: &[u8], off: usize) -> FbxResult<u32> {
    Ok(LE::read_u32(slice(buf, off, 4)?))
}

fn parse_props(buf: &[u8], mut off: usize, end: usize) -> FbxResult<Vec<FbxProperty>> {
    let mut props = Vec::new();
    while off < end {
        let t = *buf.get(off).ok_or_else(|| FbxError("Truncated property list".into()))?;
        let (size, value) = if let Some(n) = primitive_size(t) {
            (1 + n, None)
        } else if t == b'S' || t == b'R' {
            let n = u32_at(buf, off + 1)? as usize;
            (5 + n, Some(slice(buf, off + 5, n)?.to_vec()))
        } else if b"fdlibc".contains(&t) {
            // array: length, encoding, compressed length — payload kept opaque
            let comp_len = u32_at(buf, off + 9)? as usize;
            (13 + comp_len, None)
        } else {
            return Err(FbxError(format!("Unknown property type {:?} at offset {off}", t as char)));
        };
        props.push(FbxProperty { type_code: t, raw: slice(buf, off, size)?.to_vec(), value });
        off += size;
    }
    if off != end {
        return Err(FbxError("Property list length mismatch".into()));
    }
    Ok(props)
}

/// Returns the node (or `None` for a null record) and the offset after it.
fn parse_node(buf: &[u8], mut off: usize, wide: bool, depth: usize) -> FbxResult<(Option<FbxNode>, usize)> {
    if depth > 512 {
        return Err(FbxError("Node nesting too deep (corrupt file?)".into()));
    }
    let (end, plen) = if wide {
        let h = slice(buf, off, 24)?;
        off += 24;
        (LE::read_u64(&h[0..8]), LE::read_u64(&h[16..24]))
    } else {
        let h = slice(buf, off, 12)?;
        off += 12;
        (LE::read_u32(&h[0..4]) as u64, LE::read_u32(&h[8..12]) as u64)
    };
    let name_len = *buf.get(off).ok_or_else(|| FbxError("Truncated node header".into()))? as usize;
    off += 1;
    if end == 0 {
        return Ok((None, off));
    }
    let end = usize::try_from(end).map_err(|_| FbxError("Node end offset overflow".into()))?;
    if end > buf.len() {
        return Err(FbxError("Node end offset beyond file size (truncated file?)".into()));
    }
    let name = slice(buf, off, name_len)?.to_vec();
    off += name_len;
    let plen = usize::try_from(plen).map_err(|_| FbxError("Property length overflow".into()))?;
    let props_end = off.checked_add(plen).filter(|&e| e <= end).ok_or_else(|| FbxError("Property list exceeds node".into()))?;
    let props = parse_props(buf, off, props_end)?;
    off = props_end;
    let mut node = FbxNode { name, props, children: Vec::new(), has_nested: off < end };
    while off < end {
        let (child, next) = parse_node(buf, off, wide, depth + 1)?;
        match child {
            Some(c) => node.children.push(c),
            None => break,
        }
        if next <= off {
            return Err(FbxError("Node offsets do not advance (corrupt file?)".into()));
        }
        off = next;
    }
    Ok((Some(node), end))
}

pub fn is_binary(buf: &[u8]) -> bool {
    buf.starts_with(BINARY_MAGIC)
}

pub fn parse_binary(buf: &[u8]) -> FbxResult<FbxBinaryDocument> {
    if !is_binary(buf) {
        return Err(FbxError("Not a binary FBX file".into()));
    }
    let version = u32_at(buf, 23)?;
    let wide = version >= 7500;
    let mut off = HEADER_SIZE;
    let mut nodes = Vec::new();
    while off < buf.len() {
        let (node, next) = parse_node(buf, off, wide, 0)?;
        off = next;
        match node {
            Some(n) => nodes.push(n),
            None => break,
        }
    }
    Ok(FbxBinaryDocument { version, nodes, footer: buf[off.min(buf.len())..].to_vec() })
}

static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u)FBXVersion\s*:\s*(\d+)").unwrap());

/// Split into lines that keep their `\n` / `\r\n` endings.
fn split_lines(data: &[u8]) -> Vec<Vec<u8>> {
    data.split_inclusive(|&b| b == b'\n').map(<[u8]>::to_vec).collect()
}

pub fn parse_ascii(data: &[u8]) -> FbxResult<FbxAsciiDocument> {
    let lines = split_lines(data);
    let looks_fbx = lines.iter().take(50).any(|l| {
        let t = l.trim_ascii_start();
        t.starts_with(b"FBXHeaderExtension") || t.starts_with(b"; FBX")
    });
    if !looks_fbx {
        return Err(FbxError("Not an FBX file (no binary magic or ASCII header)".into()));
    }
    let head = &data[..data.len().min(20000)];
    let version = VERSION_RE
        .captures(head)
        .and_then(|c| std::str::from_utf8(&c[1]).ok()?.parse().ok())
        .unwrap_or(0);
    Ok(FbxAsciiDocument { lines, version })
}
