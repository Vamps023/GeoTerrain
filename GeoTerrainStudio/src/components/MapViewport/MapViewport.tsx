import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Viewer, Entity, RectangleGraphics, CameraFlyTo } from 'resium';
import { Cartesian3, Color, Rectangle, ScreenSpaceEventType, ScreenSpaceEventHandler, Cartographic, Math as CesiumMath } from 'cesium';
import type { GeoBounds } from '../../types/terrain';
import { useTerrainStore } from '../../core/store';
import { Native } from '../../core/ipc';
import 'cesium/Build/Cesium/Widgets/widgets.css';

interface MapViewportProps {
  className?: string;
}

const CESIUM_TOKEN = 'YOUR_CESIUM_ION_TOKEN'; // Replace with your token

export const MapViewport: React.FC<MapViewportProps> = ({ className }) => {
  const viewerRef = useRef<any>(null);
  const [selectionRect, setSelectionRect] = useState<Rectangle | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Cartographic | null>(null);
  const setSelectedBounds = useTerrainStore((s) => s.setSelectedBounds);
  const selectedBounds = useTerrainStore((s) => s.selectedBounds);
  const activeProfile = useTerrainStore((s) => s.activeProfile);
  const setGenerationPlan = useTerrainStore((s) => s.setGenerationPlan);
  const setActiveTab = useTerrainStore((s) => s.setActiveTab);

  // Setup Cesium Ion token (optional - for terrain/bing maps)
  useEffect(() => {
    if (CESIUM_TOKEN && CESIUM_TOKEN !== 'YOUR_CESIUM_ION_TOKEN') {
      import('cesium').then((Cesium) => {
        Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;
      });
    }
  }, []);

  // Convert selection rectangle to GeoBounds
  const rectToBounds = useCallback((rect: Rectangle): GeoBounds => ({
    west: CesiumMath.toDegrees(rect.west),
    south: CesiumMath.toDegrees(rect.south),
    east: CesiumMath.toDegrees(rect.east),
    north: CesiumMath.toDegrees(rect.north),
  }), []);

  // Mouse handlers for rectangle selection
  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement;
    if (!viewer) return;

    const handler = new ScreenSpaceEventHandler(viewer.canvas);

    handler.setInputAction((movement: any) => {
      const cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
      if (cartesian) {
        setDragStart(Cartographic.fromCartesian(cartesian));
        setIsDragging(true);
      }
    }, ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((movement: any) => {
      if (!isDragging || !dragStart) return;
      const cartesian = viewer.camera.pickEllipsoid(movement.endPosition, viewer.scene.globe.ellipsoid);
      if (cartesian) {
        const endCart = Cartographic.fromCartesian(cartesian);
        const rect = Rectangle.fromCartographicArray([dragStart, endCart]);
        setSelectionRect(rect);
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction(() => {
      if (selectionRect) {
        const bounds = rectToBounds(selectionRect);
        setSelectedBounds(bounds);
      }
      setIsDragging(false);
      setDragStart(null);
    }, ScreenSpaceEventType.LEFT_UP);

    return () => handler.destroy();
  }, [isDragging, dragStart, selectionRect, setSelectedBounds, rectToBounds]);

  const handlePlanGeneration = useCallback(async () => {
    if (!selectedBounds) return;
    try {
      const plan = await Native.planGeneration(selectedBounds, activeProfile);
      setGenerationPlan(plan);
      setActiveTab('layers');
    } catch (err) {
      console.error('Failed to plan generation:', err);
      alert('Failed to plan generation. See console for details.');
    }
  }, [selectedBounds, activeProfile, setGenerationPlan, setActiveTab]);

  return (
    <div className={`relative w-full h-full ${className ?? ''}`}>
      <Viewer
        ref={viewerRef}
        full
        timeline={false}
        animation={false}
        homeButton={false}
        baseLayerPicker={true}
        navigationHelpButton={false}
        sceneModePicker={false}
        geocoder={true}
        fullscreenButton={false}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <CameraFlyTo
          destination={Cartesian3.fromDegrees(0, 20, 15000000)}
          duration={0}
        />
        {selectionRect && (
          <Entity>
            <RectangleGraphics
              coordinates={selectionRect}
              material={Color.fromAlpha(Color.CYAN, 0.2)}
              outline={true}
              outlineColor={Color.CYAN}
              outlineWidth={2}
            />
          </Entity>
        )}
      </Viewer>

      {/* Selection Info Overlay */}
      <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-sm text-white p-4 rounded-lg max-w-xs pointer-events-auto">
        <h3 className="text-sm font-semibold mb-2 text-cyan-400">Map Selection</h3>
        <p className="text-xs text-gray-300 mb-2">
          Click and drag to draw a selection rectangle on the globe.
        </p>
        {selectedBounds ? (
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-400">West:</span>
              <span>{selectedBounds.west.toFixed(4)}°</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">East:</span>
              <span>{selectedBounds.east.toFixed(4)}°</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">South:</span>
              <span>{selectedBounds.south.toFixed(4)}°</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">North:</span>
              <span>{selectedBounds.north.toFixed(4)}°</span>
            </div>
            <button
              onClick={handlePlanGeneration}
              className="mt-3 w-full bg-cyan-600 hover:bg-cyan-500 text-white py-1.5 px-3 rounded text-xs font-medium transition-colors"
            >
              Plan Generation
            </button>
          </div>
        ) : (
          <p className="text-xs text-gray-500 italic">No area selected</p>
        )}
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 right-4 bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg text-xs pointer-events-auto">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-3 h-3 border-2 border-cyan-400 bg-cyan-400/20" />
          <span>Selection Area</span>
        </div>
        <p className="text-gray-400 text-[10px]">Hold Shift for 1:1 aspect ratio</p>
      </div>
    </div>
  );
};
