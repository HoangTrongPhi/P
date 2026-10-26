"""Pipeline tools: duplicate asset finder and unused texture detector."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QHeaderView, QTreeWidget, QTreeWidgetItem, QVBoxLayout

from core import scanner
from ui.widgets import BaseTab, PathPicker, button, hint
from utils.file_helpers import human_size


def find_duplicates(root: Path, progress=None, cancel=None):
    files = scanner.scan(root, cancel=cancel)
    return scanner.find_duplicates(files, progress=lambda d, t: progress(d, t, "hashing") if progress else None,
                                   cancel=cancel)


def reveal(path: Path) -> None:
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", str(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])


class ToolsTab(BaseTab):
    title = "Pipeline Tools"

    def __init__(self, main):
        super().__init__(main)
        self.folder = PathPicker("dir", "Asset folder to analyse")
        row = QHBoxLayout()
        row.addWidget(self.folder, 1)
        row.addWidget(button("Find Duplicates", self.run_duplicates,
                             tooltip="Byte-identical assets (size check, then SHA-1)"))
        row.addWidget(button("Find Unused Textures", self.run_unused,
                             tooltip="Textures not referenced by any FBX / OBJ-MTL / glTF in the folder"))

        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["File", "Size", "Folder"])
        self.tree.setAlternatingRowColors(True)
        self.tree.header().setSectionResizeMode(QHeaderView.Interactive)
        self.tree.header().setSectionResizeMode(2, QHeaderView.Stretch)
        self.tree.header().setStretchLastSection(False)
        self.tree.setColumnWidth(0, 320)
        self.tree.itemDoubleClicked.connect(self._reveal)
        self.summary = hint("Double-click a file to reveal it in Explorer. "
                            "Note: .blend scenes are not inspected for texture usage.")

        lay = QVBoxLayout(self)
        lay.addLayout(row)
        lay.addWidget(self.tree, 1)
        lay.addWidget(self.summary)

    def handle_drop(self, paths):
        target = paths[0] if paths[0].is_dir() else paths[0].parent
        self.folder.set_path(target)

    def _root(self) -> Path | None:
        root = self.folder.path()
        if not root or not root.is_dir():
            self.main.notify("Choose a folder first", error=True)
            return None
        return root

    def _file_item(self, path: Path, size: int, root: Path) -> QTreeWidgetItem:
        try:
            rel_dir = str(path.parent.relative_to(root)) or "."
        except ValueError:
            rel_dir = str(path.parent)
        it = QTreeWidgetItem([path.name, human_size(size), rel_dir])
        it.setData(0, Qt.UserRole, path)
        it.setToolTip(0, str(path))
        return it

    def run_duplicates(self):
        if root := self._root():
            self.main.run_task(find_duplicates, root, label="Finding duplicates…",
                               on_result=lambda groups: self._show_duplicates(groups, root))

    def _show_duplicates(self, groups, root: Path):
        self.tree.clear()
        wasted = 0
        for g in sorted(groups, key=lambda g: -g[0].size * (len(g) - 1)):
            wasted += g[0].size * (len(g) - 1)
            top = QTreeWidgetItem([f"{len(g)} identical copies of {g[0].path.name}", human_size(g[0].size), ""])
            for f in g:
                top.addChild(self._file_item(f.path, f.size, root))
            self.tree.addTopLevelItem(top)
            top.setExpanded(True)
        self.summary.setText(f"{len(groups)} duplicate group(s) · {human_size(wasted)} reclaimable")

    def run_unused(self):
        if root := self._root():
            self.main.run_task(scanner.find_unused_textures, root, label="Checking texture usage…",
                               on_result=lambda files: self._show_unused(files, root))

    def _show_unused(self, files, root: Path):
        self.tree.clear()
        for f in files:
            self.tree.addTopLevelItem(self._file_item(f.path, f.size, root))
        total = sum(f.size for f in files)
        self.summary.setText(f"{len(files)} texture(s) not referenced by any FBX / OBJ / glTF · {human_size(total)} "
                             "(.blend scenes are not inspected)")

    def _reveal(self, it: QTreeWidgetItem, _col: int):
        path = it.data(0, Qt.UserRole)
        if path and Path(path).exists():
            reveal(Path(path))
