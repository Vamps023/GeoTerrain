#include "MapPanel.h"

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>

#include <QPainter>
#include <QPen>
#include <QBrush>
#include <QMouseEvent>
#include <QWheelEvent>
#include <QNetworkRequest>
#include <QUrl>
#include <QFont>
#include <QFontMetrics>

#include <cmath>
#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static constexpr double MAX_WORLD_LAT = 85.05112878;

// ---------------------------------------------------------------------------
MapPanel::MapPanel(QWidget* parent)
    : QWidget(parent)
    , tile_url_template_("https://tile.openstreetmap.org/{z}/{x}/{y}.png")
    , net_manager_(new QNetworkAccessManager(this))
    , refresh_timer_(new QTimer(this))
{
    setMinimumSize(400, 300);
    setMouseTracking(true);
    setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);

    connect(net_manager_, &QNetworkAccessManager::finished,
            this,         &MapPanel::onTileDownloaded);

    refresh_timer_->setInterval(50);
    refresh_timer_->setSingleShot(true);
    connect(refresh_timer_, &QTimer::timeout, this, [this]{ update(); });

    // Start centered on (20, 0) zoom 2
    centerOn(20.0, 0.0, 2);
}

// ---------------------------------------------------------------------------
void MapPanel::setTileUrl(const QString& url_template)
{
    tile_url_template_ = url_template;
    tile_cache_.clear();
    pending_.clear();
    update();
}

// ---------------------------------------------------------------------------
void MapPanel::centerOn(double lat, double lon, int zoom)
{
    zoom_ = std::max(0, std::min(zoom, 19));
    QPointF world = latLonToWorld(lat, lon);
    view_origin_x_ = world.x() - width()  / 2.0;
    view_origin_y_ = world.y() - height() / 2.0;
    tile_cache_.clear();
    requestVisibleTiles();
    update();
}

// ---------------------------------------------------------------------------
void MapPanel::clearSelection()
{
    has_selection_ = false;
    update();
}

