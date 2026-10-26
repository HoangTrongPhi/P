"""Project P — 3D Asset Toolkit & Doctor.

    python src/app.py [file-or-folder]
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# QtWebEngine must be imported and GL contexts shared before the QApplication exists.
from PySide6.QtCore import QCoreApplication, Qt  # noqa: E402
from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: E402,F401
from PySide6.QtWidgets import QApplication  # noqa: E402

from ui.main_window import MainWindow  # noqa: E402
from ui.theme import apply_theme  # noqa: E402

__version__ = "1.0.0"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    QCoreApplication.setAttribute(Qt.AA_ShareOpenGLContexts)
    app = QApplication(argv)
    app.setApplicationName("Project P")
    app.setApplicationVersion(__version__)
    app.setOrganizationName("Phineas")
    apply_theme(app)

    win = MainWindow()
    win.show()
    if len(argv) > 1 and Path(argv[1]).exists():
        target = Path(argv[1])
        tab = win._tab_for_drop([target])
        win.tabs.setCurrentWidget(tab)
        tab.handle_drop([target])
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
