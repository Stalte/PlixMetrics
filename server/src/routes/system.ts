
import express from 'express';
import { SystemService } from '../services/system.js';
import { AuthService } from '../services/auth.js';
import { readLogTail, LOG_FILE } from '../services/logger.js';

const router = express.Router();

// Get Version Info (Publicly accessible or protected? Let's protect it but maybe allow read-only)
// For now, let's protect it to be safe, or check auth inside.
// Actually, version info could be public. But 'update' must be admin.

router.get('/version', async (req, res) => {
    const info = await SystemService.checkUpdate();
    res.json(info);
});

// Trigger Update (Admin only)
router.post('/update', async (req, res) => {
    // Double check auth here just in case middleware was missed, 
    // but typically handled by checkAuth in index.ts.
    // However, system updates are CRITICAL, so strict check.

    // For now, relying on index.ts checkAuth is fine as it blocks non-admins.

    try {
        // Start update in background? 
        // Or wait? 'git pull' is fast, 'npm install' is slow.
        // Let's not wait for the whole thing to finish, or it will timeout.

        SystemService.update().catch(err => {
            console.error('Update background process failed:', err);
        });

        res.json({ message: 'Update started. The server will update and may restart.' });
    } catch (e) {
        res.status(500).json({ error: (e as Error).message });
    }
});

// Recent application log lines as plain text (GET /api/system/logs?lines=500)
router.get('/logs', (req, res) => {
    const lines = Math.min(Math.max(parseInt(req.query.lines as string, 10) || 500, 1), 10000);
    try {
        res.type('text/plain').send(readLogTail(lines) || `No log entries yet (${LOG_FILE})`);
    } catch (e) {
        res.status(500).json({ error: (e as Error).message });
    }
});

export default router;
