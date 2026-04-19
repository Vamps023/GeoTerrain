#pragma once

#include <QDoubleSpinBox>
#include <QLineEdit>
#include <QPushButton>
#include <QSpinBox>
#include <QWidget>

// ---------------------------------------------------------------------------
// Terrain builder panel.
//
// Exposes the minimal production workflow for turning a pair of .tif files
// (heightmap + albedo) into a native UNIGINE LandscapeTerrain: three file
// pickers, world size + elevation range inputs, and a single Generate button.
// All heavy lifting (TIFF decode, .lmap creation, node spawning) happens
// behind the Generate button in GeoTerrainController.
class TerrainBuilderSection : public QWidget
{
    Q_OBJECT

public:
    explicit TerrainBuilderSection(QWidget* parent = nullptr);

    QString heightmapPath() const;
    QString albedoPath() const;
    QString outputLmapPath() const;
    double worldSizeMeters() const;
    double heightMinMeters() const;
    double heightMaxMeters() const;
    int tileResolution() const;

    void setHeightmapPath(const QString& path);
    void setAlbedoPath(const QString& path);
    void setOutputLmapPath(const QString& path);
    void setBuildEnabled(bool enabled);

signals:
    void buildTerrainRequested();

private slots:
    void onBrowseHeightmap();
    void onBrowseAlbedo();
    void onBrowseOutput();

private:
    QLineEdit* edit_heightmap_ = nullptr;
    QLineEdit* edit_albedo_ = nullptr;
    QLineEdit* edit_output_ = nullptr;
    QDoubleSpinBox* spin_world_size_ = nullptr;
    QDoubleSpinBox* spin_height_min_ = nullptr;
    QDoubleSpinBox* spin_height_max_ = nullptr;
    QSpinBox* spin_tile_resolution_ = nullptr;
    QPushButton* btn_build_ = nullptr;
};
