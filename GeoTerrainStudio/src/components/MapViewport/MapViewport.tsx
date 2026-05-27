import React, { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoBounds, TileGrid, TileDefinition, ProjectData } from '../../types/terrain';
import { useTerrainStore } from '../../core/store';
import { Native, Dialog, FsAPI } from '../../core/ipc';
import { Grid3x3, Upload, CheckSquare, Square, FileUp, MapPin, Eye, EyeOff, Lock, Save, FolderOpen } from 'lucide-react';

interface MapViewportProps {
  className?: string;
}

// ─── Tile Grid Math ───────────────────────────────────────────

function computeTileGrid(bounds: GeoBounds, tileSizeKm: number): TileGrid {
  // Approximate degrees per km at this latitude
  const centerLat = (bounds.north + bounds.south) / 2;
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos((centerLat * Math.PI) / 180);

  const tileSizeDegLat = tileSizeKm / kmPerDegLat;
  const tileSizeDegLng = tileSizeKm / kmPerDegLng;

  const widthDeg = bounds.east - bounds.west;
  const heightDeg = bounds.north - bounds.south;

  const cols = Math.max(1, Math.ceil(widthDeg / tileSizeDegLng));
  const rows = Math.max(1, Math.ceil(heightDeg / tileSizeDegLat));

  const actualTileWidth = widthDeg / cols;
  const actualTileHeight = heightDeg / rows;

  const tiles: TileDefinition[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const west = bounds.west + c * actualTileWidth;
      const east = c === cols - 1 ? bounds.east : bounds.west + (c + 1) * actualTileWidth;
      const south = bounds.south + r * actualTileHeight;
      const north = r === rows - 1 ? bounds.north : bounds.south + (r + 1) * actualTileHeight;
      tiles.push({
        row: r,
        col: c,
        bounds: { west, south, east, north },
        center: { lng: (west + east) / 2, lat: (south + north) / 2 },
        selected: true,
      });
    }
  }

  return { rows, cols, tileSizeKm, tiles };
}

// ─── Shapefile Parser ─────────────────────────────────────────

interface ShpParseResult {
  polygons: number[][][][];
  skippedTypes: Map<number, number>; // recordType → count
}

