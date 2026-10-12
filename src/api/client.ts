import axios from 'axios';

// API base URL - empty string means same origin (works for both dev and prod)
const API_BASE = '';

export const api = axios.create({
    baseURL: API_BASE,
    headers: {
        'Content-Type': 'application/json'
    }
});

// Server API
export interface ServerPayload {
    name: string;
    tautulli_url: string;
    api_key: string;
    plex_url?: string;
    plex_token?: string;
}

export const serversApi = {
    list: () => api.get('/api/servers'),
    add: (data: ServerPayload) =>
        api.post('/api/servers', data),
    update: (id: number, data: ServerPayload) =>
        api.put(`/api/servers/${id}`, data),
    delete: (id: number) => api.delete(`/api/servers/${id}`),
    checkStatus: (id: number) => api.get(`/api/servers/${id}/status`)
};

// Network API
export const networkApi = {
    getStatus: () => api.get('/api/network/status'),
    getSessions: () => api.get('/api/network/sessions')
};

// Stats API
export const statsApi = {
    getWatchStats: (params: { days: number; stat_type: string; server_id: string }) =>
        api.get('/api/stats', { params }),
    getUserDetails: (username: string, days: number = 30, server_id?: number | string | null) =>
        api.get(`/api/stats/user/${encodeURIComponent(username)}`, { params: { days, server_id } })
};

// Users API
export const usersApi = {
    list: (serverId: string) => api.get('/api/users', { params: { server_id: serverId } })
};

// Auth API
export const authApi = {
    getStatus: () => api.get('/api/auth/status'),
    setup: (password: string) => api.post('/api/auth/setup', { password }),
    login: (password: string) => api.post('/api/auth/login', { password }),
    logout: () => api.post('/api/auth/logout')
};

// System API
export const systemApi = {
    getVersion: () => api.get('/api/system/version'),
    update: () => api.post('/api/system/update')
};

// Image proxy helper
export const getImageProxyUrl = (serverId: number | string, img: string, width = 200) => {
    const params = new URLSearchParams({
        serverId: String(serverId),
        img,
        width: String(width)
    });

    const token = localStorage.getItem('plix_auth_token');
    if (token) {
        params.append('token', token);
    }

    return `/api/proxy/image?${params.toString()}`;
};

// Map API (tiles are proxied by the server so API keys stay server-side)
export interface MapConfig {
    provider: string;
    has_api_key: boolean;
    custom_url: string;
    day_night: boolean;
    labels: boolean;
    labels_max_zoom: number;
    labels_attribution: string;
    max_zoom: number;
    attribution: string;
    version: string;
    providers: Array<{ id: string; name: string; requires_key: boolean; signup_url?: string }>;
}

export const mapApi = {
    getConfig: () => api.get<MapConfig>('/api/map/config'),
    saveConfig: (data: { provider: string; api_key?: string; custom_url?: string; day_night?: boolean; labels?: boolean }) =>
        api.put<MapConfig>('/api/map/config', data)
};

export const getMapTileUrl = (version: string) => {
    const params = new URLSearchParams({ v: version });
    const token = localStorage.getItem('plix_auth_token');
    if (token) params.append('token', token);
    return `/api/map/tiles/{z}/{x}/{y}.png?${params.toString()}`;
};

export const getMapLabelsUrl = () => {
    const params = new URLSearchParams();
    const token = localStorage.getItem('plix_auth_token');
    if (token) params.append('token', token);
    const query = params.toString();
    return `/api/map/labels/{z}/{x}/{y}.png${query ? `?${query}` : ''}`;
};

// Geolocation (optional MaxMind database)
export interface GeoipStatus {
    enabled: boolean;
    account_id: string;
    has_license_key: boolean;
    edition: 'GeoLite2-City' | 'GeoIP2-City';
    database_date: string | null;
    downloaded_at: string | null;
    source: 'download' | 'upload' | null;
    last_error: string | null;
}

export const geoipApi = {
    getConfig: () => api.get<GeoipStatus>('/api/geoip/config'),
    saveConfig: (data: { account_id: string; license_key?: string; edition: string }) =>
        api.put<GeoipStatus>('/api/geoip/config', data),
    upload: (file: File) =>
        api.post<GeoipStatus>('/api/geoip/upload', file, {
            headers: { 'Content-Type': 'application/octet-stream' },
            timeout: 5 * 60 * 1000
        }),
    disable: () => api.delete<GeoipStatus>('/api/geoip/config')
};

// Plain-text application log (opened in a new tab, so the token goes in the query string)
export const getLogsUrl = (lines = 1000) => {
    const params = new URLSearchParams({ lines: String(lines) });
    const token = localStorage.getItem('plix_auth_token');
    if (token) params.append('token', token);
    return `/api/system/logs?${params.toString()}`;
};

// Request interceptor for adding token
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('plix_auth_token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});
