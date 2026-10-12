import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import maxmind, { CityResponse, Reader } from 'maxmind';
import { upstream } from './upstream.js';
import db from '../db/index.js';
import logger from './logger.js';

/**
 * Optional MaxMind GeoLite2 / GeoIP2 City database for more accurate IP locations than the
 * built-in geoip-lite data. The database is downloaded with the user's MaxMind account ID
 * and license key, stored in DATA_DIR/geoip and refreshed weekly.
 */

const log = logger.child('MaxMind');

const DATA_DIR = process.env.DATA_DIR || './data';
const GEOIP_DIR = path.join(DATA_DIR, 'geoip');
const DOWNLOAD_BASE = process.env.MAXMIND_DOWNLOAD_URL || 'https://download.maxmind.com/geoip/databases';
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export const MAXMIND_EDITIONS = ['GeoLite2-City', 'GeoIP2-City'] as const;
export type MaxmindEdition = typeof MAXMIND_EDITIONS[number];

export interface MaxmindSettings {
    account_id: string;
    license_key: string;
    edition: MaxmindEdition;
}

export interface MaxmindStatus {
    enabled: boolean;
    account_id: string;
    has_license_key: boolean;
    edition: MaxmindEdition;
    database_date: string | null;
    downloaded_at: string | null;
    /** Where the loaded database came from. */
    source: 'download' | 'upload' | null;
    last_error: string | null;
}

let reader: Reader<CityResponse> | null = null;
let databaseDate: string | null = null;
let lastError: string | null = null;
let loadedSource: MaxmindStatus['source'] = null;
let onReload: (() => void) | null = null;

const KEYS = {
    account_id: 'maxmind_account_id',
    license_key: 'maxmind_license_key',
    edition: 'maxmind_edition',
    downloaded_at: 'maxmind_downloaded_at'
} as const;

function readConfig(key: string): string {
    const row = db.prepare('SELECT value FROM system_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? '';
}

function writeConfig(key: string, value: string): void {
    db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getMaxmindSettings(): MaxmindSettings {
    const edition = readConfig(KEYS.edition) as MaxmindEdition;
    return {
        account_id: readConfig(KEYS.account_id),
        license_key: readConfig(KEYS.license_key),
        edition: MAXMIND_EDITIONS.includes(edition) ? edition : 'GeoLite2-City'
    };
}

export function getMaxmindStatus(): MaxmindStatus {
    const settings = getMaxmindSettings();
    return {
        enabled: reader !== null,
        account_id: settings.account_id,
        has_license_key: Boolean(settings.license_key),
        edition: settings.edition,
        database_date: databaseDate,
        downloaded_at: readConfig(KEYS.downloaded_at) || null,
        source: reader ? loadedSource : null,
        last_error: lastError
    };
}

/** Called after a (new) database is loaded, so cached locations from the old source can be dropped. */
export function onMaxmindReload(callback: () => void): void {
    onReload = callback;
}

function dbPath(edition: string): string {
    return path.join(GEOIP_DIR, `${edition}.mmdb`);
}

/** A database the user uploaded in the app instead of giving credentials. */
const UPLOADED_PATH = path.join(GEOIP_DIR, 'uploaded.mmdb');

async function loadDatabase(file: string, source: 'download' | 'upload' = 'download'): Promise<void> {
    const next = await maxmind.open<CityResponse>(file);
    reader = next;
    loadedSource = source;
    databaseDate = new Date(next.metadata.buildEpoch).toISOString().slice(0, 10);
    lastError = null;
    log.info(`Loaded ${path.basename(file)} (built ${databaseDate})`);
    onReload?.();
}

/** Download the database with the given credentials, then load it. Throws a readable error. */
async function download(settings: MaxmindSettings): Promise<string> {
    fs.mkdirSync(GEOIP_DIR, { recursive: true });
    const archive = path.join(GEOIP_DIR, `${settings.edition}.tar.gz.download`);
    const extractDir = path.join(GEOIP_DIR, `${settings.edition}.extract`);

    try {
        const response = await upstream.get(`${DOWNLOAD_BASE}/${settings.edition}/download?suffix=tar.gz`, {
            auth: { username: settings.account_id, password: settings.license_key },
            responseType: 'stream',
            timeout: 5 * 60 * 1000,
            maxRedirects: 5
        });
        await pipeline(response.data, fs.createWriteStream(archive));
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 401) throw new Error('MaxMind rejected the account ID or license key');
        if (status === 403) throw new Error(`This MaxMind account cannot download ${settings.edition}`);
        throw new Error(`Downloading the MaxMind database failed: ${status ? `HTTP ${status}` : err.message}`);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    try {
        await tar.x({ file: archive, cwd: extractDir, filter: (p) => p.endsWith('.mmdb') });
        const found = findMmdb(extractDir);
        if (!found) throw new Error('The downloaded archive did not contain a .mmdb file');
        const target = dbPath(settings.edition);
        fs.renameSync(found, `${target}.new`);
        // Validate before replacing the working copy
        try {
            await maxmind.open<CityResponse>(`${target}.new`);
        } catch (err) {
            fs.rmSync(`${target}.new`, { force: true });
            throw new Error(`The downloaded MaxMind database could not be read (${(err as Error).message})`);
        }
        fs.renameSync(`${target}.new`, target);
        return target;
    } finally {
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.rmSync(archive, { force: true });
    }
}

function findMmdb(dir: string): string | null {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = findMmdb(full);
            if (nested) return nested;
        } else if (entry.name.endsWith('.mmdb')) {
            return full;
        }
    }
    return null;
}

