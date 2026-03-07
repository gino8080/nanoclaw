/**
 * Stdio MCP Server for Google Maps APIs
 * Provides geocoding, places search, directions, and distance matrix tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.GOOGLE_MAPS_API_KEY!;
const BASE = 'https://maps.googleapis.com/maps/api';
const PLACES_BASE = 'https://places.googleapis.com/v1';

async function mapsGet(
  endpoint: string,
  params: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${BASE}/${endpoint}/json`);
  url.searchParams.set('key', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Google Maps API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function placesPost(
  path: string,
  body: Record<string, unknown>,
  fieldMask: string,
): Promise<unknown> {
  const res = await fetch(`${PLACES_BASE}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Places API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({
  name: 'googlemaps',
  version: '1.0.0',
});

// --- Geocode ---
server.tool(
  'geocode',
  'Convert an address to geographic coordinates (latitude/longitude).',
  {
    address: z.string().describe('The address to geocode'),
  },
  async ({ address }) => {
    try {
      const data = await mapsGet('geocode', { address });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Reverse Geocode ---
server.tool(
  'reverse_geocode',
  'Convert coordinates to a human-readable address.',
  {
    lat: z.number().describe('Latitude'),
    lng: z.number().describe('Longitude'),
  },
  async ({ lat, lng }) => {
    try {
      const data = await mapsGet('geocode', { latlng: `${lat},${lng}` });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Places Text Search (New API) ---
server.tool(
  'places_search',
  `Search for places by text query (e.g. "ristoranti a Roma", "farmacia vicino a me").
Returns name, address, rating, opening hours, location, and more.
Use location_bias to search near specific coordinates.`,
  {
    query: z.string().describe('Text search query'),
    lat: z
      .number()
      .optional()
      .describe('Latitude for location bias (optional)'),
    lng: z
      .number()
      .optional()
      .describe('Longitude for location bias (optional)'),
    radius: z
      .number()
      .optional()
      .describe('Search radius in meters (default: 5000, max: 50000)'),
    language: z
      .string()
      .optional()
      .describe('Language code for results (default: it)'),
    max_results: z
      .number()
      .optional()
      .describe('Max results to return (default: 10, max: 20)'),
  },
  async ({ query, lat, lng, radius, language, max_results }) => {
    try {
      const body: Record<string, unknown> = {
        textQuery: query,
        languageCode: language || 'it',
        maxResultCount: Math.min(max_results || 10, 20),
      };
      if (lat != null && lng != null) {
        body.locationBias = {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: radius || 5000,
          },
        };
      }
      const data = await placesPost(
        'places:searchText',
        body,
        'places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.types,places.id',
      );
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Nearby Search (New API) ---
server.tool(
  'nearby_search',
  `Search for places near specific coordinates by type (e.g. restaurant, pharmacy, gas_station).
See https://developers.google.com/maps/documentation/places/web-service/place-types for valid types.`,
  {
    lat: z.number().describe('Latitude of the center point'),
    lng: z.number().describe('Longitude of the center point'),
    radius: z
      .number()
      .describe('Search radius in meters (max: 50000)'),
    type: z
      .string()
      .optional()
      .describe(
        'Place type filter (e.g. restaurant, pharmacy, gas_station). One type only.',
      ),
    max_results: z
      .number()
      .optional()
      .describe('Max results (default: 10, max: 20)'),
  },
  async ({ lat, lng, radius, type, max_results }) => {
    try {
      const body: Record<string, unknown> = {
        maxResultCount: Math.min(max_results || 10, 20),
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: Math.min(radius, 50000),
          },
        },
      };
      if (type) {
        body.includedTypes = [type];
      }
      const data = await placesPost(
        'places:searchNearby',
        body,
        'places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.types,places.id',
      );
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Place Details (New API) ---
server.tool(
  'place_details',
  `Get detailed information about a specific place by its Place ID.
Use this after places_search or nearby_search to get full details (reviews, hours, photos, etc.).`,
  {
    place_id: z
      .string()
      .describe('The Google Place ID (from search results)'),
    language: z
      .string()
      .optional()
      .describe('Language code (default: it)'),
  },
  async ({ place_id, language }) => {
    try {
      const res = await fetch(
        `${PLACES_BASE}/places/${place_id}?languageCode=${language || 'it'}`,
        {
          headers: {
            'X-Goog-Api-Key': API_KEY,
            'X-Goog-FieldMask':
              'displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,regularOpeningHours,nationalPhoneNumber,internationalPhoneNumber,websiteUri,googleMapsUri,types,editorialSummary,reviews,paymentOptions,parkingOptions,accessibilityOptions',
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        throw new Error(`Places API ${res.status}: ${await res.text()}`);
      }
      return textResult(await res.json());
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Directions ---
server.tool(
  'directions',
  `Get directions/route between two points. Returns steps, distance, duration, and polyline.
Supports driving, walking, bicycling, and transit modes.`,
  {
    origin: z
      .string()
      .describe(
        'Start point (address, place name, or "lat,lng")',
      ),
    destination: z
      .string()
      .describe(
        'End point (address, place name, or "lat,lng")',
      ),
    mode: z
      .enum(['driving', 'walking', 'bicycling', 'transit'])
      .optional()
      .describe('Travel mode (default: driving)'),
    waypoints: z
      .string()
      .optional()
      .describe(
        'Intermediate stops, pipe-separated (e.g. "via:place1|via:place2")',
      ),
    alternatives: z
      .boolean()
      .optional()
      .describe('Return alternative routes (default: false)'),
    language: z.string().optional().describe('Language (default: it)'),
  },
  async ({ origin, destination, mode, waypoints, alternatives, language }) => {
    try {
      const params: Record<string, string> = {
        origin,
        destination,
        mode: mode || 'driving',
        language: language || 'it',
      };
      if (waypoints) params.waypoints = waypoints;
      if (alternatives) params.alternatives = 'true';
      const data = await mapsGet('directions', params);
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Distance Matrix ---
server.tool(
  'distance_matrix',
  `Calculate travel distance and time between multiple origins and destinations.
Useful for comparing routes or finding the closest location among several options.`,
  {
    origins: z
      .string()
      .describe(
        'Origin(s), pipe-separated (e.g. "Roma|Milano" or "41.9,12.5|45.4,9.2")',
      ),
    destinations: z
      .string()
      .describe('Destination(s), pipe-separated'),
    mode: z
      .enum(['driving', 'walking', 'bicycling', 'transit'])
      .optional()
      .describe('Travel mode (default: driving)'),
    language: z.string().optional().describe('Language (default: it)'),
  },
  async ({ origins, destinations, mode, language }) => {
    try {
      const data = await mapsGet('distancematrix', {
        origins,
        destinations,
        mode: mode || 'driving',
        language: language || 'it',
      });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
