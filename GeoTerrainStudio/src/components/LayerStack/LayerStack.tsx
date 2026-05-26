import React from 'react';
import { Layers, Map, Mountain, Droplets, TreePine, Building, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { useTerrainStore } from '../../core/store';

export const LayerStack: React.FC = () => {
  const generationPlan = useTerrainStore((s) => s.generationPlan);
  const activeProfile = useTerrainStore((s) => s.activeProfile);
  const setActiveProfile = useTerrainStore((s) => s.setActiveProfile);

  if (!generationPlan) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 p-8">
        <Layers className="w-12 h-12 mb-4 opacity-30" />
        <p className="text-sm">No generation plan yet.</p>
        <p className="text-xs mt-1">Select an area on the map first.</p>
      </div>
    );
  }

  const toggleMask = (key: keyof typeof activeProfile.processing) => {
    setActiveProfile({
      ...activeProfile,
      processing: {
        ...activeProfile.processing,
        [key]: !activeProfile.processing[key],
      },
    });
  };

  const layers = [
    { id: 'dem', label: 'DEM (Heightmap)', icon: Mountain, active: true, color: 'text-amber-400', locked: true },
    { id: 'imagery', label: 'Satellite Imagery', icon: Map, active: true, color: 'text-green-400', locked: true },
    { id: 'generateRoadMasks', label: 'Road Masks', icon: Eye, active: activeProfile.processing.generateRoadMasks, color: 'text-blue-400', locked: false },
    { id: 'generateWaterMasks', label: 'Water Masks', icon: Droplets, active: activeProfile.processing.generateWaterMasks, color: 'text-cyan-400', locked: false },
    { id: 'generateVegetationMasks', label: 'Vegetation Masks', icon: TreePine, active: activeProfile.processing.generateVegetationMasks, color: 'text-emerald-400', locked: false },
    { id: 'generateBuildingMasks', label: 'Building Masks', icon: Building, active: activeProfile.processing.generateBuildingMasks, color: 'text-orange-400', locked: false },
    { id: 'generateCliffMasks', label: 'Cliff Masks', icon: AlertTriangle, active: activeProfile.processing.generateCliffMasks, color: 'text-red-400', locked: false },
  ];

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
          const Icon = layer.active ? Eye : EyeOff;
          return (
            <div
              key={layer.id}
              className={`flex items-center gap-3 px-4 py-3 border-b border-gray-800 transition-colors ${
                layer.locked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-800/50 cursor-pointer'
              }`}
              onClick={() => {
                if (!layer.locked) {
                  toggleMask(layer.id as keyof typeof activeProfile.processing);
                }
              }}
            >
              <layer.icon className={`w-4 h-4 ${layer.color}`} />
              <span className="text-sm flex-1">{layer.label}</span>
              <Icon className={`w-4 h-4 ${layer.active ? 'text-gray-300' : 'text-gray-600'}`} />
            </div>
          );
        })}
      </div>

    </div>
  );
};
