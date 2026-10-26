//! In-memory FBX model. Property bytes are kept verbatim so untouched data round-trips exactly.

use std::fmt;

pub const BINARY_MAGIC: &[u8; 23] = b"Kaydara FBX Binary  \x00\x1a\x00";
pub const HEADER_SIZE: usize = 27;

#[derive(Debug)]
pub struct FbxError(pub String);

impl fmt::Display for FbxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FbxError {}

impl From<std::io::Error> for FbxError {
    fn from(e: std::io::Error) -> Self {
        FbxError(e.to_string())
    }
}

pub type FbxResult<T> = Result<T, FbxError>;

#[derive(Debug, Clone, PartialEq)]
pub struct FbxProperty {
    pub type_code: u8,
    /// Full encoded bytes including the type code.
    pub raw: Vec<u8>,
    /// Decoded payload for `S` (string) and `R` (raw) properties.
    pub value: Option<Vec<u8>>,
}

impl FbxProperty {
    pub fn string(value: &[u8], type_code: u8) -> Self {
        let mut raw = Vec::with_capacity(5 + value.len());
        raw.push(type_code);
        raw.extend_from_slice(&(value.len() as u32).to_le_bytes());
        raw.extend_from_slice(value);
        Self { type_code, raw, value: Some(value.to_vec()) }
    }

    pub fn is_string(&self) -> bool {
        self.type_code == b'S'
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FbxNode {
    /// Raw name bytes (ASCII in practice), kept as-is for byte parity.
    pub name: Vec<u8>,
    pub props: Vec<FbxProperty>,
    pub children: Vec<FbxNode>,
    /// Whether a nested list (and its null record) followed the properties.
    pub has_nested: bool,
}

impl FbxNode {
    pub fn is(&self, name: &str) -> bool {
        self.name == name.as_bytes()
    }

    pub fn child(&self, name: &str) -> Option<&FbxNode> {
        self.children.iter().find(|c| c.is(name))
    }

    pub fn name_str(&self) -> String {
        String::from_utf8_lossy(&self.name).into_owned()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FbxBinaryDocument {
    pub version: u32,
    pub nodes: Vec<FbxNode>,
    pub footer: Vec<u8>,
}

impl FbxBinaryDocument {
    /// FBX 7.5+ uses 64-bit node record fields.
    pub fn wide(&self) -> bool {
        self.version >= 7500
    }

    /// Follow a list of child indices from the top level.
    pub fn node_mut(&mut self, path: &[usize]) -> Option<&mut FbxNode> {
        let (first, rest) = path.split_first()?;
        let mut node = self.nodes.get_mut(*first)?;
        for &i in rest {
            node = node.children.get_mut(i)?;
        }
        Some(node)
    }
}

/// ASCII FBX kept as raw lines (with their line endings) so formatting survives edits.
#[derive(Debug, Clone, PartialEq)]
pub struct FbxAsciiDocument {
    pub lines: Vec<Vec<u8>>,
    pub version: u32,
}
