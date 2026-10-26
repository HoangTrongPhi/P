"""Universal previewer: 3D (Three.js in QWebEngineView), textures / HDR, and PSD with layers."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PySide6.QtCore import QDir, QSortFilterProxyModel, Qt, QUrl
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QFileSystemModel, QHBoxLayout, QHeaderView, QLabel, QPushButton, QSlider, QSplitter,
    QStackedWidget, QTreeView, QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget,
)

from core import fbx_doctor, preview_service as ps
from ui.image_viewer import ImageViewer, array_to_qimage
from ui.widgets import BaseTab, PathPicker, button, hint
from utils.file_helpers import MESH_EXTS, SOURCE_EXTS, TEXTURE_EXTS, human_size

PREVIEW_EXTS = MESH_EXTS | TEXTURE_EXTS | SOURCE_EXTS


class ViewerPage(QWebEnginePage):
    """Captures the viewer's console protocol (PP_READY / PP_STATS / PP_ERROR / PP_MISSING)."""

    def __init__(self, tab: "PreviewTab"):
        super().__init__(tab)
        self.tab = tab

    def javaScriptConsoleMessage(self, level, message, line, source):
        if message == "PP_READY":
            self.tab._viewer_ready()
        elif message.startswith("PP_STATS "):
            self.tab._show_stats(json.loads(message[9:]))
        elif message.startswith("PP_ERROR "):
            self.tab.main.log.error("3D viewer: %s", message[9:])
        elif message.startswith("PP_MISSING "):
            self.tab.main.log.warning("3D viewer: texture not found %s", message[11:])


class _AssetFilter(QSortFilterProxyModel):
    """Shows folders and previewable files only."""

    def filterAcceptsRow(self, row, parent):
        model: QFileSystemModel = self.sourceModel()
        idx = model.index(row, 0, parent)
        if model.isDir(idx):
            return True
        return Path(model.fileName(idx)).suffix.lower() in PREVIEW_EXTS


