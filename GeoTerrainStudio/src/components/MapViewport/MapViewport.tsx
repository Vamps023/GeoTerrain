import React, { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoBounds } from '../../types/terrain';
import { useTerrainStore } from '../../core/store';
import { Native } from '../../core/ipc';

interface MapViewportProps {
  className?: string;
}

export const MapViewport: React.FC<MapViewportProps> = ({ className }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ lng: number; lat: number } | null>(null);
  const liveBoundsRef = useRef<GeoBounds | null>(null);
  
  const [liveBoundsState, setLiveBoundsState] = useState<GeoBounds | null>(null);
  
  const setSelectedBounds = useTerrainStore((s) => s.setSelectedBounds);
  const selectedBounds = useTerrainStore((s) => s.selectedBounds);
  const activeProfile = useTerrainStore((s) => s.activeProfile);
  const setGenerationPlan = useTerrainStore((s) => s.setGenerationPlan);
  const setActiveTab = useTerrainStore((s) => s.setActiveTab);
  const generationPlan = useTerrainStore((s) => s.generationPlan);

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          'esri-imagery': {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            attribution: 'Esri',
          },
        },
        layers: [
          {
            id: 'esri-imagery',
            type: 'raster',
            source: 'esri-imagery',
            minzoom: 0,
            maxzoom: 22,
          },
        ],
      },
      center: [0, 20],
      zoom: 2,
      attributionControl: false,
    });

    // Disable default interactions that conflict with Shift+drag selection
    map.boxZoom.disable();

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    // Use DOM events on the canvas for reliable Shift+drag
    const canvas = map.getCanvas();

    const onMouseDown = (e: MouseEvent) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      
      // Disable map panning while selecting
      map.dragPan.disable();
      
      isDraggingRef.current = true;
      const point = new maplibregl.Point(e.offsetX, e.offsetY);
      const lngLat = map.unproject(point);
      dragStartRef.current = { lng: lngLat.lng, lat: lngLat.lat };
      canvas.style.cursor = 'crosshair';
      
      console.log('[Map] Selection started at:', dragStartRef.current);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      e.preventDefault();
      
      const point = new maplibregl.Point(e.offsetX, e.offsetY);
      const lngLat = map.unproject(point);
      const current = { lng: lngLat.lng, lat: lngLat.lat };
      const start = dragStartRef.current;
      
      const bounds: GeoBounds = {
        west: Math.min(start.lng, current.lng),
        south: Math.min(start.lat, current.lat),
        east: Math.max(start.lng, current.lng),
        north: Math.max(start.lat, current.lat),
      };
      
      liveBoundsRef.current = bounds;
      setLiveBoundsState(bounds);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      e.preventDefault();
      
      isDraggingRef.current = false;
      canvas.style.cursor = '';
      
      // Re-enable map panning
      map.dragPan.enable();
      
      if (liveBoundsRef.current) {
        console.log('[Map] Selection finalized:', liveBoundsRef.current);
        setSelectedBounds(liveBoundsRef.current);
      }
      
      dragStartRef.current = null;
      liveBoundsRef.current = null;
      setLiveBoundsState(null);
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    // Handle case where mouse is released outside canvas
    window.addEventListener('mouseup', onMouseUp);

    mapRef.current = map;

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mouseup', onMouseUp);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update selection rectangle on map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sourceId = 'selection-source';
    const fillLayerId = 'selection-fill';
    const outlineLayerId = 'selection-outline';

    const bounds = selectedBounds || liveBoundsState;
    
    if (bounds) {
      const geojson = {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [bounds.west, bounds.south],
              [bounds.east, bounds.south],
              [bounds.east, bounds.north],
              [bounds.west, bounds.north],
              [bounds.west, bounds.south],
            ],
          ],
        },
        properties: {},
      };

      if (map.getSource(sourceId)) {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson as any);
      } else {
        map.addSource(sourceId, {
          type: 'geojson',
          data: geojson as any,
        });
        map.addLayer({
          id: fillLayerId,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': '#06b6d4',
            'fill-opacity': liveBoundsState ? 0.15 : 0.3,
          },
        });
        map.addLayer({
          id: outlineLayerId,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': '#06b6d4',
            'line-width': liveBoundsState ? 2 : 3,
          },
        });
      }
    } else {
      if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
      if (map.getLayer(outlineLayerId)) map.removeLayer(outlineLayerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }, [selectedBounds, liveBoundsState]);

  // Update tile grid overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !generationPlan) return;

    const sourceId = 'tilegrid-source';
    const layerId = 'tilegrid-layer';

    const features = generationPlan.tiles.map((tile) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [tile.bounds.west, tile.bounds.south],
            [tile.bounds.east, tile.bounds.south],
            [tile.bounds.east, tile.bounds.north],
            [tile.bounds.west, tile.bounds.north],
            [tile.bounds.west, tile.bounds.south],
          ],
        ],
      },
      properties: { row: tile.row, col: tile.col },
    }));

    const geojson = {
      type: 'FeatureCollection',
      features,
    };

    if (map.getSource(sourceId)) {
      (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson as any);
    } else {
      map.addSource(sourceId, {
        type: 'geojson',
        data: geojson as any,
      });
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#f59e0b',
          'line-width': 1.5,
          'line-dasharray': [4, 2],
        },
      });
    }

    return () => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
  }, [generationPlan]);

  const handleClear = useCallback(() => {
    setSelectedBounds(null);
    setLiveBoundsState(null);
    dragStartRef.current = null;
    isDraggingRef.current = false;
    liveBoundsRef.current = null;
  }, [setSelectedBounds]);

  const handlePlanGeneration = useCallback(async () => {
    if (!selectedBounds) return;
    try {
      const plan = await Native.planGeneration(selectedBounds, activeProfile);
      setGenerationPlan(plan);
      setActiveTab('layers');
    } catch (err) {
      console.error('Failed to plan generation:', err);
    }
  }, [selectedBounds, activeProfile, setGenerationPlan, setActiveTab]);

  return (
    <div className={`relative w-full h-full ${className ?? ''}`}>
      <div ref={mapContainerRef} className="absolute inset-0" />

      {/* Selection Info Overlay */}
      <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-sm text-white p-4 rounded-lg max-w-xs pointer-events-auto z-10">
        <h3 className="text-sm font-semibold mb-2 text-cyan-400">Map Selection</h3>
        <p className="text-xs text-gray-300 mb-2">
          <strong>Shift + Click and drag</strong> to draw a selection rectangle.
        </p>

        {selectedBounds && (
          <div className="space-y-1 text-xs mt-3">
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
            <div className="flex gap-2 mt-2">
              <button
                onClick={handlePlanGeneration}
                className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white py-1.5 px-2 rounded text-xs font-medium transition-colors"
              >
                Plan Generation
              </button>
              <button
                onClick={handleClear}
                className="bg-gray-600 hover:bg-gray-500 text-white py-1.5 px-2 rounded text-xs transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 right-4 bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg text-xs pointer-events-auto z-10 space-y-1">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-cyan-400 bg-cyan-400/20" />
          <span>Selected Area</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 border border-amber-500 border-dashed" />
          <span>Tile Grid</span>
        </div>
        <p className="text-gray-400 text-[10px] mt-1">Shift+drag to select</p>
      </div>
    </div>
  );
};
