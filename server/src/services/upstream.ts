import axios from 'axios';
import http from 'http';
import https from 'https';

/**
 * Shared HTTP client for Tautulli and Plex.
 *
 * Keep-alive agents reuse connections between the frequent polling requests instead of
 * opening a new TCP (and TLS) connection for every call.
 *
 * ALLOW_INSECURE_TLS=true accepts self-signed certificates (e.g. https://192.168.1.10:8181).
 */
export const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === 'true';

export const upstream = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 32 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: !ALLOW_INSECURE_TLS }),
    headers: { 'User-Agent': 'PlixMetrics' }
});

export type UpstreamErrorKind = 'timeout' | 'unreachable' | 'tls' | 'auth' | 'http' | 'api' | 'invalid_response';

export class UpstreamError extends Error {
    constructor(public kind: UpstreamErrorKind, message: string, public status?: number) {
        super(message);
        this.name = 'UpstreamError';
    }
}

const TLS_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'EPROTO'
]);

/** Turn any axios/network error into an UpstreamError with a message a user can act on. */
export function toUpstreamError(err: any, timeoutMs: number, service: 'Tautulli' | 'Plex'): UpstreamError {
    if (err instanceof UpstreamError) return err;

    const code: string | undefined = err?.code;
    const status: number | undefined = err?.response?.status;

    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(err?.message || '')) {
        return new UpstreamError('timeout', `${service} did not answer within ${Math.round(timeoutMs / 1000)}s`);
    }
    if (code === 'ECONNREFUSED') {
        return new UpstreamError('unreachable', `Connection refused - is ${service} running and is the port correct?`);
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new UpstreamError('unreachable', `Host name not found - check the ${service} URL`);
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET' || code === 'EPIPE') {
        return new UpstreamError('unreachable', `${service} host unreachable (${code})`);
    }
    if (code && TLS_CODES.has(code)) {
        return new UpstreamError('tls', `HTTPS certificate not trusted (${code}). Use http://, or set ALLOW_INSECURE_TLS=true for self-signed certificates`);
    }
    if (status === 401 || status === 403) {
        const apiMessage = err?.response?.data?.response?.message;
        return new UpstreamError('auth', apiMessage || (service === 'Plex' ? 'Plex token rejected' : 'API key rejected'), status);
    }
    if (status) {
        const hint = status === 404 ? ` - check the URL (include any base path, e.g. /tautulli)` : '';
        return new UpstreamError('http', `${service} returned HTTP ${status}${hint}`, status);
    }
    return new UpstreamError('unreachable', err?.message || `Could not reach ${service}`);
}

/** Strip trailing slashes and add http:// when no scheme was given. */
export function normalizeUrl(url: string): string {
    let clean = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`;
    return clean;
}
