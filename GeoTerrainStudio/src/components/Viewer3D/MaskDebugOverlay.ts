/**
 * Mask Debug Overlay - Visualizes heightmap, vegetation mask, albedo,
 * and water mask directly on the 3D terrain mesh.
 *
 * Provides a cycling debug mode that swaps the terrain material texture
 * to show each layer individually, helping diagnose alignment issues.
 *
 * Usage: Call `cycleDebugOverlay(mesh, scene, tileFiles, pkgPath)` to
 * cycle through: Albedo → Vegetation Mask → Water Mask → Heightmap → Albedo
 */

import {
  Mesh,
  Scene,
  StandardMaterial,
  Texture,
  Color3,
  RawTexture,
} from '@babylonjs/core';
import { fromArrayBuffer } from 'geotiff';
import { FsAPI } from '../../core/ipc';
import { parseMask } from './MaskSampler';

export type DebugOverlayMode = 'albedo' | 'vegetation' | 'water' | 'heightmap';

const DEBUG_MODES: DebugOverlayMode[] = ['albedo', 'vegetation', 'water', 'heightmap'];

/** Tracks the current debug mode per mesh */
const meshDebugState = new Map<string, number>();

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Detect heightmap format from file extension.
 */
function getHeightmapFormat(filePath: string): 'png' | 'tif' | 'r16' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'tif';
  if (lower.endsWith('.r16')) return 'r16';
  return 'png';
}

/**
 * Parse a GeoTIFF heightmap buffer into normalized 0-255 grayscale RGBA.
 */
async function parseGeoTiffToRGBA(buffer: ArrayBuffer): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters();
  const band = rasters[0] as Float32Array | Float64Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

  // Find min/max for normalization
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    if (isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!isFinite(min) || !isFinite(max) || min === max) {
    min = 0;
    max = 1;
  }

  const range = max - min;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    const normalized = isFinite(v) ? ((v - min) / range) * 255 : 0;
    const val = Math.round(Math.max(0, Math.min(255, normalized)));
    rgba[i * 4 + 0] = val;
    rgba[i * 4 + 1] = val;
    rgba[i * 4 + 2] = val;
    rgba[i * 4 + 3] = 255;
  }

  return { rgba, width, height };
}

/**
 * Parse a raw R16 heightmap buffer into normalized 0-255 grayscale RGBA.
 */
function parseR16ToRGBA(buffer: ArrayBuffer): { rgba: Uint8Array; width: number; height: number } {
  const uint16 = new Uint16Array(buffer);
  const pixelCount = uint16.length;
  const side = Math.round(Math.sqrt(pixelCount));
  const width = side;
  const height = side;

  let min = 65535;
  let max = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (uint16[i] < min) min = uint16[i];
    if (uint16[i] > max) max = uint16[i];
  }
  if (min === max) { min = 0; max = 1; }

  const range = max - min;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < Math.min(pixelCount, width * height); i++) {
    const val = Math.round(((uint16[i] - min) / range) * 255);
    rgba[i * 4 + 0] = val;
    rgba[i * 4 + 1] = val;
    rgba[i * 4 + 2] = val;
    rgba[i * 4 + 3] = 255;
  }

  return { rgba, width, height };
}

/**
 * Apply a RawTexture to the mesh material with proper V-flip and emissive settings.
 */
