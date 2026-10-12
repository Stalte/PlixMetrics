import express, { Router } from 'express';
import { configureMaxmind, disableMaxmind, getMaxmindSettings, getMaxmindStatus, MAXMIND_EDITIONS, MaxmindEdition, uploadMaxmind } from '../services/maxmind.js';
import logger from '../services/logger.js';

const router = Router();
const log = logger.child('MaxMind');

/** GET /api/geoip/config - MaxMind status (the license key itself is never returned) */
router.get('/config', (req, res) => {
    res.json(getMaxmindStatus());
});

/** PUT /api/geoip/config - { account_id, license_key?, edition? } downloads the database and enables it */
router.put('/config', async (req, res) => {
    const current = getMaxmindSettings();
    const accountId = String(req.body.account_id ?? '').trim();
    // An empty license key keeps the saved one (the form never shows it)
    const licenseKey = String(req.body.license_key ?? '').trim() || current.license_key;
    const edition = (MAXMIND_EDITIONS as readonly string[]).includes(req.body.edition) ? req.body.edition as MaxmindEdition : 'GeoLite2-City';

    if (!/^\d+$/.test(accountId)) return res.status(400).json({ error: 'Enter your numeric MaxMind account ID' });
    if (!licenseKey) return res.status(400).json({ error: 'Enter your MaxMind license key' });

    try {
        res.json(await configureMaxmind({ account_id: accountId, license_key: licenseKey, edition }));
    } catch (err) {
        log.warn(`Setup failed: ${(err as Error).message}`);
        res.status(400).json({ error: (err as Error).message });
    }
});

/** POST /api/geoip/upload - raw body: a City .mmdb, or the .tar.gz / .gz from MaxMind's download page */
router.post('/upload', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
    try {
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        res.json(await uploadMaxmind(body));
    } catch (err) {
        log.warn(`Upload failed: ${(err as Error).message}`);
        res.status(400).json({ error: (err as Error).message });
    }
});

/** DELETE /api/geoip/config - go back to the built-in location database */
router.delete('/config', (req, res) => {
    disableMaxmind();
    res.json(getMaxmindStatus());
});

export default router;
