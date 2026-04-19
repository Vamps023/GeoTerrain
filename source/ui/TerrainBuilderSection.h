#pragma once

#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QWidget>

// ---------------------------------------------------------------------------
// Terrain builder panel.
//
// Exposes the minimal production workflow for turning a pair of .tif files
// (heightmap + albedo) into a native UNIGINE LandscapeTerrain: three file
// pickers and a single Generate button. World size, elevation range and tile
// resolution are auto-computed from the heightmap GeoTIFF (Sandworm-style).
class TerrainBuilderSection : public QWidget
{
    Q_OBJECT

public:
    explicit TerrainBuilderSection(QWidget* parent = nullptr);

    QString heightmapPath() const;
    QString albedoPath() const;
    QString outputLmapPath() const;

    void setHeightmapPath(const QString& path);
    void setAlbedoPath(const QString& path);
    void setOutputLmapPath(const QString& path);
    void setBuildEnabled(bool enabled);

    // Display auto-computed parameters after the heightmap is scanned.
    void setAutoParamsText(const QString& text);

signals:
    void buildTerrainRequested();
    void heightmapPathChanged(const QString& path);

private slots:
    void onBrowseHeightmap();
    void onBrowseAlbedo();
    void onBrowseOutput();

private:
    QLineEdit* edit_heightmap_ = nullptr;
    QLineEdit* edit_albedo_ = nullptr;
    QLineEdit* edit_output_ = nullptr;
    QLabel*    label_auto_params_ = nullptr;
    QPushButton* btn_build_ = nullptr;
};