function applyRawTexture(
  mat: StandardMaterial,
  rgba: Uint8Array,
  width: number,
  height: number,
  scene: Scene,
  vScale: number = -1,
  vOffset: number = 1
): void {
  const tex = RawTexture.CreateRGBATexture(rgba, width, height, scene, false, false);
  tex.vScale = vScale;
  tex.vOffset = vOffset;
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.emissiveColor = Color3.White();
  mat.specularColor = Color3.Black();
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Cycles the debug overlay mode for a terrain mesh.
 * Each call advances to the next visualization mode.
 *
 * @param mesh - The terrain mesh to apply the overlay to
 * @param scene - Babylon.js scene
 * @param tileFiles - Tile file paths from manifest
 * @param pkgPath - Package base path
 * @returns The new active debug mode name
 */
export async function cycleDebugOverlay(
  mesh: Mesh,
  scene: Scene,
  tileFiles: {
    heightmap?: string;
    albedo?: string;
    vegetationMask?: string;
    waterMask?: string;
  },
  pkgPath: string,
  isFlippedY: boolean = false
): Promise<string> {
  const meshName = mesh.name;
  const currentIdx = meshDebugState.get(meshName) ?? 0;
  const nextIdx = (currentIdx + 1) % DEBUG_MODES.length;
  meshDebugState.set(meshName, nextIdx);

  const mode = DEBUG_MODES[nextIdx];
  const basePath = pkgPath.replace(/\\/g, '/');

  const mat = mesh.material as StandardMaterial;
  if (!mat) return mode;

  // Clear emissive texture when switching modes
  mat.emissiveTexture = null;
  mat.emissiveColor = Color3.Black();

  // Determine V-flip for textures:
  // Default mesh has scaling.z = -1, so textures need vScale = -1 to compensate.
  // When user clicks "Flip Y", scaling.z = 1, so textures should NOT be flipped.
  const vScale = isFlippedY ? 1 : -1;
  const vOffset = isFlippedY ? 0 : 1;

  switch (mode) {
    case 'albedo': {
      if (tileFiles.albedo) {
        const filePath = `${basePath}/${tileFiles.albedo}`;
        const buffer = await FsAPI.readFileBinary(filePath);
        const blob = new Blob([buffer], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const tex = new Texture(url, scene);
        tex.vScale = vScale;
        tex.vOffset = vOffset;
        mat.diffuseTexture = tex;
        mat.emissiveColor = Color3.Black();
        mat.specularColor = Color3.Black();
      }
      break;
    }

    case 'vegetation': {
      if (tileFiles.vegetationMask) {
        const filePath = `${basePath}/${tileFiles.vegetationMask}`;
        const buffer = await FsAPI.readFileBinary(filePath);
        const maskData = await parseMask(buffer);
        // Convert grayscale mask to green-channel RGBA for visualization
        const rgba = new Uint8Array(maskData.width * maskData.height * 4);
        for (let i = 0; i < maskData.pixels.length; i++) {
          const val = maskData.pixels[i];
          rgba[i * 4 + 0] = 0;           // R
          rgba[i * 4 + 1] = val;          // G (vegetation intensity)
          rgba[i * 4 + 2] = 0;           // B
          rgba[i * 4 + 3] = 255;         // A
        }
        applyRawTexture(mat, rgba, maskData.width, maskData.height, scene, vScale, vOffset);
      } else {
        console.warn('[MaskDebug] No vegetation mask available for this tile');
      }
      break;
    }

    case 'water': {
      if (tileFiles.waterMask) {
        const filePath = `${basePath}/${tileFiles.waterMask}`;
        const buffer = await FsAPI.readFileBinary(filePath);
        const maskData = await parseMask(buffer);
        // Convert grayscale mask to blue-channel RGBA for visualization
        const rgba = new Uint8Array(maskData.width * maskData.height * 4);
        for (let i = 0; i < maskData.pixels.length; i++) {
          const val = maskData.pixels[i];
          rgba[i * 4 + 0] = 0;           // R
          rgba[i * 4 + 1] = 0;           // G
          rgba[i * 4 + 2] = val;          // B (water intensity)
          rgba[i * 4 + 3] = 255;         // A
        }
        applyRawTexture(mat, rgba, maskData.width, maskData.height, scene, vScale, vOffset);
      } else {
        console.warn('[MaskDebug] No water mask available for this tile');
      }
      break;
    }

    case 'heightmap': {
      if (tileFiles.heightmap) {
        const filePath = `${basePath}/${tileFiles.heightmap}`;
        const buffer = await FsAPI.readFileBinary(filePath);
        const format = getHeightmapFormat(tileFiles.heightmap);

        let rgba: Uint8Array;
        let width: number;
        let height: number;

        if (format === 'tif') {
          const result = await parseGeoTiffToRGBA(buffer);
          rgba = result.rgba;
          width = result.width;
          height = result.height;
        } else if (format === 'r16') {
          const result = parseR16ToRGBA(buffer);
          rgba = result.rgba;
          width = result.width;
          height = result.height;
        } else {
          // PNG — use Blob URL approach
          const blob = new Blob([buffer], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          const tex = new Texture(url, scene);
          tex.vScale = vScale;
          tex.vOffset = vOffset;
          mat.diffuseTexture = tex;
          mat.emissiveTexture = tex;
          mat.emissiveColor = Color3.White();
          mat.specularColor = Color3.Black();
          return mode;
        }

        // Apply as RawTexture for GeoTIFF and R16 formats
        applyRawTexture(mat, rgba, width, height, scene, vScale, vOffset);
      } else {
        console.warn('[MaskDebug] No heightmap available for this tile');
      }
      break;
    }
  }

  console.log(`[MaskDebug] Mode: ${mode} applied to ${meshName}`);
  return mode;
}

/**
 * Resets the debug overlay state for a mesh back to albedo.
 */
export function resetDebugOverlay(meshName: string): void {
  meshDebugState.delete(meshName);
}

/**
 * Gets the current debug mode for a mesh.
 */
export function getDebugMode(meshName: string): DebugOverlayMode {
  const idx = meshDebugState.get(meshName) ?? 0;
  return DEBUG_MODES[idx];
}
