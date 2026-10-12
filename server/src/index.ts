// Must be first: installs file logging before other modules start writing logs.
import logger, { LOG_FILE } from './services/logger.js';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';

// Import routes
import serversRouter from './routes/servers.js';
import networkRouter from './routes/network.js';
import statsRouter from './routes/stats.js';
import proxyRouter from './routes/proxy.js';
import usersRouter from './routes/users.js';
import configRouter from './routes/config.js';
import authRouter from './routes/auth.js';
import analyticsRouter from './routes/analytics.js';
import systemRouter from './routes/system.js';
import mapRouter from './routes/map.js';

// Middleware imports
import { checkAuth } from './middleware/auth.js';
import { requestLogger } from './middleware/requestLogger.js';
import { cacheResponse } from './services/cache.js';

// Initialize database (will create tables if not exist)
import './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8282;

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Public Routes (Auth endpoints themselves)
app.use('/api/auth', authRouter);

// Protected API Routes (Bypass for localhost, Require Token for others)
app.use('/api/servers', checkAuth, serversRouter);
// Short caches share one upstream fetch between open dashboards; history data changes slowly.
const LIVE_CACHE_MS = 3 * 1000;
const HISTORY_CACHE_MS = 5 * 60 * 1000;
app.use('/api/network', checkAuth, cacheResponse(LIVE_CACHE_MS), networkRouter);
app.use('/api/stats', checkAuth, cacheResponse(HISTORY_CACHE_MS), statsRouter);
app.use('/api/analytics', checkAuth, cacheResponse(HISTORY_CACHE_MS), analyticsRouter);
app.use('/api/proxy', checkAuth, proxyRouter);
app.use('/api/users', checkAuth, cacheResponse(HISTORY_CACHE_MS), usersRouter);
app.use('/api/config', checkAuth, configRouter);
app.use('/api/system', checkAuth, systemRouter);
app.use('/api/map', checkAuth, mapRouter);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files from the frontend build
const staticPath = path.join(__dirname, '../../dist');
// Vite puts a content hash in asset file names, so they can be cached for good.
app.use('/assets', express.static(path.join(staticPath, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(staticPath));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(staticPath, 'index.html'));
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

app.listen(PORT, () => {
    logger.info(`Log level: ${process.env.LOG_LEVEL || 'info'}, log file: ${LOG_FILE}`);
    console.log(`
╔═══════════════════════════════════════════════╗
║              PlixMetrics Server               ║
╠═══════════════════════════════════════════════╣
║  🚀 Server running on http://localhost:${PORT}   ║
║  📁 Static files from: ${staticPath.slice(-20).padStart(20)}  ║
║  💾 Data stored in: ${(process.env.DATA_DIR || './data').slice(-20).padStart(24)}  ║
╚═══════════════════════════════════════════════╝
    `);
});

export default app;
