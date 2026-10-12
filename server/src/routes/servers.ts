import { Router } from 'express';
import db from '../db/index.js';
import { PlexServer } from '../types.js';
import { clearServerCaches } from '../services/cache.js';
import { checkTautulli } from '../services/tautulli.js';
import { checkPlex, hasPlex } from '../services/plex.js';
import { resetLiveState } from '../services/live.js';
import { normalizeUrl } from '../services/upstream.js';
import logger from '../services/logger.js';

const router = Router();
const log = logger.child('Servers');

/**
 * GET /api/servers - List all servers
 */
router.get('/', (req, res) => {
    try {
        const stmt = db.prepare('SELECT id, name, tautulli_url, api_key_secret, plex_url, plex_token, created_at FROM servers ORDER BY created_at DESC');
        const servers = stmt.all();
        res.json(servers);
    } catch (error) {
        log.error('Error listing servers:', error);
        res.status(500).json({ error: 'Failed to list servers' });
    }
});

interface ServerInput {
    name: string;
    tautulli_url: string;
    api_key: string;
    plex_url: string | null;
    plex_token: string | null;
}

/**
 * Validate the request body and test the connections.
 * Returns the cleaned values, or an error message for a 400 response.
 */
async function validateServerInput(body: any): Promise<{ value: ServerInput } | { error: string }> {
    const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const name = trim(body.name);
    const rawTautulliUrl = trim(body.tautulli_url);
    const api_key = trim(body.api_key);
    const rawPlexUrl = trim(body.plex_url);
    const plex_token = trim(body.plex_token);

    if (!name || !rawTautulliUrl || !api_key) {
        return { error: 'Missing required fields: name, tautulli_url, api_key' };
    }
    if (Boolean(rawPlexUrl) !== Boolean(plex_token)) {
        return { error: 'To connect Plex directly, fill in both the Plex URL and the Plex token (or leave both empty)' };
    }

    const value: ServerInput = {
        name,
        tautulli_url: normalizeUrl(rawTautulliUrl),
        api_key,
        plex_url: rawPlexUrl ? normalizeUrl(rawPlexUrl) : null,
        plex_token: plex_token || null
    };

    const [tautulliCheck, plexCheck] = await Promise.all([
        checkTautulli({ name, tautulli_url: value.tautulli_url, api_key_secret: api_key }, 15000),
        hasPlex(value) ? checkPlex(value, 10000) : Promise.resolve(null)
    ]);

    if (!tautulliCheck.ok) {
        log.warn(`Connection test for "${name}" (${value.tautulli_url}) failed: ${tautulliCheck.error}`);
        return { error: `Could not connect to Tautulli: ${tautulliCheck.error}` };
    }
    if (plexCheck && !plexCheck.ok) {
        log.warn(`Plex connection test for "${name}" (${value.plex_url}) failed: ${plexCheck.error}`);
        return { error: `Could not connect to Plex: ${plexCheck.error}` };
    }
    return { value };
}

/**
 * POST /api/servers - Add a new server
 */
router.post('/', async (req, res) => {
    const result = await validateServerInput(req.body);
    if ('error' in result) return res.status(400).json({ error: result.error });
    const { name, tautulli_url, api_key, plex_url, plex_token } = result.value;

    // Save to database
    try {
        const stmt = db.prepare('INSERT INTO servers (name, tautulli_url, api_key_secret, plex_url, plex_token) VALUES (?, ?, ?, ?, ?)');
        const inserted = stmt.run(name, tautulli_url, api_key, plex_url, plex_token);
        clearServerCaches();
        log.info(`Added server "${name}" (${tautulli_url}${plex_url ? `, Plex ${plex_url}` : ''})`);

        res.json({
            success: true,
            message: 'Server added successfully',
            id: inserted.lastInsertRowid
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
    const result = await validateServerInput(req.body);
    if ('error' in result) return res.status(400).json({ error: result.error });
    const { name, tautulli_url, api_key, plex_url, plex_token } = result.value;

    // Update database
    try {
        const stmt = db.prepare('UPDATE servers SET name = ?, tautulli_url = ?, api_key_secret = ?, plex_url = ?, plex_token = ? WHERE id = ?');
        stmt.run(name, tautulli_url, api_key, plex_url, plex_token, id);
        clearServerCaches();
        resetLiveState(Number(id));
        log.info(`Updated server "${name}" (${tautulli_url}${plex_url ? `, Plex ${plex_url}` : ''})`);

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
        const stmt = db.prepare('SELECT * FROM servers WHERE id = ?');
        const server = stmt.get(id) as PlexServer | undefined;

        if (!server) {
            return res.status(404).json({ error: 'Server not found' });
        }

        const [tautulliCheck, plexCheck] = await Promise.all([
            checkTautulli(server),
            hasPlex(server) ? checkPlex(server) : Promise.resolve(null)
        ]);

        const tautulliStatus = tautulliCheck.ok
            ? { status: 'online', latency_ms: tautulliCheck.latency_ms }
            : { status: 'offline', error: tautulliCheck.error };
        const plexStatus = plexCheck === null
            ? null
            : plexCheck.ok
                ? { status: 'online', latency_ms: plexCheck.latency_ms }
                : { status: 'offline', error: plexCheck.error };

        // online: everything configured answers; degraded: one of Tautulli/Plex fails
        const failures = [
            !tautulliCheck.ok ? `Tautulli: ${tautulliCheck.error}` : null,
            plexCheck && !plexCheck.ok ? `Plex: ${plexCheck.error}` : null
        ].filter(Boolean) as string[];
        const anyOnline = tautulliCheck.ok || (plexCheck?.ok ?? false);
        const status = failures.length === 0 ? 'online' : anyOnline ? 'degraded' : 'offline';

        res.json({ status, error: failures.join(' / ') || undefined, tautulli: tautulliStatus, plex: plexStatus });
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
