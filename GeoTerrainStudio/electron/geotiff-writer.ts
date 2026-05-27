/**
 * GeoTIFF Writer with Float32, Int16, UInt16 support
 *
 * Writes TIFF files with proper GeoTIFF tags.
 * Supports compression: none, Deflate (zlib)
 *
 * Byte order: little-endian ("II")
 * Layout: single IFD, single image strip
 */

import * as zlib from 'zlib';

interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type GeoTIFFCompression = 'none' | 'deflate';
export type GeoTIFFRasterType = 'area' | 'point';

interface GeoTIFFOptions {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  sampleFormat: 1 | 2 | 3; // 1=unsigned int, 2=signed int, 3=IEEE float
  samplesPerPixel: 1 | 3;
  photometricInterpretation: 1 | 2; // 1=black-is-zero, 2=RGB
  bounds: GeoBounds;
  compression?: GeoTIFFCompression;
  // PixelIsPoint = elevation sample AT pixel corners (use for heightmaps to avoid tile seams)
  // PixelIsArea = pixel covers an area (use for imagery)
  rasterType?: GeoTIFFRasterType;
}

// ─── TIFF Constants ───────────────────────────────────────────

const TIFF_MAGIC = 42;
const BYTE_ORDER_LE = 0x4949; // "II"

// TIFF Types
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_DOUBLE = 12;

// TIFF Tags
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_PLANAR_CONFIG = 284;
const TAG_SAMPLE_FORMAT = 339;

// GeoTIFF Tags
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_MODEL_TIEPOINT = 33922;
const TAG_GEO_KEY_DIRECTORY = 34735;
const TAG_GEO_DOUBLE_PARAMS = 34736;
const TAG_GEO_ASCII_PARAMS = 34737;

// ─── Helper: Build IFD Entry ──────────────────────────────────

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  values: number[];
  asciiData?: Buffer; // For ASCII type entries
}

function createIfdEntry(tag: number, type: number, values: number[], asciiData?: Buffer, countOverride?: number): IfdEntry {
  return { tag, type, count: countOverride ?? values.length, values, asciiData };
}

function valueSizeBytes(type: number): number {
  switch (type) {
    case 1:
    case 2:
      return 1;
    case 3:
      return 2;
    case 4:
    case 11:
      return 4;
    case 5:
    case 12:
      return 8;
    default:
      return 1;
  }
}

function fitsInline(entry: IfdEntry): boolean {
  return entry.count * valueSizeBytes(entry.type) <= 4;
}

// ─── Main Writer ──────────────────────────────────────────────

