import { Map, Layers, Clock, Download, Box } from 'lucide-react';
import { useTerrainStore } from './core/store';
import { MapViewport } from './components/MapViewport/MapViewport';
import { LayerStack } from './components/LayerStack/LayerStack';
import { JobQueue } from './components/JobQueue/JobQueue';
import { ExportPanel } from './components/ExportPanel/ExportPanel';
import { TerrainViewer3D } from './components/Viewer3D/TerrainViewer3D';

const TABS = [
  { id: 'map' as const, label: 'Map', icon: Map },
  { id: 'layers' as const, label: 'Layers', icon: Layers },
  { id: 'jobs' as const, label: 'Jobs', icon: Clock },
  { id: 'export' as const, label: 'Export', icon: Download },
  { id: 'view3d' as const, label: '3D View', icon: Box },
];

function App(): React.JSX.Element {
  const activeTab = useTerrainStore((s) => s.activeTab);
  const setActiveTab = useTerrainStore((s) => s.setActiveTab);
  const exportedManifest = useTerrainStore((s) => s.exportedManifest);
  const exportedPackagePath = useTerrainStore((s) => s.exportedPackagePath);

  return (
    <div className="flex flex-col h-screen bg-[#121212] text-white overflow-hidden">
      {/* Title Bar */}
      <header className="h-12 bg-[#1a1a1a] border-b border-gray-800 flex items-center px-4 justify-between select-none">
        <div className="flex items-center gap-3">
          <img src="./logo/logo.png" alt="GeoTerrain" className="w-8 h-8 rounded object-contain" />
          <h1 className="text-sm font-semibold tracking-wide">GeoTerrain Studio</h1>
          <span className="text-[10px] px-1.5 py-0.5 bg-cyan-500/20 text-cyan-400 rounded">v2.0.0-beta</span>
        </div>
        <div className="text-xs text-gray-500">
          Standalone Terrain Extractor
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar — Tabs */}
        <nav className="w-16 bg-[#1a1a1a] border-r border-gray-800 flex flex-col items-center py-4 gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  isActive
                    ? 'bg-cyan-500/10 text-cyan-400'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                }`}
                title={tab.label}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[9px]">{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Center Panel */}
        <main className="flex-1 flex overflow-hidden">
          {/* Map Viewport */}
          <div className={`flex-1 relative ${activeTab === 'map' ? 'block' : 'hidden'}`}>
            <MapViewport />
          </div>

          {/* 3D Viewport */}
          <div className={`flex-1 relative ${activeTab === 'view3d' ? 'block' : 'hidden'}`}>
            <TerrainViewer3D manifest={exportedManifest} packagePath={exportedPackagePath} />
          </div>

          {/* Side Panels (Layers/Jobs/Export) */}
          {activeTab !== 'map' && activeTab !== 'view3d' && (
            <div className="w-80 border-r border-gray-800">
              {activeTab === 'layers' && <LayerStack />}
              {activeTab === 'jobs' && <JobQueue />}
              {activeTab === 'export' && <ExportPanel />}
            </div>
          )}

          {/* Right panel removed — layer controls now on map overlay */}
        </main>
      </div>

      {/* Status Bar */}
      <footer className="h-6 bg-[#1a1a1a] border-t border-gray-800 flex items-center px-3 text-[10px] text-gray-500 justify-between">
        <div className="flex items-center gap-3">
          <span>Ready</span>
          <span className="text-gray-700">|</span>
          <span>MapLibre + Babylon.js</span>
        </div>
        <div className="flex items-center gap-3">
          <span>Native Core: v2.0.0</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
