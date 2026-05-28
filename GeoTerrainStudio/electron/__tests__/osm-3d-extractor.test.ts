/**
 * Unit tests for osm-3d-extractor.ts building extraction logic.
 *
 * Tests the extractBuildings function and its helper functions
 * for height estimation, footprint filtering, and optional tag extraction.
 */

import { describe, it, expect } from 'vitest';
import { extractBuildings, estimateBuildingHeight, extractRoads, estimateRoadWidth } from '../osm-3d-extractor';
import type { OverpassFeature } from '../overpass-client';

// ─── Helper: create a valid building feature ───────────────────

function makeFeature(opts: {
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
  type?: 'way' | 'relation';
}): OverpassFeature {
  return {
    type: opts.type ?? 'way',
    id: 1,
    geometry: opts.geometry ?? [
      { lat: 48.0, lon: 2.0 },
      { lat: 48.001, lon: 2.0 },
      { lat: 48.001, lon: 2.001 },
      { lat: 48.0, lon: 2.0 },
    ],
    tags: opts.tags ?? { building: 'yes' },
  };
}

// ─── Height Estimation Tests ───────────────────────────────────

describe('estimateBuildingHeight', () => {
  it('uses explicit height tag when valid', () => {
    const result = estimateBuildingHeight({ height: '15.5' }, 9);
    expect(result.height).toBe(15.5);
  });

  it('falls back to building:levels when height is invalid', () => {
    const result = estimateBuildingHeight({ height: 'abc', 'building:levels': '5' }, 9);
    expect(result.height).toBe(15); // 5 * 3.0
    expect(result.floors).toBe(5);
  });

  it('falls back to building:levels when height is out of range (too low)', () => {
    const result = estimateBuildingHeight({ height: '0.05', 'building:levels': '3' }, 9);
    expect(result.height).toBe(9); // 3 * 3.0
    expect(result.floors).toBe(3);
  });

  it('falls back to building:levels when height is out of range (too high)', () => {
    const result = estimateBuildingHeight({ height: '1001', 'building:levels': '4' }, 9);
    expect(result.height).toBe(12); // 4 * 3.0
    expect(result.floors).toBe(4);
  });

  it('falls back to default when both height and levels are invalid', () => {
    const result = estimateBuildingHeight({ height: 'NaN', 'building:levels': 'abc' }, 9);
    expect(result.height).toBe(9);
  });

  it('falls back to default when levels is out of range (0)', () => {
    const result = estimateBuildingHeight({ 'building:levels': '0' }, 9);
    expect(result.height).toBe(9);
  });

  it('falls back to default when levels is out of range (201)', () => {
    const result = estimateBuildingHeight({ 'building:levels': '201' }, 9);
    expect(result.height).toBe(9);
  });

  it('falls back to default when levels is not an integer', () => {
    const result = estimateBuildingHeight({ 'building:levels': '3.5' }, 9);
    expect(result.height).toBe(9);
  });

  it('uses levels for floors when height tag is valid and levels is also valid', () => {
    const result = estimateBuildingHeight({ height: '20', 'building:levels': '7' }, 9);
    expect(result.height).toBe(20);
    expect(result.floors).toBe(7);
  });

  it('estimates floors from height when height is valid but levels is invalid', () => {
    const result = estimateBuildingHeight({ height: '12' }, 9);
    expect(result.height).toBe(12);
    expect(result.floors).toBe(4); // round(12 / 3.0)
  });

  it('accepts boundary height value 0.1', () => {
    const result = estimateBuildingHeight({ height: '0.1' }, 9);
    expect(result.height).toBe(0.1);
  });

  it('accepts boundary height value 1000', () => {
    const result = estimateBuildingHeight({ height: '1000' }, 9);
    expect(result.height).toBe(1000);
  });

  it('accepts boundary levels value 1', () => {
    const result = estimateBuildingHeight({ 'building:levels': '1' }, 9);
    expect(result.height).toBe(3);
    expect(result.floors).toBe(1);
  });

  it('accepts boundary levels value 200', () => {
    const result = estimateBuildingHeight({ 'building:levels': '200' }, 9);
    expect(result.height).toBe(600);
    expect(result.floors).toBe(200);
  });
});

// ─── extractBuildings Tests ────────────────────────────────────

