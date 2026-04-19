#include "MapPanel.h"

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>

#include <QBrush>
#include <QFont>
#include <QFontMetrics>
#include <QImageReader>
#include <QMouseEvent>
#include <QNetworkRequest>
#include <QPainter>
#include <QPen>
#include <QUrl>
#include <QWheelEvent>

#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

MapPanel::MapPanel(QWidget* parent)
    : QWidget(parent)
    , tile_url_template_("https://tile.openstreetmap.org/{z}/{x}/{y}.png")
    , tile_source_name_("Street")
    , net_manager_(new QNetworkAccessManager(this))
    , refresh_timer_(new QTimer(this))
{
    setMinimumSize(400, 300);
    setMouseTracking(true);
    setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);

    connect(net_manager_, &QNetworkAccessManager::finished, this, &MapPanel::onTileDownloaded);

    refresh_timer_->setInterval(50);
    refresh_timer_->setSingleShot(true);
    connect(refresh_timer_, &QTimer::timeout, this, [this]() { update(); });

    centerOn(20.0, 0.0, 2);
}

void MapPanel::clearPendingRequests()
{
    // Create a copy of pending replies to avoid modifying the map during iteration
    QList<QNetworkReply*> replies;
    for (auto it = pending_.begin(); it != pending_.end(); ++it)
    {
        if (it.value())
            replies << it.value();
    }
    
    // Clear the map first to prevent re-entry from finished signal
    pending_.clear();
    
    // Abort and delete each reply (disconnect to prevent double-deletion)
    for (QNetworkReply* reply : replies)
    {
        if (reply)
        {
            reply->disconnect();  // Disconnect all signals to prevent re-entry
            reply->abort();
            reply->deleteLater();
        }
    }
}

void MapPanel::setTileUrl(const QString& url_template, const QString& source_name)
{
    tile_url_template_ = url_template;
    tile_source_name_ = source_name.isEmpty() ? url_template : source_name;
    tile_cache_.clear();
    clearPendingRequests();
    tile_success_count_ = 0;
    tile_failure_count_ = 0;
    tile_problem_reported_ = false;
    jpeg_error_logged_ = false;  // Reset for new tile source
    requestVisibleTiles();
    update();
}

void MapPanel::centerOn(double lat, double lon, int zoom)
{
    zoom_ = std::max(0, std::min(zoom, 19));
    QPointF world = latLonToWorld(lat, lon);
    view_origin_x_ = world.x() - width() / 2.0;
    view_origin_y_ = world.y() - height() / 2.0;
    tile_cache_.clear();
    requestVisibleTiles();
    update();
}

void MapPanel::clearSelection()
{
    has_selection_ = false;
    update();
}

void MapPanel::setSelection(const GeoBounds& bounds)
{
    sel_start_world_ = latLonToWorld(bounds.north, bounds.west);
    sel_end_world_ = latLonToWorld(bounds.south, bounds.east);
    has_selection_ = true;
    selecting_ = false;
    update();
    emit selectionChanged(bounds);
}

void MapPanel::setOverlayLayers(const QVector<OverlayLayer>& layers)
{
    overlay_layers_ = layers;
    update();
}

void MapPanel::clearOverlay()
{
    overlay_layers_.clear();
    update();
}

void MapPanel::setChunkGrid(const QVector<GeoBounds>& chunks)
{
    chunk_grid_ = chunks;
    chunk_enabled_.fill(true, chunks.size());
    update();
}

void MapPanel::clearChunkGrid()
{
    chunk_grid_.clear();
    chunk_enabled_.clear();
    update();
}

GeoBounds MapPanel::selectedBounds() const
{
    GeoBounds b;
    if (!has_selection_)
        return b;

    double lat0 = 0.0;
    double lon0 = 0.0;
    double lat1 = 0.0;
    double lon1 = 0.0;
    worldToLatLon(sel_start_world_.x(), sel_start_world_.y(), lat0, lon0);
    worldToLatLon(sel_end_world_.x(), sel_end_world_.y(), lat1, lon1);

    b.west = std::min(lon0, lon1);
    b.east = std::max(lon0, lon1);
    b.south = std::min(lat0, lat1);
    b.north = std::max(lat0, lat1);
    return b;
}

QPointF MapPanel::latLonToWorld(double lat, double lon) const
{
    const double n = std::pow(2.0, zoom_);
    const double tx = (lon + 180.0) / 360.0 * n;
    const double lat_r = lat * M_PI / 180.0;
    const double ty = (1.0 - std::log(std::tan(lat_r) + 1.0 / std::cos(lat_r)) / M_PI) / 2.0 * n;
    return QPointF(tx * TILE_SIZE, ty * TILE_SIZE);
}

