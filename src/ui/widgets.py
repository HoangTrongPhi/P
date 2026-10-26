"""Small reusable widgets shared by the tabs."""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QFileDialog, QHBoxLayout, QLabel, QLineEdit, QPushButton, QTableWidgetItem, QWidget,
)

if TYPE_CHECKING:
    from ui.main_window import MainWindow


def button(text: str, slot: Callable | None = None, primary: bool = False, tooltip: str = "") -> QPushButton:
    b = QPushButton(text)
    if primary:
        b.setProperty("primary", True)
    if slot:
        b.clicked.connect(slot)
    if tooltip:
        b.setToolTip(tooltip)
    return b


def hint(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setProperty("hint", True)
    lbl.setWordWrap(True)
    return lbl


def item(text: str, color: str | None = None, tooltip: str | None = None, data=None) -> QTableWidgetItem:
    it = QTableWidgetItem(text)
    it.setFlags(it.flags() & ~Qt.ItemIsEditable)
    if color:
        it.setForeground(QColor(color))
    it.setToolTip(tooltip if tooltip is not None else text)
    if data is not None:
        it.setData(Qt.UserRole, data)
    return it


class PathPicker(QWidget):
    """Line edit + Browse button for a folder, file or save path."""

    changed = Signal(str)

    def __init__(self, mode: str = "dir", placeholder: str = "", file_filter: str = "", parent=None):
        super().__init__(parent)
        self.mode, self.file_filter = mode, file_filter
        self.edit = QLineEdit()
        self.edit.setPlaceholderText(placeholder)
        self.edit.editingFinished.connect(lambda: self.changed.emit(self.edit.text()))
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.edit, 1)
        lay.addWidget(browse)

    def _browse(self):
        start = self.edit.text() or str(Path.home())
        if self.mode == "dir":
            path = QFileDialog.getExistingDirectory(self, "Select folder", start)
        elif self.mode == "save":
            path, _ = QFileDialog.getSaveFileName(self, "Save as", start, self.file_filter)
        else:
            path, _ = QFileDialog.getOpenFileName(self, "Select file", start, self.file_filter)
        if path:
            self.set_path(path)

    def path(self) -> Path | None:
        text = self.edit.text().strip().strip('"')
        return Path(text) if text else None

    def set_path(self, path: str | Path) -> None:
        self.edit.setText(str(path))
        self.changed.emit(str(path))


class BaseTab(QWidget):
    """Tabs receive the main window (task runner, asset server, settings) and dropped paths."""

    title = ""

    def __init__(self, main: "MainWindow"):
        super().__init__()
        self.main = main

    def handle_drop(self, paths: list[Path]) -> None:
        """Called when files/folders are dropped anywhere on the window while this tab is active."""