describe('extractBuildings', () => {
  it('extracts a valid building with default tags', () => {
    const features = [makeFeature({})];
    const result = extractBuildings(features, 9);
    expect(result).toHaveLength(1);
    expect(result[0].height).toBe(9);
    expect(result[0].footprint).toHaveLength(4);
  });

  it('filters out buildings with fewer than 4 coordinate pairs', () => {
    const features = [
      makeFeature({ geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }, { lat: 3, lon: 3 }] }),
    ];
    const result = extractBuildings(features, 9);
    expect(result).toHaveLength(0);
  });

  it('filters out buildings with empty geometry', () => {
    const features = [makeFeature({ geometry: [] })];
    const result = extractBuildings(features, 9);
    expect(result).toHaveLength(0);
  });

  it('includes roofShape when valid', () => {
    const features = [makeFeature({ tags: { building: 'yes', 'roof:shape': 'gabled' } })];
    const result = extractBuildings(features, 9);
    expect(result[0].roofShape).toBe('gabled');
  });

  it('omits roofShape when invalid', () => {
    const features = [makeFeature({ tags: { building: 'yes', 'roof:shape': 'dome' } })];
    const result = extractBuildings(features, 9);
    expect(result[0].roofShape).toBeUndefined();
  });

  it('includes all valid roof shapes', () => {
    for (const shape of ['flat', 'gabled', 'hipped', 'pyramidal']) {
      const features = [makeFeature({ tags: { building: 'yes', 'roof:shape': shape } })];
      const result = extractBuildings(features, 9);
      expect(result[0].roofShape).toBe(shape);
    }
  });

  it('extracts building:min_level when valid', () => {
    const features = [makeFeature({ tags: { building: 'yes', 'building:min_level': '2' } })];
    const result = extractBuildings(features, 9);
    expect(result[0].minLevel).toBe(2);
  });

  it('defaults minLevel to 0 when tag is invalid', () => {
    const features = [makeFeature({ tags: { building: 'yes', 'building:min_level': 'abc' } })];
    const result = extractBuildings(features, 9);
    expect(result[0].minLevel).toBe(0);
  });

  it('defaults minLevel to 0 when tag is out of range', () => {
    const features = [makeFeature({ tags: { building: 'yes', 'building:min_level': '201' } })];
    const result = extractBuildings(features, 9);
    expect(result[0].minLevel).toBe(0);
  });

  it('defaults minLevel to 0 when tag is negative', () => {
    const features = [makeFeature({ tags: { building: 'yes', 'building:min_level': '-1' } })];
    const result = extractBuildings(features, 9);
    expect(result[0].minLevel).toBe(0);
  });

  it('accepts minLevel boundary value 0', () => {
    const features = [makeFeature({ tags: { building: 'yes', 'building:min_level': '0' } })];
    const result = extractBuildings(features, 9);
    expect(result[0].minLevel).toBe(0);
  });

  it('accepts minLevel boundary value 200', () => {
    const features = [makeFeature({ tags: { building: 'yes', 'building:min_level': '200' } })];
    const result = extractBuildings(features, 9);
    expect(result[0].minLevel).toBe(200);
  });

  it('handles relation features with collected geometry', () => {
    const features = [makeFeature({
      type: 'relation',
      geometry: [
        { lat: 48.0, lon: 2.0 },
        { lat: 48.001, lon: 2.0 },
        { lat: 48.001, lon: 2.001 },
        { lat: 48.0, lon: 2.001 },
        { lat: 48.0, lon: 2.0 },
      ],
      tags: { building: 'yes', type: 'multipolygon' },
    })];
    const result = extractBuildings(features, 9);
    expect(result).toHaveLength(1);
    expect(result[0].footprint).toHaveLength(5);
  });

  it('preserves all tags in the output', () => {
    const tags = { building: 'residential', name: 'Test Building', height: '10' };
    const features = [makeFeature({ tags })];
    const result = extractBuildings(features, 9);
    expect(result[0].tags).toEqual(tags);
  });

  it('preserves coordinate order in footprint', () => {
    const geometry = [
      { lat: 1.0, lon: 10.0 },
      { lat: 2.0, lon: 20.0 },
      { lat: 3.0, lon: 30.0 },
      { lat: 1.0, lon: 10.0 },
    ];
    const features = [makeFeature({ geometry })];
    const result = extractBuildings(features, 9);
    expect(result[0].footprint).toEqual(geometry);
  });

  it('processes multiple features correctly', () => {
    const features = [
      makeFeature({ tags: { building: 'yes', height: '10' } }),
      makeFeature({ tags: { building: 'yes', 'building:levels': '5' } }),
      makeFeature({ geometry: [{ lat: 1, lon: 1 }] }), // invalid - too few points
      makeFeature({ tags: { building: 'yes' } }),
    ];
    const result = extractBuildings(features, 9);
    expect(result).toHaveLength(3);
    expect(result[0].height).toBe(10);
    expect(result[1].height).toBe(15);
    expect(result[2].height).toBe(9);
  });
});

