import { Request, Response, NextFunction } from 'express';
import logger from '../services/logger.js';

const log = logger.child('HTTP');
const SLOW_REQUEST_MS = 3000;

/**
 * Logs every API request with status and duration.
 * Errors and slow requests are logged as warnings; routine polling stays at debug level.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api')) return next();

    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`;
        if (res.statusCode >= 500) log.error(line);
        else if (res.statusCode >= 400 && res.statusCode !== 401) log.warn(line);
        else if (ms >= SLOW_REQUEST_MS) log.warn(`Slow request: ${line}`);
        else log.debug(line);
    });
    next();
};
