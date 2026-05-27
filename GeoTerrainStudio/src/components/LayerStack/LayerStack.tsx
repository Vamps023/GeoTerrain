import React from 'react';
import { Layers, Map, Mountain, Droplets, TreePine, Building, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { useTerrainStore } from '../../core/store';

export const LayerStack: React.FC = () => {
  const generationPlan = useTerrainStore((s) => s.generationPlan);
  const maskSettings = useTerrainStore((s) => s.maskSettings);
  const setMaskSettings = useTerrainStore((s) => s.setMaskSettings);

  if (!generationPlan) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 p-8">
        <Layers className="w-12 h-12 mb-4 opacity-30" />
        <p className="text-sm">No generation plan yet.</p>
        <p className="text-xs mt-1">Select an area on the map first.</p>
      </div>
    );
  }

  const layers = [
    { id: 'dem', label: 'DEM (Heightmap)', icon: Mountain, active: true, color: 'text-amber-400', locked: true },
    { id: 'imagery', label: 'Satellite Imagery', icon: Map, active: true, color: 'text-green-400', locked: true },
    { id: 'generateRoadMask', label: 'Road Mask', icon: Eye, active: maskSettings.generateRoadMask, color: 'text-blue-400', locked: false },
    { id: 'generateWaterMask', label: 'Water Mask', icon: Droplets, active: maskSettings.generateWaterMask, color: 'text-cyan-400', locked: false },
    { id: 'generateVegetationMask', label: 'Vegetation Mask', icon: TreePine, active: maskSettings.generateVegetationMask, color: 'text-emerald-400', locked: false },
    { id: 'generateBuildingMask', label: 'Building Mask', icon: Building, active: maskSettings.generateBuildingMask, color: 'text-orange-400', locked: false },
    { id: 'generateCliffMask', label: 'Cliff Mask', icon: AlertTriangle, active: maskSettings.generateCliffMask, color: 'text-red-400', locked: false },
  ];

  const toggleLayer = (id: string) => {
    switch (id) {
      case 'generateRoadMask':
        setMaskSettings({ generateRoadMask: !maskSettings.generateRoadMask });
        break;
      case 'generateWaterMask':
        setMaskSettings({ generateWaterMask: !maskSettings.generateWaterMask });
        break;
      case 'generateVegetationMask':
        setMaskSettings({ generateVegetationMask: !maskSettings.generateVegetationMask });
        break;
      case 'generateBuildingMask':
        setMaskSettings({ generateBuildingMask: !maskSettings.generateBuildingMask });
        break;
      case 'generateCliffMask':
        setMaskSettings({ generateCliffMask: !maskSettings.generateCliffMask });
        break;
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] text-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          Layer Stack
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          {generationPlan.tiles.length} tiles planned · ~{generationPlan.estimatedMemoryMb} MB · ~{Math.ceil(generationPlan.estimatedDurationSec / 60)} min
        </p>
      </div>

      {/* Layer List */}
      <div className="flex-1 overflow-y-auto">
        {layers.map((layer) => {
          const VisIcon = layer.active ? Eye : EyeOff;
          return (
            <div key={layer.id}>
              <div
                className={`flex items-center gap-3 px-4 py-3 border-b border-gray-800 transition-colors ${
                  layer.locked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-800/50 cursor-pointer'
                }`}
                onClick={() => {
                  if (!layer.locked) toggleLayer(layer.id);
                }}
              >
                <layer.icon className={`w-4 h-4 ${layer.color}`} />
                <span className="text-sm flex-1">{layer.label}</span>
                <VisIcon className={`w-4 h-4 ${layer.active ? 'text-gray-300' : 'text-gray-600'}`} />
              </div>

              {/* Road Width Slider */}
              {layer.id === 'generateRoadMask' && maskSettings.generateRoadMask && (
                <div className="px-6 py-2 border-b border-gray-800 bg-gray-800/30">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-gray-400">Road Width</span>
                    <span className="text-[10px] text-gray-400">{maskSettings.roadLineWidthPx}px</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={maskSettings.roadLineWidthPx}
                    onChange={(e) => setMaskSettings({ roadLineWidthPx: Number(e.target.value) })}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                  />
                </div>
              )}

              {/* Cliff Threshold Slider */}
              {layer.id === 'generateCliffMask' && maskSettings.generateCliffMask && (
                <div className="px-6 py-2 border-b border-gray-800 bg-gray-800/30">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-gray-400">Cliff Threshold</span>
                    <span className="text-[10px] text-gray-400">{maskSettings.cliffThresholdDegrees}°</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={90}
                    step={1}
                    value={maskSettings.cliffThresholdDegrees}
                    onChange={(e) => setMaskSettings({ cliffThresholdDegrees: Number(e.target.value) })}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
