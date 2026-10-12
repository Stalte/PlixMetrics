import { upstream, toUpstreamError, UpstreamError } from './upstream.js';
import logger from './logger.js';
import type { LiveActivity, RawSession } from './live.js';

const log = logger.child('Plex');

const PLEX_TIMEOUT_MS = parseInt(process.env.PLEX_TIMEOUT_MS || '', 10) || 8000;
const SLOW_CALL_MS = 3000;

export interface PlexTarget {
    id?: number;
    name: string;
    plex_url?: string | null;
    plex_token?: string | null;
}

export function hasPlex(server: PlexTarget): server is PlexTarget & { plex_url: string; plex_token: string } {
    return Boolean(server.plex_url && server.plex_token);
}

const PLEX_HEADERS = {
    Accept: 'application/json',
    'X-Plex-Product': 'PlixMetrics',
    'X-Plex-Client-Identifier': 'plixmetrics-server'
};

/** GET a path on the Plex Media Server and return the parsed MediaContainer. */
export async function plex<T = any>(server: PlexTarget, pathName: string, options: { timeout?: number } = {}): Promise<T> {
    if (!hasPlex(server)) throw new UpstreamError('api', 'Plex is not configured for this server');

    const timeout = options.timeout ?? PLEX_TIMEOUT_MS;
    const start = Date.now();
    try {
        const res = await upstream.get(`${server.plex_url}${pathName}`, {
            headers: { ...PLEX_HEADERS, 'X-Plex-Token': server.plex_token },
            timeout
        });
        const container = res.data?.MediaContainer;
        if (!container) {
            throw new UpstreamError('invalid_response', 'The URL did not answer like a Plex Media Server - check the address and port (usually 32400)');
        }

        const ms = Date.now() - start;
        if (ms >= SLOW_CALL_MS) log.warn(`${server.name}: ${pathName} was slow (${ms}ms)`);
        else log.debug(`${server.name}: ${pathName} ${ms}ms`);
        return container as T;
    } catch (err) {
        const error = toUpstreamError(err, timeout, 'Plex');
        log.warn(`${server.name}: ${pathName} failed after ${Date.now() - start}ms - ${error.message}`);
        throw error;
    }
}

/** Connection check. /status/sessions needs a valid token, unlike /identity. */
export async function checkPlex(server: PlexTarget, timeout = 8000): Promise<{ ok: true; latency_ms: number } | { ok: false; error: string; kind: string }> {
    const start = Date.now();
    try {
        await plex(server, '/status/sessions', { timeout });
        return { ok: true, latency_ms: Date.now() - start };
    } catch (err) {
        const e = err as UpstreamError;
        return { ok: false, error: e.message, kind: e.kind };
    }
}

function streamDecision(item: any): 'transcode' | 'copy' | 'direct play' {
    const ts = item.TranscodeSession;
    if (!ts) return 'direct play';
    if (ts.videoDecision === 'transcode' || ts.audioDecision === 'transcode') return 'transcode';
    return 'copy';
}

function fullTitle(item: any): string {
    if ((item.type === 'episode' || item.type === 'track') && item.grandparentTitle) {
        return `${item.grandparentTitle} - ${item.title}`;
    }
    return item.title;
}

/**
 * Map a Plex /status/sessions item to the field names Tautulli's get_activity uses,
 * so the rest of the app handles both sources the same way.
 */
export function plexSessionToRaw(item: any): RawSession {
    const decision = streamDecision(item);
    const media = Array.isArray(item.Media) ? item.Media[0] : undefined;
    const duration = parseInt(item.duration || '0', 10) || 0;
    const viewOffset = parseInt(item.viewOffset || '0', 10) || 0;
    const player = item.Player || {};

    return {
        session_key: item.sessionKey != null ? String(item.sessionKey) : undefined,
        session_id: item.Session?.id,
        full_title: fullTitle(item),
        title: item.title,
        user: item.User?.title,
        player: player.title || player.product,
        state: player.state,
        ip_address: player.address,
        ip_address_public: player.local ? undefined : (player.remotePublicAddress || undefined),
        bandwidth: item.Session?.bandwidth != null ? String(item.Session.bandwidth) : '0',
        quality_profile: decision === 'transcode' ? `Transcode${media?.videoResolution ? ` ${media.videoResolution}` : ''}` : 'Original',
        stream_container_decision: decision,
        transcode_decision: decision,
        thumb: item.thumb,
        grandparent_thumb: item.grandparentThumb,
        art: item.grandparentArt || item.art,
        grandparent_title: item.grandparentTitle,
        parent_media_index: item.parentIndex != null ? String(item.parentIndex) : undefined,
        media_index: item.index != null ? String(item.index) : undefined,
        year: item.year != null ? String(item.year) : undefined,
        duration: String(duration),
        view_offset: String(viewOffset),
        progress_percent: duration > 0 ? String(Math.round((viewOffset / duration) * 100)) : '0',
        media_type: item.type
    };
}

/** Live sessions read straight from the Plex Media Server. */
export async function getPlexActivity(server: PlexTarget): Promise<LiveActivity> {
    const container = await plex<any>(server, '/status/sessions');
    const items = Array.isArray(container.Metadata) ? container.Metadata : [];
    return {
        source: 'plex',
        stream_count: items.length,
        sessions: items.map(plexSessionToRaw)
    };
}

/** URL for an artwork path resized by Plex's own photo transcoder. */
export function plexImageUrl(server: PlexTarget, img: string, width: unknown, height: unknown): string | null {
    if (!hasPlex(server)) return null;
    const params = new URLSearchParams({
        width: String(width || 300),
        height: String(height || 300),
        minSize: '1',
        upscale: '1',
        url: img,
        'X-Plex-Token': server.plex_token
    });
    return `${server.plex_url}/photo/:/transcode?${params.toString()}`;
}