function parseShpBuffer(buffer: ArrayBuffer): ShpParseResult {
  const view = new DataView(buffer);
  const polygons: number[][][][] = [];
  const skippedTypes = new Map<number, number>();

  // File header (100 bytes)
  const fileCode = view.getInt32(0, false);
  if (fileCode !== 9994) {
    console.error('[SHP] Invalid shapefile, file code:', fileCode);
    return { polygons, skippedTypes };
  }

  const fileLengthWords = view.getInt32(24, false); // in 16-bit words
  const fileLength = fileLengthWords * 2; // in bytes
  const version = view.getInt32(28, true);
  const shapeType = view.getInt32(32, true);

  console.log('[SHP] Version:', version, 'Shape type:', shapeType, 'File length:', fileLength, 'bytes');

  // Read records starting at byte 100
  let offset = 100;
  let recordCount = 0;

  while (offset < fileLength - 8) {
    try {
      // Record header: recordNumber (4 bytes, big-endian) + contentLength (4 bytes, big-endian, in 16-bit words)
      const recordNumber = view.getInt32(offset, false);
      const contentLengthWords = view.getInt32(offset + 4, false);
      const contentLength = contentLengthWords * 2; // in bytes

      // Sanity check
      if (contentLength <= 0 || contentLength > 1000000) {
        console.error('[SHP] Invalid content length at record', recordNumber, ':', contentLength);
        break;
      }

      // Record content starts after the 8-byte header
      const contentOffset = offset + 8;
      const recordType = view.getInt32(contentOffset, true); // little-endian

      if (recordCount < 3 || recordCount % 100 === 0) {
        console.log('[SHP] Record', recordNumber, 'type:', recordType, 'contentLength:', contentLength, 'offset:', offset);
      }

      if (recordType === 1) { // Point
        const x = view.getFloat64(contentOffset + 4, true);
        const y = view.getFloat64(contentOffset + 12, true);
        polygons.push([[[x, y]]]);
      } else if (recordType === 3) { // Polyline
        const numParts = view.getInt32(contentOffset + 36, true);
        const numPoints = view.getInt32(contentOffset + 40, true);

        if (numParts < 0 || numParts > 10000 || numPoints < 0 || numPoints > 1000000) {
          console.error('[SHP] Invalid polyline at record', recordNumber, 'parts:', numParts, 'points:', numPoints);
          offset = offset + 8 + contentLength;
          recordCount++;
          continue;
        }

        if (recordCount < 3 || recordCount % 100 === 0) {
          console.log('[SHP] Polyline parts:', numParts, 'points:', numPoints);
        }

        const parts: number[] = [];
        for (let i = 0; i < numParts; i++) {
          parts.push(view.getInt32(contentOffset + 44 + i * 4, true));
        }

        const pointsOffset = contentOffset + 44 + numParts * 4;
        const points: number[][] = [];
        for (let i = 0; i < numPoints; i++) {
          const x = view.getFloat64(pointsOffset + i * 16, true);
          const y = view.getFloat64(pointsOffset + i * 16 + 8, true);
          points.push([x, y]);
        }

        // Each part is a separate line — include ALL parts (even 2-point lines)
        for (let i = 0; i < parts.length; i++) {
          const start = parts[i];
          const end = i + 1 < parts.length ? parts[i + 1] : numPoints;
          const partPoints = points.slice(start, end);
          if (partPoints.length >= 2) {
            polygons.push([partPoints]);
          }
        }
      } else if (recordType === 5) { // Polygon
        const numParts = view.getInt32(contentOffset + 36, true);
        const numPoints = view.getInt32(contentOffset + 40, true);

        if (numParts < 0 || numParts > 10000 || numPoints < 0 || numPoints > 1000000) {
          console.error('[SHP] Invalid polygon at record', recordNumber, 'parts:', numParts, 'points:', numPoints);
          offset = offset + 8 + contentLength;
          recordCount++;
          continue;
        }

        if (recordCount < 3 || recordCount % 100 === 0) {
          console.log('[SHP] Polygon parts:', numParts, 'points:', numPoints);
        }

        const parts: number[] = [];
        for (let i = 0; i < numParts; i++) {
          parts.push(view.getInt32(contentOffset + 44 + i * 4, true));
        }

        const pointsOffset = contentOffset + 44 + numParts * 4;
        const points: number[][] = [];
        for (let i = 0; i < numPoints; i++) {
          const x = view.getFloat64(pointsOffset + i * 16, true);
          const y = view.getFloat64(pointsOffset + i * 16 + 8, true);
          points.push([x, y]);
        }

        // Build rings from parts — each part is a ring
        const rings: number[][][] = [];
        for (let i = 0; i < parts.length; i++) {
          const start = parts[i];
          const end = i + 1 < parts.length ? parts[i + 1] : numPoints;
          rings.push(points.slice(start, end));
        }
        polygons.push(rings);
      } else if (recordType === 0) {
        // Null shape — skip
      } else {
        console.log('[SHP] Skipping unsupported record type:', recordType, 'at record', recordNumber);
        skippedTypes.set(recordType, (skippedTypes.get(recordType) || 0) + 1);
      }

      recordCount++;
      // Move to next record: current offset + 8 byte header + content length
      offset = offset + 8 + contentLength;
    } catch (e) {
      console.error('[SHP] Parse error at offset', offset, ':', e);
      break;
    }
  }

  console.log('[SHP] Parsed', polygons.length, 'polygons/lines from', recordCount, 'records');
  return { polygons, skippedTypes };
}

