import geoip from 'geoip-lite';
import db from '../db/index.js';
import { maxmindLookup, onMaxmindReload, startMaxmind } from './maxmind.js';
import { getPublicIp } from './publicIp.js';
import logger from './logger.js';

const log = logger.child('GeoIP');

const GEO_CACHE_MAX_AGE_DAYS = 90;
const GEO_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface GeoLocation {
    lat: number;
    lon: number;
    city?: string;
    /** State or province (a code such as "CA" from the built-in database, a name from MaxMind). */
    region?: string;
    country?: string;
}

/**
 * Remove geo_cache entries older than 90 days
 */
export function cleanupGeoCache(): number {
    const stmt = db.prepare(`DELETE FROM geo_cache WHERE updated_at < datetime('now', ?)`);
    const result = stmt.run(`-${GEO_CACHE_MAX_AGE_DAYS} days`);
    if (result.changes > 0) {
        console.log(`[GeoIP] Cleaned up ${result.changes} stale cache entries (>${GEO_CACHE_MAX_AGE_DAYS} days old)`);
    }
    return result.changes;
}

// Run cleanup on startup and every 24 hours
cleanupGeoCache();
setInterval(cleanupGeoCache, GEO_CLEANUP_INTERVAL_MS);

// Locations cached from the previous database would otherwise win over the new one.
onMaxmindReload(() => {
    const removed = db.prepare('DELETE FROM geo_cache').run().changes;
    if (removed > 0) log.info(`Cleared ${removed} cached locations after the location database changed`);
    refreshHomeLocation();
});
startMaxmind();

/** True for addresses that never have a public location (LAN, loopback, CGNAT, link-local). */
export function isPrivateIp(ip: string): boolean {
    const v4 = ip.replace(/^::ffff:/i, '');
    const m = v4.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        return a === 10 || a === 127 || a === 0 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127);
    }
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

/**
 * Where this server is, from its public IP. Streams from the local network have
 * private IPs with no location, so they are shown here instead of being left off the map.
 */
let homeLocation: GeoLocation | null = null;

function locate(ip: string): GeoLocation | null {
    const mm = maxmindLookup(ip);
    if (mm) return { lat: mm.lat, lon: mm.lon, city: mm.city, region: mm.region, country: mm.country };
    const geo = geoip.lookup(ip);
    if (geo && geo.ll) return { lat: geo.ll[0], lon: geo.ll[1], city: geo.city || undefined, region: geo.region || undefined, country: geo.country || undefined };
    return null;
}

async function refreshHomeLocation(): Promise<void> {
    if (process.env.HOME_LAT && process.env.HOME_LON) {
        homeLocation = { lat: parseFloat(process.env.HOME_LAT), lon: parseFloat(process.env.HOME_LON) };
        return;
    }
    const publicIp = await getPublicIp();
    if (!publicIp) return;
    homeLocation = locate(publicIp);
    if (homeLocation) log.info(`Local network streams are shown at the server's location (${homeLocation.city || homeLocation.country || 'unknown'})`);
}

refreshHomeLocation().catch(() => { /* logged by getPublicIp */ });
setInterval(() => refreshHomeLocation().catch(() => { /* ignore */ }), 6 * 60 * 60 * 1000).unref();

/**
 * Batch geolocation lookup - reduces DB reads from O(n) to O(1)
 */
export async function batchGeoLookup(ips: string[]): Promise<Map<string, GeoLocation>> {
    const result = new Map<string, GeoLocation>();
    if (ips.length === 0) return result;

    const uniqueIps = [...new Set(ips)];

    // SQLite batch lookup
    const placeholders = uniqueIps.map(() => '?').join(',');
    const sanitizedKeys = uniqueIps.map(ip => ip.replace(/\./g, '_'));

    const stmt = db.prepare(`SELECT * FROM geo_cache WHERE ip IN (${placeholders})`);
    const rows = stmt.all(...sanitizedKeys) as any[];

    rows.forEach(row => {
        const originalIp = row.ip.replace(/_/g, '.');
        if (row.lat && row.lon) {
            result.set(originalIp, { lat: row.lat, lon: row.lon, city: row.city, region: row.region, country: row.country });
        }
    });

    return result;
}

/**
 * Lookup single IP: local addresses map to the server's location, then the cache,
 * then MaxMind (if configured), then geoip-lite
 */
export function lookupIp(ip: string): GeoLocation | null {
    if (isPrivateIp(ip)) return homeLocation;

    // Check cache first
    const sanitizedIp = ip.replace(/\./g, '_');
    const stmt = db.prepare('SELECT * FROM geo_cache WHERE ip = ?');
    const cached = stmt.get(sanitizedIp) as any;

    if (cached && cached.lat && cached.lon) {
        return { lat: cached.lat, lon: cached.lon, city: cached.city, region: cached.region, country: cached.country };
    }

    // MaxMind when configured, otherwise the built-in geoip-lite data
    const location = locate(ip);
    if (location) {
        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO geo_cache (ip, lat, lon, city, region, country, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        insertStmt.run(sanitizedIp, location.lat, location.lon, location.city ?? null, location.region ?? null, location.country ?? null);
    }
    return location;
}

/**
 * Batch save new geo cache entries
 */
export function saveGeoCache(entries: Array<{ ip: string } & GeoLocation>) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO geo_cache (ip, lat, lon, city, region, country, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const insertMany = db.transaction((items: typeof entries) => {
        for (const item of items) {
            stmt.run(item.ip.replace(/\./g, '_'), item.lat, item.lon, item.city ?? null, item.region ?? null, item.country ?? null);
        }
    });

    insertMany(entries);
}
