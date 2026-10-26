"""Blender 5.0+ pack & consolidate view."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QColor
from PySide6.QtWidgets import (
    QAbstractItemView, QButtonGroup, QCheckBox, QComboBox, QFileDialog, QFormLayout, QGroupBox, QHBoxLayout,
    QHeaderView, QListWidget, QListWidgetItem, QRadioButton, QSplitter, QTreeWidget, QTreeWidgetItem,
    QVBoxLayout, QWidget,
)

from core import blender_packer as bp
from core import scanner
from ui import theme
from ui.widgets import BaseTab, PathPicker, button, hint


def pack_many(blender: bp.BlenderInstall, files: list[Path], options: dict, on_line=None,
              progress=None, cancel=None) -> list[tuple[Path, bp.PackResult | str]]:
    results = []
    for i, f in enumerate(files):
        if cancel and cancel.is_set():
            break
        opts = bp.PackOptions(**options)
        out_dir = options.get("output")
        if out_dir:  # "save into folder": one sub-folder per blend keeps textures apart
            opts.output = Path(out_dir) / f.stem / f.name
        if options.get("zip_archive"):
            opts.zip_archive = (Path(out_dir) if out_dir else f.parent) / f"{f.stem}_packed.zip"

        def step(done, total, text, i=i):
            if progress:
                progress(i * 100 + done * 100 // max(total, 1), len(files) * 100, f"{f.name}: {text}")

        try:
            results.append((f, bp.run_pack(blender, f, opts, on_output=on_line, on_progress=step, cancel=cancel)))
        except Exception as exc:
            results.append((f, str(exc)))
    return results


class BlenderTab(BaseTab):
    title = "Blender Packer"

    def __init__(self, main):
        super().__init__(main)
        self.installs: list[bp.BlenderInstall] = []

        self.blender = QComboBox()
        self.blender.setMinimumWidth(380)
        bl_row = QHBoxLayout()
        bl_row.addWidget(self.blender, 1)
        bl_row.addWidget(button("Browse…", self.browse_blender))
        bl_row.addWidget(button("Detect", self.detect))

        self.files = QListWidget()
        self.files.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.files.setAlternatingRowColors(True)
        file_btns = QHBoxLayout()
        file_btns.addWidget(button("Add .blend…", self.add_files))
        file_btns.addWidget(button("Add Folder…", self.add_folder))
        file_btns.addWidget(button("Remove", self.remove_selected))
        file_btns.addWidget(button("Clear", self.files.clear))
        file_btns.addStretch(1)
        files_box = QGroupBox("Blend files  (drop .blend files or folders)")
        fl = QVBoxLayout(files_box)
        fl.addWidget(self.files, 1)
        fl.addLayout(file_btns)

        self.consolidate = QCheckBox("Consolidate external files into //textures", checked=True)
        self.consolidate.setToolTip("Copy every referenced file next to the .blend and repoint it there")
        self.unpack = QCheckBox("Unpack embedded files into //textures")
        self.relative = QCheckBox("Make all paths relative", checked=True)
        self.pack = QCheckBox("Pack all resources into the .blend")
        self.analyse = QCheckBox("Analyse only (don't modify or save)")
        self.analyse.toggled.connect(self._update_options)

        self.out_mode = QButtonGroup(self)
        self.in_place = QRadioButton("Overwrite in place (Blender keeps .blend1)")
        self.to_folder = QRadioButton("Save copies into folder:")
        self.to_folder.setChecked(True)
        self.out_mode.addButton(self.in_place)
        self.out_mode.addButton(self.to_folder)
        self.out_mode.buttonToggled.connect(self._update_options)
        self.out_dir = PathPicker("dir", "Output folder")
        self.zip = QCheckBox("Bundle each result into a .zip archive")

        opts = QGroupBox("Operations")
        form = QFormLayout(opts)
        for w in (self.consolidate, self.unpack, self.relative, self.pack, self.analyse):
            form.addRow(w)
        form.addRow(self.in_place)
        out_row = QHBoxLayout()
        out_row.addWidget(self.to_folder)
        out_row.addWidget(self.out_dir, 1)
        form.addRow(out_row)
        form.addRow(self.zip)
        self.run_btn = button("Run", self.run, primary=True)
        run_row = QHBoxLayout()
        run_row.addWidget(hint("Runs Blender headless (blender -b -P). Your session is not affected."), 1)
        run_row.addWidget(self.run_btn)
        form.addRow(run_row)

        self.report = QTreeWidget()
        self.report.setHeaderLabels(["File / Data-block", "Type", "Path", "Status"])
        self.report.setAlternatingRowColors(True)
        rh = self.report.header()
        rh.setSectionResizeMode(QHeaderView.Interactive)
        rh.setSectionResizeMode(2, QHeaderView.Stretch)
        rh.setStretchLastSection(False)
        self.report.setColumnWidth(0, 240)
        self.report.setColumnWidth(1, 80)
        self.report.setColumnWidth(3, 120)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(files_box, 1)
        ll.addWidget(opts)
        split = QSplitter(Qt.Horizontal)
        split.addWidget(left)
        rep_box = QGroupBox("Dependency report")
        QVBoxLayout(rep_box).addWidget(self.report)
        split.addWidget(rep_box)
        split.setStretchFactor(1, 1)
        split.setChildrenCollapsible(False)

        lay = QVBoxLayout(self)
        lay.addLayout(bl_row)
        lay.addWidget(split, 1)
        self._update_options()
        self.detect()

    # ------------------------------------------------------------------ blender discovery

    def detect(self):
        self.blender.clear()
        self.blender.addItem("Detecting Blender installs…")
        self.main.run_task(bp.discover_blenders, label="Detecting Blender…", on_result=self._set_installs)

    def _set_installs(self, installs: list[bp.BlenderInstall]):
        self.installs = installs
        self.blender.clear()
        for b in installs:
            label = str(b) if b.supported else f"{b}   — unsupported (needs 5.0+)"
            self.blender.addItem(label, b)
        if not installs:
            self.blender.addItem("No Blender found — use Browse… to pick blender.exe", None)
        self.run_btn.setEnabled(bool(installs))

    def browse_blender(self):
        path, _ = QFileDialog.getOpenFileName(self, "Locate blender executable", "", "Blender (blender.exe blender)")
        if not path:
            return
        ver = bp.probe_version(path)
        if ver is None:
            self.main.notify("That file is not a working Blender executable", error=True)
            return
        install = bp.BlenderInstall(Path(path), ver)
        self.installs.insert(0, install)
        self._set_installs(self.installs)

    # ------------------------------------------------------------------ files

    def _add_paths(self, paths: list[Path]):
        existing = {self.files.item(i).data(Qt.UserRole) for i in range(self.files.count())}
        for p in paths:
            for f in scanner.scan(p, {".blend"}):
                if f.path not in existing:
                    it = QListWidgetItem(f.path.name)
                    it.setToolTip(str(f.path))
                    it.setData(Qt.UserRole, f.path)
                    self.files.addItem(it)
                    existing.add(f.path)

    def handle_drop(self, paths):
        self._add_paths(paths)

    def add_files(self):
        files, _ = QFileDialog.getOpenFileNames(self, "Select .blend files", "", "Blender (*.blend)")
        self._add_paths([Path(f) for f in files])

    def add_folder(self):
        d = QFileDialog.getExistingDirectory(self, "Folder with .blend files")
        if d:
            self._add_paths([Path(d)])

    def remove_selected(self):
        for it in self.files.selectedItems():
            self.files.takeItem(self.files.row(it))

    def _update_options(self, *_):
        writable = not self.analyse.isChecked()
        for w in (self.consolidate, self.unpack, self.relative, self.pack, self.in_place, self.to_folder, self.zip):
            w.setEnabled(writable)
        self.out_dir.setEnabled(writable and self.to_folder.isChecked())

    # ------------------------------------------------------------------ run

    def run(self):
        install = self.blender.currentData()
        if not isinstance(install, bp.BlenderInstall):
            self.main.notify("Select a Blender executable first", error=True)
            return
        if not install.supported:
            self.main.log.warning("Blender %s is older than 5.0; results may differ", install.version_string)
        files = [self.files.item(i).data(Qt.UserRole) for i in range(self.files.count())]
        if not files:
            self.main.notify("Add .blend files first", error=True)
            return
        out_dir = None
        if not self.analyse.isChecked() and self.to_folder.isChecked():
            out_dir = self.out_dir.path()
            if not out_dir:
                self.main.notify("Choose an output folder (or select 'Overwrite in place')", error=True)
                return
        options = dict(
            consolidate=self.consolidate.isChecked(), unpack=self.unpack.isChecked(),
            make_relative=self.relative.isChecked(), pack_all=self.pack.isChecked(),
            analyse_only=self.analyse.isChecked(), output=out_dir, zip_archive=self.zip.isChecked() or None,
        )
        self.report.clear()
        blender_log = self.main.log.getChild("blender.out")
        self.run_btn.setEnabled(False)
        self.main.run_task(
            pack_many, install, files, options, on_line=lambda line: blender_log.info(line) if line.strip() else None,
            label=f"Blender: processing {len(files)} file(s)…", on_result=self._show_results,
            on_finished=lambda: self.run_btn.setEnabled(True),
        )

    def _show_results(self, results):
        ok_count = 0
        for f, res in results:
            top = QTreeWidgetItem([f.name, "", str(f)])
            bold = top.font(0)
            bold.setBold(True)
            top.setFont(0, bold)
            if isinstance(res, str) or not res.ok:
                err = res if isinstance(res, str) else res.error
                top.setText(3, "Failed")
                top.setForeground(3, QBrush(QColor(theme.ERROR)))
                top.setToolTip(3, err or "")
                self.main.log.error("%s: %s", f.name, err)
                if not isinstance(res, str) and res.report.get("traceback"):
                    self.main.log.error(res.report["traceback"])
            else:
                ok_count += 1
                missing = res.missing
                top.setText(3, f"{len(missing)} missing" if missing else "OK")
                top.setForeground(3, QBrush(QColor(theme.WARN if missing else theme.OK)))
                saved = res.report.get("blend")
                if saved and Path(saved) != f:
                    top.setText(2, saved)
                for dep in res.report.get("after", []):
                    if dep["packed"]:
                        status, color = "Packed", theme.INFO
                    elif dep["exists"]:
                        status, color = ("Relative" if dep["relative"] else "Absolute"), (
                            theme.OK if dep["relative"] else theme.WARN)
                    else:
                        status, color = "Missing", theme.ERROR
                    child = QTreeWidgetItem([dep["name"], dep["type"], dep["filepath"], status])
                    child.setToolTip(2, dep["abspath"])
                    child.setForeground(3, QBrush(QColor(color)))
                    top.addChild(child)
                for line in res.report.get("log", []):
                    self.main.log.info("%s: %s", f.name, line)
                if res.archive:
                    self.main.log.info("%s: archive %s", f.name, res.archive)
            self.report.addTopLevelItem(top)
            top.setExpanded(True)
        self.main.notify(f"Blender finished: {ok_count}/{len(results)} file(s) OK")
