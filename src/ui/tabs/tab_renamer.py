"""Batch rename view: scan, rule editor, live dry-run table, apply and undo."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QFormLayout, QGroupBox, QHBoxLayout, QHeaderView,
    QLabel, QLineEdit, QMessageBox, QSplitter, QTableWidget, QVBoxLayout, QWidget,
)

from core import renamer, scanner
from ui import theme
from ui.widgets import BaseTab, PathPicker, button, hint, item
from utils.file_helpers import MESH_EXTS, SCENE_EXTS, SOURCE_EXTS, TEXTURE_EXTS

FILTERS = {
    "All assets": None,
    "Meshes (fbx, obj, glb, gltf)": MESH_EXTS,
    "Textures": TEXTURE_EXTS,
    "Meshes + Textures + PSD": MESH_EXTS | TEXTURE_EXTS | SOURCE_EXTS,
    "Blender scenes": SCENE_EXTS,
    "Photoshop (psd)": SOURCE_EXTS,
}

STATUS_COLORS = {
    renamer.Status.OK: theme.OK,
    renamer.Status.UNCHANGED: theme.TEXT_DIM,
    renamer.Status.COLLISION: theme.WARN,
    renamer.Status.INVALID: theme.ERROR,
}


class RenamerTab(BaseTab):
    title = "Batch Renamer"

    def __init__(self, main):
        super().__init__(main)
        self.files: list[Path] = []
        self.plan: list[renamer.RenameEntry] = []
        self._preview_timer = QTimer(self, singleShot=True, interval=150, timeout=self.refresh_preview)

        # --- source
        self.folder = PathPicker("dir", "Folder to scan (or drop a folder / files here)")
        self.folder.changed.connect(lambda _: self.scan())
        self.recursive = QCheckBox("Recursive", checked=True)
        self.filter = QComboBox()
        self.filter.addItems(FILTERS)
        self.filter.setCurrentIndex(3)
        src_row = QHBoxLayout()
        src_row.addWidget(self.folder, 1)
        src_row.addWidget(self.filter)
        src_row.addWidget(self.recursive)
        src_row.addWidget(button("Scan", self.scan))

        # --- rules
        self.preset = QComboBox()
        self.preset.addItem("None", None)
        self.preset.addItem("Unreal Engine 5  (SM_ / SK_ / T_ _D _N _R _M _ORM)", "ue5")
        self.preset.addItem("Unity  (PascalCase, _Albedo _Normal …)", "unity")
        self.find = QLineEdit(placeholderText="Find")
        self.replace = QLineEdit(placeholderText="Replace with")
        self.regex = QCheckBox("Regex")
        self.case_sensitive = QCheckBox("Match case", checked=True)
        self.case = QComboBox()
        self.case.addItem("Keep", None)
        for style in renamer.CASE_STYLES:
            self.case.addItem({"camel": "camelCase", "snake": "snake_case", "pascal": "PascalCase",
                               "upper": "UPPER_CASE", "lower": "lowercase", "kebab": "kebab-case"}[style], style)
        self.prefix = QLineEdit(placeholderText="e.g. SM_")
        self.suffix = QLineEdit(placeholderText="e.g. _LOD0")
        self.regex_error = QLabel()
        self.regex_error.setStyleSheet(f"color: {theme.ERROR}")

        find_row = QHBoxLayout()
        find_row.addWidget(self.find, 1)
        find_row.addWidget(self.replace, 1)
        find_row.addWidget(self.regex)
        find_row.addWidget(self.case_sensitive)

        rules = QGroupBox("Rules  (applied top to bottom; extension is never changed)")
        form = QFormLayout(rules)
        form.addRow("Preset", self.preset)
        form.addRow("Search", find_row)
        form.addRow("", self.regex_error)
        self.regex_error.hide()
        form.addRow("Case", self.case)
        affix = QHBoxLayout()
        affix.addWidget(QLabel("Prefix"))
        affix.addWidget(self.prefix, 1)
        affix.addWidget(QLabel("Suffix"))
        affix.addWidget(self.suffix, 1)
        form.addRow("", affix)
        for w in (self.find, self.replace, self.prefix, self.suffix):
            w.textChanged.connect(self._schedule_preview)
        for w in (self.preset, self.case):
            w.currentIndexChanged.connect(self._schedule_preview)
        for w in (self.regex, self.case_sensitive):
            w.toggled.connect(self._schedule_preview)

        # --- dry-run table
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["Status", "Original", "New name", "Folder"])
        self.table.setAlternatingRowColors(True)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.verticalHeader().hide()
        hdr = self.table.horizontalHeader()
        hdr.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(1, QHeaderView.Interactive)
        hdr.setSectionResizeMode(2, QHeaderView.Interactive)
        hdr.setStretchLastSection(True)
        self.table.setColumnWidth(1, 260)
        self.table.setColumnWidth(2, 260)

        self.summary = hint("Scan a folder to start.")
        self.apply_btn = button("Apply Rename", self.apply, primary=True)
        self.undo_btn = button("Undo Last", self.undo, tooltip="Reverse the last rename in this folder")
        actions = QHBoxLayout()
        actions.addWidget(self.summary, 1)
        actions.addWidget(self.undo_btn)
        actions.addWidget(self.apply_btn)

        top = QWidget()
        top_lay = QVBoxLayout(top)
        top_lay.setContentsMargins(0, 0, 0, 0)
        top_lay.addLayout(src_row)
        top_lay.addWidget(rules)
        bottom = QWidget()
        bottom_lay = QVBoxLayout(bottom)
        bottom_lay.setContentsMargins(0, 0, 0, 0)
        bottom_lay.addWidget(self.table, 1)
        bottom_lay.addLayout(actions)
        split = QSplitter(Qt.Vertical)
        split.addWidget(top)
        split.addWidget(bottom)
        split.setStretchFactor(1, 1)
        split.setChildrenCollapsible(False)

        lay = QVBoxLayout(self)
        lay.addWidget(split)
        self._update_buttons()

    # ------------------------------------------------------------------ helpers

    def history(self) -> renamer.RenameHistory | None:
        root = self.folder.path()
        if root and root.is_dir():
            return renamer.RenameHistory(root)
        if self.files:
            return renamer.RenameHistory(self.files[0].parent)
        return None

    def rules(self) -> list[renamer.Rule]:
        rules: list[renamer.Rule] = []
        if preset := self.preset.currentData():
            rules.append(renamer.PresetRule(preset))
        self.regex_error.hide()
        if self.find.text():
            try:
                rules.append(renamer.SearchReplaceRule(
                    self.find.text(), self.replace.text(), self.regex.isChecked(), self.case_sensitive.isChecked()))
            except Exception as exc:  # re.error while typing a regex
                self.regex_error.setText(f"Invalid regex: {exc}")
                self.regex_error.show()
        if style := self.case.currentData():
            rules.append(renamer.CaseRule(style))
        if self.prefix.text():
            rules.append(renamer.PrefixRule(self.prefix.text()))
        if self.suffix.text():
            rules.append(renamer.SuffixRule(self.suffix.text()))
        return rules

    def _schedule_preview(self, *_):
        self._preview_timer.start()

    def _update_buttons(self):
        ok = sum(e.status is renamer.Status.OK for e in self.plan)
        self.apply_btn.setEnabled(ok > 0)
        self.apply_btn.setText(f"Apply Rename ({ok})" if ok else "Apply Rename")
        hist = self.history()
        last = hist.peek() if hist else None
        self.undo_btn.setEnabled(last is not None)
        self.undo_btn.setToolTip(f"Undo: {last.label}" if last else "Nothing to undo in this folder")

    # ------------------------------------------------------------------ actions

    def handle_drop(self, paths):
        if len(paths) == 1 and paths[0].is_dir():
            self.folder.set_path(paths[0])
            return
        exts = FILTERS[self.filter.currentText()]
        files = []
        for p in paths:
            files += [f.path for f in scanner.scan(p, exts, self.recursive.isChecked())]
        self.folder.edit.clear()
        self.set_files(files)

    def scan(self):
        root = self.folder.path()
        if not root or not root.exists():
            self.summary.setText("Folder not found.")
            return
        exts = FILTERS[self.filter.currentText()]
        self.main.run_task(
            scanner.scan, root, exts, self.recursive.isChecked(),
            label=f"Scanning {root.name}…", on_result=lambda res: self.set_files([f.path for f in res]),
        )

    def set_files(self, files: list[Path]):
        self.files = files
        self.refresh_preview()

    def refresh_preview(self):
        self.plan = renamer.build_plan(self.files, self.rules())
        self.table.setUpdatesEnabled(False)
        self.table.setRowCount(len(self.plan))
        root = self.folder.path()
        for row, e in enumerate(self.plan):
            color = STATUS_COLORS[e.status]
            self.table.setItem(row, 0, item(e.status.value, color, e.message or e.status.value))
            self.table.setItem(row, 1, item(e.src.name))
            self.table.setItem(row, 2, item(e.new_name, theme.TEXT if e.status is renamer.Status.OK else theme.TEXT_DIM))
            folder = e.src.parent
            if root and root.is_dir():
                try:
                    folder = folder.relative_to(root)
                except ValueError:
                    pass
            self.table.setItem(row, 3, item(str(folder) if str(folder) != "." else "(root)", theme.TEXT_DIM, str(e.src.parent)))
        self.table.setUpdatesEnabled(True)
        counts = {s: sum(e.status is s for e in self.plan) for s in renamer.Status}
        self.summary.setText(
            f"{len(self.plan)} file(s)  ·  {counts[renamer.Status.OK]} to rename  ·  "
            f"{counts[renamer.Status.UNCHANGED]} unchanged  ·  {counts[renamer.Status.COLLISION]} collision(s)  ·  "
            f"{counts[renamer.Status.INVALID]} invalid"
        )
        self._update_buttons()

    def apply(self):
        todo = [e for e in self.plan if e.status is renamer.Status.OK]
        if not todo:
            return
        skipped = sum(e.status in (renamer.Status.COLLISION, renamer.Status.INVALID) for e in self.plan)
        text = f"Rename {len(todo)} file(s)?"
        if skipped:
            text += f"\n{skipped} file(s) with collisions / invalid names will be skipped."
        if QMessageBox.question(self, "Apply rename", text) != QMessageBox.Yes:
            return
        try:
            renamer.execute_plan(self.plan, self.history())
        except Exception as exc:
            QMessageBox.critical(self, "Rename failed", f"Nothing was changed (rolled back).\n\n{exc}")
            return
        mapping = {e.src: e.dst for e in todo}
        self.set_files([mapping.get(f, f) for f in self.files])

    def undo(self):
        hist = self.history()
        if not hist:
            return
        try:
            tx = renamer.undo_last(hist)
        except Exception as exc:
            QMessageBox.warning(self, "Undo failed", str(exc))
            return
        if tx:
            back = {Path(op["dst"]): Path(op["src"]) for op in tx.ops}
            self.set_files([back.get(f, f) for f in self.files])
