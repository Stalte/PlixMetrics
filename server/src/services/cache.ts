import { Request, Response, NextFunction } from 'express';
import logger from './logger.js';

const log = logger.child('Cache');

// In-memory cache for per-server data (e.g. user lists) to reduce external API pressure
export const metadataCache: Map<string, { timestamp: number; stats: any }> = new Map();

interface CachedResponse {
    timestamp: number;
    status: number;
    body: unknown;
}

const responseCache = new Map<string, CachedResponse>();
const inFlight = new Map<string, Promise<CachedResponse>>();
const MAX_RESPONSE_ENTRIES = 200;

/**
 * Clear all in-memory caches when server config changes
 */
export function clearServerCaches(): void {
    metadataCache.clear();
    responseCache.clear();
    log.info('All server caches cleared');
}

function cacheKey(req: Request): string {
    const query = Object.entries(req.query)
        .filter(([key]) => key !== 'token' && key !== 'refresh')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('&');
    return `${req.baseUrl}${req.path}?${query}`;
}

/**
 * Cache successful JSON responses of a GET route for `ttlMs`.
 *
 * Concurrent requests for the same URL share one upstream fetch, so several open
 * dashboards (or a quick page switch) do not each re-query Tautulli. Add `refresh=1`
 * to the query string to bypass the cache.
 */
export function cacheResponse(ttlMs: number) {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET') return next();

        const key = cacheKey(req);
        const cached = responseCache.get(key);
        const bypass = req.query.refresh === '1' || req.query.refresh === 'true';

        if (!bypass && cached && Date.now() - cached.timestamp < ttlMs) {
            res.set('X-Cache-Status', 'HIT');
            return res.status(cached.status).json(cached.body);
        }

        const pending = inFlight.get(key);
        if (pending) {
            try {
                const shared = await pending;
                res.set('X-Cache-Status', 'SHARED');
                return res.status(shared.status).json(shared.body);
            } catch {
                return next();
            }
        }

        // Capture the route's response so it can be stored and shared.
        let resolve!: (value: CachedResponse) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<CachedResponse>((res2, rej2) => { resolve = res2; reject = rej2; });
        promise.catch(() => { /* handled by waiters */ });
        inFlight.set(key, promise);

        const originalJson = res.json.bind(res);
        res.json = (body: unknown) => {
            const entry: CachedResponse = { timestamp: Date.now(), status: res.statusCode, body };
            inFlight.delete(key);
            if (res.statusCode === 200) {
                if (responseCache.size >= MAX_RESPONSE_ENTRIES) {
                    const oldest = responseCache.keys().next().value;
                    if (oldest !== undefined) responseCache.delete(oldest);
                }
                responseCache.set(key, entry);
            }
            resolve(entry);
            res.set('X-Cache-Status', 'MISS');
            return originalJson(body);
        };
        res.on('close', () => {
            if (inFlight.get(key) === promise) {
                inFlight.delete(key);
                reject(new Error('Response closed without JSON body'));
            }
        });

        next();
    };
}
