import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Search } from 'lucide-react';
import maplibregl from 'maplibre-gl';
import {
  searchLocations,
  getZoomForPlaceType,
  shouldTriggerSearch,
} from '@core/geocoding-service';
import type { GeocodingResult } from '@core/geocoding-service';

interface SearchBarProps {
  mapRef: React.RefObject<maplibregl.Map | null>;
  className?: string;
}

export const SearchBar: React.FC<SearchBarProps> = ({ mapRef, className }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodingResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [hasSearched, setHasSearched] = useState(false);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRequestTimeRef = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Rate-limited search function (minimum 1000ms between requests)
  const performSearch = useCallback(async (searchQuery: string) => {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTimeRef.current;

    if (timeSinceLastRequest < 1000) {
      // Schedule the search after the rate limit window
      const delay = 1000 - timeSinceLastRequest;
      setTimeout(() => performSearch(searchQuery), delay);
      return;
    }

    lastRequestTimeRef.current = Date.now();

    try {
      const searchResults = await searchLocations(searchQuery);
      setResults(searchResults);
      setHasSearched(true);
      setShowDropdown(true);
      setHighlightedIndex(-1);
    } catch {
      // Silently handle fetch failures
      setResults([]);
      setHasSearched(true);
      setShowDropdown(true);
    }
  }, []);

  // Handle input change with debounce
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);

      // Clear any pending debounce
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (!shouldTriggerSearch(value)) {
        setShowDropdown(false);
        setResults([]);
        setHasSearched(false);
        setHighlightedIndex(-1);
        return;
      }

      // Debounce: 300ms after last keystroke
      debounceTimerRef.current = setTimeout(() => {
        performSearch(value.trim());
      }, 300);
    },
    [performSearch]
  );

  // Handle suggestion selection
  const handleSelect = useCallback(
    (result: GeocodingResult) => {
      setQuery(result.displayName);
      setShowDropdown(false);
      setResults([]);
      setHasSearched(false);
      setHighlightedIndex(-1);

      const zoom = getZoomForPlaceType(result.type);
      mapRef.current?.flyTo({
        center: [result.longitude, result.latitude],
        zoom,
      });
    },
    [mapRef]
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!showDropdown || results.length === 0) {
        if (e.key === 'Escape') {
          setShowDropdown(false);
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightedIndex((prev) => {
            if (prev < results.length - 1) return prev + 1;
            return 0;
          });
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prev) => {
            if (prev > 0) return prev - 1;
            return results.length - 1;
          });
          break;
        case 'Enter':
          e.preventDefault();
          if (highlightedIndex >= 0 && highlightedIndex < results.length) {
            handleSelect(results[highlightedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setShowDropdown(false);
          break;
      }
    },
    [showDropdown, results, highlightedIndex, handleSelect]
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return (
    <div className={`relative ${className ?? ''}`}>
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Search for a location..."
          className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition-colors"
        />
      </div>

      {/* Suggestions Dropdown */}
      {showDropdown && hasSearched && (
        <ul className="absolute z-50 mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-400 cursor-default select-none">
              No results found
            </li>
          ) : (
            results.slice(0, 5).map((result, index) => (
              <li
                key={`${result.latitude}-${result.longitude}-${index}`}
                onClick={() => handleSelect(result)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={`px-3 py-2 text-sm cursor-pointer transition-colors ${
                  index === highlightedIndex
                    ? 'bg-cyan-500/20 text-white'
                    : 'text-gray-300 hover:bg-gray-700'
                }`}
              >
                <span className="block truncate">{result.displayName}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
};