// ─── Component ────────────────────────────────────────────────

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
  const tileSizeKm = useTerrainStore((s) => s.tileSizeKm);
  const setTileSizeKm = useTerrainStore((s) => s.setTileSizeKm);
  const tileGrid = useTerrainStore((s) => s.tileGrid);
  const setTileGrid = useTerrainStore((s) => s.setTileGrid);
  const selectedTiles = useTerrainStore((s) => s.selectedTiles);
  const toggleTileSelection = useTerrainStore((s) => s.toggleTileSelection);
  const selectedTilesRef = useRef(selectedTiles);
  useEffect(() => {
    selectedTilesRef.current = selectedTiles;
  }, [selectedTiles]);
  const selectAllTiles = useTerrainStore((s) => s.selectAllTiles);
  const deselectAllTiles = useTerrainStore((s) => s.deselectAllTiles);
  const addNotification = useTerrainStore((s) => s.addNotification);

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
            maxzoom: 19,
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
      maxZoom: 22,
      attributionControl: false,
    });

    map.boxZoom.disable();
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    // Zoom lock handler — uses ref to always get current state
    const onZoom = () => {
      if (zoomLockedRef.current && lockedZoomRef.current !== null) {
        const currentZoom = map.getZoom();
        if (Math.abs(currentZoom - lockedZoomRef.current) > 0.01) {
          map.setZoom(lockedZoomRef.current);
        }
      }
    };
    map.on('zoom', onZoom);

    const canvas = map.getCanvas();

    const onMouseDown = (e: MouseEvent) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      map.dragPan.disable();
      isDraggingRef.current = true;
      const point = new maplibregl.Point(e.offsetX, e.offsetY);
      const lngLat = map.unproject(point);
      dragStartRef.current = { lng: lngLat.lng, lat: lngLat.lat };
      canvas.style.cursor = 'crosshair';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      e.preventDefault();
      const point = new maplibregl.Point(e.offsetX, e.offsetY);
      const lngLat = map.unproject(point);
      const current = { lng: lngLat.lng, lat: lngLat.lat };
      const start = dragStartRef.current;

      // Constrain to 1:1 square ratio
      const dLat = Math.abs(current.lat - start.lat);
      const dLng = Math.abs(current.lng - start.lng);
      const size = Math.max(dLat, dLng);

      // Determine direction of drag
      const signLat = current.lat >= start.lat ? 1 : -1;
      const signLng = current.lng >= start.lng ? 1 : -1;

      const endLat = start.lat + signLat * size;
      const endLng = start.lng + signLng * size;

      const bounds: GeoBounds = {
        west: Math.min(start.lng, endLng),
        south: Math.min(start.lat, endLat),
        east: Math.max(start.lng, endLng),
        north: Math.max(start.lat, endLat),
      };
      liveBoundsRef.current = bounds;
      setLiveBoundsState(bounds);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      e.preventDefault();
      isDraggingRef.current = false;
      canvas.style.cursor = '';
      map.dragPan.enable();
      if (liveBoundsRef.current) {
        setSelectedBounds(liveBoundsRef.current);
      }
      dragStartRef.current = null;
      liveBoundsRef.current = null;
      setLiveBoundsState(null);
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
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

  // Compute tile grid when bounds or tile size changes
  useEffect(() => {
    if (!selectedBounds) {
      setTileGrid(null);
      return;
    }
    const grid = computeTileGrid(selectedBounds, tileSizeKm);
    setTileGrid(grid);
    // Only auto-select all if no tiles are currently selected (fresh selection)
    const currentSelected = useTerrainStore.getState().selectedTiles;
    if (currentSelected.size === 0) {
      useTerrainStore.getState().selectAllTiles();
    }
  }, [selectedBounds, tileSizeKm, setTileGrid]);

  // Render tile grid overlay — separated into data update + one-time handler setup
  // Update GeoJSON data whenever tileGrid or selectedTiles changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tileGrid) return;

    const sourceId = 'tilegrid-source';
    const fillLayerId = 'tilegrid-fill';
    const outlineLayerId = 'tilegrid-outline';
    const labelLayerId = 'tilegrid-label';

    const features = tileGrid.tiles.map((tile) => {
      const isSelected = selectedTilesRef.current.has(`${tile.row},${tile.col}`);
      return {
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
        properties: {
          row: tile.row,
          col: tile.col,
          selected: isSelected ? 1 : 0,
          label: `${tile.row},${tile.col}`,
        },
      };
    });

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

      // Fill layer - selected tiles are cyan, unselected are transparent
      map.addLayer({
        id: fillLayerId,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': '#06b6d4',
          'fill-opacity': ['case', ['==', ['get', 'selected'], 1], 0.25, 0.05],
        },
      });

      // Outline layer
      map.addLayer({
        id: outlineLayerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': ['case', ['==', ['get', 'selected'], 1], '#06b6d4', '#666666'],
          'line-width': ['case', ['==', ['get', 'selected'], 1], 2, 1],
          'line-dasharray': [4, 2],
        },
      });

      // Label layer
      map.addLayer({
        id: labelLayerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 12,
          'text-anchor': 'center',
        },
        paint: {
          'text-color': ['case', ['==', ['get', 'selected'], 1], '#06b6d4', '#888888'],
          'text-halo-color': '#000000',
          'text-halo-width': 1,
        },
      });
    }
  }, [tileGrid, selectedTiles]);

  // One-time handler setup for tile grid interaction — only depends on tileGrid
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tileGrid) return;

    const fillLayerId = 'tilegrid-fill';

    // Click handler for tile selection — uses ref to avoid stale closure
    const handleClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (!e.features || e.features.length === 0) return;
      const feature = e.features[0];
      const row = feature.properties?.row as number;
      const col = feature.properties?.col as number;
      toggleTileSelection(row, col);
    };

    // Hover cursor handlers
    const handleMouseEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    map.on('click', fillLayerId, handleClick);
    map.on('mouseenter', fillLayerId, handleMouseEnter);
    map.on('mouseleave', fillLayerId, handleMouseLeave);

    return () => {
      map.off('click', fillLayerId, handleClick);
      map.off('mouseenter', fillLayerId, handleMouseEnter);
      map.off('mouseleave', fillLayerId, handleMouseLeave);
    };
  }, [tileGrid, toggleTileSelection]);

  // Cleanup tile grid when bounds cleared
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!tileGrid && !selectedBounds) {
      const sourceId = 'tilegrid-source';
      const fillLayerId = 'tilegrid-fill';
      const outlineLayerId = 'tilegrid-outline';
      const labelLayerId = 'tilegrid-label';
      if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
      if (map.getLayer(outlineLayerId)) map.removeLayer(outlineLayerId);
      if (map.getLayer(labelLayerId)) map.removeLayer(labelLayerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }, [tileGrid, selectedBounds]);

  const handleClear = useCallback(() => {
    setSelectedBounds(null);
    setLiveBoundsState(null);
    setTileGrid(null);
    dragStartRef.current = null;
    isDraggingRef.current = false;
    liveBoundsRef.current = null;
  }, [setSelectedBounds, setTileGrid]);

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

  const selectedCount = selectedTiles.size;
  const totalTiles = tileGrid?.tiles.length ?? 0;

  // ─── Selection & Grid Visibility ────────────────────────────
  const [selectionVisible, setSelectionVisible] = useState(true);
  const [gridVisible, setGridVisible] = useState(true);

  // ─── Shapefile Import ───────────────────────────────────────
  const [isDraggingShp, setIsDraggingShp] = useState(false);
  const [shpBounds, setShpBounds] = useState<{ minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  const [shpLoaded, setShpLoaded] = useState(false);
  const [shpVisible, setShpVisible] = useState(true);
  const [shpOpacity, setShpOpacity] = useState(0.35);
  const [shpThickness, setShpThickness] = useState(3);
  const shpGeoJSONRef = useRef<ProjectData['shapefileGeoJSON']>(null);

  // ─── Zoom Lock ──────────────────────────────────────────────
  const [zoomLocked, setZoomLocked] = useState(false);
  const zoomLockedRef = useRef(false);
  const lockedZoomRef = useRef<number | null>(null);

  // Toggle selection visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const fillLayerId = 'selection-fill';
    const outlineLayerId = 'selection-outline';
    if (map.getLayer(fillLayerId)) {
      map.setLayoutProperty(fillLayerId, 'visibility', selectionVisible ? 'visible' : 'none');
    }
    if (map.getLayer(outlineLayerId)) {
      map.setLayoutProperty(outlineLayerId, 'visibility', selectionVisible ? 'visible' : 'none');
    }
  }, [selectionVisible]);

  // Toggle grid visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const fillLayerId = 'tilegrid-fill';
    const outlineLayerId = 'tilegrid-outline';
    const labelLayerId = 'tilegrid-label';
    if (map.getLayer(fillLayerId)) {
      map.setLayoutProperty(fillLayerId, 'visibility', gridVisible ? 'visible' : 'none');
    }
    if (map.getLayer(outlineLayerId)) {
      map.setLayoutProperty(outlineLayerId, 'visibility', gridVisible ? 'visible' : 'none');
    }
    if (map.getLayer(labelLayerId)) {
      map.setLayoutProperty(labelLayerId, 'visibility', gridVisible ? 'visible' : 'none');
    }
  }, [gridVisible]);

  const handleShpDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingShp(false);

    const files = Array.from(e.dataTransfer.files);
    const shpFile = files.find((f) => f.name.toLowerCase().endsWith('.shp'));
    const dbfFile = files.find((f) => f.name.toLowerCase().endsWith('.dbf'));
    const prjFile = files.find((f) => f.name.toLowerCase().endsWith('.prj'));

    if (!shpFile) {
      addNotification({ type: 'info', message: 'Please drop a .shp file (optionally with .shx, .dbf, .prj)' });
      return;
    }

    parseShapefile(shpFile, dbfFile, prjFile);
  }, []);

  const handleShpDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingShp(true);
  }, []);

  const handleShpDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingShp(false);
  }, []);

  const handleShpFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const shpFile = files.find((f) => f.name.toLowerCase().endsWith('.shp'));
    const dbfFile = files.find((f) => f.name.toLowerCase().endsWith('.dbf'));
    const prjFile = files.find((f) => f.name.toLowerCase().endsWith('.prj'));
    if (shpFile) {
      parseShapefile(shpFile, dbfFile, prjFile);
    }
  }, []);

  // Simple shapefile parser (reads SHP header + records as polygons)
  const parseShapefile = useCallback((shpFile: File, _dbfFile?: File, prjFile?: File) => {
    // Check projection first
    if (prjFile) {
      const prjReader = new FileReader();
      prjReader.onload = (e) => {
        const prjText = e.target?.result as string;
        console.log('[SHP] Projection:', prjText?.substring(0, 100));
        if (prjText && !prjText.includes('WGS_1984') && !prjText.includes('GCS_WGS_1984') && !prjText.includes('GEOGCS')) {
          addNotification({ type: 'error', message: 'Shapefile uses projected CRS (not WGS84). Please reproject to EPSG:4326 before importing.' });
        }
        readShpData();
      };
      prjReader.readAsText(prjFile);
    } else {
      console.warn('[SHP] No .prj file found. Assuming WGS84.');
      readShpData();
    }

    function readShpData() {
      const reader = new FileReader();
      reader.onload = (event) => {
        const buffer = event.target?.result as ArrayBuffer;
        if (!buffer) return;
        const { polygons, skippedTypes } = parseShpBuffer(buffer);
        if (skippedTypes.size > 0) {
          const totalSkipped = Array.from(skippedTypes.values()).reduce((a, b) => a + b, 0);
          const skippedTypesList = Array.from(skippedTypes.keys()).join(', ');
          addNotification({
            type: 'warning',
            message: `Shapefile: skipped ${totalSkipped} unsupported records (types: ${skippedTypesList})`,
          });
        }
        if (polygons.length > 0) {
          addShapefileToMap(polygons);
        }
      };
      reader.readAsArrayBuffer(shpFile);
    }
  }, []);

  const addShapefileToMap = useCallback((polygons: number[][][][]) => {
    const map = mapRef.current;
    if (!map) return;

    const features = polygons.map((poly, i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: poly,
      },
      properties: { id: i },
    }));

    const geojson = {
      type: 'FeatureCollection' as const,
      features,
    };

    // Store for project save
    shpGeoJSONRef.current = geojson as unknown as ProjectData['shapefileGeoJSON'];

    const sourceId = 'shapefile-source';
    const fillLayerId = 'shapefile-fill';
    const outlineLayerId = 'shapefile-outline';

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
          'fill-color': '#f59e0b',
          'fill-opacity': shpVisible ? shpOpacity : 0,
        },
      });
      map.addLayer({
        id: outlineLayerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#f59e0b',
          'line-width': shpVisible ? shpThickness : 0,
        },
      });
    }

    // Compute bounds
    const allCoords = polygons.flat(2);
    const xs = allCoords.map((c) => c[0]);
    const ys = allCoords.map((c) => c[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    setShpBounds({ minX, maxX, minY, maxY });
    setShpLoaded(true);
    setShpVisible(true);

    // Check if coordinates are in valid lat/lng range
    const isWGS84 = minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;

    if (isWGS84) {
      const bounds = new maplibregl.LngLatBounds([minX, minY], [maxX, maxY]);
      map.fitBounds(bounds, { padding: 50 });
    } else {
      console.warn('[SHP] Coordinates out of lat/lng range. Shapefile may be in a projected CRS.');
      console.warn('[SHP] Bounds:', { minX, maxX, minY, maxY });
      addNotification({ type: 'error', message: 'Shapefile coordinates out of range (projected CRS?). Please reproject to WGS84 (EPSG:4326).' });
    }
  }, []);

  // Update shapefile layer styles when controls change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const fillLayerId = 'shapefile-fill';
    const outlineLayerId = 'shapefile-outline';
    if (map.getLayer(fillLayerId)) {
      map.setPaintProperty(fillLayerId, 'fill-opacity', shpVisible ? shpOpacity : 0);
    }
    if (map.getLayer(outlineLayerId)) {
      map.setPaintProperty(outlineLayerId, 'line-width', shpVisible ? shpThickness : 0);
    }
  }, [shpVisible, shpOpacity, shpThickness]);

  const handleFocusShp = useCallback(() => {
    const map = mapRef.current;
    if (!map || !shpBounds) return;

    // Use the GeoJSON source's built-in extent if available
    const source = map.getSource('shapefile-source') as maplibregl.GeoJSONSource;
    if (source) {
      // For GeoJSON sources, we can compute bounds from the data
      // Since the source may have projected coords, just zoom to a default area
      // and let the user see the shapefile is loaded
      console.log('[SHP] Focusing on shapefile bounds:', shpBounds);

      // If WGS84, use normal fitBounds
      const isWGS84 = shpBounds.minX >= -180 && shpBounds.maxX <= 180 && shpBounds.minY >= -90 && shpBounds.maxY <= 90;
      if (isWGS84) {
        const bounds = new maplibregl.LngLatBounds(
          [shpBounds.minX, shpBounds.minY],
          [shpBounds.maxX, shpBounds.maxY]
        );
        map.fitBounds(bounds, { padding: 100, duration: 1000 });
      } else {
        // For projected coords, we can't use fitBounds directly
        // Just zoom out to show the world and flash a message
        map.flyTo({ center: [0, 20], zoom: 2, duration: 1000 });
        addNotification({ type: 'error', message: `Shapefile uses projected coordinates. Raw bounds: X:${shpBounds.minX.toFixed(0)}-${shpBounds.maxX.toFixed(0)} Y:${shpBounds.minY.toFixed(0)}-${shpBounds.maxY.toFixed(0)}` });
      }
    }
  }, [shpBounds]);

  return (
    <div
      className={`relative w-full h-full ${className ?? ''}`}
      onDrop={handleShpDrop}
      onDragOver={handleShpDragOver}
      onDragLeave={handleShpDragLeave}
    >
      <div ref={mapContainerRef} className="absolute inset-0" />

      {/* Shapefile Drop Overlay */}
      {isDraggingShp && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-gray-800 border-2 border-dashed border-amber-400 rounded-xl p-8 text-center">
            <FileUp className="w-12 h-12 text-amber-400 mx-auto mb-3" />
            <p className="text-white font-medium">Drop shapefile here</p>
            <p className="text-gray-400 text-xs mt-1">.shp (with optional .shx, .dbf)</p>
          </div>
        </div>
      )}

      {/* Top Left: Selection Info + Tile Controls + Shapefile Import */}
      <div className="absolute top-4 left-4 flex flex-col gap-3 pointer-events-none z-10 w-[220px]">
        {/* Selection Info */}
        <div className="bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg pointer-events-auto flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs font-semibold text-cyan-400">Selection</h3>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setSelectionVisible((v) => !v)}
                className={`inline-flex items-center gap-1 py-0.5 px-1.5 rounded text-[9px] transition-colors ${
                  selectionVisible ? 'bg-cyan-600/30 text-cyan-400' : 'bg-gray-700 text-gray-500'
                }`}
                title="Toggle selection visibility"
              >
                {selectionVisible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
              </button>
              <button
                onClick={() => {
                  const map = mapRef.current;
                  if (!map) return;
                  if (!zoomLocked) {
                    lockedZoomRef.current = map.getZoom();
                    zoomLockedRef.current = true;
                    setZoomLocked(true);
                  } else {
                    lockedZoomRef.current = null;
                    zoomLockedRef.current = false;
                    setZoomLocked(false);
                  }
                }}
                className={`inline-flex items-center gap-1 py-0.5 px-1.5 rounded text-[9px] transition-colors ${
                  zoomLocked ? 'bg-cyan-600/30 text-cyan-400' : 'bg-gray-700 text-gray-500'
                }`}
                title={zoomLocked ? `Locked at zoom ${lockedZoomRef.current?.toFixed(1)}` : 'Lock current zoom'}
              >
                <Lock className="w-2.5 h-2.5" />
                {zoomLocked ? 'Locked' : 'Lock'}
              </button>
            </div>
          </div>
          <p className="text-[10px] text-gray-400 mb-2">Shift+drag to select area</p>

          {selectedBounds ? (
            <div className="space-y-0.5 text-[10px]">
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">W:</span>
                <span>{selectedBounds.west.toFixed(3)}°</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">E:</span>
                <span>{selectedBounds.east.toFixed(3)}°</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">S:</span>
                <span>{selectedBounds.south.toFixed(3)}°</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">N:</span>
                <span>{selectedBounds.north.toFixed(3)}°</span>
              </div>
              <div className="flex gap-1 mt-2">
                <button
                  onClick={handlePlanGeneration}
                  className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white py-1 px-2 rounded text-[10px] transition-colors"
                >
                  Plan
                </button>
                <button
                  onClick={handleClear}
                  className="bg-gray-600 hover:bg-gray-500 text-white py-1 px-2 rounded text-[10px] transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[10px] text-gray-500">No area selected</p>
          )}
        </div>

        {/* Project Save/Load Panel */}
        <div className="bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg pointer-events-auto flex-shrink-0">
          <h3 className="text-xs font-semibold mb-2 text-green-400 flex items-center gap-1">
            <Save className="w-3 h-3" />
            Project
          </h3>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={async () => {
                const map = mapRef.current;
                if (!map) return;
                const filePath = await Dialog.saveProject();
                if (!filePath) return;
                const center = map.getCenter();
                const project: ProjectData = {
                  version: '1.0',
                  savedAt: new Date().toISOString(),
                  selectedBounds,
                  tileSizeKm,
                  tileGrid,
                  selectedTiles: Array.from(selectedTiles),
                  shapefileGeoJSON: shpGeoJSONRef.current,
                  shapefileBounds: shpBounds,
                  mapCenter: { lng: center.lng, lat: center.lat },
                  mapZoom: map.getZoom(),
                };
                const ok = await FsAPI.saveProject(filePath, project);
                if (ok) addNotification({ type: 'success', message: 'Project saved!' });
                else addNotification({ type: 'error', message: 'Failed to save project' });
              }}
              className="flex items-center justify-center gap-1 bg-green-600 hover:bg-green-500 text-white py-1.5 px-2 rounded text-[10px] transition-colors"
            >
              <Save className="w-3 h-3" />
              Save
            </button>
            <button
              onClick={async () => {
                const filePath = await Dialog.loadProject();
                if (!filePath) return;
                const project = await FsAPI.loadProject(filePath);
                if (!project) {
                  addNotification({ type: 'error', message: 'Failed to load project' });
                  return;
                }
                // Restore selected tiles FIRST (before setting bounds/grid)
                if (project.selectedTiles) {
                  const store = useTerrainStore.getState();
                  store.setSelectedTiles(new Set(project.selectedTiles));
                }
                // Restore tile grid config
                if (project.tileSizeKm) {
                  setTileSizeKm(project.tileSizeKm);
                }
                // Restore tile grid
                if (project.tileGrid) {
                  setTileGrid(project.tileGrid);
                }
                // Restore selection bounds LAST (triggers grid render)
                if (project.selectedBounds) {
                  setSelectedBounds(project.selectedBounds);
                }
                // Restore shapefile
                if (project.shapefileGeoJSON && project.shapefileBounds) {
                  shpGeoJSONRef.current = project.shapefileGeoJSON;
                  setShpBounds(project.shapefileBounds);
                  setShpLoaded(true);
                  setShpVisible(true);
                  // Add to map
                  const map = mapRef.current;
                  if (map) {
                    const sourceId = 'shapefile-source';
                    const fillLayerId = 'shapefile-fill';
                    const outlineLayerId = 'shapefile-outline';
                    if (map.getSource(sourceId)) {
                      (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(project.shapefileGeoJSON as any);
                    } else {
                      map.addSource(sourceId, {
                        type: 'geojson',
                        data: project.shapefileGeoJSON as any,
                      });
                      map.addLayer({
                        id: fillLayerId,
                        type: 'fill',
                        source: sourceId,
                        paint: {
                          'fill-color': '#f59e0b',
                          'fill-opacity': shpOpacity,
                        },
                      });
                      map.addLayer({
                        id: outlineLayerId,
                        type: 'line',
                        source: sourceId,
                        paint: {
                          'line-color': '#f59e0b',
                          'line-width': shpThickness,
                        },
                      });
                    }
                  }
                }
                // Restore map view
                const map = mapRef.current;
                if (map && project.mapCenter) {
                  map.setCenter([project.mapCenter.lng, project.mapCenter.lat]);
                  map.setZoom(project.mapZoom);
                }
                addNotification({ type: 'success', message: 'Project loaded!' });
              }}
              className="flex items-center justify-center gap-1 bg-gray-700 hover:bg-gray-600 text-white py-1.5 px-2 rounded text-[10px] transition-colors"
            >
              <FolderOpen className="w-3 h-3" />
              Load
            </button>
          </div>
        </div>

        {/* Tile Grid Controls */}
        {selectedBounds && tileGrid && (
          <div className="bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg pointer-events-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-cyan-400 flex items-center gap-1">
                <Grid3x3 className="w-3 h-3" />
                Tile Grid
              </h3>
              <button
                onClick={() => setGridVisible((v) => !v)}
                className={`inline-flex items-center gap-1 py-0.5 px-1.5 rounded text-[9px] transition-colors ${
                  gridVisible ? 'bg-cyan-600/30 text-cyan-400' : 'bg-gray-700 text-gray-500'
                }`}
                title="Toggle grid visibility"
              >
                {gridVisible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
              </button>
            </div>

            {/* Tile Size Buttons */}
            <div className="flex gap-1 mb-2">
              {[1, 2, 4, 8, 16].map((size) => (
                <button
                  key={size}
                  onClick={() => setTileSizeKm(size)}
                  className={`flex-1 py-1 rounded text-[9px] font-medium transition-colors text-center ${
                    tileSizeKm === size
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  }`}
                >
                  {size}km
                </button>
              ))}
            </div>

            {/* Grid Info */}
            <div className="flex items-center justify-between text-[10px] mb-1.5">
              <span className="text-gray-400">
                {tileGrid.rows}×{tileGrid.cols} = {totalTiles}
              </span>
              <span className={selectedCount > 0 ? 'text-cyan-400' : 'text-red-400'}>
                {selectedCount} selected
              </span>
            </div>

            {/* Select/Deselect */}
            <div className="flex gap-1">
              <button
                onClick={selectAllTiles}
                className="flex-1 flex items-center justify-center gap-1 bg-gray-700 hover:bg-gray-600 text-white py-1 rounded text-[10px] transition-colors"
              >
                <CheckSquare className="w-3 h-3" />
                All
              </button>
              <button
                onClick={deselectAllTiles}
                className="flex-1 flex items-center justify-center gap-1 bg-gray-700 hover:bg-gray-600 text-white py-1 rounded text-[10px] transition-colors"
              >
                <Square className="w-3 h-3" />
                None
              </button>
            </div>
          </div>
        )}

        {/* Shapefile Import Panel */}
        <div className="bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg pointer-events-auto flex-shrink-0">
          <h3 className="text-xs font-semibold mb-1 text-amber-400 flex items-center gap-1">
            <Upload className="w-3 h-3" />
            Shapefile
          </h3>
          <p className="text-[10px] text-gray-400 mb-1.5">Drop .shp on map or browse</p>
          <div className="grid grid-cols-2 gap-1.5 mb-2">
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".shp,.shx,.dbf,.prj"
                multiple
                onChange={handleShpFileInput}
                className="hidden"
              />
              <span className="inline-flex items-center justify-center gap-1 bg-amber-600 hover:bg-amber-500 text-white py-1 px-1 rounded text-[10px] transition-colors w-full">
                <FileUp className="w-3 h-3" />
                Import
              </span>
            </label>
            {shpLoaded && (
              <button
                onClick={handleFocusShp}
                className="inline-flex items-center justify-center gap-1 bg-gray-700 hover:bg-gray-600 text-white py-1 px-1 rounded text-[10px] transition-colors"
              >
                <MapPin className="w-3 h-3" />
                Focus
              </button>
            )}
          </div>

          {/* Shapefile Visibility Controls */}
          {shpLoaded && (
            <div className="space-y-2 border-t border-gray-600 pt-2 mt-1">
              {/* Visibility Toggle */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-300">Visible</span>
                <button
                  onClick={() => setShpVisible((v) => !v)}
                  className={`inline-flex items-center gap-1 py-0.5 px-1.5 rounded text-[10px] transition-colors ${
                    shpVisible ? 'bg-amber-600/30 text-amber-400' : 'bg-gray-700 text-gray-500'
                  }`}
                >
                  {shpVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {shpVisible ? 'On' : 'Off'}
                </button>
              </div>

              {/* Opacity Slider */}
              <div>
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-gray-300">Fill Opacity</span>
                  <span className="text-amber-400">{Math.round(shpOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(shpOpacity * 100)}
                  onChange={(e) => setShpOpacity(Number(e.target.value) / 100)}
                  className="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-amber-500"
                />
              </div>

              {/* Thickness Slider */}
              <div>
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-gray-300">Line Thickness</span>
                  <span className="text-amber-400">{shpThickness}px</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={shpThickness}
                  onChange={(e) => setShpThickness(Number(e.target.value))}
                  className="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-amber-500"
                />
              </div>
            </div>
          )}

          {shpBounds && (
            <p className="text-[9px] text-gray-500 mt-1">
              {shpBounds.minX >= -180 && shpBounds.maxX <= 180
                ? `WGS84 bounds loaded`
                : `Projected CRS — needs reprojection`}
            </p>
          )}
        </div>
      </div>

      {/* Bottom Right: Legend */}
      <div className="absolute bottom-4 right-4 bg-black/70 backdrop-blur-sm text-white p-2 rounded-lg text-[10px] pointer-events-auto z-10 space-y-1">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 border-2 border-cyan-400 bg-cyan-400/20" />
          <span>Selected Area</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 border border-amber-500 border-dashed" />
          <span>Shapefile</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 bg-cyan-400/40 border border-cyan-400" />
          <span>Selected Tile</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 bg-gray-500/20 border border-gray-500" />
          <span>Unselected Tile</span>
        </div>
      </div>
    </div>
  );
};
