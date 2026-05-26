import React, { useState, useEffect } from 'react';
import { Download, FolderOpen, FileArchive, Check, Key, Eye, EyeOff } from 'lucide-react';
import { useTerrainStore } from '../../core/store';
import { Native, Dialog, Settings } from '../../core/ipc';
import type { ExportPreset, HeightmapFormat, AlbedoFormat, DEMSource, ImagerySource, TerrainManifest, ApiKeys } from '../../types/terrain';
import { FsAPI } from '../../core/ipc';

interface PresetConfig {
  id: ExportPreset;
  name: string;
  desc: string;
  icon: string;
  heightmapFormat: HeightmapFormat;
  albedoFormat: AlbedoFormat;
  recommendedRes: { heightmap: number; albedo: number };
  notes?: string;
}

const PRESETS: PresetConfig[] = [
  {
    id: 'unigine',
    name: 'UNIGINE',
    desc: 'LandscapeLayerMap (.lmap) + materials',
    icon: 'U',
    heightmapFormat: 'float32', // Float32 GeoTIFF for full precision
    albedoFormat: 'geotiff',      // GeoTIFF RGB
    recommendedRes: { heightmap: 4096, albedo: 4096 },
    notes: 'GeoTIFF with full metadata',
  },
  {
    id: 'unreal',
    name: 'Unreal Engine',
    desc: '16-bit RAW + PNG albedo + splat',
    icon: 'UE',
    heightmapFormat: 'r16',      // R16 raw binary
    albedoFormat: 'png',         // PNG RGB
    recommendedRes: { heightmap: 2017, albedo: 2048 }, // UE5 recommended
    notes: 'R16 for heightmap, PNG for albedo',
  },
  {
    id: 'unity',
    name: 'Unity',
    desc: 'RAW heightmap + splat textures',
    icon: 'U3D',
    heightmapFormat: 'r16',      // Unity Terrain uses R16 RAW
    albedoFormat: 'png',         // PNG for control/albedo
    recommendedRes: { heightmap: 2049, albedo: 2048 }, // Unity likes odd+1 sizes
    notes: 'R16 RAW (2049x2049), PNG albedo',
  },
  {
    id: 'godot',
    name: 'Godot',
    desc: 'EXR heightmap + JPG albedo',
    icon: 'G',
    heightmapFormat: 'float32',  // EXR via GeoTIFF Float32
    albedoFormat: 'png',         // Godot prefers PNG/JPG
    recommendedRes: { heightmap: 2048, albedo: 2048 },
    notes: 'Float32 for precision',
  },
  {
    id: 'generic',
    name: 'Generic / Custom',
    desc: 'GeoTIFF bundle for any engine',
    icon: '*',
    heightmapFormat: 'geotiff',  // Int16 GeoTIFF
    albedoFormat: 'geotiff',     // RGB GeoTIFF
    recommendedRes: { heightmap: 4096, albedo: 4096 },
    notes: 'Standard GeoTIFF (GDAL compatible)',
  },
  {
    id: 'babylon',
    name: 'Babylon.js',
    desc: 'Import all data for 3D viewport viewing',
    icon: 'BJS',
    heightmapFormat: 'geotiff',  // Readable by geotiff.js
    albedoFormat: 'png',         // PNG for web compatibility
    recommendedRes: { heightmap: 1024, albedo: 1024 },
    notes: 'Web-ready formats, optimized for browser',
  },
];

