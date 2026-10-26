"""Pan / zoom image viewport with a transparency checkerboard and pixel picking."""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QImage, QPainter, QPixmap
from PySide6.QtWidgets import QGraphicsPixmapItem, QGraphicsScene, QGraphicsView


def array_to_qimage(arr: np.ndarray) -> QImage:
    """H x W x 4 uint8 RGBA -> QImage that owns its memory."""
    arr = np.ascontiguousarray(arr)
    h, w = arr.shape[:2]
    return QImage(arr.data, w, h, 4 * w, QImage.Format_RGBA8888).copy()


def _checker_brush(size: int = 10) -> QBrush:
    pm = QPixmap(size * 2, size * 2)
    pm.fill(QColor("#3a3d45"))
    p = QPainter(pm)
    p.fillRect(0, 0, size, size, QColor("#2c2f36"))
    p.fillRect(size, size, size, size, QColor("#2c2f36"))
    p.end()
    return QBrush(pm)


class ImageViewer(QGraphicsView):
    pixelHovered = Signal(int, int)  # image coordinates, (-1, -1) when outside
    zoomChanged = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self._item = QGraphicsPixmapItem()
        self._item.setTransformationMode(Qt.FastTransformation)  # crisp pixels when zoomed in
        self._scene.addItem(self._item)
        self._checker = _checker_brush()
        self._fit = True
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.AnchorViewCenter)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.setMouseTracking(True)
        self.setBackgroundBrush(QColor("#1b1d22"))
        self.setFrameShape(QGraphicsView.NoFrame)

    def set_image(self, image: QImage, keep_view: bool = False) -> None:
        self._item.setPixmap(QPixmap.fromImage(image))
        self._scene.setSceneRect(QRectF(self._item.pixmap().rect()))
        if not keep_view:
            self.fit()

    def clear(self) -> None:
        self._item.setPixmap(QPixmap())

    def fit(self) -> None:
        self._fit = True
        if not self._item.pixmap().isNull():
            self.fitInView(self._item, Qt.KeepAspectRatio)
            if self.transform().m11() > 1:  # don't upscale small textures on fit
                self.resetTransform()
            self.zoomChanged.emit(self.transform().m11())

    def actual_size(self) -> None:
        self._fit = False
        self.resetTransform()
        self.zoomChanged.emit(1.0)

    def drawBackground(self, painter: QPainter, rect: QRectF) -> None:
        super().drawBackground(painter, rect)
        if not self._item.pixmap().isNull():
            painter.save()
            painter.setBrushOrigin(0, 0)
            painter.fillRect(self._item.sceneBoundingRect().intersected(rect), self._checker)
            painter.restore()

    def wheelEvent(self, event) -> None:
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        scale = self.transform().m11() * factor
        if 0.02 < scale < 64:
            self._fit = False
            self.scale(factor, factor)
            self.zoomChanged.emit(scale)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        if self._fit:
            self.fit()

    def mouseMoveEvent(self, event) -> None:
        super().mouseMoveEvent(event)
        pos: QPointF = self.mapToScene(event.position().toPoint())
        pm = self._item.pixmap()
        x, y = int(pos.x()), int(pos.y())
        if not pm.isNull() and 0 <= x < pm.width() and 0 <= y < pm.height():
            self.pixelHovered.emit(x, y)
        else:
            self.pixelHovered.emit(-1, -1)
