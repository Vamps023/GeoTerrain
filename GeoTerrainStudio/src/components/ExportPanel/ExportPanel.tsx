import React, { useState } from 'react';
import { Download, FolderOpen, FileArchive, Settings, Check } from 'lucide-react';
import { useTerrainStore } from '../../core/store';
import { Native, Dialog } from '../../core/ipc';
import type { ExportPreset } from '../../types/terrain';

const PRESETS: Array<{ id: ExportPreset; name: string; desc: string; icon: string }> = [
  { id: 'unigine', name: 'UNIGINE', desc: 'LandscapeLayerMap (.lmap) + materials', icon: 'U' },
  { id: 'unreal', name: 'Unreal Engine', desc: '16-bit RAW + PNG albedo + splat', icon: 'UE' },
  { id: 'unity', name: 'Unity', desc: 'RAW heightmap + splat textures', icon: 'U3D' },
  { id: 'godot', name: 'Godot', desc: 'EXR heightmap + JPG albedo', icon: 'G' },
  { id: 'generic', name: 'Generic / Custom', desc: 'GeoTIFF bundle for any engine', icon: '*' },
];

export const ExportPanel: React.FC = () => {
  const selectedPreset = useTerrainStore((s) => s.selectedPreset);
  const setSelectedPreset = useTerrainStore((s) => s.setSelectedPreset);
  const outputPath = useTerrainStore((s) => s.outputPath);
  const setOutputPath = useTerrainStore((s) => s.setOutputPath);
  const jobProgress = useTerrainStore((s) => s.jobProgress);
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
      const result = await Native.exportPackage(sessionId, outputPath, selectedPreset);
      setExportResult(result);
    } catch (err) {
      console.error('Export failed:', err);
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
            <div className="flex-1 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 truncate">
              {outputPath ?? 'No folder selected'}
            </div>
            <button
              onClick={handleSelectFolder}
              className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs py-2 px-3 rounded-lg transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Browse
            </button>
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
          disabled={!outputPath || isExporting || jobProgress?.state !== 'complete'}
          className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-colors ${
            !outputPath || jobProgress?.state !== 'complete'
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
              ✅ Package exported to: <span className="font-mono">{exportResult}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
