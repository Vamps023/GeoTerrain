#pragma once

#include "GeoBounds.h"

#include <QColor>
#include <QMap>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QPixmap>
#include <QPoint>
#include <QRect>
#include <QString>
#include <QTimer>
#include <QVector>
#include <QWidget>

struct OverlayRing
{
    QVector<QPointF> points;
    bool closed = false;
};

struct OverlayLayer
{
    QString name;
    QColor color = QColor(255, 165, 0);
    QVector<OverlayRing> rings;
};

class MapPanel : public QWidget
{
    Q_OBJECT

public:
    explicit MapPanel(QWidget* parent = nullptr);
    ~MapPanel() override = default;

    void setTileUrl(const QString& url_template, const QString& source_name = QString());

    GeoBounds selectedBounds() const;
    bool hasSelection() const { return has_selection_; }

    void clearSelection();
    void centerOn(double lat, double lon, int zoom);
    void setSelection(const GeoBounds& bounds);

    void setOverlayLayers(const QVector<OverlayLayer>& layers);
    void clearOverlay();

    void setChunkGrid(const QVector<GeoBounds>& chunks);
    void clearChunkGrid();
    QVector<bool> chunkEnabled() const { return chunk_enabled_; }

signals:
    void selectionChanged(const GeoBounds& bounds);
    void logMessage(const QString& message);
    void tileSourceProblem(const QString& source_name, const QString& detail);

protected:
    void paintEvent(QPaintEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void mouseMoveEvent(QMouseEvent* event) override;
    void mouseReleaseEvent(QMouseEvent* event) override;
    void wheelEvent(QWheelEvent* event) override;
    void resizeEvent(QResizeEvent* event) override;

private slots:
    void onTileDownloaded(QNetworkReply* reply);

private:
    QPointF worldToWidget(double world_x, double world_y) const;
    QPointF widgetToWorld(const QPointF& pt) const;
    QPointF latLonToWorld(double lat, double lon) const;
    void worldToLatLon(double wx, double wy, double& lat, double& lon) const;
    void requestVisibleTiles();
    QString tileKey(int z, int x, int y) const;
    void clearPendingRequests();
    void logImageFormats();

    QString tile_url_template_;
    QString tile_source_name_;
    QNetworkAccessManager* net_manager_ = nullptr;
    QMap<QString, QPixmap> tile_cache_;
    QMap<QString, QNetworkReply*> pending_;
    int tile_success_count_ = 0;
    int tile_failure_count_ = 0;
    bool tile_problem_reported_ = false;
    bool image_formats_logged_ = false;
    bool jpeg_error_logged_ = false;

    static constexpr int TILE_SIZE = 256;

    double view_origin_x_ = 0.0;
    double view_origin_y_ = 0.0;
    int zoom_ = 4;

    bool panning_ = false;
    QPoint pan_start_widget_;
    double pan_start_origin_x_ = 0.0;
    double pan_start_origin_y_ = 0.0;

    bool selecting_ = false;
    bool has_selection_ = false;
    QPointF sel_start_world_;
    QPointF sel_end_world_;

    QTimer* refresh_timer_ = nullptr;
    QVector<OverlayLayer> overlay_layers_;
    QVector<GeoBounds> chunk_grid_;
    QVector<bool> chunk_enabled_;
};
