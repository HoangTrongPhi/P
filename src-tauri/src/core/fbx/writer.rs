//! Byte-accurate binary FBX serializer: recomputes node end offsets and footer alignment.

use super::node::*;

/// Footer tail: version (4) + 120 zero bytes + 16-byte magic.
pub const FOOTER_TAIL_SIZE: usize = 4 + 120 + 16;

fn null_record(wide: bool) -> &'static [u8] {
    if wide {
        &[0; 25]
    } else {
        &[0; 13]
    }
}

fn write_node(node: &FbxNode, out: &mut Vec<u8>, wide: bool) {
    let start = out.len();
    let props_len: usize = node.props.iter().map(|p| p.raw.len()).sum();
    if wide {
        out.extend_from_slice(&0u64.to_le_bytes());
        out.extend_from_slice(&(node.props.len() as u64).to_le_bytes());
        out.extend_from_slice(&(props_len as u64).to_le_bytes());
    } else {
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(node.props.len() as u32).to_le_bytes());
        out.extend_from_slice(&(props_len as u32).to_le_bytes());
    }
    out.push(node.name.len() as u8);
    out.extend_from_slice(&node.name);
    for p in &node.props {
        out.extend_from_slice(&p.raw);
    }
    if node.has_nested || !node.children.is_empty() {
        for c in &node.children {
            write_node(c, out, wide);
        }
        out.extend_from_slice(null_record(wide));
    }
    // End offset is absolute (from the start of the file).
    let end = out.len();
    if wide {
        out[start..start + 8].copy_from_slice(&(end as u64).to_le_bytes());
    } else {
        out[start..start + 4].copy_from_slice(&(end as u32).to_le_bytes());
    }
}

fn footer_pad_for(start: usize) -> usize {
    let ofs = start + 20;
    match ((ofs + 15) & !15) - ofs {
        0 => 16,
        p => p,
    }
}

/// Recompute the footer's alignment padding when the body length changed.
///
/// Footer = 16-byte id + 4 zero bytes + padding (aligns to 16, 1..=16 bytes) + version + 120 zeros + magic.
/// Unknown footer layouts are kept verbatim.
pub fn rebuild_footer(footer: &[u8], old_start: usize, new_start: usize) -> Vec<u8> {
    if old_start == new_start || footer.len() < 20 + 1 + FOOTER_TAIL_SIZE {
        return footer.to_vec();
    }
    let old_pad = footer.len() - 20 - FOOTER_TAIL_SIZE;
    if footer[20..20 + old_pad].iter().any(|&b| b != 0) || footer_pad_for(old_start) != old_pad {
        return footer.to_vec();
    }
    let mut out = footer[..20].to_vec();
    out.resize(20 + footer_pad_for(new_start), 0);
    out.extend_from_slice(&footer[footer.len() - FOOTER_TAIL_SIZE..]);
    out
}

/// Serialize `doc`. Pass the original body length to realign the footer after edits.
pub fn serialize_binary(doc: &FbxBinaryDocument, original_body_end: Option<usize>) -> Vec<u8> {
    let wide = doc.wide();
    let mut out = Vec::with_capacity(HEADER_SIZE + doc.footer.len() + 1024);
    out.extend_from_slice(BINARY_MAGIC);
    out.extend_from_slice(&doc.version.to_le_bytes());
    for n in &doc.nodes {
        write_node(n, &mut out, wide);
    }
    out.extend_from_slice(null_record(wide));
    match original_body_end {
        Some(old) => {
            let footer = rebuild_footer(&doc.footer, old, out.len());
            out.extend_from_slice(&footer);
        }
        None => out.extend_from_slice(&doc.footer),
    }
    out
}