// ─── Road Width Estimation Tests ───────────────────────────────

describe('estimateRoadWidth', () => {
  it('uses explicit width tag when valid', () => {
    expect(estimateRoadWidth({ highway: 'residential', width: '7.5' })).toBe(7.5);
  });

  it('accepts boundary width value 0.5', () => {
    expect(estimateRoadWidth({ highway: 'path', width: '0.5' })).toBe(0.5);
  });

  it('accepts boundary width value 50', () => {
    expect(estimateRoadWidth({ highway: 'motorway', width: '50' })).toBe(50);
  });

  it('falls back to lanes when width is non-numeric', () => {
    expect(estimateRoadWidth({ highway: 'residential', width: 'narrow', lanes: '2' })).toBe(7); // 2 * 3.5
  });

  it('falls back to lanes when width is below 0.5', () => {
    expect(estimateRoadWidth({ highway: 'residential', width: '0.3', lanes: '3' })).toBe(10.5); // 3 * 3.5
  });

  it('falls back to lanes when width is above 50', () => {
    expect(estimateRoadWidth({ highway: 'motorway', width: '55', lanes: '4' })).toBe(14); // 4 * 3.5
  });

  it('uses lanes-based estimation when no width tag', () => {
    expect(estimateRoadWidth({ highway: 'primary', lanes: '3' })).toBe(10.5); // 3 * 3.5
  });

  it('falls back to classification when lanes is not a positive integer (0)', () => {
    expect(estimateRoadWidth({ highway: 'primary', lanes: '0' })).toBe(8);
  });

  it('falls back to classification when lanes is negative', () => {
    expect(estimateRoadWidth({ highway: 'secondary', lanes: '-2' })).toBe(7);
  });

  it('falls back to classification when lanes is not an integer', () => {
    expect(estimateRoadWidth({ highway: 'tertiary', lanes: '2.5' })).toBe(6);
  });

  it('falls back to classification when lanes is non-numeric', () => {
    expect(estimateRoadWidth({ highway: 'residential', lanes: 'two' })).toBe(5);
  });

  it('uses classification lookup for motorway', () => {
    expect(estimateRoadWidth({ highway: 'motorway' })).toBe(12);
  });

  it('uses classification lookup for trunk', () => {
    expect(estimateRoadWidth({ highway: 'trunk' })).toBe(10);
  });

  it('uses classification lookup for primary', () => {
    expect(estimateRoadWidth({ highway: 'primary' })).toBe(8);
  });

  it('uses classification lookup for secondary', () => {
    expect(estimateRoadWidth({ highway: 'secondary' })).toBe(7);
  });

  it('uses classification lookup for tertiary', () => {
    expect(estimateRoadWidth({ highway: 'tertiary' })).toBe(6);
  });

  it('uses classification lookup for residential', () => {
    expect(estimateRoadWidth({ highway: 'residential' })).toBe(5);
  });

  it('uses classification lookup for service', () => {
    expect(estimateRoadWidth({ highway: 'service' })).toBe(3.5);
  });

  it('uses classification lookup for footway', () => {
    expect(estimateRoadWidth({ highway: 'footway' })).toBe(2);
  });

  it('uses classification lookup for path', () => {
    expect(estimateRoadWidth({ highway: 'path' })).toBe(2);
  });

  it('uses classification lookup for cycleway', () => {
    expect(estimateRoadWidth({ highway: 'cycleway' })).toBe(2);
  });

  it('uses default width (4) for unknown highway types', () => {
    expect(estimateRoadWidth({ highway: 'track' })).toBe(4);
  });

  it('uses default width (4) when no highway tag', () => {
    expect(estimateRoadWidth({})).toBe(4);
  });
});

