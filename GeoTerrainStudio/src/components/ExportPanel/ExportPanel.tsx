import React, { useState } from 'react';
import { Download, FolderOpen, FileArchive, Settings, Check } from 'lucide-react';
import { useTerrainStore } from '../../core/store';
import { Native, Dialog } from '../../core/ipc';
import type { ExportPreset, HeightmapFormat, AlbedoFormat } from '../../types/terrain';

const PRESETS: Array<{ id: ExportPreset; name: string; desc: string; icon: string }> = [
  { id: 'unigine', name: 'UNIGINE', desc: 'LandscapeLayerMap (.lmap) + materials', icon: 'U' },
  { id: 'unreal', name: 'Unreal Engine', desc: '16-bit RAW + PNG albedo + splat', icon: 'UE' },
  { id: 'unity', name: 'Unity', desc: 'RAW heightmap + splat textures', icon: 'U3D' },
  { id: 'godot', name: 'Godot', desc: 'EXR heightmap + JPG albedo', icon: 'G' },
  { id: 'generic', name: 'Generic / Custom', desc: 'GeoTIFF bundle for any engine', icon: '*' },
  { id: 'babylon', name: 'Babylon.js', desc: 'Import all data for 3D viewport viewing', icon: 'BJS' },
];

export const ExportPanel: React.FC = () => {
  const selectedPreset = useTerrainStore((s) => s.selectedPreset);
  const setSelectedPreset = useTerrainStore((s) => s.setSelectedPreset);
  const heightmapFormat = useTerrainStore((s) => s.heightmapFormat);
  const setHeightmapFormat = useTerrainStore((s) => s.setHeightmapFormat);
  const albedoFormat = useTerrainStore((s) => s.albedoFormat);
  const setAlbedoFormat = useTerrainStore((s) => s.setAlbedoFormat);
  const outputPath = useTerrainStore((s) => s.outputPath);
  const setOutputPath = useTerrainStore((s) => s.setOutputPath);
  const selectedBounds = useTerrainStore((s) => s.selectedBounds);
  const setExportedData = useTerrainStore((s) => s.setExportedData);
  const setActiveTab = useTerrainStore((s) => s.setActiveTab);
  // Quality settings
  const heightmapResolution = useTerrainStore((s) => s.heightmapResolution);
  const setHeightmapResolution = useTerrainStore((s) => s.setHeightmapResolution);
  const albedoResolution = useTerrainStore((s) => s.albedoResolution);
  const setAlbedoResolution = useTerrainStore((s) => s.setAlbedoResolution);
  const imageryZoom = useTerrainStore((s) => s.imageryZoom);
  const setImageryZoom = useTerrainStore((s) => s.setImageryZoom);
  const demSource = useTerrainStore((s) => s.demSource);
  const setDEMSource = useTerrainStore((s) => s.setDEMSource);
  const imagerySource = useTerrainStore((s) => s.imagerySource);
  const setImagerySource = useTerrainStore((s) => s.setImagerySource);
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  const handleSelectFolder = async () => {
    const path = await Dialog.selectFolder();
    if (path) setOutputPath(path);
  };

  const handleExport = async () => {
    if (!outputPath) {
      alert('Please select an output folder first.');
      return;
    }
    try {
      setIsExporting(true);
      const sessionId = `session-${Date.now()}`;

      // Special handling for Babylon.js export
      if (selectedPreset === 'babylon') {
        // Create a mock manifest for Babylon.js 3D viewing
        const mockManifest = {
          version: '1.0.0',
          createdBy: 'GeoTerrain Studio',
          createdAt: new Date().toISOString(),
          terrainName: 'Babylon.js Terrain',
          description: 'Terrain for 3D viewport viewing',
          bounds: selectedBounds || { west: 0, south: 0, east: 0.1, north: 0.1 },
          crs: 'EPSG:4326',
          tileGrid: {
            rows: 1,
            cols: 1,
            chunkSizeM: 1000,
            heightmapResolution: 1024,
            albedoResolution: 1024,
          },
          tiles: [
            {
              row: 0,
              col: 0,
              bounds: selectedBounds || { west: 0, south: 0, east: 0.1, north: 0.1 },
              worldOffset: { x: 0, y: 0, z: 0 },
              files: {
                heightmap: 'heightmap.tif',
                albedo: 'albedo.png',
              },
              elevation: { min: 0, max: 100, units: 'meters' as const },
            },
          ],
          sources: {
            dem: { id: 'aws-terrain', name: 'AWS Terrain Tiles', attribution: 'AWS' },
            imagery: { id: 'arcgis', name: 'ArcGIS World Imagery', attribution: 'Esri' },
          },
          exportPreset: 'babylon' as const,
          processing: {
            normalizeHeights: true,
            heightScale: 1.0,
            seamStitching: true,
            fillNodata: true,
            generateRoadMasks: false,
            generateWaterMasks: false,
            generateVegetationMasks: false,
            generateBuildingMasks: false,
            generateCliffMasks: false,
            cliffThresholdDegrees: 45.0,
          },
        };

        setExportedData(mockManifest, outputPath);
        setExportResult(`Terrain prepared for 3D viewing. Output path: ${outputPath}`);
        // Auto-switch to 3D view
        setActiveTab('view3d');
      } else {
        // For other presets, use the native export
        const bounds = selectedBounds || { west: 0, south: 0, east: 0.1, north: 0.1 };
        const result = await Native.exportPackage(
          sessionId,
          outputPath,
          selectedPreset,
          bounds,
          heightmapFormat,
          albedoFormat,
          heightmapResolution,
          albedoResolution,
          imageryZoom,
          demSource,
          imagerySource,
        );
        setExportResult(`Export complete. Files saved to: ${result}`);
      }
    } catch (err) {
      console.error('Export failed:', err);
      setExportResult(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      alert('Export failed. See console for details.');
    } finally {
      setIsExporting(false);
    }
  };

  const preset = PRESETS.find((p) => p.id === selectedPreset);

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] text-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Download className="w-4 h-4 text-cyan-400" />
          Export Terrain Package
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Engine Preset Selection */}
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Target Engine
          </h3>
          <div className="grid grid-cols-1 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPreset(p.id)}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                  selectedPreset === p.id
                    ? 'border-cyan-500 bg-cyan-500/10'
                    : 'border-gray-700 hover:border-gray-600 bg-gray-800/30'
                }`}
              >
                <div
                  className={`w-10 h-10 rounded flex items-center justify-center text-xs font-bold ${
                    selectedPreset === p.id ? 'bg-cyan-500 text-white' : 'bg-gray-700 text-gray-400'
                  }`}
                >
                  {selectedPreset === p.id ? <Check className="w-5 h-5" /> : p.icon}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-gray-500">{p.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Output Folder */}
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Output Location
          </h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={outputPath ?? ''}
              onChange={(e) => setOutputPath(e.target.value || null)}
              placeholder="Enter output path..."
              className="flex-1 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-cyan-500"
            />
            <button
              onClick={handleSelectFolder}
              className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs py-2 px-3 rounded-lg transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Browse
            </button>
          </div>
        </div>

        {/* Quality & Resolution */}
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Resolution & Quality
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Heightmap Resolution</label>
              <select
                value={heightmapResolution}
                onChange={(e) => setHeightmapResolution(Number(e.target.value))}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <option value={512}>512 × 512 (~150m/pixel)</option>
                <option value={1024}>1024 × 1024 (~75m/pixel)</option>
                <option value={2048}>2048 × 2048 (~37m/pixel)</option>
                <option value={4096}>4096 × 4096 (~18m/pixel)</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Albedo Resolution</label>
              <select
                value={albedoResolution}
                onChange={(e) => setAlbedoResolution(Number(e.target.value))}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <option value={1024}>1024 × 1024</option>
                <option value={2048}>2048 × 2048</option>
                <option value={4096}>4096 × 4096</option>
                <option value={8192}>8192 × 8192 (Ultra)</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Imagery Zoom Level</label>
              <select
                value={imageryZoom}
                onChange={(e) => setImageryZoom(Number(e.target.value))}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <option value={0}>Auto (recommended)</option>
                <option value={10}>10 — Low (global overview)</option>
                <option value={12}>12 — Medium</option>
                <option value={14}>14 — Good</option>
                <option value={16}>16 — High</option>
                <option value={18}>18 — Very High</option>
                <option value={19}>19 — Maximum</option>
              </select>
              <p className="text-[10px] text-gray-500">
                Higher zoom = sharper imagery but more tiles to download
              </p>
            </div>
          </div>
        </div>

        {/* Data Sources */}
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Data Sources
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-gray-400">DEM Source</label>
              <select
                value={demSource}
                onChange={(e) => setDEMSource(e.target.value as any)}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <option value="aws-terrarium">AWS Terrarium (~30m)</option>
                <option value="mapzen">Mapzen Terrarium (~30m)</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Imagery Source</label>
              <select
                value={imagerySource}
                onChange={(e) => setImagerySource(e.target.value as any)}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <option value="arcgis-world-imagery">ArcGIS World Imagery (free)</option>
                <option value="mapbox-satellite">Mapbox Satellite (token req)</option>
                <option value="maptiler-satellite">MapTiler Satellite (token req)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Format Selection */}
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Export Formats
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Heightmap Format</label>
              <select
                value={heightmapFormat}
                onChange={(e) => setHeightmapFormat(e.target.value as HeightmapFormat)}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <option value="dem">DEM (GeoTIFF float32)</option>
                <option value="geotiff">GeoTIFF (16-bit normalized)</option>
                <option value="r16">R16 (Raw 16-bit)</option>
                <option value="png">PNG (8-bit grayscale)</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Albedo Format</label>
              <select
                value={albedoFormat}
                onChange={(e) => setAlbedoFormat(e.target.value as AlbedoFormat)}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <option value="png">PNG (RGB)</option>
                <option value="geotiff">GeoTIFF (RGB)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Preset-specific Options */}
        {preset?.id === 'unigine' && (
          <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4 space-y-3">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Settings className="w-4 h-4 text-gray-400" />
              UNIGINE Options
            </h4>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                defaultChecked
                className="rounded border-gray-600 bg-gray-700 text-cyan-500"
              />
              Enable terrain streaming
            </label>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">LMAP Resolution</label>
              <select className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2">
                <option>1024x1024</option>
                <option>2048x2048</option>
                <option>4096x4096</option>
              </select>
            </div>
          </div>
        )}

        {preset?.id === 'unreal' && (
          <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4 space-y-3">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Settings className="w-4 h-4 text-gray-400" />
              Unreal Engine Options
            </h4>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Z Scale</label>
              <input
                type="number"
                defaultValue={100}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2"
              />
            </div>
          </div>
        )}

        {/* Export Button */}
        <button
          onClick={handleExport}
          disabled={!outputPath || isExporting}
          className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-colors ${
            !outputPath
              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
              : 'bg-cyan-600 hover:bg-cyan-500 text-white'
          }`}
        >
          <FileArchive className="w-4 h-4" />
          {isExporting ? 'Exporting...' : 'Export Terrain Package'}
        </button>

        {exportResult && (
          <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3">
            <p className="text-xs text-green-400">
              ✅ {exportResult}
            </p>
            <p className="text-[10px] text-gray-400 mt-1">
              Note: In web mode, files are not actually written to disk. Use the Electron app for actual file export.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
