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
        id: 'esri',
        name: 'Esri Dark Gray (no key)',
        requiresKey: false,
        maxZoom: 16,
        attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
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

export const DEFAULT_PROVIDER = 'esri';

export interface MapSettings {
    provider: string;
    api_key: string;
    custom_url: string;
    updated_at: string;
}

const KEYS = {
    provider: 'map_provider',
    api_key: 'map_api_key',
    custom_url: 'map_custom_url',
    updated_at: 'map_updated_at'
} as const;

function readConfig(key: string): string {
    const row = db.prepare('SELECT value FROM system_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? '';
}

export function getMapSettings(): MapSettings {
    const provider = readConfig(KEYS.provider);
    return {
        provider: MAP_PROVIDERS.some((p) => p.id === provider) ? provider : DEFAULT_PROVIDER,
        api_key: readConfig(KEYS.api_key),
        custom_url: readConfig(KEYS.custom_url),
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