void MapPanel::worldToLatLon(double wx, double wy, double& lat, double& lon) const
{
    const double n = std::pow(2.0, zoom_);
    const double tx = wx / TILE_SIZE;
    const double ty = wy / TILE_SIZE;
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

QString MapPanel::tileKey(int z, int x, int y) const
{
    return QString("%1/%2/%3").arg(z).arg(x).arg(y);
}

QString MapPanel::tileDecodeFailureReason() const
{
    const bool expects_jpeg = tile_url_template_.contains("arcgisonline.com")
                           || tile_url_template_.contains("nationalmap.gov");
    if (!expects_jpeg)
        return "Failed to decode PNG tile";

    const QList<QByteArray> formats = QImageReader::supportedImageFormats();
    const bool has_jpeg = formats.contains("jpeg") || formats.contains("jpg");
    return has_jpeg
        ? "Failed to decode JPEG tile despite JPEG support"
        : "Cannot decode JPEG tiles - Qt JPEG plugin (qjpeg.dll) missing";
}

void MapPanel::logImageFormats()
{
    if (image_formats_logged_)
        return;
    
    image_formats_logged_ = true;
    QList<QByteArray> formats = QImageReader::supportedImageFormats();
    QStringList format_strings;
    for (const QByteArray& format : formats)
        format_strings << QString(format);
    
    emit logMessage(QString("[Map] Qt supports image formats: %1").arg(format_strings.join(", ")));
    
    // Check for JPEG specifically since ArcGIS tiles are JPEG
    bool has_jpeg = formats.contains("jpeg") || formats.contains("jpg");
    if (!has_jpeg)
        emit logMessage("[Map] WARNING: JPEG support not available - satellite tiles may not decode");
}

void MapPanel::requestVisibleTiles()
{
    const int max_tile = static_cast<int>(std::pow(2.0, zoom_)) - 1;
    const int tile_x0 = std::max(0, static_cast<int>(std::floor(view_origin_x_ / TILE_SIZE)));
    const int tile_y0 = std::max(0, static_cast<int>(std::floor(view_origin_y_ / TILE_SIZE)));
    const int tile_x1 = std::min(max_tile, static_cast<int>(std::floor((view_origin_x_ + width()) / TILE_SIZE)));
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

            const QUrl request_url(url);
            QNetworkRequest req(request_url);
            req.setRawHeader("User-Agent", "GeoTerrainEditorPlugin/1.0");
            req.setRawHeader("Accept", "image/*,*/*;q=0.8");
            if (request_url.host().contains("arcgisonline.com"))
                req.setRawHeader("Referer", "https://www.arcgis.com/");
            else if (request_url.host().contains("nationalmap.gov"))
                req.setRawHeader("Referer", "https://www.usgs.gov/");
            req.setAttribute(QNetworkRequest::User, key);

            QNetworkReply* reply = net_manager_->get(req);
            pending_[key] = reply;
        }
    }
}

void MapPanel::onTileDownloaded(QNetworkReply* reply)
{
    // Defensive null check
    if (!reply)
        return;
    
    // Get the key before removing from pending map
    const QString key = reply->request().attribute(QNetworkRequest::User).toString();
    pending_.remove(key);

    if (reply->error() == QNetworkReply::NoError)
    {
        QByteArray data = reply->readAll();
        QPixmap pix;
        
        // Log image formats on first successful download attempt
        logImageFormats();
        
        if (pix.loadFromData(data))
        {
            tile_cache_.insert(key, new QPixmap(pix));
            ++tile_success_count_;
            if (!refresh_timer_->isActive())
                refresh_timer_->start();
        }
        else
        {
            ++tile_failure_count_;
            if (!jpeg_error_logged_)
            {
                jpeg_error_logged_ = true;
                emit logMessage("[Map] ERROR: " + tileDecodeFailureReason());
            }
        }
    }
    else
    {
        ++tile_failure_count_;
        emit logMessage(QString("[Map] Network error for tile: %1").arg(reply->errorString()));
    }

    if (!tile_problem_reported_ && tile_success_count_ == 0 && tile_failure_count_ >= 6)
    {
        tile_problem_reported_ = true;
        const QString detail = reply->error() != QNetworkReply::NoError
            ? reply->errorString()
            : tileDecodeFailureReason();
        emit logMessage(QString("[Map] %1 preview is having trouble: %2").arg(tile_source_name_, detail));
        emit tileSourceProblem(tile_source_name_, detail);
    }

    reply->deleteLater();
}

