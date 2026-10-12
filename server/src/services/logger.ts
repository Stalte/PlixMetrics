import fs from 'fs';
import path from 'path';
import util from 'util';

/**
 * Application logger.
 *
 * Writes to the console and to a size-rotated file at DATA_DIR/logs/plixmetrics.log.
 * Configure with:
 *   LOG_LEVEL      debug | info | warn | error   (default: info)
 *   LOG_DIR        directory for log files        (default: DATA_DIR/logs)
 *   LOG_MAX_BYTES  rotate after this many bytes   (default: 5 MB)
 *   LOG_MAX_FILES  rotated files to keep           (default: 5)
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const DATA_DIR = process.env.DATA_DIR || './data';
export const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'plixmetrics.log');
const MAX_BYTES = parseInt(process.env.LOG_MAX_BYTES || '', 10) || 5 * 1024 * 1024;
const MAX_FILES = parseInt(process.env.LOG_MAX_FILES || '', 10) || 5;

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
const minLevel = LEVELS[envLevel] ?? LEVELS.info;

// Keep references to the real console before we patch it.
const rawConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
};

let fileEnabled = true;
let currentSize = 0;

try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    currentSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
} catch (err) {
    fileEnabled = false;
    rawConsole.error('[Logger] Could not create log directory, file logging disabled:', err);
}

function rotate(): void {
    try {
        for (let i = MAX_FILES - 1; i >= 1; i--) {
            const src = `${LOG_FILE}.${i}`;
            if (fs.existsSync(src)) fs.renameSync(src, `${LOG_FILE}.${i + 1}`);
        }
        const oldest = `${LOG_FILE}.${MAX_FILES}`;
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
        currentSize = 0;
    } catch (err) {
        rawConsole.error('[Logger] Log rotation failed:', err);
    }
}

function writeFile(line: string): void {
    if (!fileEnabled) return;
    try {
        if (currentSize + line.length > MAX_BYTES) rotate();
        fs.appendFileSync(LOG_FILE, line);
        currentSize += Buffer.byteLength(line);
    } catch (err) {
        fileEnabled = false;
        rawConsole.error('[Logger] Writing log file failed, file logging disabled:', err);
    }
}

/** Remove secrets (Tautulli API keys, Plex tokens, JWTs) from log text. */
export function redact(text: string): string {
    return text
        .replace(/(apikey=)[^&\s"']+/gi, '$1***')
        .replace(/(X-Plex-Token=)[^&\s"']+/gi, '$1***')
        .replace(/("?(?:api_key|api_key_secret|apikey|plex_token|X-Plex-Token|token|password)"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"')
        .replace(/(token=)[^&\s"']+/gi, '$1***')
        .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1***');
}

/** Summarise an axios error in one line instead of dumping the whole request object. */
function formatAxiosError(err: any): string {
    const url = err.config?.url ? ` ${err.config.method?.toUpperCase() || 'GET'} ${err.config.url}` : '';
    const params = err.config?.params?.cmd ? ` cmd=${err.config.params.cmd}` : '';
    const status = err.response?.status ? ` HTTP ${err.response.status}` : '';
    const code = err.code ? ` ${err.code}` : '';
    return `AxiosError${code}${status}:${url}${params} - ${err.message}`;
}

function formatArg(arg: unknown): string {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object' && (arg as any).isAxiosError) return formatAxiosError(arg);
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    return util.inspect(arg, { depth: 4, breakLength: 160 });
}

function emit(level: Level, scope: string | null, args: unknown[]): void {
    if (LEVELS[level] < minLevel) return;
    const message = redact(args.map(formatArg).join(' '));
    const prefix = scope ? `[${scope}] ` : '';
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix}${message}`;

    const out = level === 'error' ? rawConsole.error : level === 'warn' ? rawConsole.warn : rawConsole.log;
    out(line);
    writeFile(line + '\n');
}

export interface Logger {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    child: (scope: string) => Logger;
}

function createLogger(scope: string | null): Logger {
    return {
        debug: (...args) => emit('debug', scope, args),
        info: (...args) => emit('info', scope, args),
        warn: (...args) => emit('warn', scope, args),
        error: (...args) => emit('error', scope, args),
        child: (childScope: string) => createLogger(scope ? `${scope}:${childScope}` : childScope)
    };
}

export const logger = createLogger(null);

/**
 * Route existing console.* calls (ours and third-party) through the logger so
 * everything ends up in the log file with timestamps and secrets redacted.
 */
let consoleCaptured = false;
export function installConsoleCapture(): void {
    if (consoleCaptured) return;
    consoleCaptured = true;
    console.log = (...args: unknown[]) => emit('info', null, args);
    console.info = (...args: unknown[]) => emit('info', null, args);
    console.warn = (...args: unknown[]) => emit('warn', null, args);
    console.error = (...args: unknown[]) => emit('error', null, args);
    console.debug = (...args: unknown[]) => emit('debug', null, args);

    // Record fatal errors before the process exits (Node's default behaviour is kept).
    process.on('uncaughtException', (err) => {
        emit('error', 'Process', ['Uncaught exception, exiting:', err]);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        emit('error', 'Process', ['Unhandled promise rejection, exiting:', reason]);
        process.exit(1);
    });
}

/** Return the last `lines` lines of the current log file. */
export function readLogTail(lines: number): string {
    if (!fs.existsSync(LOG_FILE)) return '';
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const all = content.split('\n');
    return all.slice(Math.max(0, all.length - lines - 1)).join('\n');
}

// Installed on import so logs written while other modules load (e.g. DB init) are captured too.
installConsoleCapture();

export default logger;
