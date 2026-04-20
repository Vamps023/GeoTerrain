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

    // Single-tile mode
    QString heightmapPath() const;
    QString albedoPath() const;
    QString outputLmapPath() const;

    void setHeightmapPath(const QString& path);
    void setAlbedoPath(const QString& path);
    void setOutputLmapPath(const QString& path);

    // Multi-tile (folder) mode
    QString heightmapFolderPath() const;
    QString albedoFolderPath() const;
    QString outputLmapFolderPath() const;
    bool isMultiTileMode() const;

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
    void onBrowseHeightmapFolder();
    void onBrowseAlbedoFolder();
    void onBrowseOutputFolder();
    void onModeToggled(bool multi_tile);

private:
    // Single-tile widgets
    QWidget*   single_tile_widget_ = nullptr;
    QLineEdit* edit_heightmap_ = nullptr;
    QLineEdit* edit_albedo_ = nullptr;
    QLineEdit* edit_output_ = nullptr;
    // Multi-tile widgets
    QWidget*   multi_tile_widget_ = nullptr;
    QLineEdit* edit_heightmap_folder_ = nullptr;
    QLineEdit* edit_albedo_folder_ = nullptr;
    QLineEdit* edit_output_folder_ = nullptr;

    QLabel*      label_auto_params_ = nullptr;
    QPushButton* btn_build_ = nullptr;
};