void MapPanel::paintEvent(QPaintEvent*)
{
    QPainter p(this);
    p.setRenderHint(QPainter::SmoothPixmapTransform, true);
    p.fillRect(rect(), QColor(30, 30, 30));

    const int max_tile = static_cast<int>(std::pow(2.0, zoom_)) - 1;
    const int tile_x0 = static_cast<int>(std::floor(view_origin_x_ / TILE_SIZE));
    const int tile_y0 = static_cast<int>(std::floor(view_origin_y_ / TILE_SIZE));
    const int tile_x1 = static_cast<int>(std::floor((view_origin_x_ + width()) / TILE_SIZE));
    const int tile_y1 = static_cast<int>(std::floor((view_origin_y_ + height()) / TILE_SIZE));

    for (int ty = tile_y0; ty <= tile_y1; ++ty)
    {
        for (int tx = tile_x0; tx <= tile_x1; ++tx)
        {
            const int cx = std::max(0, std::min(tx, max_tile));
            const int cy = std::max(0, std::min(ty, max_tile));
            const QString key = tileKey(zoom_, cx, cy);

            const int wx = static_cast<int>(std::round(tx * TILE_SIZE - view_origin_x_));
            const int wy = static_cast<int>(std::round(ty * TILE_SIZE - view_origin_y_));

            if (QPixmap* cached = tile_cache_.object(key))
            {
                p.drawPixmap(wx, wy, TILE_SIZE, TILE_SIZE, *cached);
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

    if ((selecting_ || has_selection_) && sel_start_world_ != sel_end_world_)
    {
        const QPointF w0 = worldToWidget(sel_start_world_.x(), sel_start_world_.y());
        const QPointF w1 = worldToWidget(sel_end_world_.x(), sel_end_world_.y());
        const QRectF sel_rect = QRectF(w0, w1).normalized();

        p.setBrush(QColor(0, 120, 215, 50));
        p.setPen(QPen(QColor(0, 180, 255), 2, Qt::SolidLine));
        p.drawRect(sel_rect);

        p.setBrush(QColor(0, 180, 255));
        p.setPen(Qt::NoPen);
        const int hsize = 6;
        for (const QPointF& corner : { sel_rect.topLeft(), sel_rect.topRight(), sel_rect.bottomLeft(), sel_rect.bottomRight() })
            p.drawEllipse(corner, hsize, hsize);
    }

    if (!chunk_grid_.isEmpty())
    {
        p.setRenderHint(QPainter::Antialiasing, false);
        QFont cf = p.font();
        cf.setPointSize(8);
        cf.setBold(true);
        p.setFont(cf);

        for (int i = 0; i < chunk_grid_.size(); ++i)
        {
            const GeoBounds& cb = chunk_grid_[i];
            const bool enabled = i < chunk_enabled_.size() && chunk_enabled_[i];

            const QPointF worldNW = latLonToWorld(cb.north, cb.west);
            const QPointF worldSE = latLonToWorld(cb.south, cb.east);
            const QPointF wNW = worldToWidget(worldNW.x(), worldNW.y());
            const QPointF wSE = worldToWidget(worldSE.x(), worldSE.y());
            const QRectF cr = QRectF(wNW, wSE).normalized();

            if (enabled)
            {
                p.setBrush(QColor(0, 200, 80, 40));
                p.setPen(QPen(QColor(0, 220, 100), 1, Qt::DashLine));
            }
            else
            {
                p.setBrush(QColor(220, 0, 0, 55));
                p.setPen(QPen(QColor(255, 60, 60), 1, Qt::DashLine));
            }
            p.drawRect(cr);

            const QString lbl = enabled ? QString("C%1").arg(i + 1) : QString("C%1\nSKIP").arg(i + 1);
            p.setPen(enabled ? QColor(120, 255, 140) : QColor(255, 100, 100));
            p.drawText(cr, Qt::AlignCenter, lbl);

            if (!enabled)
            {
                p.setPen(QPen(QColor(255, 60, 60, 160), 1));
                p.drawLine(cr.topLeft(), cr.bottomRight());
                p.drawLine(cr.topRight(), cr.bottomLeft());
            }
        }

        p.setFont(QFont());
        p.setBrush(QColor(0, 0, 0, 140));
        p.setPen(Qt::NoPen);
        const QString hint = "Click chunk to skip/include";
        QFontMetrics hfm(p.font());
        QRect hrect(6, height() - hfm.height() - 14, hfm.horizontalAdvance(hint) + 12, hfm.height() + 8);
        p.drawRoundedRect(hrect, 3, 3);
        p.setPen(QColor(200, 200, 200));
        p.drawText(hrect, Qt::AlignCenter, hint);
    }

    if (has_selection_)
    {
        const GeoBounds b = selectedBounds();
        const QString info = QString("N:%1  S:%2  W:%3  E:%4")
            .arg(b.north, 0, 'f', 5).arg(b.south, 0, 'f', 5)
            .arg(b.west, 0, 'f', 5).arg(b.east, 0, 'f', 5);

        QFont font = p.font();
        font.setPointSize(9);
        p.setFont(font);
        const QFontMetrics fm(font);
        const int pad = 6;
        const int tw = fm.horizontalAdvance(info) + pad * 2;
        const int th = fm.height() + pad * 2;
        const QRect info_rect(6, 6, tw, th);

        p.setBrush(QColor(0, 0, 0, 160));
        p.setPen(Qt::NoPen);
        p.drawRoundedRect(info_rect, 4, 4);
        p.setPen(Qt::white);
        p.drawText(info_rect, Qt::AlignCenter, info);
    }

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

    if (!overlay_layers_.isEmpty())
    {
        p.setRenderHint(QPainter::Antialiasing, true);
        for (const OverlayLayer& layer : overlay_layers_)
        {
            QPen pen(layer.color, 2, Qt::SolidLine);
            pen.setCosmetic(true);
            p.setPen(pen);
            p.setBrush(Qt::NoBrush);
            for (const OverlayRing& ring : layer.rings)
            {
                if (ring.points.size() < 2)
                    continue;
                QPolygonF poly;
                poly.reserve(ring.points.size());
                for (const QPointF& ll : ring.points)
                {
                    const QPointF w = latLonToWorld(ll.y(), ll.x());
                    poly << worldToWidget(w.x(), w.y());
                }
                if (ring.closed)
                    p.drawPolygon(poly);
                else
                    p.drawPolyline(poly);
            }
        }
    }

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
}

void MapPanel::mousePressEvent(QMouseEvent* event)
{
    if (event->button() == Qt::LeftButton &&
        !(event->modifiers() & Qt::ShiftModifier) &&
        !chunk_grid_.isEmpty())
    {
        const QPointF pos = event->pos();
        for (int i = 0; i < chunk_grid_.size(); ++i)
        {
            const GeoBounds& cb = chunk_grid_[i];
            const QPointF worldNW = latLonToWorld(cb.north, cb.west);
            const QPointF worldSE = latLonToWorld(cb.south, cb.east);
            const QPointF wNW = worldToWidget(worldNW.x(), worldNW.y());
            const QPointF wSE = worldToWidget(worldSE.x(), worldSE.y());
            const QRectF cr = QRectF(wNW, wSE).normalized();

            if (cr.contains(pos))
            {
                chunk_enabled_[i] = !chunk_enabled_[i];
                update();
                event->accept();
                return;
            }
        }
    }

    if (event->button() == Qt::RightButton ||
        (event->button() == Qt::LeftButton && !(event->modifiers() & Qt::ShiftModifier)))
    {
        panning_ = true;
        pan_start_widget_ = event->pos();
        pan_start_origin_x_ = view_origin_x_;
        pan_start_origin_y_ = view_origin_y_;
        setCursor(Qt::ClosedHandCursor);
    }
    else if (event->button() == Qt::LeftButton && (event->modifiers() & Qt::ShiftModifier))
    {
        selecting_ = true;
        has_selection_ = false;
        sel_start_world_ = widgetToWorld(event->pos());
        sel_end_world_ = sel_start_world_;
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
        selecting_ = false;
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
    const int steps = degrees / 15;

    const QPointF cursor_widget = event->pos();
    QPointF cursor_world = widgetToWorld(cursor_widget);
    double lat_at_cursor = 0.0;
    double lon_at_cursor = 0.0;
    worldToLatLon(cursor_world.x(), cursor_world.y(), lat_at_cursor, lon_at_cursor);

    const int new_zoom = std::max(0, std::min(19, zoom_ + steps));
    if (new_zoom == zoom_)
    {
        event->accept();
        return;
    }

    zoom_ = new_zoom;
    tile_cache_.clear();
    clearPendingRequests();

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
