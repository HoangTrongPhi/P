"""Structured logging shared by the core services and the UI log panel."""
from __future__ import annotations

import logging
import sys
from typing import Callable

LOGGER_NAME = "project_p"
_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


class CallbackHandler(logging.Handler):
    """Forwards formatted records to a callable (e.g. a Qt signal emitter)."""

    def __init__(self, callback: Callable[[str, int], None]):
        super().__init__()
        self._callback = callback
        self.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s", "%H:%M:%S"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._callback(self.format(record), record.levelno)
        except Exception:  # never let logging crash the app
            self.handleError(record)


def get_logger(child: str | None = None) -> logging.Logger:
    root = logging.getLogger(LOGGER_NAME)
    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(_FORMAT))
        root.addHandler(handler)
        root.setLevel(logging.INFO)
    return root.getChild(child) if child else root


def add_callback_handler(callback: Callable[[str, int], None]) -> CallbackHandler:
    handler = CallbackHandler(callback)
    get_logger().addHandler(handler)
    return handler
