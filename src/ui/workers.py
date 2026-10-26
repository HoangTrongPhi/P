"""Background execution on QThreadPool with Qt-signal callbacks."""
from __future__ import annotations

import inspect
import threading
import traceback
from typing import Any, Callable

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal

from utils.logger import get_logger

log = get_logger("worker")


class WorkerSignals(QObject):
    result = Signal(object)
    error = Signal(str)
    progress = Signal(int, int, str)
    finished = Signal()


class Worker(QRunnable):
    """Runs ``fn(*args, **kwargs)`` off the GUI thread.

    If ``fn`` accepts ``cancel`` / ``progress`` keyword arguments they are injected:
    ``cancel`` is a threading.Event, ``progress(done, total, text="")`` emits ``signals.progress``.
    """

    def __init__(self, fn: Callable[..., Any], *args, **kwargs):
        super().__init__()
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.signals = WorkerSignals()
        self.cancel_event = threading.Event()
        params = inspect.signature(fn).parameters
        if "cancel" in params:
            self.kwargs.setdefault("cancel", self.cancel_event)
        if "progress" in params:
            self.kwargs.setdefault("progress", self._progress)

    def _progress(self, done: int, total: int, text: str = "") -> None:
        self.signals.progress.emit(done, total, text)

    def run(self) -> None:
        try:
            result = self.fn(*self.args, **self.kwargs)
        except Exception as exc:
            log.debug(traceback.format_exc())
            self.signals.error.emit(f"{type(exc).__name__}: {exc}")
        else:
            self.signals.result.emit(result)
        finally:
            self.signals.finished.emit()

    def cancel(self) -> None:
        self.cancel_event.set()


def start(worker: Worker) -> Worker:
    QThreadPool.globalInstance().start(worker)
    return worker
