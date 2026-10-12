import { Request, Response, NextFunction, RequestHandler } from 'express';
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

function storeEntry(key: string, entry: CachedResponse): void {
    if (entry.status !== 200) return;
    responseCache.delete(key); // re-insert so the map keeps least-recently-written first
    if (responseCache.size >= MAX_RESPONSE_ENTRIES) {
        const oldest = responseCache.keys().next().value;
        if (oldest !== undefined) responseCache.delete(oldest);
    }
    responseCache.set(key, entry);
}

/**
 * Re-run a route without a client attached, to refresh a stale cache entry in the background.
 * The routes behind this cache only use res.status() and res.json().
 */
function refreshInBackground(key: string, req: Request, handler: RequestHandler): void {
    if (inFlight.has(key)) return;

    const fakeReq = Object.create(req) as Request;
    fakeReq.url = (req as any).cacheOriginalUrl;
    const promise = new Promise<CachedResponse>((resolve, reject) => {
        const fakeRes: any = {
            statusCode: 200,
            headersSent: false,
            locals: {},
            status(code: number) { this.statusCode = code; return this; },
            set() { return this; },
            setHeader() { return this; },
            json(body: unknown) {
                this.headersSent = true;
                resolve({ timestamp: Date.now(), status: this.statusCode, body });
                return this;
            },
            send(body: unknown) { return this.json(body); },
            on() { return this; }
        };
        try {
            handler(fakeReq, fakeRes as Response, (err?: unknown) => reject(err || new Error('No route answered')));
        } catch (err) {
            reject(err);
        }
    });

    inFlight.set(key, promise);
    promise
        .then((entry) => {
            storeEntry(key, entry);
            log.debug(`Refreshed ${key} in the background`);
        })
        .catch((err) => log.warn(`Background refresh of ${key} failed:`, err))
        .finally(() => {
            if (inFlight.get(key) === promise) inFlight.delete(key);
        });
}

interface CacheOptions {
    /** How long a response is served without refreshing it. */
    ttlMs: number;
    /**
     * How long an older response may still be served instantly while a fresh one is
     * fetched in the background (needs `handler`). Slow Tautulli statistics then load
     * immediately instead of making the page wait on Tautulli every time.
     */
    staleMs?: number;
    /** The router behind this cache, used for background refreshes. */
    handler?: RequestHandler;
}

/**
 * Cache successful JSON responses of a GET route.
 *
 * Concurrent requests for the same URL share one upstream fetch, so several open
 * dashboards (or a quick page switch) do not each re-query Tautulli. Add `refresh=1`
 * to the query string to bypass the cache.
 */
export function cacheResponse({ ttlMs, staleMs = 0, handler }: CacheOptions) {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET') return next();

        const key = cacheKey(req);
        (req as any).cacheOriginalUrl = req.url;
        const cached = responseCache.get(key);
        const bypass = req.query.refresh === '1' || req.query.refresh === 'true';
        const age = cached ? Date.now() - cached.timestamp : Infinity;

        if (!bypass && cached && age < ttlMs) {
            res.set('X-Cache-Status', 'HIT');
            return res.status(cached.status).json(cached.body);
        }

        if (!bypass && cached && handler && age < ttlMs + staleMs) {
            refreshInBackground(key, req, handler);
            res.set('X-Cache-Status', 'STALE');
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
            if (inFlight.get(key) === promise) inFlight.delete(key);
            storeEntry(key, entry);
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
