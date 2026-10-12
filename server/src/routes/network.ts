import { Router } from 'express';
import { getAllServersWithKeys } from './servers.js';
import { NetworkStatus } from '../types.js';
import { buildActiveSessions, getLiveActivityForAll, getServerUserKeys } from '../services/live.js';
import logger from '../services/logger.js';

const router = Router();
const log = logger.child('Network');

/**
 * GET /api/network/status - Full network status (polled less frequently)
 *
 * Live activity and the user list are fetched independently per server, so a slow
 * activity call on one server no longer removes that server's users from the total.
 */
router.get('/status', async (req, res) => {
    try {
        const servers = getAllServersWithKeys();

        if (servers.length === 0) {
            return res.json({
                total_bandwidth: 0,
                total_stream_count: 0,
                total_transcodes: 0,
                total_users: 0,
                active_sessions: [],
                servers: []
            });
        }

        const [liveResults, userKeys] = await Promise.all([
            getLiveActivityForAll(servers),
            Promise.all(servers.map((server) => getServerUserKeys(server)))
        ]);

        const globalUniqueUsers = new Set<string>();
        userKeys.forEach((keys) => keys?.forEach((k) => globalUniqueUsers.add(k)));

        const live = await buildActiveSessions(liveResults);
        const offlineServers = liveResults.filter((r) => !r.activity).length;

        const response: NetworkStatus = {
            total_bandwidth: live.total_bandwidth,
            total_stream_count: live.total_stream_count,
            total_transcodes: live.total_transcodes,
            total_users: globalUniqueUsers.size,
            active_sessions: live.sessions,
            offline_servers_count: offlineServers,
            total_servers_count: servers.length,
            servers: liveResults.map((r, i) => ({
                id: r.server.id,
                name: r.server.name,
                online: !!r.activity,
                live_source: r.activity?.source,
                error: r.error,
                user_count: userKeys[i]?.length ?? null
            }))
        };

        res.json(response);
    } catch (error) {
        log.error('Critical error building network status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/network/sessions - Active sessions only (polled frequently)
 */
router.get('/sessions', async (req, res) => {
    try {
        const servers = getAllServersWithKeys();

        if (servers.length === 0) {
            return res.json({ active_sessions: [], total_stream_count: 0, total_bandwidth: 0, total_transcodes: 0 });
        }

        const liveResults = await getLiveActivityForAll(servers);
        const live = await buildActiveSessions(liveResults);

        res.json({
            active_sessions: live.sessions,
            total_stream_count: live.total_stream_count,
            total_bandwidth: live.total_bandwidth,
            total_transcodes: live.total_transcodes,
            offline_servers_count: liveResults.filter((r) => !r.activity).length,
            total_servers_count: servers.length
        });
    } catch (error) {
        log.error('Critical error fetching sessions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
