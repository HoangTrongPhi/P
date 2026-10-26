"""FBX Path Doctor view: scan FBX files, inspect texture paths, preview and apply fixes."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QColor
from PySide6.QtWidgets import (
    QButtonGroup, QCheckBox, QFileDialog, QFormLayout, QGroupBox, QHBoxLayout, QHeaderView, QLineEdit,
    QMessageBox, QRadioButton, QSplitter, QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget,
)

from core import fbx_doctor as fd
from core import scanner
from ui import theme
from ui.widgets import BaseTab, PathPicker, button, hint

KIND_COLORS = {
    fd.PathKind.ABSOLUTE_LOCAL: theme.ERROR,
    fd.PathKind.UNC_NETWORK: theme.WARN,
    fd.PathKind.RELATIVE_PORTABLE: theme.OK,
    fd.PathKind.EMPTY: theme.TEXT_DIM,
}
RESOLUTION_COLORS = {"found": theme.OK, "found_by_name": theme.WARN, "missing": theme.ERROR, "embedded": theme.INFO}
RESOLUTION_TEXT = {"found": "Found", "found_by_name": "Found by name", "missing": "Missing", "embedded": "Embedded"}


def scan_many(paths: list[Path], progress=None, cancel=None) -> list[fd.FbxScanResult]:
    results = []
    for i, p in enumerate(paths):
        if cancel and cancel.is_set():
            break
        try:
            results.append(fd.scan_fbx(p))
        except Exception as exc:
            results.append(fd.FbxScanResult(p, "?", 0, [], error=str(exc)))
        if progress:
            progress(i + 1, len(paths), p.name)
    return results


def fix_many(paths: list[Path], options: dict, progress=None, cancel=None) -> list[fd.FixReport | tuple[Path, str]]:
    reports = []
    for i, p in enumerate(paths):
        if cancel and cancel.is_set():
            break
        try:
            reports.append(fd.fix_fbx(p, **options))
        except Exception as exc:
            reports.append((p, str(exc)))
        if progress:
            progress(i + 1, len(paths), p.name)
    return reports


class FbxDoctorTab(BaseTab):
    title = "FBX Path Doctor"

    def __init__(self, main):
        super().__init__(main)
        self.results: list[fd.FbxScanResult] = []

        self.source = PathPicker("dir", "Folder with .fbx files (or drop folders / .fbx files here)")
        self.source.changed.connect(lambda _: self.scan())
        self.recursive = QCheckBox("Recursive", checked=True)
        src_row = QHBoxLayout()
        src_row.addWidget(self.source, 1)
        src_row.addWidget(self.recursive)
        src_row.addWidget(button("Add Files…", self.add_files))
        src_row.addWidget(button("Scan", self.scan))

        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["File / Owner", "Field", "Path", "Type", "On disk"])
        self.tree.setAlternatingRowColors(True)
        self.tree.setSelectionMode(QTreeWidget.ExtendedSelection)
        self.tree.setUniformRowHeights(True)
        hdr = self.tree.header()
        hdr.setSectionResizeMode(QHeaderView.Interactive)
        hdr.setStretchLastSection(False)
        hdr.setSectionResizeMode(2, QHeaderView.Stretch)
        self.tree.setColumnWidth(0, 260)
        self.tree.setColumnWidth(1, 120)
        self.tree.setColumnWidth(3, 130)
        self.tree.setColumnWidth(4, 110)
        self.summary = hint("Scan a folder to list texture paths baked into FBX files.")
        self.only_problems = QCheckBox("Show problems only")
        self.only_problems.toggled.connect(self.populate)

        # --- fix options
        self.mode_group = QButtonGroup(self)
        modes = QHBoxLayout()
        for mode, label, tip in (
            (fd.FixMode.RELATIVE, "Convert to relative", "Point at the real texture location, relative to the FBX"),
            (fd.FixMode.STRIP, "Strip to file name", "C:\\path\\to\\wood.png  ->  wood.png"),
            (fd.FixMode.COLLECT, "Collect && relink", "Copy textures into <fbx folder>/<subfolder> and point there"),
        ):
            rb = QRadioButton(label)
            rb.setToolTip(tip)
            rb.setProperty("mode", mode.value)
            self.mode_group.addButton(rb)
            modes.addWidget(rb)
        modes.addStretch(1)
        self.mode_group.buttons()[0].setChecked(True)
        self.mode_group.buttonToggled.connect(self._update_mode)

        self.rebase = PathPicker("dir", "Optional: rebase all textures onto this folder")
        self.subfolder = QLineEdit("textures")
        self.fix_all = QCheckBox("Rewrite all paths (not only problematic ones)")
        self.backup = QCheckBox("Keep .fbx.bak backup", checked=True)

        opts = QGroupBox("Fix")
        form = QFormLayout(opts)
        form.addRow("Mode", modes)
        form.addRow("Rebase folder", self.rebase)
        form.addRow("Subfolder", self.subfolder)
        flags = QHBoxLayout()
        flags.addWidget(self.fix_all)
        flags.addWidget(self.backup)
        flags.addStretch(1)
        form.addRow("", flags)
        actions = QHBoxLayout()
        actions.addWidget(hint("Applies to selected files, or all scanned files if none are selected."), 1)
        actions.addWidget(button("Restore Backup", self.restore))
        actions.addWidget(button("Dry Run", lambda: self.fix(dry_run=True)))
        self.fix_btn = button("Fix Paths", lambda: self.fix(dry_run=False), primary=True)
        actions.addWidget(self.fix_btn)
        form.addRow(actions)
        self._update_mode()

        top = QWidget()
        top_lay = QVBoxLayout(top)
        top_lay.setContentsMargins(0, 0, 0, 0)
        top_lay.addLayout(src_row)
        top_lay.addWidget(self.tree, 1)
        bar = QHBoxLayout()
        bar.addWidget(self.summary, 1)
        bar.addWidget(self.only_problems)
        top_lay.addLayout(bar)
        split = QSplitter(Qt.Vertical)
        split.addWidget(top)
        split.addWidget(opts)
        split.setStretchFactor(0, 1)
        split.setChildrenCollapsible(False)
        lay = QVBoxLayout(self)
        lay.addWidget(split)

        self._extra_files: list[Path] = []

    # ------------------------------------------------------------------ state

    def mode(self) -> fd.FixMode:
        return fd.FixMode(self.mode_group.checkedButton().property("mode"))

    def _update_mode(self, *_):
        m = self.mode()
        self.rebase.setEnabled(m is fd.FixMode.RELATIVE)
        self.subfolder.setEnabled(m is not fd.FixMode.STRIP)

    def selected_paths(self) -> list[Path]:
        paths = []
        for it in self.tree.selectedItems():
            while it.parent():
                it = it.parent()
            p = it.data(0, Qt.UserRole)
            if p and p not in paths:
                paths.append(p)
        return paths or [r.path for r in self.results if not r.error]

    # ------------------------------------------------------------------ scanning

    def handle_drop(self, paths):
        if len(paths) == 1 and paths[0].is_dir():
            self._extra_files = []
            self.source.set_path(paths[0])
        else:
            self.source.edit.clear()
            self._extra_files = paths
            self.scan()

    def add_files(self):
        files, _ = QFileDialog.getOpenFileNames(self, "Select FBX files", "", "FBX (*.fbx)")
        if files:
            self.handle_drop([Path(f) for f in files])

    def _collect(self) -> list[Path]:
        roots = [self.source.path()] if self.source.path() else self._extra_files
        files = []
        for r in roots:
            if r and r.exists():
                files += [f.path for f in scanner.scan(r, {".fbx"}, self.recursive.isChecked())]
        return files

    def scan(self):
        files = self._collect()
        if not files:
            self.summary.setText("No .fbx files found.")
            self.tree.clear()
            return
        self.main.run_task(scan_many, files, label=f"Scanning {len(files)} FBX file(s)…", on_result=self.set_results)

    def set_results(self, results: list[fd.FbxScanResult]):
        self.results = results
        self.populate()

    def populate(self, *_):
        self.tree.clear()
        only = self.only_problems.isChecked()
        n_problems = n_refs = 0
        for res in self.results:
            problems = res.problems
            n_problems += len(problems)
            n_refs += len(res.references)
            if only and not problems and not res.error:
                continue
            top = QTreeWidgetItem([res.path.name, f"{res.format} {res.version}".strip(), str(res.path.parent)])
            top.setData(0, Qt.UserRole, res.path)
            top.setToolTip(0, str(res.path))
            if res.error:
                status, color = f"Error: {res.error}", theme.ERROR
            elif problems:
                status, color = f"{len(problems)} issue(s)", theme.WARN
            else:
                status, color = "OK" if res.references else "No textures", theme.OK
            top.setText(3, status)
            top.setForeground(3, QBrush(QColor(color)))
            top.setText(4, f"{len(res.references)} path(s)")
            f = top.font(0)
            f.setBold(True)
            top.setFont(0, f)
            for ref in res.references:
                if only and not ref.is_problem:
                    continue
                child = QTreeWidgetItem([ref.owner, ref.field, ref.value, ref.kind.value,
                                         RESOLUTION_TEXT.get(ref.resolution, ref.resolution)])
                child.setForeground(3, QBrush(QColor(KIND_COLORS[ref.kind])))
                child.setForeground(4, QBrush(QColor(RESOLUTION_COLORS.get(ref.resolution, theme.TEXT))))
                child.setToolTip(2, ref.value)
                if ref.resolved:
                    child.setToolTip(4, f"Resolved to: {ref.resolved}")
                top.addChild(child)
            self.tree.addTopLevelItem(top)
            top.setExpanded(bool(problems) and len(self.results) <= 30)
        files_with = sum(bool(r.problems) for r in self.results)
        self.summary.setText(
            f"{len(self.results)} FBX file(s) · {n_refs} texture path(s) · "
            f"{n_problems} issue(s) in {files_with} file(s)"
        )

    # ------------------------------------------------------------------ fixing

    def fix(self, dry_run: bool):
        paths = self.selected_paths()
        if not paths:
            return
        if not dry_run and QMessageBox.question(
            self, "Fix FBX paths", f"Rewrite texture paths in {len(paths)} FBX file(s)?"
            + ("\nA .fbx.bak backup is kept next to each file." if self.backup.isChecked() else "")
        ) != QMessageBox.Yes:
            return
        rebase = self.rebase.path() if self.mode() is fd.FixMode.RELATIVE else None
        options = dict(mode=self.mode(), rebase_dir=rebase, subfolder=self.subfolder.text().strip(),
                       fix_all=self.fix_all.isChecked(), backup=self.backup.isChecked(), dry_run=dry_run)
        self.main.run_task(
            fix_many, paths, options, label="Previewing fixes…" if dry_run else "Fixing FBX paths…",
            on_result=lambda reps: self._fixed(reps, dry_run, paths),
        )

    def _fixed(self, reports, dry_run: bool, paths: list[Path]):
        log = self.main.log
        prefix = "[dry run] " if dry_run else ""
        total = 0
        for rep in reports:
            if isinstance(rep, tuple):
                log.error("%s%s: %s", prefix, rep[0].name, rep[1])
                continue
            total += len(rep.changes)
            if not rep.changes and not rep.copied:
                log.info("%s%s: nothing to change", prefix, rep.path.name)
            for c in rep.changes:
                log.info("%s%s  [%s %s]  %s  ->  %s", prefix, rep.path.name, c.owner, c.field, c.old, c.new)
            for src, dst in rep.copied:
                log.info("%s%s  copy %s -> %s", prefix, rep.path.name, src, dst)
            for w in rep.warnings:
                log.warning("%s%s: %s", prefix, rep.path.name, w)
        verb = "would be rewritten" if dry_run else "rewritten"
        self.main.notify(f"{total} path(s) {verb} in {len(reports)} file(s)")
        if not dry_run:
            self.main.run_task(scan_many, [r.path for r in self.results], label="Re-scanning…",
                               on_result=self.set_results)

    def restore(self):
        paths = self.selected_paths()
        restored = [p for p in paths if fd.restore_backup(p)]
        self.main.notify(f"Restored {len(restored)} file(s) from .bak" if restored else "No .fbx.bak backups found")
        if restored:
            self.main.run_task(scan_many, [r.path for r in self.results], label="Re-scanning…",
                               on_result=self.set_results)