/** Save credentials, download the database and switch lookups to it. */
export async function configureMaxmind(settings: MaxmindSettings): Promise<MaxmindStatus> {
    const file = await download(settings);
    writeConfig(KEYS.account_id, settings.account_id);
    writeConfig(KEYS.license_key, settings.license_key);
    writeConfig(KEYS.edition, settings.edition);
    writeConfig(KEYS.downloaded_at, new Date().toISOString());
    await loadDatabase(file);
    return getMaxmindStatus();
}

/** Forget the credentials and go back to the built-in database. */
export function disableMaxmind(): void {
    for (const key of Object.values(KEYS)) db.prepare('DELETE FROM system_config WHERE key = ?').run(key);
    reader = null;
    databaseDate = null;
    lastError = null;
    loadedSource = null;
    fs.rmSync(GEOIP_DIR, { recursive: true, force: true });
    log.info('MaxMind disabled, using the built-in location database');
    onReload?.();
}

async function refreshIfDue(): Promise<void> {
    const settings = getMaxmindSettings();
    if (!settings.account_id || !settings.license_key) {
        if (!reader && fs.existsSync(UPLOADED_PATH)) await loadDatabase(UPLOADED_PATH, 'upload');
        return;
    }

    const downloadedAt = Date.parse(readConfig(KEYS.downloaded_at) || '') || 0;
    const file = dbPath(settings.edition);
    if (fs.existsSync(file) && Date.now() - downloadedAt < REFRESH_INTERVAL_MS) {
        if (!reader) await loadDatabase(file);
        return;
    }

    try {
        log.info(`Updating ${settings.edition}...`);
        await loadDatabase(await download(settings));
        writeConfig(KEYS.downloaded_at, new Date().toISOString());
    } catch (err) {
        lastError = (err as Error).message;
        log.warn(`Update failed: ${lastError}`);
        // Keep using the previous copy if there is one
        if (!reader && fs.existsSync(file)) await loadDatabase(file).catch(() => { /* ignore */ });
        if (!reader && fs.existsSync(UPLOADED_PATH)) await loadDatabase(UPLOADED_PATH, 'upload').catch(() => { /* ignore */ });
    }
}

/**
 * Use a database file uploaded in the app: the .mmdb itself, or the .tar.gz / .gz that
 * MaxMind's download page offers. Only City databases are accepted, since Country and ASN
 * databases cannot place a stream more precisely than the built-in data.
 */
export async function uploadMaxmind(data: Buffer): Promise<MaxmindStatus> {
    if (data.length === 0) throw new Error('The uploaded file is empty');
    fs.mkdirSync(GEOIP_DIR, { recursive: true });
    const work = path.join(GEOIP_DIR, 'upload.work');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });

    try {
        let mmdb: string | null;
        const gzipped = data[0] === 0x1f && data[1] === 0x8b;
        const content = gzipped ? zlib.gunzipSync(data) : data;
        const isTar = content.length > 262 && content.toString('latin1', 257, 262) === 'ustar';
        if (isTar) {
            const archive = path.join(work, 'upload.tar');
            fs.writeFileSync(archive, content);
            await tar.x({ file: archive, cwd: work, filter: (p) => p.endsWith('.mmdb') });
            mmdb = findMmdb(work);
            if (!mmdb) throw new Error('The archive does not contain a .mmdb file');
        } else {
            mmdb = path.join(work, 'upload.mmdb');
            fs.writeFileSync(mmdb, content);
        }

        let check: Reader<CityResponse>;
        try {
            check = await maxmind.open<CityResponse>(mmdb);
        } catch (err) {
            throw new Error(`This is not a MaxMind database file (${(err as Error).message})`);
        }
        const type = check.metadata.databaseType;
        if (!/City/i.test(type)) {
            throw new Error(`This is a ${type} database. Upload the GeoLite2 City (or GeoIP2 City) .mmdb or .tar.gz instead`);
        }

        fs.renameSync(mmdb, UPLOADED_PATH);
        await loadDatabase(UPLOADED_PATH, 'upload');
        return getMaxmindStatus();
    } catch (err: any) {
        if (err?.code === 'Z_DATA_ERROR' || err?.code === 'Z_BUF_ERROR') throw new Error('The file looks gzipped but could not be unpacked');
        throw err;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/** Load the saved database on startup and keep it up to date. */
export function startMaxmind(): void {
    refreshIfDue().catch((err) => log.warn('Startup load failed:', err));
    setInterval(() => refreshIfDue().catch(() => { /* logged inside */ }), CHECK_INTERVAL_MS).unref();
}

export interface MaxmindLocation {
    lat: number;
    lon: number;
    city?: string;
    region?: string;
    country?: string;
    accuracy_km?: number;
}

export function maxmindLookup(ip: string): MaxmindLocation | null {
    if (!reader) return null;
    try {
        const result = reader.get(ip);
        const loc = result?.location;
        if (!loc || loc.latitude === undefined || loc.longitude === undefined) return null;
        return {
            lat: loc.latitude,
            lon: loc.longitude,
            city: result?.city?.names?.en,
            region: result?.subdivisions?.[0]?.names?.en,
            country: result?.country?.iso_code,
            accuracy_km: loc.accuracy_radius
        };
    } catch {
        return null;
    }
}
