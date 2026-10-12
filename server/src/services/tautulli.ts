import { upstream, toUpstreamError, UpstreamError } from './upstream.js';
import logger from './logger.js';

const log = logger.child('Tautulli');

/**
 * Default timeout for Tautulli API calls (statistics, history, users). Large Tautulli
 * databases can take well over a minute for long time ranges, so this is generous;
 * live activity and connection checks use their own short timeouts.
 */
export const TAUTULLI_TIMEOUT_MS = parseInt(process.env.TAUTULLI_TIMEOUT_MS || '', 10) || 120000;
const SLOW_CALL_MS = 5000;

/** How long a server that refused the connection is skipped by the heavy history endpoints. */
const DOWN_BACKOFF_MS = 30000;

export interface TautulliTarget {
    id?: number;
    name: string;
    tautulli_url: string;
    api_key_secret: string;
}

const lastConnectionFailure = new Map<number, number>();

/**
 * True when the server refused the connection very recently. Used instead of the old
 * 2-second "status" pre-check, which marked slow-but-healthy Tautulli instances as offline.
 * Timeouts do not count: a slow server is still worth asking.
 */
export function isTemporarilyDown(serverId: number): boolean {
    const failedAt = lastConnectionFailure.get(serverId);
    return failedAt !== undefined && Date.now() - failedAt < DOWN_BACKOFF_MS;
}

/**
 * Call a Tautulli API v2 command and return its `data`.
 * Throws an UpstreamError describing what went wrong (timeout, bad API key, unreachable...).
 */
export async function tautulli<T = any>(
    server: TautulliTarget,
    cmd: string,
    params: Record<string, unknown> = {},
    options: { timeout?: number } = {}
): Promise<T> {
    const timeout = options.timeout ?? TAUTULLI_TIMEOUT_MS;
    const start = Date.now();

    try {
        const res = await upstream.get(`${server.tautulli_url}/api/v2`, {
            params: { ...params, apikey: server.api_key_secret, cmd },
            timeout
        });

        const body = res.data?.response;
        if (!body || typeof body !== 'object') {
            throw new UpstreamError('invalid_response', 'The URL did not answer like Tautulli - check the address and port');
        }
        if (body.result !== 'success') {
            const message = body.message || 'Tautulli returned an error';
            throw new UpstreamError(/api ?key/i.test(message) ? 'auth' : 'api', message);
        }

        const ms = Date.now() - start;
        if (ms >= SLOW_CALL_MS) log.warn(`${server.name}: ${cmd} was slow (${ms}ms)`);
        else log.debug(`${server.name}: ${cmd} ${ms}ms`);

        if (server.id !== undefined) lastConnectionFailure.delete(server.id);
        return body.data as T;
    } catch (err) {
        const error = toUpstreamError(err, timeout, 'Tautulli');
        log.warn(`${server.name}: ${cmd} failed after ${Date.now() - start}ms - ${error.message}`);
        if (server.id !== undefined && (error.kind === 'unreachable' || error.kind === 'tls')) {
            lastConnectionFailure.set(server.id, Date.now());
        }
        throw error;
    }
}

/**
 * Lightweight connection check. `get_server_friendly_name` only reads Tautulli's config,
 * unlike `get_activity` which has to wait for Plex to answer first.
 */
export async function checkTautulli(server: TautulliTarget, timeout = 10000): Promise<{ ok: true; latency_ms: number } | { ok: false; error: string; kind: string }> {
    const start = Date.now();
    try {
        await tautulli(server, 'get_server_friendly_name', {}, { timeout });
        return { ok: true, latency_ms: Date.now() - start };
    } catch (err) {
        const e = err as UpstreamError;
        return { ok: false, error: e.message, kind: e.kind };
    }
}