// ─── extractRoads Tests ────────────────────────────────────────

function makeRoadFeature(opts: {
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}): OverpassFeature {
  return {
    type: 'way',
    id: 100,
    geometry: opts.geometry ?? [
      { lat: 48.0, lon: 2.0 },
      { lat: 48.001, lon: 2.001 },
    ],
    tags: opts.tags ?? { highway: 'residential' },
  };
}

describe('extractRoads', () => {
  it('extracts a valid road with default classification width', () => {
    const features = [makeRoadFeature({})];
    const result = extractRoads(features);
    expect(result).toHaveLength(1);
    expect(result[0].width).toBe(5); // residential
    expect(result[0].highway).toBe('residential');
    expect(result[0].surface).toBe('');
    expect(result[0].centerline).toHaveLength(2);
  });

  it('filters out roads with fewer than 2 coordinate points', () => {
    const features = [
      makeRoadFeature({ geometry: [{ lat: 1, lon: 1 }] }),
    ];
    const result = extractRoads(features);
    expect(result).toHaveLength(0);
  });

  it('filters out roads with empty geometry', () => {
    const features = [makeRoadFeature({ geometry: [] })];
    const result = extractRoads(features);
    expect(result).toHaveLength(0);
  });

  it('accepts roads with exactly 2 coordinate points', () => {
    const features = [makeRoadFeature({
      geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }],
    })];
    const result = extractRoads(features);
    expect(result).toHaveLength(1);
  });

  it('extracts surface tag when present', () => {
    const features = [makeRoadFeature({ tags: { highway: 'primary', surface: 'asphalt' } })];
    const result = extractRoads(features);
    expect(result[0].surface).toBe('asphalt');
  });

  it('uses empty string for surface when tag is absent', () => {
    const features = [makeRoadFeature({ tags: { highway: 'primary' } })];
    const result = extractRoads(features);
    expect(result[0].surface).toBe('');
  });

  it('extracts highway classification tag', () => {
    const features = [makeRoadFeature({ tags: { highway: 'motorway' } })];
    const result = extractRoads(features);
    expect(result[0].highway).toBe('motorway');
  });

  it('uses explicit width tag over classification', () => {
    const features = [makeRoadFeature({ tags: { highway: 'residential', width: '8' } })];
    const result = extractRoads(features);
    expect(result[0].width).toBe(8);
  });

  it('uses lanes-based width over classification', () => {
    const features = [makeRoadFeature({ tags: { highway: 'residential', lanes: '4' } })];
    const result = extractRoads(features);
    expect(result[0].width).toBe(14); // 4 * 3.5
  });

  it('preserves coordinate order in centerline', () => {
    const geometry = [
      { lat: 1.0, lon: 10.0 },
      { lat: 2.0, lon: 20.0 },
      { lat: 3.0, lon: 30.0 },
    ];
    const features = [makeRoadFeature({ geometry })];
    const result = extractRoads(features);
    expect(result[0].centerline).toEqual(geometry);
  });

  it('preserves all tags in the output', () => {
    const tags = { highway: 'secondary', name: 'Main Street', surface: 'concrete', lanes: '2' };
    const features = [makeRoadFeature({ tags })];
    const result = extractRoads(features);
    expect(result[0].tags).toEqual(tags);
  });

  it('processes multiple features correctly', () => {
    const features = [
      makeRoadFeature({ tags: { highway: 'motorway', width: '15' } }),
      makeRoadFeature({ tags: { highway: 'footway' } }),
      makeRoadFeature({ geometry: [{ lat: 1, lon: 1 }] }), // invalid - too few points
      makeRoadFeature({ tags: { highway: 'primary', lanes: '3' } }),
    ];
    const result = extractRoads(features);
    expect(result).toHaveLength(3);
    expect(result[0].width).toBe(15);
    expect(result[1].width).toBe(2);
    expect(result[2].width).toBe(10.5); // 3 * 3.5
  });

  it('handles road with no highway tag', () => {
    const features = [makeRoadFeature({ tags: {} })];
    const result = extractRoads(features);
    expect(result).toHaveLength(1);
    expect(result[0].highway).toBe('');
    expect(result[0].width).toBe(4); // default for unknown
  });
});
