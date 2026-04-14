#pragma once

#include "GeoBounds.h"

#include <QWidget>
#include <QPixmap>
#include <QPoint>
#include <QRect>
#include <QMap>
#include <QColor>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QString>
#include <QTimer>
#include <QVector>

#include <functional>

// ---------------------------------------------------------------------------
// Overlay geometry — lat/lon rings drawn on top of the map
// ---------------------------------------------------------------------------
struct OverlayRing
{
    QVector<QPointF> points;  // lat/lon pairs  (x=lon, y=lat)
    bool             closed = false;
};

struct OverlayLayer
{
    QString            name;
    QColor             color  = QColor(255, 165, 0);  // orange default
    QVector<OverlayRing> rings;
};

// ---------------------------------------------------------------------------
// MapPanel
// Native Qt widget that renders XYZ/TMS tiles and lets the user drag a
// geographic bounding box selection.
// ---------------------------------------------------------------------------
class MapPanel : public QWidget
{
    Q_OBJECT

public:
    explicit MapPanel(QWidget* parent = nullptr);
    ~MapPanel() override = default;

    // Set the TMS URL template, e.g.
    //   "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
    void setTileUrl(const QString& url_template);

    // Current selection
    GeoBounds  selectedBounds() const;
    bool       hasSelection()   const { return has_selection_; }

    // Clear the current selection rectangle
    void clearSelection();

    // Navigate to a lat/lon center at a given zoom
    void centerOn(double lat, double lon, int zoom);

    // Programmatically set the selection rectangle and emit selectionChanged
    void setSelection(const GeoBounds& bounds);

    // Set vector overlay layers drawn on top of tiles (pass empty to clear)
    void setOverlayLayers(const QVector<OverlayLayer>& layers);
    void clearOverlay();

    // Chunk grid — drawn over the selection; click to enable/disable tiles
    void setChunkGrid(const QVector<GeoBounds>& chunks);  // pass empty to clear
    void clearChunkGrid();
    QVector<bool> chunkEnabled() const { return chunk_enabled_; }

signals:
    void selectionChanged(const GeoBounds& bounds);
    void logMessage(const QString& message);
    void chunkToggled(int index, bool enabled);

protected:
    void paintEvent(QPaintEvent* event)         override;
    void mousePressEvent(QMouseEvent* event)    override;
    void mouseMoveEvent(QMouseEvent* event)     override;
    void mouseReleaseEvent(QMouseEvent* event)  override;
    void wheelEvent(QWheelEvent* event)         override;
    void resizeEvent(QResizeEvent* event)       override;

private slots:
    void onTileDownloaded(QNetworkReply* reply);

private:
    // Convert world (pixel) coords <-> widget coords
    QPointF worldToWidget(double world_x, double world_y) const;
    QPointF widgetToWorld(const QPointF& pt) const;

    // Convert lat/lon to world pixel at current zoom
    QPointF latLonToWorld(double lat, double lon) const;
    void    worldToLatLon(double wx, double wy, double& lat, double& lon) const;

    void requestVisibleTiles();
    QString tileKey(int z, int x, int y) const;

    // TMS / tile state
    QString                      tile_url_template_;
    QNetworkAccessManager*       net_manager_   = nullptr;
    QMap<QString, QPixmap>       tile_cache_;
    QMap<QString, QNetworkReply*> pending_;

    static constexpr int TILE_SIZE = 256;

    // Viewport: origin in world-pixel space
    double view_origin_x_ = 0.0;
    double view_origin_y_ = 0.0;
    int    zoom_          = 4;

    // Pan state
    bool    panning_    = false;
    QPoint  pan_start_widget_;
    double  pan_start_origin_x_ = 0.0;
    double  pan_start_origin_y_ = 0.0;

    // Bounding-box selection state
    bool    selecting_    = false;
    bool    has_selection_= false;
    QPointF sel_start_world_;   // anchor corner in world-pixel space
    QPointF sel_end_world_;     // drag corner in world-pixel space

    QTimer* refresh_timer_ = nullptr;

    // Vector overlay layers
    QVector<OverlayLayer> overlay_layers_;

    // Chunk grid
    QVector<GeoBounds> chunk_grid_;
    QVector<bool>      chunk_enabled_;
};
