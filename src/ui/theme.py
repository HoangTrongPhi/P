"""Dark DCC-studio theme (palette + stylesheet)."""
from __future__ import annotations

from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication

BG = "#1e2026"
BG_ALT = "#252830"
PANEL = "#2b2f38"
BORDER = "#3a3f4b"
TEXT = "#d7dae0"
TEXT_DIM = "#8a909c"
ACCENT = "#4c8dff"
ACCENT_HOVER = "#6aa1ff"

OK = "#5fbf77"
WARN = "#e5b84b"
ERROR = "#ef6b6b"
INFO = "#6fb3ff"

STYLESHEET = f"""
QWidget {{ background: {BG}; color: {TEXT}; font-family: "Segoe UI", sans-serif; font-size: 9.5pt; }}
QMainWindow::separator {{ background: {BORDER}; width: 1px; height: 1px; }}
QToolTip {{ background: {PANEL}; color: {TEXT}; border: 1px solid {BORDER}; padding: 4px; }}

QTabWidget::pane {{ border: 1px solid {BORDER}; border-radius: 4px; top: -1px; background: {BG}; }}
QTabBar::tab {{ background: {BG_ALT}; color: {TEXT_DIM}; padding: 8px 18px; border: 1px solid {BORDER};
               border-bottom: none; border-top-left-radius: 4px; border-top-right-radius: 4px; margin-right: 2px; }}
QTabBar::tab:selected {{ background: {BG}; color: {TEXT}; border-top: 2px solid {ACCENT}; }}
QTabBar::tab:hover:!selected {{ color: {TEXT}; }}

QGroupBox {{ border: 1px solid {BORDER}; border-radius: 5px; margin-top: 14px; padding: 8px 6px 6px 6px; }}
QGroupBox::title {{ subcontrol-origin: margin; left: 10px; padding: 0 4px; color: {TEXT_DIM}; }}

QPushButton {{ background: {PANEL}; border: 1px solid {BORDER}; border-radius: 4px; padding: 5px 14px; }}
QPushButton:hover {{ border-color: {ACCENT}; }}
QPushButton:pressed {{ background: {BG_ALT}; }}
QPushButton:disabled {{ color: #5c6270; border-color: #2f333c; }}
QPushButton[primary="true"] {{ background: {ACCENT}; border-color: {ACCENT}; color: white; font-weight: 600; }}
QPushButton[primary="true"]:hover {{ background: {ACCENT_HOVER}; }}
QPushButton[primary="true"]:disabled {{ background: #34405a; border-color: #34405a; color: #8a96ad; }}
QPushButton:checked {{ background: #2f4673; border-color: {ACCENT}; }}

QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox, QPlainTextEdit, QTextEdit {{
    background: {BG_ALT}; border: 1px solid {BORDER}; border-radius: 4px; padding: 4px 6px;
    selection-background-color: {ACCENT}; }}
QLineEdit:focus, QComboBox:focus, QPlainTextEdit:focus {{ border-color: {ACCENT}; }}
QComboBox::drop-down {{ border: none; width: 18px; }}
QComboBox QAbstractItemView {{ background: {PANEL}; border: 1px solid {BORDER}; selection-background-color: {ACCENT}; }}

QTableView, QTreeView, QListView, QTableWidget, QTreeWidget, QListWidget {{
    background: {BG_ALT}; alternate-background-color: #282b34; border: 1px solid {BORDER}; border-radius: 4px;
    gridline-color: {BORDER}; selection-background-color: #34507f; selection-color: white; }}
QHeaderView::section {{ background: {PANEL}; color: {TEXT_DIM}; border: none; border-right: 1px solid {BORDER};
                        border-bottom: 1px solid {BORDER}; padding: 5px 6px; }}

QCheckBox::indicator, QRadioButton::indicator {{ width: 14px; height: 14px; }}
QCheckBox::indicator:unchecked, QTreeView::indicator:unchecked {{ border: 1px solid #5c6270; background: {BG_ALT}; border-radius: 3px; }}
QCheckBox::indicator:checked, QTreeView::indicator:checked {{ border: 1px solid {ACCENT}; background: {ACCENT}; border-radius: 3px; }}
QRadioButton::indicator {{ border-radius: 8px; }}
QRadioButton::indicator:unchecked {{ border: 1px solid #5c6270; background: {BG_ALT}; }}
QRadioButton::indicator:checked {{ border: 4px solid {ACCENT}; background: white; width: 8px; height: 8px; }}
QCheckBox:disabled, QRadioButton:disabled {{ color: #5c6270; }}

QProgressBar {{ background: {BG_ALT}; border: 1px solid {BORDER}; border-radius: 4px; text-align: center; height: 14px; }}
QProgressBar::chunk {{ background: {ACCENT}; border-radius: 3px; }}

QSlider::groove:horizontal {{ height: 4px; background: {BORDER}; border-radius: 2px; }}
QSlider::handle:horizontal {{ background: {ACCENT}; width: 12px; margin: -5px 0; border-radius: 6px; }}

QScrollBar:vertical {{ background: {BG}; width: 10px; }}
QScrollBar:horizontal {{ background: {BG}; height: 10px; }}
QScrollBar::handle {{ background: #444a57; border-radius: 4px; min-height: 24px; min-width: 24px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}

QDockWidget::title {{ background: {PANEL}; padding: 5px 8px; color: {TEXT_DIM}; }}
QStatusBar {{ background: {BG_ALT}; color: {TEXT_DIM}; }}
QSplitter::handle {{ background: {BORDER}; }}
QLabel[hint="true"] {{ color: {TEXT_DIM}; }}
QLabel[title="true"] {{ font-size: 11pt; font-weight: 600; }}
QFrame#dropZone {{ border: 2px dashed {BORDER}; border-radius: 8px; }}
"""


def apply_theme(app: QApplication) -> None:
    app.setStyle("Fusion")
    pal = QPalette()
    for role, color in {
        QPalette.Window: BG, QPalette.WindowText: TEXT, QPalette.Base: BG_ALT, QPalette.AlternateBase: "#282b34",
        QPalette.Text: TEXT, QPalette.Button: PANEL, QPalette.ButtonText: TEXT, QPalette.Highlight: ACCENT,
        QPalette.HighlightedText: "#ffffff", QPalette.ToolTipBase: PANEL, QPalette.ToolTipText: TEXT,
        QPalette.PlaceholderText: TEXT_DIM, QPalette.Link: ACCENT,
    }.items():
        pal.setColor(role, QColor(color))
    pal.setColor(QPalette.Disabled, QPalette.Text, QColor("#5c6270"))
    pal.setColor(QPalette.Disabled, QPalette.ButtonText, QColor("#5c6270"))
    app.setPalette(pal)
    app.setStyleSheet(STYLESHEET)
