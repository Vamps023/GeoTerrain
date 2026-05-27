import React from 'react';
import { Map, Layers, Download, Box, X } from 'lucide-react';
import { useTerrainStore } from './core/store';
import { MapViewport } from './components/MapViewport/MapViewport';
import { LayerStack } from './components/LayerStack/LayerStack';
import { ExportPanel } from './components/ExportPanel/ExportPanel';
import { TerrainViewer3D } from './components/Viewer3D/TerrainViewer3D';
import { ToastContainer } from './components/Toast/Toast';

const APP_VERSION = __APP_VERSION__ || '2.0.0';

// Left nav: Map + 3D toggle only
const LEFT_TABS = [
  { id: 'map' as const, label: 'Map', icon: Map },
  { id: 'view3d' as const, label: '3D View', icon: Box },
];

// Right panel tabs
const RIGHT_TABS = [
  { id: 'layers' as const, label: 'Layers & Jobs', icon: Layers },
  { id: 'export' as const, label: 'Export', icon: Download },
];

function ExportProgressOverlay() {
  const exportProgress = useTerrainStore((s) => s.exportProgress);
  const exportResult = useTerrainStore((s) => s.exportResult);
  const exportStartTime = useTerrainStore((s) => s.exportStartTime);
  const setExportResult = useTerrainStore((s) => s.setExportResult);

  if (!exportProgress && !exportResult) return null;

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
      <div className="pointer-events-auto bg-[#0f1a10] border border-[#4a7c3f]/60 rounded-2xl shadow-2xl w-[480px] p-6 space-y-4">

        {/* Success state */}
        {!exportProgress && exportResult && (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#4a7c3f]/30 border border-[#4a7c3f]/60 flex items-center justify-center">
                  <span className="text-[#7ab86f] text-lg">✓</span>
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">Export Complete</div>
                  <div className="text-xs text-[#c4a96b]/80 mt-0.5 max-w-xs truncate">{exportResult}</div>
                </div>
              </div>
              <button
                onClick={() => setExportResult(null)}
                className="text-gray-500 hover:text-[#c4a96b] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        )}

        {/* In-progress state */}
        {exportProgress && (
          <>
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#4a7c3f]/30 border border-[#4a7c3f]/60 flex items-center justify-center">
                <Download className="w-5 h-5 text-[#7ab86f] animate-pulse" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-white">Exporting Terrain Package</div>
                <div className="text-xs text-[#c4a96b] mt-0.5">{exportProgress.message}</div>
              </div>
              <span className="text-2xl font-bold text-[#7ab86f] tabular-nums">{exportProgress.percent}%</span>
            </div>

            {/* Progress Bar */}
            <div className="h-3 bg-gray-900 rounded-full overflow-hidden border border-[#4a7c3f]/20">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${exportProgress.percent}%`, background: 'linear-gradient(90deg, #4a7c3f, #7ab86f)' }}
              />
            </div>

            {/* Tile counter + time estimate */}
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span className="font-medium">
                Tile <span className="text-[#c4a96b]">{exportProgress.current}</span> of <span className="text-[#c4a96b]">{exportProgress.total}</span>
              </span>
              {exportStartTime && exportProgress.percent > 0 && (
                <span className="text-[#c4a96b]/70">
                  {(() => {
                    const elapsed = Date.now() - exportStartTime;
                    const totalEst = (elapsed / exportProgress.percent) * 100;
                    const remaining = Math.max(0, totalEst - elapsed);
                    if (remaining > 60000) return `~${Math.ceil(remaining / 60000)}m remaining`;
                    if (remaining > 1000) return `~${Math.ceil(remaining / 1000)}s remaining`;
                    return 'Almost done...';
                  })()}
                </span>
              )}
            </div>

            {/* Pipeline stages */}
            <div className="bg-black/50 rounded-xl p-3 grid grid-cols-5 gap-2 border border-[#4a7c3f]/15">
              {[
                { stage: 'init', label: 'Init' },
                { stage: 'download_dem', label: 'DEM' },
                { stage: 'download_imagery', label: 'Imagery' },
                { stage: 'process_dem', label: 'Process' },
                { stage: 'write', label: 'Write' },
              ].map(({ stage, label }, idx) => {
                const stages = ['init','download_dem','download_imagery','process_dem','write'];
                const currentIdx = stages.indexOf(exportProgress.stage);
                const isDone = idx < currentIdx || exportProgress.stage === 'done';
                const isActive = exportProgress.stage === stage ||
                  (stage === 'process_dem' && (exportProgress.stage === 'process_dem' || exportProgress.stage === 'process_imagery'));
                return (
                  <div key={stage} className="flex flex-col items-center gap-1">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                      isDone ? 'bg-[#4a7c3f]/40 text-[#7ab86f] border border-[#4a7c3f]/60' :
                      isActive ? 'bg-[#4a7c3f]/20 text-[#7ab86f] border border-[#4a7c3f]/80 ring-2 ring-[#4a7c3f]/30' :
                      'bg-gray-900 text-gray-600 border border-gray-700'
                    }`}>
                      {isDone ? '✓' : idx + 1}
                    </div>
                    <span className={`text-[9px] text-center leading-tight ${
                      isDone ? 'text-[#7ab86f]' : isActive ? 'text-[#c4a96b]' : 'text-gray-600'
                    }`}>{label}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function App(): React.JSX.Element {
  const activeTab = useTerrainStore((s) => s.activeTab);
  const setActiveTab = useTerrainStore((s) => s.setActiveTab);
  const exportedManifest = useTerrainStore((s) => s.exportedManifest);
  const exportedPackagePath = useTerrainStore((s) => s.exportedPackagePath);

  // Right panel is open when a right-tab is active
  const rightTab = RIGHT_TABS.find((t) => t.id === activeTab);
  const isRightPanelOpen = !!rightTab;

  // Left tab: map or view3d
  const leftTabId = LEFT_TABS.find((t) => t.id === activeTab)?.id ?? 'map';

  const handleLeftTab = (id: typeof leftTabId) => {
    setActiveTab(id);
  };

  const handleRightTab = (id: 'layers' | 'export') => {
    // Toggle: clicking the already-active right tab closes it, returns to map
    if (activeTab === id) {
      setActiveTab('map');
    } else {
      setActiveTab(id);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#121212] text-white overflow-hidden">
      <ToastContainer />

      {/* Title Bar */}
      <header className="h-12 bg-[#1a1a1a] border-b border-gray-800 flex items-center px-4 justify-between select-none">
        <div className="flex items-center gap-3">
          <img src="./logo/logo.png" alt="GeoTerrain" className="w-8 h-8 rounded object-contain" />
          <h1 className="text-sm font-semibold tracking-wide">GeoTerrain Studio</h1>
          <span className="text-[10px] px-1.5 py-0.5 bg-cyan-500/20 text-cyan-400 rounded">v{APP_VERSION}-beta</span>
        </div>
        <div className="text-xs text-gray-500">Standalone Terrain Extractor</div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">

        {/* Left Sidebar — Map / 3D View only */}
        <nav className="w-16 bg-[#1a1a1a] border-r border-gray-800 flex flex-col items-center py-4 gap-1">
          {LEFT_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleLeftTab(tab.id)}
                className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  isActive ? 'bg-cyan-500/10 text-cyan-400' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                }`}
                title={tab.label}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[9px]">{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Center — Map always visible (or 3D view) */}
        <main className="flex-1 flex overflow-hidden relative">
          {/* Map Viewport — always mounted, shown when not view3d */}
          <div className={`flex-1 relative ${leftTabId !== 'view3d' ? 'block' : 'hidden'}`}>
            <MapViewport />
            {/* Export progress overlay on the big empty map area */}
            <ExportProgressOverlay />
          </div>

          {/* 3D Viewport */}
          <div className={`flex-1 relative ${activeTab === 'view3d' ? 'block' : 'hidden'}`}>
            <TerrainViewer3D manifest={exportedManifest} packagePath={exportedPackagePath} />
          </div>

          {/* Right Side Panel — Layers / Jobs / Export */}
          {isRightPanelOpen && (
            <aside className="w-80 border-l border-gray-800 flex flex-col bg-[#1a1a1a] overflow-hidden">
              {/* Panel Tab Header */}
              <div className="flex border-b border-gray-800 shrink-0">
                {RIGHT_TABS.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => handleRightTab(tab.id)}
                      className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] transition-colors border-b-2 ${
                        isActive
                          ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5'
                          : 'border-transparent text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              {/* Panel Content */}
              <div className="flex-1 overflow-y-auto">
                {activeTab === 'layers' && <LayerStack />}
                {activeTab === 'export' && <ExportPanel />}
              </div>
            </aside>
          )}
        </main>

        {/* Right Sidebar — icon nav for Layers / Jobs / Export */}
        <nav className="w-16 bg-[#1a1a1a] border-l border-gray-800 flex flex-col items-center py-4 gap-1">
          {RIGHT_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleRightTab(tab.id)}
                className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  isActive ? 'bg-cyan-500/10 text-cyan-400' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                }`}
                title={tab.label}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[9px]">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Status Bar */}
      <footer className="h-6 bg-[#1a1a1a] border-t border-gray-800 flex items-center px-3 text-[10px] text-gray-500 justify-between">
        <div className="flex items-center gap-3">
          <span>Ready</span>
          <span className="text-gray-700">|</span>
          <span>MapLibre + Babylon.js</span>
        </div>
        <div className="flex items-center gap-3">
          <span>Native Core: v{APP_VERSION}</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
