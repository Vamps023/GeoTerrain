/**
 * Geocoding service for location search using Nominatim (OpenStreetMap).
 * Runs entirely in the renderer process using the browser Fetch API.
 */

export interface GeocodingResult {
  displayName: string;
  latitude: number;
  longitude: number;
  type: string;
  boundingBox: [number, number, number, number]; // [south, north, west, east]
}

export interface NominatimRawResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type: string;
  class: string;
  boundingbox: [string, string, string, string];
  address?: {
    city?: string;
    town?: string;
    village?: string;
    country?: string;
    state?: string;
  };
}

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'GeoTerrainStudio/2.0';
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Builds the Nominatim search URL with required parameters.
 * Includes format=json, limit=5, addressdetails=1, and URL-encoded q parameter.
 */
export function buildNominatimUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: '5',
    addressdetails: '1',
  });
  return `${NOMINATIM_BASE_URL}?${params.toString()}`;
}

/**
 * Parses a raw Nominatim JSON response into structured GeocodingResult objects.
 * Converts string lat/lon to numbers and maps boundingbox strings to a numeric tuple.
 */
export function parseNominatimResponse(rawResults: NominatimRawResult[]): GeocodingResult[] {
  return rawResults.map((raw) => ({
    displayName: raw.display_name,
    latitude: parseFloat(raw.lat),
    longitude: parseFloat(raw.lon),
    type: raw.type,
    boundingBox: [
      parseFloat(raw.boundingbox[0]),
      parseFloat(raw.boundingbox[1]),
      parseFloat(raw.boundingbox[2]),
      parseFloat(raw.boundingbox[3]),
    ] as [number, number, number, number],
  }));
}

/**
 * Determines the appropriate zoom level for a place type.
 * Returns 12 for city, 14 for town, 16 for village/address/landmark,
 * and 14 as default. Always clamped to [2, 18].
 */
export function getZoomForPlaceType(type: string): number {
  let zoom: number;

  switch (type) {
    case 'city':
      zoom = 12;
      break;
    case 'town':
      zoom = 14;
      break;
    case 'village':
    case 'address':
    case 'landmark':
      zoom = 16;
      break;
    default:
      zoom = 14;
      break;
  }

  return Math.max(2, Math.min(18, zoom));
}

/**
 * Determines whether a search query should trigger a geocoding request.
 * Returns true if the trimmed input has 3 or more characters.
 */
export function shouldTriggerSearch(query: string): boolean {
  return query.trim().length >= 3;
}

/**
 * Queries Nominatim and returns parsed results.
 * Uses a 5-second timeout via AbortController and sends the required User-Agent header.
 */
export async function searchLocations(query: string): Promise<GeocodingResult[]> {
  const url = buildNominatimUrl(query);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      return [];
    }

    const rawResults: NominatimRawResult[] = await response.json();
    return parseNominatimResponse(rawResults);
  } catch {
    // Network errors, timeouts, or JSON parse errors — return empty results silently
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}
