import db from '../db/index.js';

/**
 * Map tile providers for the Live User Map.
 *
 * Tiles are fetched by the server (see routes/map.ts), so API keys never reach the browser
 * and tiles are cached on disk.
 */
export interface MapProvider {
    id: string;
    name: string;
    requiresKey: boolean;
    maxZoom: number;
    attribution: string;
    signupUrl?: string;
    /** Upstream tile URL with {z}/{x}/{y} and {key} placeholders. */
    url: string;
}

export const MAP_PROVIDERS: MapProvider[] = [
    {
        id: 'bluemarble',
        name: 'NASA Blue Marble - day/night earth (no key)',
        requiresKey: false,
        maxZoom: 8,
        attribution: 'Imagery &copy; NASA Blue Marble, NASA EOSDIS GIBS',
        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'
    },
    {
        id: 'nightlights',
        name: 'NASA Earth at Night - city lights (no key)',
        requiresKey: false,
        maxZoom: 8,
        attribution: 'Imagery &copy; NASA Earth Observatory, NASA EOSDIS GIBS',
        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'
    },
    {
        id: 'satellite',
        name: 'Esri World Imagery - satellite (no key)',
        requiresKey: false,
        maxZoom: 18,
        attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
    },
    {
        id: 'esri',
        name: 'Esri Dark Gray (no key)',
        requiresKey: false,
        maxZoom: 16,
        attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
    },
    {
        id: 'carto',
        name: 'CARTO Dark Matter',
        requiresKey: true,
        maxZoom: 20,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        signupUrl: 'https://carto.com/basemaps/apikey',
        url: 'https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key={key}'
    },
    {
        id: 'stadia',
        name: 'Stadia Maps - Alidade Smooth Dark',
        requiresKey: true,
        maxZoom: 20,
        attribution: '&copy; Stadia Maps &copy; OpenMapTiles &copy; OpenStreetMap contributors',
        signupUrl: 'https://client.stadiamaps.com/signup/',
        url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}.png?api_key={key}'
    },
    {
        id: 'maptiler',
        name: 'MapTiler - Dataviz Dark',
        requiresKey: true,
        maxZoom: 20,
        attribution: '&copy; MapTiler &copy; OpenStreetMap contributors',
        signupUrl: 'https://cloud.maptiler.com/auth/widget?next=https://cloud.maptiler.com/maps/',
        url: 'https://api.maptiler.com/maps/dataviz-dark/256/{z}/{x}/{y}.png?key={key}'
    },
    {
        id: 'mapbox',
        name: 'Mapbox - Dark',
        requiresKey: true,
        maxZoom: 20,
        attribution: '&copy; Mapbox &copy; OpenStreetMap contributors',
        signupUrl: 'https://account.mapbox.com/auth/signup/',
        url: 'https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}?access_token={key}'
    },
    {
        id: 'custom',
        name: 'Custom tile URL',
        requiresKey: false,
        maxZoom: 20,
        attribution: '&copy; OpenStreetMap contributors',
        url: ''
    }
];

export const DEFAULT_PROVIDER = 'bluemarble';

/**
 * Transparent overlay with country, state and city borders and names, drawn on top of any
 * map style. Esri's reference layer is designed for imagery (light labels with dark halos),
 * needs no key, and shows more detail as you zoom in.
 */
export const LABELS_LAYER = {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    attribution: 'Labels &copy; Esri'
};

export interface MapSettings {
    provider: string;
    api_key: string;
    custom_url: string;
    /** Shade the part of the world where it is currently night. */
    day_night: boolean;
    /** Show borders and place names on top of the map. */
    labels: boolean;
    updated_at: string;
}

const KEYS = {
    provider: 'map_provider',
    api_key: 'map_api_key',
    custom_url: 'map_custom_url',
    day_night: 'map_day_night',
    labels: 'map_labels',
    updated_at: 'map_updated_at'
} as const;

function readConfig(key: string): string {
    const row = db.prepare('SELECT value FROM system_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? '';
}

/** Where the original PlixMetrics (1.4.9+) stores its CARTO key. */
const LEGACY_CARTO_KEY = 'carto_api_key';

export function getMapSettings(): MapSettings {
    let provider = readConfig(KEYS.provider);
    let apiKey = readConfig(KEYS.api_key);
    // A CARTO key saved by the original app, before any map style was chosen here
    if (!provider && readConfig(LEGACY_CARTO_KEY)) {
        provider = 'carto';
        apiKey = readConfig(LEGACY_CARTO_KEY);
    }
    return {
        provider: MAP_PROVIDERS.some((p) => p.id === provider) ? provider : DEFAULT_PROVIDER,
        api_key: apiKey,
        custom_url: readConfig(KEYS.custom_url),
        day_night: readConfig(KEYS.day_night) !== 'false',
        labels: readConfig(KEYS.labels) !== 'false',
        updated_at: readConfig(KEYS.updated_at) || '0'
    };
}

export function saveMapSettings(settings: Omit<MapSettings, 'updated_at'>): MapSettings {
    const upsert = db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const updatedAt = String(Date.now());
    db.transaction(() => {
        upsert.run(KEYS.provider, settings.provider);
        upsert.run(KEYS.api_key, settings.api_key);
        upsert.run(KEYS.custom_url, settings.custom_url);
        upsert.run(KEYS.day_night, String(settings.day_night));
        upsert.run(KEYS.labels, String(settings.labels));
        upsert.run(KEYS.updated_at, updatedAt);
    })();
    return { ...settings, updated_at: updatedAt };
}

export function getProvider(id: string): MapProvider {
    return MAP_PROVIDERS.find((p) => p.id === id) || MAP_PROVIDERS[0];
}

/** Upstream URL for one tile with the current settings, or null if the settings are incomplete. */
export function buildTileUrl(settings: MapSettings, z: number, x: number, y: number): string | null {
    const provider = getProvider(settings.provider);
    const template = provider.id === 'custom' ? settings.custom_url : provider.url;
    if (!template) return null;
    if (provider.requiresKey && !settings.api_key) return null;

    return template
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y))
        .replace('{s}', 'a')
        .replace('{r}', '')
        .replace('{key}', encodeURIComponent(settings.api_key));
}