export function writeGeoTIFF(
  pixelData: Buffer | Int16Array | Uint16Array | Float32Array,
  options: GeoTIFFOptions
): Buffer {
  const {
    width,
    height,
    bitsPerSample,
    sampleFormat,
    samplesPerPixel,
    photometricInterpretation,
    bounds,
    compression = 'none',
    rasterType = 'area',
  } = options;

  const bytesPerSample = bitsPerSample / 8;
  const stripByteCount = width * height * samplesPerPixel * bytesPerSample;
  // For PixelIsPoint, sample positions are at pixel corners, so divisor is (size - 1)
  // For PixelIsArea, sample positions are at pixel centers, so divisor is size
  const isPoint = rasterType === 'point';
  const pixelWidth = (bounds.east - bounds.west) / (isPoint ? (width - 1) : width);
  const pixelHeight = (bounds.south - bounds.north) / (isPoint ? (height - 1) : height); // negative for north-up

  // ── Build IFD entries ─────────────────────────────────────
  const entries: IfdEntry[] = [];

  entries.push(createIfdEntry(TAG_IMAGE_WIDTH, TYPE_LONG, [width]));
  entries.push(createIfdEntry(TAG_IMAGE_LENGTH, TYPE_LONG, [height]));
  entries.push(createIfdEntry(TAG_BITS_PER_SAMPLE, TYPE_SHORT, [bitsPerSample]));
  // Compression: 1=uncompressed, 32946=Deflate (Adobe)
  const compressionCode = compression === 'deflate' ? 32946 : 1;
  entries.push(createIfdEntry(TAG_COMPRESSION, TYPE_SHORT, [compressionCode]));
  entries.push(
    createIfdEntry(TAG_PHOTOMETRIC, TYPE_SHORT, [photometricInterpretation])
  );
  // StripOffsets placeholder — will be patched later
  entries.push(createIfdEntry(TAG_STRIP_OFFSETS, TYPE_LONG, [0]));
  entries.push(createIfdEntry(TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, [samplesPerPixel]));
  entries.push(createIfdEntry(TAG_ROWS_PER_STRIP, TYPE_LONG, [height]));
  // StripByteCounts placeholder
  entries.push(createIfdEntry(TAG_STRIP_BYTE_COUNTS, TYPE_LONG, [stripByteCount]));
  entries.push(createIfdEntry(TAG_PLANAR_CONFIG, TYPE_SHORT, [1])); // chunky
  entries.push(createIfdEntry(TAG_SAMPLE_FORMAT, TYPE_SHORT, [sampleFormat]));

  // GeoTIFF tags
  entries.push(
    createIfdEntry(TAG_MODEL_PIXEL_SCALE, TYPE_DOUBLE, [pixelWidth, pixelHeight, 0])
  );
  entries.push(
    createIfdEntry(TAG_MODEL_TIEPOINT, TYPE_DOUBLE, [
      0, 0, 0, bounds.west, bounds.north, 0,
    ])
  );

  // GeoKeyDirectoryTag — complete EPSG:4326 (WGS 84)
  // Format: [Version(1), Revision(1), Minor(0), NumberOfKeys(N)] header
  // Followed by N entries of [KeyID, TIFFTagLocation, Count, Value]
  // TIFFTagLocation: 0 = inline value, 34736 = GeoDoubleParams, 34737 = GeoAsciiParams
  // GTRasterTypeGeoKey: 1=PixelIsArea (imagery), 2=PixelIsPoint (heightmaps - prevents tile seams)
  const rasterTypeCode = isPoint ? 2 : 1;
  const numGeoKeys = 7;
  const geoKeys = [
    1, 1, 0, numGeoKeys,         // Header: Version=1, Revision=1, Minor=0, NumberOfKeys=7
    1024, 0, 1, 2,                // GTModelTypeGeoKey = Geographic (2)
    1025, 0, 1, rasterTypeCode,   // GTRasterTypeGeoKey = PixelIsArea(1) or PixelIsPoint(2)
    2048, 0, 1, 4326,             // GeographicTypeGeoKey = WGS84 (4326)
    2049, 34737, 7, 0,            // GeogCitationGeoKey -> "WGS 84\0" at offset 0 in ASCII params
    2054, 0, 1, 9102,             // GeogAngularUnitsGeoKey = Degree (9102)
    2057, 34736, 1, 0,            // GeogSemiMajorAxisGeoKey -> index 0 in double params
    2059, 34736, 1, 1,            // GeogInvFlatteningGeoKey -> index 1 in double params
  ];
  entries.push(createIfdEntry(TAG_GEO_KEY_DIRECTORY, TYPE_SHORT, geoKeys));

  // GeoDoubleParamsTag — WGS84 ellipsoid parameters
  // Index 0: Semi-major axis = 6378137.0 meters
  // Index 1: Inverse flattening = 298.257223563
  entries.push(createIfdEntry(TAG_GEO_DOUBLE_PARAMS, TYPE_DOUBLE, [6378137.0, 298.257223563]));

  // GeoAsciiParamsTag — citation string (must be null-terminated and padded to even length)
  const asciiParamsRaw = Buffer.from("WGS 84\0", "ascii");
  // Pad to even length as required by TIFF spec
  const asciiParams = asciiParamsRaw.length % 2 === 0
    ? asciiParamsRaw
    : Buffer.concat([asciiParamsRaw, Buffer.from([0])]);
  // For ASCII type, count = number of bytes including null terminator
  entries.push(createIfdEntry(TAG_GEO_ASCII_PARAMS, TYPE_ASCII, [asciiParams.length], asciiParams, asciiParams.length));

  // Sort entries by tag ID (TIFF requirement)
  entries.sort((a, b) => a.tag - b.tag);

  // ── Calculate layout ──────────────────────────────────────
  const headerSize = 8;
  const ifdSize = 2 + entries.length * 12 + 4; // count + entries + nextIFD
  let currentOffset = headerSize + ifdSize;

  // Determine inline vs external, calculate external blob offsets
  const inlineValues = new Map<number, number>();
  const externalBlobs: { entryIndex: number; offset: number; data: Buffer }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (fitsInline(entry)) {
      // Pack value into 4-byte inline field
      const buf = Buffer.allocUnsafe(4);
      buf.fill(0);
      switch (entry.type) {
        case TYPE_SHORT:
          for (let j = 0; j < entry.count && j < 2; j++) {
            buf.writeUInt16LE(entry.values[j], j * 2);
          }
          break;
        case TYPE_LONG:
          buf.writeUInt32LE(entry.values[0], 0);
          break;
        case TYPE_ASCII:
          // ASCII inline (4 bytes or less)
          if (entry.asciiData) {
            entry.asciiData.copy(buf, 0, 0, Math.min(entry.asciiData.length, 4));
          }
          break;
      }
      inlineValues.set(i, buf.readUInt32LE(0));
    } else {
      // External blob
      const valueBytes = entry.count * valueSizeBytes(entry.type);
      const blobBuf = Buffer.allocUnsafe(valueBytes);
      blobBuf.fill(0);

      switch (entry.type) {
        case TYPE_SHORT:
          for (let j = 0; j < entry.count; j++) {
            blobBuf.writeUInt16LE(entry.values[j], j * 2);
          }
          break;
        case TYPE_LONG:
          for (let j = 0; j < entry.count; j++) {
            blobBuf.writeUInt32LE(entry.values[j], j * 4);
          }
          break;
        case TYPE_DOUBLE:
          for (let j = 0; j < entry.count; j++) {
            blobBuf.writeDoubleLE(entry.values[j], j * 8);
          }
          break;
        case TYPE_ASCII:
          if (entry.asciiData) {
            entry.asciiData.copy(blobBuf, 0, 0, entry.asciiData.length);
          }
          break;
      }

      externalBlobs.push({ entryIndex: i, offset: currentOffset, data: blobBuf });
      inlineValues.set(i, currentOffset);
      currentOffset += valueBytes;

      // Align to 2-byte boundary
      if (currentOffset % 2 !== 0) currentOffset++;
    }
  }

  // Pixel data offset
  const stripOffset = currentOffset;
  // Update StripOffsets entry
  const stripOffsetsEntryIdx = entries.findIndex((e) => e.tag === TAG_STRIP_OFFSETS);
  if (stripOffsetsEntryIdx >= 0) {
    inlineValues.set(stripOffsetsEntryIdx, stripOffset);
  }

  // ── Serialize pixel data to raw buffer ────────────────────
  const rawPixelBuf = Buffer.allocUnsafe(stripByteCount);
  if (pixelData instanceof Int16Array) {
    Buffer.from(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength).copy(rawPixelBuf);
  } else if (pixelData instanceof Uint16Array) {
    Buffer.from(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength).copy(rawPixelBuf);
  } else if (pixelData instanceof Float32Array) {
    Buffer.from(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength).copy(rawPixelBuf);
  } else {
    pixelData.copy(rawPixelBuf);
  }

  // ── Apply compression if requested ────────────────────────
  const stripData = compression === 'deflate'
    ? zlib.deflateSync(rawPixelBuf)
    : rawPixelBuf;
  const actualStripByteCount = stripData.length;

  // Update StripByteCounts entry with actual (possibly compressed) size
  const stripByteCountsEntryIdx = entries.findIndex((e) => e.tag === TAG_STRIP_BYTE_COUNTS);
  if (stripByteCountsEntryIdx >= 0) {
    inlineValues.set(stripByteCountsEntryIdx, actualStripByteCount);
  }

  // Total file size
  const totalSize = stripOffset + actualStripByteCount;

  // ── Assemble file ─────────────────────────────────────────
  const file = Buffer.allocUnsafe(totalSize);
  file.fill(0);

  // Header
  file.writeUInt16LE(BYTE_ORDER_LE, 0);
  file.writeUInt16LE(TIFF_MAGIC, 2);
  file.writeUInt32LE(headerSize, 4); // IFD offset

  // IFD
  let pos = headerSize;
  file.writeUInt16LE(entries.length, pos);
  pos += 2;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    file.writeUInt16LE(entry.tag, pos);
    file.writeUInt16LE(entry.type, pos + 2);
    file.writeUInt32LE(entry.count, pos + 4);
    file.writeUInt32LE(inlineValues.get(i) ?? 0, pos + 8);
    pos += 12;
  }

  // Next IFD offset (0 = none)
  file.writeUInt32LE(0, pos);
  pos += 4;

  // External blobs
  for (const blob of externalBlobs) {
    blob.data.copy(file, blob.offset);
  }

  // Write (possibly compressed) pixel data
  stripData.copy(file, stripOffset);

  return file;
}
