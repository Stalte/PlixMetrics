import { PlexServer, ActiveSession } from '../types.js';
import { tautulli } from './tautulli.js';
import { getPlexActivity, hasPlex } from './plex.js';
import { batchGeoLookup, isPrivateIp, lookupIp, GeoLocation } from './geoip.js';
import { metadataCache } from './cache.js';
import logger from './logger.js';

const log = logger.child('Live');

const LIVE_TIMEOUT_MS = 15000;
const USERS_CACHE_MS = 10 * 60 * 1000;

/** A playing session in Tautulli's get_activity shape (also produced from Plex data). */
export type RawSession = Record<string, any>;

export interface LiveActivity {
    source: 'tautulli' | 'plex';
    stream_count: number;
    sessions: RawSession[];
}

export interface ServerLiveResult {
    server: PlexServer;
    activity: LiveActivity | null;
    error?: string;
}

// After a failed Plex call, use Tautulli for a minute instead of waiting on Plex every poll.
const PLEX_RETRY_MS = 60 * 1000;
const plexFailedAt = new Map<number, number>();
const plexBackoff = (serverId: number) => {
    const failedAt = plexFailedAt.get(serverId);
    return failedAt !== undefined && Date.now() - failedAt < PLEX_RETRY_MS;
};

/**
 * Current activity for one server.
 * Reads Plex directly when a Plex URL and token are configured (faster and always current),
 * and falls back to Tautulli's get_activity when Plex is not configured or does not answer.
 */
export async function getLiveActivity(server: PlexServer): Promise<LiveActivity> {
    if (hasPlex(server) && !plexBackoff(server.id)) {
        try {
            const activity = await getPlexActivity(server);
            plexFailedAt.delete(server.id);
            return activity;
        } catch (err) {
            plexFailedAt.set(server.id, Date.now());
            log.warn(`${server.name}: Plex live data unavailable, using Tautulli for the next minute (${(err as Error).message})`);
        }
    }

    const data = await tautulli(server, 'get_activity', {}, { timeout: LIVE_TIMEOUT_MS });
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    return {
        source: 'tautulli',
        stream_count: parseInt(data?.stream_count || String(sessions.length), 10) || 0,
        sessions
    };
}

/** Current activity for every server. Never throws; failed servers carry an error. */
export async function getLiveActivityForAll(servers: PlexServer[]): Promise<ServerLiveResult[]> {
    return Promise.all(servers.map(async (server) => {
        try {
            return { server, activity: await getLiveActivity(server) };
        } catch (err) {
            return { server, activity: null, error: (err as Error).message };
        }
    }));
}

const usersInFlight = new Map<number, Promise<string[]>>();

/**
 * Unique user identifiers for one server, cached for 10 minutes.
 * On failure the last known list is returned so one slow refresh does not drop
 * a whole server's users from the total.
 */
export async function getServerUserKeys(server: PlexServer): Promise<string[] | null> {
    const cacheKey = `users-${server.id}`;
    const cached = metadataCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < USERS_CACHE_MS) return cached.stats as string[];

    let request = usersInFlight.get(server.id);
    if (!request) {
        request = (async () => {
            const users = await tautulli(server, 'get_users');
            const keys = new Set<string>();
            if (Array.isArray(users)) {
                for (const u of users) {
                    const userId = parseInt(u.user_id, 10);
                    const username = u.username || '';
                    // Skip Tautulli's built-in "Local" account
                    if (userId === 0 || username === 'Local' || username === 'None') continue;
                    // Plex account ids are shared between servers, so they de-duplicate users
                    // across servers. Managed (home) users have no username, so the old
                    // username-only key silently left them out.
                    if (userId) keys.add(`id:${userId}`);
                    else if (username) keys.add(`name:${username.toLowerCase()}`);
                }
            }
            const list = Array.from(keys);
            metadataCache.set(cacheKey, { timestamp: Date.now(), stats: list });
            return list;
        })().finally(() => usersInFlight.delete(server.id));
        usersInFlight.set(server.id, request);
    }

    try {
        return await request;
    } catch {
        if (cached) {
            log.warn(`${server.name}: using cached user list from ${Math.round((Date.now() - cached.timestamp) / 60000)} min ago`);
            return cached.stats as string[];
        }
        return null;
    }
}

