import axios from 'axios';

// Cache the info to avoid spamming external services
let cachedPublicIp: string | null = null;
let lastPublicIpCheck = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

export const getPublicIp = async (): Promise<string | null> => {
    // 1. Check Env Override
    if (process.env.PUBLIC_IP) {
        return process.env.PUBLIC_IP;
    }

    const now = Date.now();
    if (cachedPublicIp && (now - lastPublicIpCheck < CACHE_DURATION)) {
        return cachedPublicIp;
    }

    const providers = [
        'https://api.ipify.org?format=json',
        'https://ifconfig.me/ip',
        'https://icanhazip.com'
    ];

    for (const url of providers) {
        try {
            const response = await axios.get(url, { timeout: 5000 });
            let ip = typeof response.data === 'object' ? response.data.ip : response.data;
            ip = ip.trim(); // Clean up newlines if any

            if (ip) {
                cachedPublicIp = ip;
                lastPublicIpCheck = now;
                return ip;
            }
        } catch (error) {
            console.warn(`[Network] Failed to fetch public IP from ${url}:`, error instanceof Error ? error.message : String(error));
            // Continue to next provider
        }
    }

    console.error('[Network] All public IP providers failed.');
    return null;
};