// ---------------------------------------------------------------------------
GeoBounds MapPanel::selectedBounds() const
{
    GeoBounds b;
    if (!has_selection_)
        return b;

    double lat0, lon0, lat1, lon1;
    worldToLatLon(sel_start_world_.x(), sel_start_world_.y(), lat0, lon0);
    worldToLatLon(sel_end_world_.x(),   sel_end_world_.y(),   lat1, lon1);

    b.west  = std::min(lon0, lon1);
    b.east  = std::max(lon0, lon1);
    b.south = std::min(lat0, lat1);
    b.north = std::max(lat0, lat1);
    return b;
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------
QPointF MapPanel::latLonToWorld(double lat, double lon) const
{
    const double n   = std::pow(2.0, zoom_);
    const double tx  = (lon + 180.0) / 360.0 * n;
    const double lat_r = lat * M_PI / 180.0;
    const double ty  = (1.0 - std::log(std::tan(lat_r) + 1.0 / std::cos(lat_r)) / M_PI) / 2.0 * n;
    return QPointF(tx * TILE_SIZE, ty * TILE_SIZE);
}

void MapPanel::worldToLatLon(double wx, double wy, double& lat, double& lon) const
{
    const double n   = std::pow(2.0, zoom_);
    const double tx  = wx / TILE_SIZE;
    const double ty  = wy / TILE_SIZE;
    lon = tx / n * 360.0 - 180.0;
    const double sinh_val = std::sinh(M_PI * (1.0 - 2.0 * ty / n));
    lat = std::atan(sinh_val) * 180.0 / M_PI;
}

QPointF MapPanel::worldToWidget(double world_x, double world_y) const
{
    return QPointF(world_x - view_origin_x_, world_y - view_origin_y_);
}

QPointF MapPanel::widgetToWorld(const QPointF& pt) const
{
    return QPointF(pt.x() + view_origin_x_, pt.y() + view_origin_y_);
}

// ---------------------------------------------------------------------------
QString MapPanel::tileKey(int z, int x, int y) const
{
    return QString("%1/%2/%3").arg(z).arg(x).arg(y);
}

// ---------------------------------------------------------------------------
void MapPanel::requestVisibleTiles()
{
    const int max_tile = static_cast<int>(std::pow(2.0, zoom_)) - 1;

    const int tile_x0 = std::max(0, static_cast<int>(std::floor(view_origin_x_ / TILE_SIZE)));
    const int tile_y0 = std::max(0, static_cast<int>(std::floor(view_origin_y_ / TILE_SIZE)));
    const int tile_x1 = std::min(max_tile, static_cast<int>(std::floor((view_origin_x_ + width())  / TILE_SIZE)));
    const int tile_y1 = std::min(max_tile, static_cast<int>(std::floor((view_origin_y_ + height()) / TILE_SIZE)));

    for (int ty = tile_y0; ty <= tile_y1; ++ty)
    {
        for (int tx = tile_x0; tx <= tile_x1; ++tx)
        {
            const QString key = tileKey(zoom_, tx, ty);
            if (tile_cache_.contains(key) || pending_.contains(key))
                continue;

            QString url = tile_url_template_;
            url.replace("{z}", QString::number(zoom_));
            url.replace("{x}", QString::number(tx));
            url.replace("{y}", QString::number(ty));

            QNetworkRequest req;
            req.setUrl(QUrl(url));
            req.setRawHeader("User-Agent", "GeoTerrainEditorPlugin/1.0");
            req.setAttribute(QNetworkRequest::User, key);

            QNetworkReply* reply = net_manager_->get(req);
            pending_[key] = reply;
        }
    }
}

// ---------------------------------------------------------------------------
void MapPanel::onTileDownloaded(QNetworkReply* reply)
{
    const QString key = reply->request().attribute(QNetworkRequest::User).toString();
    pending_.remove(key);

    if (reply->error() == QNetworkReply::NoError)
    {
        QPixmap pix;
        if (pix.loadFromData(reply->readAll()))
        {
            tile_cache_[key] = pix;
            if (!refresh_timer_->isActive())
                refresh_timer_->start();
        }
    }
    reply->deleteLater();
}

// ---------------------------------------------------------------------------
void MapPanel::paintEvent(QPaintEvent*)
{
    QPainter p(this);
    p.setRenderHint(QPainter::SmoothPixmapTransform, true);

    // --- Background ---
    p.fillRect(rect(), QColor(30, 30, 30));

    // --- Tiles ---
    const int max_tile = static_cast<int>(std::pow(2.0, zoom_)) - 1;
    const int tile_x0  = static_cast<int>(std::floor(view_origin_x_ / TILE_SIZE));
    const int tile_y0  = static_cast<int>(std::floor(view_origin_y_ / TILE_SIZE));
    const int tile_x1  = static_cast<int>(std::floor((view_origin_x_ + width())  / TILE_SIZE));
    const int tile_y1  = static_cast<int>(std::floor((view_origin_y_ + height()) / TILE_SIZE));

    for (int ty = tile_y0; ty <= tile_y1; ++ty)
    {
        for (int tx = tile_x0; tx <= tile_x1; ++tx)
        {
            const int cx = std::max(0, std::min(tx, max_tile));
            const int cy = std::max(0, std::min(ty, max_tile));
            const QString key = tileKey(zoom_, cx, cy);

            const int wx = static_cast<int>(std::round(tx * TILE_SIZE - view_origin_x_));
            const int wy = static_cast<int>(std::round(ty * TILE_SIZE - view_origin_y_));

            if (tile_cache_.contains(key))
            {
                p.drawPixmap(wx, wy, TILE_SIZE, TILE_SIZE, tile_cache_[key]);
            }
            else
            {
                p.fillRect(wx, wy, TILE_SIZE, TILE_SIZE, QColor(50, 50, 55));
                p.setPen(QColor(70, 70, 75));
                p.drawRect(wx, wy, TILE_SIZE - 1, TILE_SIZE - 1);
                p.setPen(QColor(100, 100, 110));
                p.drawText(QRect(wx, wy, TILE_SIZE, TILE_SIZE), Qt::AlignCenter,
                           QString("%1/%2/%3").arg(zoom_).arg(cx).arg(cy));
            }
        }
    }

    // --- Selection rectangle ---
    if ((selecting_ || has_selection_) && sel_start_world_ != sel_end_world_)
    {
        const QPointF w0 = worldToWidget(sel_start_world_.x(), sel_start_world_.y());
        const QPointF w1 = worldToWidget(sel_end_world_.x(),   sel_end_world_.y());

        const QRectF sel_rect = QRectF(w0, w1).normalized();

        // Semi-transparent fill
        p.setBrush(QColor(0, 120, 215, 50));
        p.setPen(QPen(QColor(0, 180, 255), 2, Qt::SolidLine));
        p.drawRect(sel_rect);

        // Corner handles
        p.setBrush(QColor(0, 180, 255));
        p.setPen(Qt::NoPen);
        const int hsize = 6;
        for (const QPointF& corner : { sel_rect.topLeft(), sel_rect.topRight(),
                                        sel_rect.bottomLeft(), sel_rect.bottomRight() })
            p.drawEllipse(corner, hsize, hsize);
    }

    // --- Coordinates overlay ---
    if (has_selection_)
    {
        const GeoBounds b = selectedBounds();
        const QString info = QString("N:%1  S:%2  W:%3  E:%4")
            .arg(b.north, 0, 'f', 5).arg(b.south, 0, 'f', 5)
            .arg(b.west,  0, 'f', 5).arg(b.east,  0, 'f', 5);

        QFont font = p.font();
        font.setPointSize(9);
        p.setFont(font);
        const QFontMetrics fm(font);
        const int pad  = 6;
        const int tw   = fm.horizontalAdvance(info) + pad * 2;
        const int th   = fm.height() + pad * 2;
        const QRect info_rect(6, 6, tw, th);

        p.setBrush(QColor(0, 0, 0, 160));
        p.setPen(Qt::NoPen);
        p.drawRoundedRect(info_rect, 4, 4);
        p.setPen(Qt::white);
        p.drawText(info_rect, Qt::AlignCenter, info);
    }

    // --- Zoom level indicator ---
    {
        const QString zoom_str = QString("Zoom: %1").arg(zoom_);
        QFont font = p.font();
        font.setPointSize(8);
        p.setFont(font);
        const QFontMetrics fm(font);
        const int tw = fm.horizontalAdvance(zoom_str) + 10;
        const int th = fm.height() + 6;
        const QRect zoom_rect(width() - tw - 6, 6, tw, th);
        p.setBrush(QColor(0, 0, 0, 140));
        p.setPen(Qt::NoPen);
        p.drawRoundedRect(zoom_rect, 3, 3);
        p.setPen(QColor(200, 200, 200));
        p.drawText(zoom_rect, Qt::AlignCenter, zoom_str);
    }

    // --- Instructions ---
    if (!has_selection_)
    {
        p.setPen(QColor(180, 180, 180, 180));
        QFont font = p.font();
        font.setPointSize(8);
        p.setFont(font);
        p.drawText(rect().adjusted(0, 0, 0, -8),
                   Qt::AlignBottom | Qt::AlignHCenter,
                   "Right-drag: pan  |  Shift+drag: select area  |  Scroll: zoom");
    }

    requestVisibleTiles();
}

// ---------------------------------------------------------------------------
void MapPanel::mousePressEvent(QMouseEvent* event)
{
    if (event->button() == Qt::RightButton ||
        (event->button() == Qt::LeftButton && !(event->modifiers() & Qt::ShiftModifier)))
    {
        panning_         = true;
        pan_start_widget_   = event->pos();
        pan_start_origin_x_ = view_origin_x_;
        pan_start_origin_y_ = view_origin_y_;
        setCursor(Qt::ClosedHandCursor);
    }
    else if (event->button() == Qt::LeftButton && (event->modifiers() & Qt::ShiftModifier))
    {
        selecting_       = true;
        has_selection_   = false;
        sel_start_world_ = widgetToWorld(event->pos());
        sel_end_world_   = sel_start_world_;
        setCursor(Qt::CrossCursor);
    }
    event->accept();
}

void MapPanel::mouseMoveEvent(QMouseEvent* event)
{
    if (panning_)
    {
        const QPoint delta = event->pos() - pan_start_widget_;
        view_origin_x_ = pan_start_origin_x_ - delta.x();
        view_origin_y_ = pan_start_origin_y_ - delta.y();
        requestVisibleTiles();
        update();
    }
    else if (selecting_)
    {
        sel_end_world_ = widgetToWorld(event->pos());
        update();
    }
    event->accept();
}

void MapPanel::mouseReleaseEvent(QMouseEvent* event)
{
    if (panning_)
    {
        panning_ = false;
        setCursor(Qt::ArrowCursor);
    }
    else if (selecting_)
    {
        selecting_     = false;
        sel_end_world_ = widgetToWorld(event->pos());

        const QPointF delta = sel_end_world_ - sel_start_world_;
        if (std::abs(delta.x()) > 4 && std::abs(delta.y()) > 4)
        {
            has_selection_ = true;
            emit selectionChanged(selectedBounds());
        }
        setCursor(Qt::ArrowCursor);
        update();
    }
    event->accept();
}

void MapPanel::wheelEvent(QWheelEvent* event)
{
    const int degrees = event->angleDelta().y() / 8;
    const int steps   = degrees / 15;

    // Widget position under cursor — keep it fixed during zoom
    const QPointF cursor_widget = event->pos();
    QPointF cursor_world        = widgetToWorld(cursor_widget);
    double  lat_at_cursor, lon_at_cursor;
    worldToLatLon(cursor_world.x(), cursor_world.y(), lat_at_cursor, lon_at_cursor);

    const int new_zoom = std::max(0, std::min(19, zoom_ + steps));
    if (new_zoom == zoom_)
    {
        event->accept();
        return;
    }

    zoom_ = new_zoom;
    tile_cache_.clear();
    pending_.clear();

    // Reposition so the cursor lat/lon stays under the mouse
    const QPointF new_world = latLonToWorld(lat_at_cursor, lon_at_cursor);
    view_origin_x_ = new_world.x() - cursor_widget.x();
    view_origin_y_ = new_world.y() - cursor_widget.y();

    requestVisibleTiles();
    update();
    event->accept();
}

void MapPanel::resizeEvent(QResizeEvent* event)
{
    QWidget::resizeEvent(event);
    requestVisibleTiles();
}