class PreviewTab(BaseTab):
    title = "Asset Previewer"

    def __init__(self, main):
        super().__init__(main)
        self.current: Path | None = None
        self.texture: ps.TextureData | None = None
        self.rendered: np.ndarray | None = None
        self.psd: ps.PsdDocument | None = None
        self._ready = False
        self._pending_model: tuple[str, str] | None = None
        self._load_token = 0

        # --- browser
        self.root = PathPicker("dir", "Folder to browse")
        self.root.changed.connect(self.set_root)
        self.fs = QFileSystemModel(self)
        self.fs.setFilter(QDir.AllDirs | QDir.NoDotAndDotDot | QDir.Files)
        self.proxy = _AssetFilter(self)
        self.proxy.setSourceModel(self.fs)
        self.browser = QTreeView()
        self.browser.setModel(self.proxy)
        for col in (2, 3):
            self.browser.hideColumn(col)
        self.browser.header().setSectionResizeMode(0, QHeaderView.Stretch)
        self.browser.header().setStretchLastSection(False)
        self.browser.setSortingEnabled(True)
        self.browser.sortByColumn(0, Qt.AscendingOrder)
        self.browser.selectionModel().currentChanged.connect(self._browser_selected)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(self.root)
        ll.addWidget(self.browser, 1)
        ll.addWidget(hint("Drop any .fbx .obj .glb .gltf .png .jpg .tga .dds .exr .hdr .psd file to preview."))

        # --- 3D page
        self.web = QWebEngineView()
        self.web.setPage(ViewerPage(self))
        self.web.setUrl(QUrl(self.main.server.viewer_url))
        self.wire = QPushButton("Wireframe", checkable=True)
        self.wire.toggled.connect(lambda on: self._js(f"setWireframe({str(on).lower()})"))
        self.checker = QPushButton("UV Checker", checkable=True)
        self.checker.toggled.connect(lambda on: self._js(f"setUvChecker({str(on).lower()})"))
        self.grid = QPushButton("Grid", checkable=True, checked=True)
        self.grid.toggled.connect(lambda on: self._js(f"setGrid({str(on).lower()})"))
        bar3d = QHBoxLayout()
        for w in (self.wire, self.checker, self.grid):
            bar3d.addWidget(w)
        bar3d.addWidget(button("Frame", lambda: self._js("resetView()")))
        bar3d.addStretch(1)
        page3d = QWidget()
        l3 = QVBoxLayout(page3d)
        l3.setContentsMargins(0, 0, 0, 0)
        l3.addLayout(bar3d)
        l3.addWidget(self.web, 1)

        # --- 2D page (textures + PSD share the viewport)
        self.viewer = ImageViewer()
        self.viewer.pixelHovered.connect(self._pixel_info)
        self.viewer.zoomChanged.connect(lambda z: self.zoom_lbl.setText(f"{z * 100:.0f}%"))
        self.channel = QComboBox()
        for mode, label in (("rgba", "RGBA"), ("rgb", "RGB"), ("alpha", "Alpha"), ("r", "R"), ("g", "G"), ("b", "B")):
            self.channel.addItem(label, mode)
        self.channel.currentIndexChanged.connect(self.rerender)
        self.exposure = QSlider(Qt.Horizontal, minimum=-80, maximum=80, value=0)  # tenths of a stop
        self.gamma = QSlider(Qt.Horizontal, minimum=50, maximum=300, value=100)   # hundredths
        self.exposure.valueChanged.connect(self.rerender)
        self.gamma.valueChanged.connect(self.rerender)
        self.exp_lbl, self.gamma_lbl, self.zoom_lbl = QLabel("0.0 EV"), QLabel("γ 1.00"), QLabel("")
        for lbl in (self.exp_lbl, self.gamma_lbl):
            lbl.setMinimumWidth(56)
        reset = button("Reset", self._reset_tone)
        bar2d = QHBoxLayout()
        bar2d.addWidget(QLabel("Channel"))
        bar2d.addWidget(self.channel)
        bar2d.addSpacing(12)
        bar2d.addWidget(QLabel("Exposure"))
        bar2d.addWidget(self.exposure, 1)
        bar2d.addWidget(self.exp_lbl)
        bar2d.addWidget(QLabel("Gamma"))
        bar2d.addWidget(self.gamma, 1)
        bar2d.addWidget(self.gamma_lbl)
        bar2d.addWidget(reset)
        bar2d.addWidget(button("Fit", self.viewer.fit))
        bar2d.addWidget(button("1:1", self.viewer.actual_size))
        bar2d.addWidget(self.zoom_lbl)

        self.layers = QTreeWidget()
        self.layers.setHeaderLabels(["Layer", "Kind", "Size"])
        self.layers.header().setSectionResizeMode(0, QHeaderView.Stretch)
        self.layers.header().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.layers.header().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.layers.header().setStretchLastSection(False)
        self.layers.itemChanged.connect(self._layer_toggled)
        self.layers.setMinimumWidth(300)
        self.composite_btn = button("Re-composite", self._recomposite)

        self.layer_panel = QWidget()
        lp = QVBoxLayout(self.layer_panel)
        lp.setContentsMargins(0, 0, 0, 0)
        lp.addWidget(self.layers, 1)
        self.live_composite = QCheckBox("Live update", checked=True)
        row = QHBoxLayout()
        row.addWidget(self.live_composite)
        row.addStretch(1)
        row.addWidget(self.composite_btn)
        lp.addLayout(row)

        img_split = QSplitter(Qt.Horizontal)
        img_split.addWidget(self.viewer)
        img_split.addWidget(self.layer_panel)
        img_split.setStretchFactor(0, 1)
        img_split.setSizes([800, 320])
        page2d = QWidget()
        l2 = QVBoxLayout(page2d)
        l2.setContentsMargins(0, 0, 0, 0)
        l2.addLayout(bar2d)
        l2.addWidget(img_split, 1)
        self.bar2d_widgets = [self.channel, self.exposure, self.gamma, reset]

        self.empty = QLabel("Select or drop an asset to preview")
        self.empty.setAlignment(Qt.AlignCenter)
        self.empty.setProperty("hint", True)

        self.stack = QStackedWidget()
        self.stack.addWidget(self.empty)
        self.stack.addWidget(page3d)
        self.stack.addWidget(page2d)

        self.info = QLabel()
        self.info.setProperty("hint", True)
        self.info.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.pixel = QLabel()
        self.pixel.setProperty("hint", True)
        info_row = QHBoxLayout()
        info_row.addWidget(self.info, 1)
        info_row.addWidget(self.pixel)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(self.stack, 1)
        rl.addLayout(info_row)

        split = QSplitter(Qt.Horizontal)
        split.addWidget(left)
        split.addWidget(right)
        split.setSizes([280, 900])
        split.setChildrenCollapsible(False)
        lay = QVBoxLayout(self)
        lay.addWidget(split)

    # ------------------------------------------------------------------ browsing

    def set_root(self, path: str):
        p = Path(path)
        if not p.is_dir():
            return
        src_root = self.fs.setRootPath(str(p))
        self.browser.setRootIndex(self.proxy.mapFromSource(src_root))

    def _browser_selected(self, current, _previous):
        path = Path(self.fs.filePath(self.proxy.mapToSource(current)))
        if path.is_file():
            self.open(path)

    def handle_drop(self, paths):
        p = paths[0]
        if p.is_dir():
            self.root.set_path(p)
        else:
            self.root.edit.setText(str(p.parent))
            self.set_root(str(p.parent))
            self.open(p)

    # ------------------------------------------------------------------ dispatch

    def open(self, path: Path):
        ext = path.suffix.lower()
        if ext not in PREVIEW_EXTS:
            self.main.notify(f"Unsupported file type: {ext}", error=True)
            return
        self.current = path
        self._load_token += 1
        self.pixel.clear()
        if ext in MESH_EXTS:
            self._open_model(path)
        elif ext in SOURCE_EXTS:
            self._open_psd(path)
        else:
            self._open_texture(path)

    # ------------------------------------------------------------------ 3D

    def _js(self, code: str):
        if self._ready:
            self.web.page().runJavaScript(code)

    def _viewer_ready(self):
        self._ready = True
        self._js(f"setWireframe({str(self.wire.isChecked()).lower()})")
        if self._pending_model:
            url, name = self._pending_model
            self._pending_model = None
            self._js(f"loadModel({json.dumps(url)}, {json.dumps(name)})")

    def _open_model(self, path: Path):
        self.stack.setCurrentIndex(1)
        self.info.setText(f"{path.name}  ·  {human_size(path.stat().st_size)}  ·  loading…")
        extra_dirs = []
        if path.suffix.lower() == ".fbx":
            # textures with absolute paths baked in: let the server find them where FBX Doctor resolves them
            try:
                extra_dirs = sorted({str(r.resolved.parent) for r in fbx_doctor.scan_fbx(path).references if r.resolved})
            except Exception as exc:
                self.main.log.debug("FBX pre-scan failed: %s", exc)
        url = self.main.server.url_for(path, extra_dirs)
        if self._ready:
            self._js(f"loadModel({json.dumps(url)}, {json.dumps(path.name)})")
        else:
            self._pending_model = (url, path.name)

    def _show_stats(self, s: dict):
        if not self.current:
            return
        size = " × ".join(f"{v:.3g}" for v in s["size"])
        self.info.setText(
            f"{s['name']}  ·  {human_size(self.current.stat().st_size)}  ·  {s['meshes']} mesh(es)  ·  "
            f"{s['vertices']:,} verts  ·  {s['triangles']:,} tris  ·  {s['materials']} material(s)  ·  "
            f"{s['uvSets']} UV set(s)  ·  bounds {size}"
        )

    # ------------------------------------------------------------------ textures

    def _open_texture(self, path: Path):
        self.stack.setCurrentIndex(2)
        self.layer_panel.hide()
        self.psd = None
        token = self._load_token
        self.info.setText(f"{path.name}  ·  decoding…")
        self.main.run_task(ps.load_texture, path, label=f"Decoding {path.name}…",
                           on_result=lambda tex: self._texture_loaded(tex, token),
                           on_error=lambda err: self._load_failed(path, err))

    def _texture_loaded(self, tex: ps.TextureData, token: int):
        if token != self._load_token:
            return  # a newer selection superseded this one
        self.texture = tex
        for w in self.bar2d_widgets:
            w.setEnabled(True)
        # Linear HDR data needs display gamma; 8-bit textures are already sRGB-encoded.
        self.gamma.blockSignals(True)
        self.exposure.blockSignals(True)
        self.gamma.setValue(220 if tex.is_float and tex.info.get("bit_depth") == 32 else 100)
        self.exposure.setValue(0)
        self.gamma.blockSignals(False)
        self.exposure.blockSignals(False)
        self.rerender(keep_view=False)
        i = tex.info
        self.info.setText(
            f"{i['file']}  ·  {tex.width} × {tex.height}  ·  {i['format']}  ·  {i.get('mode', '')}  ·  "
            f"{i.get('bit_depth', 8)}-bit  ·  {tex.source_channels} channel(s)  ·  {human_size(i['file_size'])}"
        )

    def _reset_tone(self):
        if self.texture:
            self._texture_loaded(self.texture, self._load_token)

    def rerender(self, *_, keep_view: bool = True):
        ev, gamma = self.exposure.value() / 10, self.gamma.value() / 100
        self.exp_lbl.setText(f"{ev:+.1f} EV")
        self.gamma_lbl.setText(f"γ {gamma:.2f}")
        if self.texture is None or self.psd is not None:
            return
        self.rendered = ps.render_texture(self.texture, ev, gamma, self.channel.currentData())
        self.viewer.set_image(array_to_qimage(self.rendered), keep_view=keep_view)

    def _pixel_info(self, x: int, y: int):
        if x < 0:
            self.pixel.clear()
            return
        if self.psd is None and self.texture is not None:
            v = self.texture.pixels[y, x]
            vals = ", ".join(f"{c:.3f}" for c in v) if self.texture.is_float else ", ".join(str(int(c)) for c in v)
        elif self.rendered is not None:
            vals = ", ".join(str(int(c)) for c in self.rendered[y, x])
        else:
            return
        self.pixel.setText(f"x {x}  y {y}  ·  RGBA ({vals})")

    def _load_failed(self, path: Path, err: str):
        self.info.setText(f"{path.name}  ·  could not be decoded")
        self.viewer.clear()
        self.main.log.error("Preview %s: %s", path.name, err)

    # ------------------------------------------------------------------ PSD

    def _open_psd(self, path: Path):
        self.stack.setCurrentIndex(2)
        self.layer_panel.show()
        self.texture = None
        for w in self.bar2d_widgets:
            w.setEnabled(False)
        token = self._load_token
        self.info.setText(f"{path.name}  ·  compositing…")

        def load(p):
            doc = ps.PsdDocument(p)
            return doc, doc.composite()

        self.main.run_task(load, path, label=f"Compositing {path.name}…",
                           on_result=lambda res: self._psd_loaded(*res, token),
                           on_error=lambda err: self._load_failed(path, err))

    def _psd_loaded(self, doc: ps.PsdDocument, image: np.ndarray, token: int):
        if token != self._load_token:
            return
        self.psd = doc
        self.rendered = image
        self.viewer.set_image(array_to_qimage(image))
        i = doc.info
        self.info.setText(f"{i['file']}  ·  {i['width']} × {i['height']}  ·  PSD {i['color_mode']}  ·  "
                          f"{i['bit_depth']}-bit  ·  {i['layers']} layer(s)  ·  {human_size(i['file_size'])}")
        self.layers.blockSignals(True)
        self.layers.clear()

        def add(parent, nodes):
            for n in nodes:
                x1, y1, x2, y2 = n.bbox
                it = QTreeWidgetItem([n.name, n.kind, f"{x2 - x1} × {y2 - y1}"])
                it.setData(0, Qt.UserRole, n.layer_id)
                it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
                it.setCheckState(0, Qt.Checked if n.visible else Qt.Unchecked)
                (parent.addChild if parent else self.layers.addTopLevelItem)(it)
                add(it, n.children)
                it.setExpanded(True)

        add(None, doc.layer_tree())
        self.layers.blockSignals(False)

    def _layer_toggled(self, it: QTreeWidgetItem, column: int):
        if self.psd is None or column != 0:
            return
        self.psd.set_visible(it.data(0, Qt.UserRole), it.checkState(0) == Qt.Checked)
        if self.live_composite.isChecked():
            self._recomposite()

    def _recomposite(self):
        if self.psd is None:
            return
        doc, token = self.psd, self._load_token

        def done(img):
            if token == self._load_token:
                self.rendered = img
                self.viewer.set_image(array_to_qimage(img), keep_view=True)

        self.main.run_task(doc.composite, label="Compositing…", on_result=done)
