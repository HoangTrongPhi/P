//! JSON-backed rename undo stack (`.rename_history.json`), file-compatible with the Python prototype.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const HISTORY_FILENAME: &str = ".rename_history.json";
pub const MAX_HISTORY: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenameOp {
    pub src: String,
    pub dst: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transaction {
    pub id: String,
    /// Unix seconds.
    pub timestamp: f64,
    #[serde(default)]
    pub ops: Vec<RenameOp>,
}

#[derive(Serialize, Deserialize)]
struct HistoryFile {
    version: u32,
    transactions: Vec<Transaction>,
}

pub struct RenameHistory {
    pub path: PathBuf,
}

impl RenameHistory {
    /// `path` may be the working folder or the history file itself.
    pub fn new(path: &Path) -> Self {
        let path = if path.is_dir() { path.join(HISTORY_FILENAME) } else { path.to_path_buf() };
        Self { path }
    }

    /// A corrupt file reads as empty rather than blocking new renames.
    pub fn load(&self) -> Vec<Transaction> {
        let Ok(text) = fs::read_to_string(&self.path) else { return Vec::new() };
        serde_json::from_str::<HistoryFile>(&text).map(|h| h.transactions).unwrap_or_else(|e| {
            eprintln!("Corrupt rename history {}: {e}", self.path.display());
            Vec::new()
        })
    }

    fn save(&self, txs: &[Transaction]) -> io::Result<()> {
        let keep = &txs[txs.len().saturating_sub(MAX_HISTORY)..];
        let data = serde_json::to_string_pretty(&HistoryFile { version: 1, transactions: keep.to_vec() })
            .map_err(io::Error::other)?;
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, data)?;
        fs::rename(&tmp, &self.path)
    }

    pub fn push(&self, tx: Transaction) -> io::Result<()> {
        let mut txs = self.load();
        txs.push(tx);
        self.save(&txs)
    }

    pub fn pop(&self) -> io::Result<Option<Transaction>> {
        let mut txs = self.load();
        let tx = txs.pop();
        if tx.is_some() {
            self.save(&txs)?;
        }
        Ok(tx)
    }

    pub fn peek(&self) -> Option<Transaction> {
        self.load().pop()
    }
}
