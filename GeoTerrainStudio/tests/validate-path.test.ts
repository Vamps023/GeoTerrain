/**
 * Unit tests for validatePath utility (Bug 5.1 fix)
 *
 * Tests the path validation logic that prevents arbitrary file reads via IPC.
 * Since validatePath is defined in electron/main.ts (which requires Electron APIs),
 * we replicate the exact same logic here for isolated testing.
 *
 * Validates: Requirements 2.21
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';

/**
 * Exact replica of the validatePath function from electron/main.ts
 * for unit testing purposes.
 */
function validatePath(requestedPath: string, allowedBasePaths: string[]): boolean {
  // Reject paths containing null bytes (poison null byte attack)
  if (requestedPath.includes('\0')) {
    return false;
  }

  // Resolve and normalize the requested path
  const resolved = path.resolve(requestedPath);

  for (const basePath of allowedBasePaths) {
    if (!basePath) continue;

    // Resolve and normalize the base path, ensure trailing separator
    const resolvedBase = path.resolve(basePath) + path.sep;

    if (process.platform === 'win32') {
      // Case-insensitive comparison on Windows
      if (resolved.toLowerCase().startsWith(resolvedBase.toLowerCase()) ||
          resolved.toLowerCase() === resolvedBase.slice(0, -1).toLowerCase()) {
        return true;
      }
    } else {
      if (resolved.startsWith(resolvedBase) || resolved === resolvedBase.slice(0, -1)) {
        return true;
      }
    }
  }

  return false;
}

describe('validatePath - IPC path validation (Bug 5.1 fix)', () => {
  const allowedDirs = process.platform === 'win32'
    ? ['C:\\Users\\TestUser\\GeoTerrain\\output', 'C:\\Users\\TestUser\\AppData\\Roaming\\geoterrain-studio']
    : ['/home/testuser/GeoTerrain/output', '/home/testuser/.config/geoterrain-studio'];

  describe('rejects paths outside allowed directories', () => {
    it('should reject system file paths', () => {
      const dangerousPath = process.platform === 'win32'
        ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
        : '/etc/passwd';
      expect(validatePath(dangerousPath, allowedDirs)).toBe(false);
    });

    it('should reject SSH key paths', () => {
      const sshPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\.ssh\\id_rsa'
        : '/home/testuser/.ssh/id_rsa';
      expect(validatePath(sshPath, allowedDirs)).toBe(false);
    });

    it('should reject root paths', () => {
      const rootPath = process.platform === 'win32' ? 'C:\\' : '/';
      expect(validatePath(rootPath, allowedDirs)).toBe(false);
    });
  });

  describe('rejects path traversal attacks', () => {
    it('should reject ../ traversal that escapes allowed directory', () => {
      const traversalPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output\\..\\..\\..\\Windows\\System32\\config\\SAM'
        : '/home/testuser/GeoTerrain/output/../../../etc/shadow';
      expect(validatePath(traversalPath, allowedDirs)).toBe(false);
    });

    it('should reject relative path traversal', () => {
      const traversalPath = '../../etc/passwd';
      // This resolves relative to CWD, which is unlikely to be within allowed dirs
      // unless CWD happens to be inside an allowed dir
      const resolved = path.resolve(traversalPath);
      const isInAllowed = allowedDirs.some(base =>
        resolved.startsWith(path.resolve(base) + path.sep) || resolved === path.resolve(base)
      );
      expect(validatePath(traversalPath, allowedDirs)).toBe(isInAllowed);
    });
  });

  describe('rejects null byte attacks', () => {
    it('should reject paths containing null bytes', () => {
      const nullBytePath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output\\file.png\0.exe'
        : '/home/testuser/GeoTerrain/output/file.png\0.exe';
      expect(validatePath(nullBytePath, allowedDirs)).toBe(false);
    });

    it('should reject paths with embedded null bytes', () => {
      const nullBytePath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output\\\0\\..\\..\\etc\\passwd'
        : '/home/testuser/GeoTerrain/output/\0/../../../etc/passwd';
      expect(validatePath(nullBytePath, allowedDirs)).toBe(false);
    });
  });

  describe('accepts valid paths within allowed directories', () => {
    it('should accept files directly in allowed directory', () => {
      const validPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output\\manifest.json'
        : '/home/testuser/GeoTerrain/output/manifest.json';
      expect(validatePath(validPath, allowedDirs)).toBe(true);
    });

    it('should accept files in subdirectories of allowed directory', () => {
      const validPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output\\tile_0_0\\tile_0_0_heightmap.png'
        : '/home/testuser/GeoTerrain/output/tile_0_0/tile_0_0_heightmap.png';
      expect(validatePath(validPath, allowedDirs)).toBe(true);
    });

    it('should accept the allowed directory itself', () => {
      const validPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output'
        : '/home/testuser/GeoTerrain/output';
      expect(validatePath(validPath, allowedDirs)).toBe(true);
    });

    it('should accept paths in userData directory', () => {
      const validPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\AppData\\Roaming\\geoterrain-studio\\settings.json'
        : '/home/testuser/.config/geoterrain-studio/settings.json';
      expect(validatePath(validPath, allowedDirs)).toBe(true);
    });
  });

  describe('handles edge cases', () => {
    it('should handle empty allowed paths list', () => {
      const anyPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\file.txt'
        : '/home/testuser/file.txt';
      expect(validatePath(anyPath, [])).toBe(false);
    });

    it('should handle null/empty entries in allowed paths', () => {
      const validPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output\\file.png'
        : '/home/testuser/GeoTerrain/output/file.png';
      const mixedAllowed = ['', ...allowedDirs];
      expect(validatePath(validPath, mixedAllowed)).toBe(true);
    });

    if (process.platform === 'win32') {
      it('should handle case-insensitive paths on Windows', () => {
        const upperPath = 'C:\\USERS\\TESTUSER\\GEOTERRAIN\\OUTPUT\\file.png';
        expect(validatePath(upperPath, allowedDirs)).toBe(true);
      });

      it('should handle mixed case on Windows', () => {
        const mixedPath = 'c:\\users\\TestUser\\GeoTerrain\\Output\\tile_0_0\\heightmap.tif';
        expect(validatePath(mixedPath, allowedDirs)).toBe(true);
      });
    }

    it('should handle paths with trailing separators', () => {
      const trailingPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output\\'
        : '/home/testuser/GeoTerrain/output/';
      expect(validatePath(trailingPath, allowedDirs)).toBe(true);
    });

    it('should reject paths that are prefixes but not subdirectories', () => {
      // e.g., "output-evil" should not match "output"
      const trickPath = process.platform === 'win32'
        ? 'C:\\Users\\TestUser\\GeoTerrain\\output-evil\\secret.txt'
        : '/home/testuser/GeoTerrain/output-evil/secret.txt';
      expect(validatePath(trickPath, allowedDirs)).toBe(false);
    });
  });
});
