import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { upstream } from '../services/upstream.js';
import { MAP_PROVIDERS, buildTileUrl, getMapSettings, getProvider, saveMapSettings } from '../services/map.js';
import logger from '../services/logger.js';

const router = Router();
const log = logger.child('Map');

const DATA_DIR = process.env.DATA_DIR || './data';
const TILE_CACHE_DIR = path.join(DATA_DIR, 'cache', 'tiles');
const TILE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
fs.mkdirSync(TILE_CACHE_DIR, { recursive: true });

// Only log one tile failure per minute, a broken key would otherwise log every tile.
let lastTileErrorLog = 0;

/** Image type from the file's first bytes (cached tiles are stored without an extension). */
function imageType(buffer: Buffer): string {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer.subarray(0, 4).toString('latin1') === 'RIFF') return 'image/webp';
    return 'image/png';
}

function publicConfig() {
    const settings = getMapSettings();
    const provider = getProvider(settings.provider);
    return {
        provider: settings.provider,
        has_api_key: Boolean(settings.api_key),
        custom_url: settings.custom_url,
        day_night: settings.day_night,
        max_zoom: provider.maxZoom,
        attribution: provider.attribution,
        version: settings.updated_at,
        providers: MAP_PROVIDERS.map(({ id, name, requiresKey, signupUrl }) => ({ id, name, requires_key: requiresKey, signup_url: signupUrl }))
    };
}

/** GET /api/map/config - current map provider (the API key itself is never returned) */
router.get('/config', (req, res) => {
    res.json(publicConfig());
});

/** PUT /api/map/config - { provider, api_key?, custom_url? } */
router.put('/config', async (req, res) => {
    const providerId = String(req.body.provider || '');
    const provider = MAP_PROVIDERS.find((p) => p.id === providerId);
    if (!provider) return res.status(400).json({ error: 'Unknown map provider' });

    const current = getMapSettings();
    // An empty api_key keeps the saved one, so the form does not have to show the key.
    const apiKey = typeof req.body.api_key === 'string' && req.body.api_key.trim()
        ? req.body.api_key.trim()
        : (providerId === current.provider ? current.api_key : '');
    const customUrl = typeof req.body.custom_url === 'string' ? req.body.custom_url.trim() : '';
    const dayNight = req.body.day_night === undefined ? current.day_night : Boolean(req.body.day_night);

    if (provider.requiresKey && !apiKey) {
        return res.status(400).json({ error: `${provider.name} needs an API key` });
    }
    if (provider.id === 'custom' && !/^https?:\/\/.+\{z\}.+\{x\}.+\{y\}|^https?:\/\/.+\{z\}.+\{y\}.+\{x\}/.test(customUrl)) {
        return res.status(400).json({ error: 'The custom URL must start with http(s):// and contain {z}, {x} and {y}' });
    }

    // Try one tile before saving so a wrong key is reported right away.
    const candidate = { provider: provider.id, api_key: apiKey, custom_url: customUrl, day_night: dayNight, updated_at: '' };
    const testUrl = buildTileUrl(candidate, 2, 1, 1);
    if (testUrl) {
        try {
            const r = await upstream.get(testUrl, { responseType: 'arraybuffer', timeout: 10000 });
            const type = String(r.headers['content-type'] || '');
            if (!type.startsWith('image/')) throw new Error(`returned ${type || 'no content type'} instead of an image`);
        } catch (err: any) {
            const status = err?.response?.status;
            const message = status === 401 || status === 403 ? 'API key rejected' : status ? `HTTP ${status}` : err.message;
            log.warn(`Map provider test for ${provider.id} failed: ${message}`);
            return res.status(400).json({ error: `The map provider did not return a tile: ${message}` });
        }
    }

    saveMapSettings({ provider: provider.id, api_key: apiKey, custom_url: customUrl, day_night: dayNight });
    log.info(`Map provider set to ${provider.id}`);
    res.json(publicConfig());
});

/** GET /api/map/tiles/:z/:x/:y.png - tile from the configured provider, cached on disk */
router.get('/tiles/:z/:x/:y.png', async (req, res) => {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);
    const max = 2 ** z;
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= max || y >= max) {
        return res.status(400).send('Invalid tile');
    }

    const settings = getMapSettings();
    const url = buildTileUrl(settings, z, x, y);
    if (!url) return res.status(404).send('Map provider not configured');

    const cacheName = crypto.createHash('md5').update(`${settings.provider}|${settings.custom_url}|${settings.updated_at}|${z}/${x}/${y}`).digest('hex');
    const cachePath = path.join(TILE_CACHE_DIR, cacheName);

    try {
        const stat = fs.statSync(cachePath);
        if (stat.size > 0 && Date.now() - stat.mtimeMs < TILE_CACHE_MAX_AGE_MS) {
            const buffer = fs.readFileSync(cachePath);
            res.set('Content-Type', imageType(buffer));
            res.set('Cache-Control', 'public, max-age=604800');
            res.set('X-Cache-Status', 'HIT');
            return res.end(buffer);
        }
    } catch { /* not cached */ }

    try {
        const response = await upstream.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 15000 });
        const contentType = String(response.headers['content-type'] || 'image/png').split(';')[0];
        const buffer = Buffer.from(response.data);
        if (!contentType.startsWith('image/') || buffer.length === 0) throw new Error(`returned ${contentType}`);

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=604800');
        res.set('X-Cache-Status', 'MISS');
        res.end(buffer);

        const tmp = `${cachePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFile(tmp, buffer, (err) => {
            if (err) return fs.unlink(tmp, () => { /* ignore */ });
            fs.rename(tmp, cachePath, () => { /* ignore */ });
        });
    } catch (err: any) {
        if (Date.now() - lastTileErrorLog > 60000) {
            lastTileErrorLog = Date.now();
            log.warn(`Tile ${z}/${x}/${y} from ${settings.provider} failed: ${err?.response?.status ? `HTTP ${err.response.status}` : err.message}`);
        }
        if (!res.headersSent) res.status(502).send('Tile unavailable');
    }
});

export default router;
