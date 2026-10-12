import { Router } from 'express';
import db from '../db/index.js';
import { PlexServer } from '../types.js';
import { clearServerCaches } from '../services/cache.js';
import { checkTautulli } from '../services/tautulli.js';
import { normalizeUrl } from '../services/upstream.js';
import logger from '../services/logger.js';

const router = Router();
const log = logger.child('Servers');

/**
 * GET /api/servers - List all servers
 */
router.get('/', (req, res) => {
    try {
        const stmt = db.prepare('SELECT id, name, tautulli_url, api_key_secret, created_at FROM servers ORDER BY created_at DESC');
        const servers = stmt.all();
        res.json(servers);
    } catch (error) {
        log.error('Error listing servers:', error);
        res.status(500).json({ error: 'Failed to list servers' });
    }
});

/**
 * POST /api/servers - Add a new server
 */
router.post('/', async (req, res) => {
    const { name, tautulli_url } = req.body;
    const api_key = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : req.body.api_key;

    if (!name || !tautulli_url || !api_key) {
        return res.status(400).json({ error: 'Missing required fields: name, tautulli_url, api_key' });
    }

    const cleanUrl = normalizeUrl(tautulli_url);

    // Test connection
    const check = await checkTautulli({ name, tautulli_url: cleanUrl, api_key_secret: api_key }, 15000);
    if (!check.ok) {
        log.warn(`Connection test for "${name}" (${cleanUrl}) failed: ${check.error}`);
        return res.status(400).json({ error: `Could not connect to Tautulli: ${check.error}` });
    }

    // Save to database
    try {
        const stmt = db.prepare('INSERT INTO servers (name, tautulli_url, api_key_secret) VALUES (?, ?, ?)');
        const result = stmt.run(name, cleanUrl, api_key);
        clearServerCaches();

        res.json({
            success: true,
            message: 'Server added successfully',
            id: result.lastInsertRowid
        });
    } catch (error) {
        log.error('Error adding server:', error);
        res.status(500).json({ error: 'Failed to save server' });
    }
});

/**
 * PUT /api/servers/:id - Update a server
 */
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, tautulli_url } = req.body;
    const api_key = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : req.body.api_key;

    if (!name || !tautulli_url || !api_key) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const cleanUrl = normalizeUrl(tautulli_url);

    // Test connection
    const check = await checkTautulli({ name, tautulli_url: cleanUrl, api_key_secret: api_key }, 15000);
    if (!check.ok) {
        log.warn(`Connection test for "${name}" (${cleanUrl}) failed: ${check.error}`);
        return res.status(400).json({ error: `Could not connect to Tautulli: ${check.error}` });
    }

    // Update database
    try {
        const stmt = db.prepare('UPDATE servers SET name = ?, tautulli_url = ?, api_key_secret = ? WHERE id = ?');
        stmt.run(name, cleanUrl, api_key, id);
        clearServerCaches();

        res.json({ success: true, message: 'Server updated successfully' });
    } catch (error) {
        log.error('Error updating server:', error);
        res.status(500).json({ error: 'Failed to update server' });
    }
});

/**
 * DELETE /api/servers/:id - Delete a server
 */
router.delete('/:id', (req, res) => {
    const { id } = req.params;

    try {
        const stmt = db.prepare('DELETE FROM servers WHERE id = ?');
        stmt.run(id);
        clearServerCaches();

        res.json({ success: true, message: 'Server deleted successfully' });
    } catch (error) {
        log.error('Error deleting server:', error);
        res.status(500).json({ error: 'Failed to delete server' });
    }
});

/**
 * GET /api/servers/:id/status - Check a server's connection
 */
router.get('/:id/status', async (req, res) => {
    const { id } = req.params;
    try {
        const stmt = db.prepare('SELECT id, name, tautulli_url, api_key_secret FROM servers WHERE id = ?');
        const server = stmt.get(id) as PlexServer | undefined;

        if (!server) {
            return res.status(404).json({ error: 'Server not found' });
        }

        const check = await checkTautulli({ ...server, id: Number(id) });
        if (check.ok) {
            res.json({ status: 'online', tautulli: { status: 'online', latency_ms: check.latency_ms } });
        } else {
            res.json({ status: 'offline', error: check.error, tautulli: { status: 'offline', error: check.error } });
        }
    } catch (error) {
        log.error(`Status check for server ${id} failed:`, error);
        res.json({ status: 'offline', error: 'Internal error while checking the server' });
    }
});


/**
 * Helper: Get all servers with API keys (internal use only)
 */
export function getAllServersWithKeys(): PlexServer[] {
    const stmt = db.prepare('SELECT * FROM servers');
    return stmt.all() as PlexServer[];
}

export default router;