// Helper to get preset config
const getPresetConfig = (id: ExportPreset): PresetConfig =>
  PRESETS.find((p) => p.id === id) ?? PRESETS[4]; // default to generic

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
  const selectedTiles = useTerrainStore((s) => s.selectedTiles);

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportResult, setExportResult] = useState<string | null>(null);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKeys>({});
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [apiKeysExpanded, setApiKeysExpanded] = useState(false);
  const [apiKeysSaved, setApiKeysSaved] = useState(false);

  // Load API keys on mount
  useEffect(() => {
    Settings.getApiKeys().then(setApiKeys).catch(console.error);
  }, []);

  const handleSaveApiKeys = async () => {
    const success = await Settings.setApiKeys(apiKeys);
    if (success) {
      setApiKeysSaved(true);
      setTimeout(() => setApiKeysSaved(false), 2000);
    }
  };

  const handleSelectFolder = async () => {
    const path = await Dialog.selectFolder();
    if (path) setOutputPath(path);
  };

  // Auto-set formats when preset changes
  const handleSelectPreset = (presetId: ExportPreset) => {
    const config = getPresetConfig(presetId);
    setSelectedPreset(presetId);
    setHeightmapFormat(config.heightmapFormat);
    setAlbedoFormat(config.albedoFormat);
    setHeightmapResolution(config.recommendedRes.heightmap);
    setAlbedoResolution(config.recommendedRes.albedo);
  };

  const handleExport = async () => {
    if (!outputPath) {
      alert('Please select an output folder first.');
      return;
    }
    if (!selectedBounds) {
      alert('Please select an area on the map first.');
      return;
    }
    if (selectedTiles.size === 0) {
      alert('Please select at least one tile to export.');
      return;
    }

    try {
      setIsExporting(true);
      setExportResult(null);

      // Multi-tile export (works for all presets including Babylon.js)
      const grid = useTerrainStore.getState().tileGrid;
      const tilesToExport = grid?.tiles.filter((t: { row: number; col: number }) =>
        selectedTiles.has(`${t.row},${t.col}`)
      ) ?? [];

      if (tilesToExport.length === 0) {
        alert('No tiles selected for export.');
        return;
      }

      const total = tilesToExport.length;
      setExportProgress({ current: 0, total });

      // Export each tile
      for (let i = 0; i < tilesToExport.length; i++) {
        const tile = tilesToExport[i];
        const sessionId = `session-${Date.now()}-${i}`;
        // Use platform-agnostic path construction
        const tileOutputPath = `${outputPath}${window.navigator.platform.startsWith('Win') ? '\\' : '/'}tile_${tile.row}_${tile.col}`;

        setExportProgress({ current: i + 1, total });

        await Native.exportPackage(
          sessionId,
          tileOutputPath,
          selectedPreset,
          tile.bounds,
          heightmapFormat,
          albedoFormat,
          heightmapResolution,
          albedoResolution,
          imageryZoom,
          demSource,
          imagerySource,
          apiKeys,
        );
      }

      // For Babylon.js preset, switch to 3D view after export
      if (selectedPreset === 'babylon') {
        // Read the first tile's manifest for the 3D viewer
        const firstTile = tilesToExport[0];
        if (firstTile) {
          const firstTilePath = `${outputPath}${window.navigator.platform.startsWith('Win') ? '\\' : '/'}tile_${firstTile.row}_${firstTile.col}`;
          try {
            const manifest = await FsAPI.readManifest(firstTilePath);
            setExportedData(manifest as TerrainManifest, firstTilePath);
          } catch (e) {
            console.warn('Could not read manifest for 3D view:', e);
          }
        }
        setExportResult(`Terrain exported for 3D viewing. ${total} tile(s) saved to: ${outputPath}`);
        setActiveTab('view3d');
      } else {
        setExportResult(`Export complete. ${total} tile(s) saved to: ${outputPath}`);
      }
    } catch (err) {
      console.error('Export failed:', err);
      setExportResult(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      alert('Export failed. See console for details.');
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  };

  const selectedCount = selectedTiles.size;

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
                onClick={() => handleSelectPreset(p.id)}
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
          {/* Show current preset recommendation */}
          {selectedPreset && (
            <div className="mt-3 p-2 bg-cyan-500/10 border border-cyan-500/30 rounded text-xs text-cyan-400">
              <span className="font-semibold">{getPresetConfig(selectedPreset).name}:</span>{' '}
              {getPresetConfig(selectedPreset).notes}
            </div>
          )}
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

        {/* Selected Tiles Summary */}
        {selectedBounds && selectedCount > 0 && (
          <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-lg p-3">
            <div className="flex justify-between text-xs">
              <span className="text-cyan-400">Tiles to export:</span>
              <span className="text-white font-medium">{selectedCount}</span>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">
              Use the map overlay to select tiles and change tile size.
            </p>
          </div>
        )}

        {/* Resolution & Quality */}
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
                <option value={10}>10 — Low</option>
                <option value={12}>12 — Medium</option>
                <option value={14}>14 — Good</option>
                <option value={16}>16 — High</option>
                <option value={18}>18 — Very High</option>
                <option value={19}>19 — Maximum</option>
              </select>
            </div>
          </div>
        </div>

        {/* API Keys */}
        <div>
          <button
            onClick={() => setApiKeysExpanded(!apiKeysExpanded)}
            className="w-full flex items-center justify-between text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 hover:text-white"
          >
            <span className="flex items-center gap-2">
              <Key className="w-3 h-3" />
              API Keys
              {(apiKeys.opentopography || apiKeys.mapbox || apiKeys.maptiler) && (
                <span className="text-cyan-400 normal-case">(configured)</span>
              )}
            </span>
            <span>{apiKeysExpanded ? '−' : '+'}</span>
          </button>
          {apiKeysExpanded && (
            <div className="space-y-3 bg-gray-800/50 p-3 rounded border border-gray-700">
              <div className="space-y-1">
                <label className="text-xs text-gray-400 flex items-center justify-between">
                  OpenTopography
                  <a href="https://portal.opentopography.org/myopentopo" target="_blank" rel="noopener" className="text-cyan-400 hover:underline text-[10px] normal-case">Get free key</a>
                </label>
                <div className="relative">
                  <input
                    type={showApiKeys ? 'text' : 'password'}
                    value={apiKeys.opentopography || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, opentopography: e.target.value })}
                    placeholder="Paste OpenTopography API key"
                    className="w-full bg-gray-700 border border-gray-600 rounded text-xs py-1.5 px-2 pr-8 text-white"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400 flex items-center justify-between">
                  Mapbox Access Token
                  <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noopener" className="text-cyan-400 hover:underline text-[10px] normal-case">Get free token</a>
                </label>
                <input
                  type={showApiKeys ? 'text' : 'password'}
                  value={apiKeys.mapbox || ''}
                  onChange={(e) => setApiKeys({ ...apiKeys, mapbox: e.target.value })}
                  placeholder="pk.eyJ..."
                  className="w-full bg-gray-700 border border-gray-600 rounded text-xs py-1.5 px-2 text-white"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400 flex items-center justify-between">
                  MapTiler API Key
                  <a href="https://cloud.maptiler.com/account/keys/" target="_blank" rel="noopener" className="text-cyan-400 hover:underline text-[10px] normal-case">Get free key</a>
                </label>
                <input
                  type={showApiKeys ? 'text' : 'password'}
                  value={apiKeys.maptiler || ''}
                  onChange={(e) => setApiKeys({ ...apiKeys, maptiler: e.target.value })}
                  placeholder="Paste MapTiler API key"
                  className="w-full bg-gray-700 border border-gray-600 rounded text-xs py-1.5 px-2 text-white"
                />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => setShowApiKeys(!showApiKeys)}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-white"
                >
                  {showApiKeys ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  {showApiKeys ? 'Hide' : 'Show'}
                </button>
                <button
                  onClick={handleSaveApiKeys}
                  className="ml-auto flex items-center gap-1 px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white text-xs rounded"
                >
                  {apiKeysSaved ? <><Check className="w-3 h-3" /> Saved</> : 'Save Keys'}
                </button>
              </div>
              <p className="text-[10px] text-gray-500 leading-relaxed">
                Keys are stored locally on your device. They are never uploaded.
              </p>
            </div>
          )}
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
                onChange={(e) => setDEMSource(e.target.value as DEMSource)}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <optgroup label="Tiled (no API key)">
                  <option value="aws-terrarium">AWS Terrarium (~30m, free)</option>
                  <option value="mapzen">Mapzen Terrarium (~30m, free)</option>
                  <option value="mapbox-terrain-rgb">Mapbox Terrain-RGB (HD 0.1m, Mapbox token)</option>
                </optgroup>
                <optgroup label="OpenTopography (free API key)">
                  <option value="opentopo-cop30">Copernicus GLO-30 (~30m, best quality)</option>
                  <option value="opentopo-nasadem">NASADEM (~30m, reprocessed)</option>
                  <option value="opentopo-srtmgl1">SRTM GL1 (~30m, global)</option>
                  <option value="opentopo-srtmgl3">SRTM GL3 (~90m, global)</option>
                  <option value="opentopo-aw3d30">ALOS AW3D30 (~30m, global)</option>
                  <option value="opentopo-usgs10m">USGS 3DEP (~10m, USA only)</option>
                </optgroup>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Imagery Source</label>
              <select
                value={imagerySource}
                onChange={(e) => setImagerySource(e.target.value as ImagerySource)}
                className="w-full bg-gray-700 border border-gray-600 rounded text-sm py-1.5 px-2 text-white"
              >
                <option value="arcgis">ArcGIS World Imagery (free)</option>
                <option value="mapbox">Mapbox Satellite (token req)</option>
                <option value="maptiler">MapTiler Satellite (token req)</option>
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
                <option value="float32">Float32 GeoTIFF (full precision)</option>
                <option value="dem">DEM (Int16 GeoTIFF)</option>
                <option value="geotiff">UInt16 GeoTIFF (normalized)</option>
                <option value="r16">R16 (Raw 16-bit)</option>
                <option value="png">PNG (16-bit grayscale)</option>
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

        {/* Export Button */}
        <button
          onClick={handleExport}
          disabled={!outputPath || isExporting || selectedCount === 0}
          className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-colors ${
            !outputPath || selectedCount === 0
              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
              : 'bg-cyan-600 hover:bg-cyan-500 text-white'
          }`}
        >
          <FileArchive className="w-4 h-4" />
          {isExporting
            ? exportProgress
              ? `Exporting ${exportProgress.current}/${exportProgress.total} tiles...`
              : 'Exporting...'
            : `Export ${selectedCount} Tile${selectedCount !== 1 ? 's' : ''}`}
        </button>

        {exportResult && (
          <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3">
            <p className="text-xs text-green-400">
              ✅ {exportResult}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
