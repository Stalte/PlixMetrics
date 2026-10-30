import express from 'express';
import os from 'os';
import axios from 'axios';
import { db } from '../db/index.js';

const router = express.Router();

// system_config key holding the CARTO basemaps API key used by the live map
const MAP_API_KEY_CONFIG = 'carto_api_key';

interface NetworkInfo {
    localIp: string | null;
    publicIp: string | null;
    port: number;
}

// Cache the info to avoid spamming external services
let cachedPublicIp: string | null = null;
let lastPublicIpCheck = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

const getLocalIp = (): string | null => {
    // 1. Check Env Override (for Docker)
    if (process.env.HOST_IP) {
        return process.env.HOST_IP;
    }

    // 2. Auto-detect
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return null;
};

const getPublicIp = async (): Promise<string | null> => {
    // 1. Check Env Override
    if (process.env.PUBLIC_IP) {
        return process.env.PUBLIC_IP;
    }

    const now = Date.now();
    if (cachedPublicIp && (now - lastPublicIpCheck < CACHE_DURATION)) {
        return cachedPublicIp;
    }

    const providers = [
        'https://api.ipify.org?format=json',
        'https://ifconfig.me/ip',
        'https://icanhazip.com'
    ];

    for (const url of providers) {
        try {
            const response = await axios.get(url, { timeout: 5000 });
            let ip = typeof response.data === 'object' ? response.data.ip : response.data;
            ip = ip.trim(); // Clean up newlines if any

            if (ip) {
                cachedPublicIp = ip;
                lastPublicIpCheck = now;
                return ip;
            }
        } catch (error) {
            console.warn(`[Network] Failed to fetch public IP from ${url}:`, error instanceof Error ? error.message : String(error));
            // Continue to next provider
        }
    }

    console.error('[Network] All public IP providers failed.');
    return null;
};

router.get('/info', async (req, res) => {
    const localIp = getLocalIp();
    const publicIp = await getPublicIp();
    const port = parseInt(process.env.PORT || '8282', 10);

    const info: NetworkInfo = {
        localIp,
        publicIp,
        port
    };

    res.json(info);
});

router.get('/map-key', (req, res) => {
    const row = db.prepare('SELECT value FROM system_config WHERE key = ?').get(MAP_API_KEY_CONFIG) as { value: string } | undefined;
    res.json({ apiKey: row?.value || '' });
});

router.put('/map-key', (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';

    // An empty key removes the stored one (map falls back to keyless tiles)
    if (apiKey) {
        db.prepare('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)').run(MAP_API_KEY_CONFIG, apiKey);
    } else {
        db.prepare('DELETE FROM system_config WHERE key = ?').run(MAP_API_KEY_CONFIG);
    }

    res.json({ apiKey });
});

export default router;
