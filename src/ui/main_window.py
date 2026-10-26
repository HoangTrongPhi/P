"""Main application window: tab navigation, task runner, log panel, global drag & drop."""
from __future__ import annotations

import logging
from pathlib import Path

from PySide6.QtCore import QObject, QSettings, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QTextCharFormat
from PySide6.QtWidgets import (
    QDockWidget, QLabel, QMainWindow, QPlainTextEdit, QProgressBar, QPushButton, QTabWidget,
)

from core.preview_service import AssetServer
from ui import theme, workers
from ui.tabs.tab_blender import BlenderTab
from ui.tabs.tab_fbx_doctor import FbxDoctorTab
from ui.tabs.tab_preview import PreviewTab
from ui.tabs.tab_renamer import RenamerTab
from ui.tabs.tab_tools import ToolsTab
from utils.logger import add_callback_handler, get_logger

APP_NAME = "Project P — 3D Asset Toolkit"
LEVEL_COLORS = {logging.DEBUG: theme.TEXT_DIM, logging.INFO: theme.TEXT, logging.WARNING: theme.WARN,
                logging.ERROR: theme.ERROR, logging.CRITICAL: theme.ERROR}


class _LogBridge(QObject):
    """Moves log records from any thread onto the GUI thread."""

    message = Signal(str, int)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(1400, 880)
        self.setAcceptDrops(True)
        self.settings = QSettings("Phineas", "ProjectP")
        self.log = get_logger("ui")
        self.server = AssetServer().start()
        self._tasks: list[workers.Worker] = []

        # --- log panel
        self.log_view = QPlainTextEdit(readOnly=True)
        self.log_view.setMaximumBlockCount(5000)
        self.log_view.setStyleSheet("font-family: Consolas, 'Cascadia Mono', monospace; font-size: 9pt;")
        dock = QDockWidget("Log", self)
        dock.setObjectName("LogDock")
        dock.setWidget(self.log_view)
        dock.setFeatures(QDockWidget.DockWidgetMovable | QDockWidget.DockWidgetFloatable)
        self.addDockWidget(Qt.BottomDockWidgetArea, dock)
        self._bridge = _LogBridge()
        self._bridge.message.connect(self._append_log, Qt.QueuedConnection)
        self._log_handler = add_callback_handler(self._bridge.message.emit)

        # --- status bar (before the tabs: they may start tasks while being built)
        self.status_label = QLabel()
        self.progress = QProgressBar(maximumWidth=260, textVisible=True)
        self.progress.hide()
        self.cancel_btn = QPushButton("Cancel", clicked=self.cancel_tasks)
        self.cancel_btn.hide()
        sb = self.statusBar()
        sb.addWidget(self.status_label, 1)
        sb.addPermanentWidget(self.progress)
        sb.addPermanentWidget(self.cancel_btn)

        # --- tabs
        self.tabs = QTabWidget()
        self.tab_list = [RenamerTab(self), FbxDoctorTab(self), BlenderTab(self), PreviewTab(self), ToolsTab(self)]
        for t in self.tab_list:
            self.tabs.addTab(t, t.title)
        self.setCentralWidget(self.tabs)

        self.resizeDocks([dock], [150], Qt.Vertical)
        self._restore_state()
        self.log.info("Ready. Drop files or folders onto any tab.")

    # ------------------------------------------------------------------ tasks

    def run_task(self, fn, *args, label: str = "Working…", on_result=None, on_error=None, on_finished=None,
                 **kwargs) -> workers.Worker:
        w = workers.Worker(fn, *args, **kwargs)
        self._tasks.append(w)
        if on_result:
            w.signals.result.connect(on_result)
        w.signals.error.connect(on_error or (lambda err: self._task_error(label, err)))
        w.signals.progress.connect(self._task_progress)
        w.signals.finished.connect(lambda: self._task_done(w))
        if on_finished:
            w.signals.finished.connect(on_finished)
        self.status_label.setText(label)
        self.progress.setRange(0, 0)  # busy until the first progress report
        self.progress.show()
        self.cancel_btn.show()
        return workers.start(w)

    def _task_progress(self, done: int, total: int, text: str):
        self.progress.setRange(0, max(total, 1))
        self.progress.setValue(done)
        if text:
            self.status_label.setText(text)

    def _task_error(self, label: str, err: str):
        self.log.error("%s failed: %s", label.rstrip("…."), err)
        self.notify(err, error=True)

    def _task_done(self, w: workers.Worker):
        if w in self._tasks:
            self._tasks.remove(w)
        if not self._tasks:
            self.progress.hide()
            self.cancel_btn.hide()
            if not self.status_label.property("sticky"):
                self.status_label.setText("Ready")

    def cancel_tasks(self):
        for w in self._tasks:
            w.cancel()
        self.log.warning("Cancellation requested")

    def notify(self, text: str, error: bool = False):
        self.status_label.setText(text)
        self.status_label.setStyleSheet(f"color: {theme.ERROR}" if error else "")
        self.status_label.setProperty("sticky", True)
        QTimer.singleShot(6000, lambda: (self.status_label.setProperty("sticky", False),
                                         self.status_label.setStyleSheet("")))
        (self.log.error if error else self.log.info)(text)

    # ------------------------------------------------------------------ log

    def _append_log(self, text: str, level: int):
        fmt = QTextCharFormat()
        fmt.setForeground(QColor(LEVEL_COLORS.get(level, theme.TEXT)))
        cursor = self.log_view.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        cursor.insertText(text + "\n", fmt)
        self.log_view.setTextCursor(cursor)
        self.log_view.ensureCursorVisible()

    # ------------------------------------------------------------------ drag & drop

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dragMoveEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event):
        paths = [Path(u.toLocalFile()) for u in event.mimeData().urls() if u.isLocalFile()]
        paths = [p for p in paths if p.exists()]
        if not paths:
            return
        event.acceptProposedAction()
        tab = self._tab_for_drop(paths)
        self.tabs.setCurrentWidget(tab)
        tab.handle_drop(paths)

    def _tab_for_drop(self, paths: list[Path]):
        """Stay on the current tab, except a single previewable file jumps to the previewer."""
        current = self.tabs.currentWidget()
        single = paths[0] if len(paths) == 1 and paths[0].is_file() else None
        if single:
            ext = single.suffix.lower()
            if ext == ".blend":
                return next(t for t in self.tab_list if isinstance(t, BlenderTab))
            if isinstance(current, (RenamerTab, ToolsTab)) or (ext != ".fbx" and isinstance(current, FbxDoctorTab)):
                return next(t for t in self.tab_list if isinstance(t, PreviewTab))
        return current

    # ------------------------------------------------------------------ persistence

    def _restore_state(self):
        if geo := self.settings.value("geometry"):
            self.restoreGeometry(geo)
        if state := self.settings.value("windowState"):
            self.restoreState(state)
        self.tabs.setCurrentIndex(int(self.settings.value("tab", 0)))

    def closeEvent(self, event):
        self.settings.setValue("geometry", self.saveGeometry())
        self.settings.setValue("windowState", self.saveState())
        self.settings.setValue("tab", self.tabs.currentIndex())
        self.cancel_tasks()
        get_logger().removeHandler(self._log_handler)
        self.server.stop()
        super().closeEvent(event)