/** Convert raw sessions from all servers into dashboard sessions with geolocation. */
export async function buildActiveSessions(results: ServerLiveResult[]): Promise<{
    sessions: ActiveSession[];
    total_bandwidth: number;
    total_stream_count: number;
    total_transcodes: number;
}> {
    let totalBandwidth = 0;
    let totalStreamCount = 0;
    let totalTranscodes = 0;
    const ipsToLookup: string[] = [];
    const sessionData: Array<{ session: RawSession; server: PlexServer; sessionBandwidth: number; ipToLookup?: string; lat?: number; lon?: number }> = [];

    for (const { server, activity } of results) {
        if (!activity) continue;
        totalStreamCount += activity.stream_count;

        for (const session of activity.sessions) {
            let sessionBandwidth = parseInt(session.bandwidth || '0', 10) || 0;
            if (session.stream_container_decision === 'transcode' || session.transcode_decision === 'transcode') {
                totalTranscodes++;
            }
            if (sessionBandwidth >= 10000000) sessionBandwidth = 0;
            totalBandwidth += sessionBandwidth;

            const ipToLookup = session.ip_address_public || session.ip_address;
            const lat: number | undefined = session.latitude ? parseFloat(session.latitude) : undefined;
            const lon: number | undefined = session.longitude ? parseFloat(session.longitude) : undefined;

            if (ipToLookup && !isPrivateIp(ipToLookup)) {
                ipsToLookup.push(ipToLookup);
            }

            sessionData.push({ session, server, sessionBandwidth, ipToLookup, lat, lon });
        }
    }

    // Batch geo lookup
    const geoCache = await batchGeoLookup([...new Set(ipsToLookup)]);
    const sessions: ActiveSession[] = [];

    for (let idx = 0; idx < sessionData.length; idx++) {
        const { session, server, sessionBandwidth, ipToLookup } = sessionData[idx];
        let { lat, lon } = sessionData[idx];
        const isLocal = Boolean(ipToLookup && isPrivateIp(ipToLookup));

        // Cache first, then a fresh lookup (which caches public IPs itself). Local addresses
        // resolve to the server's own location and are not cached.
        let geo: GeoLocation | null = null;
        if (ipToLookup) geo = geoCache.get(ipToLookup) ?? lookupIp(ipToLookup);
        if ((!lat || !lon) && geo) {
            lat = geo.lat;
            lon = geo.lon;
        }

        // session_key is unique per active stream; session_id is empty for direct play
        // streams, so falling back to it alone caused colliding React keys (and dropped cards).
        const uniqueKey = session.session_key || session.session_id || idx;
        sessions.push({
            session_id: `${server.id}-${uniqueKey}`,
            title: session.full_title || session.title,
            user: session.user || session.username,
            player: session.player,
            status: session.state,
            ip_address: ipToLookup || '',
            latitude: lat,
            longitude: lon,
            location_city: isLocal ? undefined : geo?.city,
            location_region: isLocal ? undefined : geo?.region,
            location_country: isLocal ? undefined : geo?.country,
            is_local: isLocal,
            bandwidth: sessionBandwidth,
            quality_profile: session.quality_profile,
            stream_container_decision: session.stream_container_decision,
            server_name: server.name,
            server_id: server.id,
            thumb: session.thumb,
            grandparent_thumb: session.grandparent_thumb,
            art: session.art,
            grandparent_title: session.grandparent_title,
            parent_media_index: session.parent_media_index,
            media_index: session.media_index,
            year: session.year,
            duration: parseInt(session.duration || '0', 10),
            view_offset: parseInt(session.view_offset || '0', 10),
            progress_percent: parseInt(session.progress_percent || '0', 10),
            media_type: session.media_type
        });
    }

    return { sessions, total_bandwidth: totalBandwidth, total_stream_count: totalStreamCount, total_transcodes: totalTranscodes };
}

/** Forget connection failures, e.g. after a server's settings change. */
export function resetLiveState(serverId?: number): void {
    if (serverId === undefined) plexFailedAt.clear();
    else plexFailedAt.delete(serverId);
}
