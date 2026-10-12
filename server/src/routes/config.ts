import express from 'express';
import os from 'os';
import { getPublicIp } from '../services/publicIp.js';

const router = express.Router();

interface NetworkInfo {
    localIp: string | null;
    publicIp: string | null;
    port: number;
}

const getLocalIp = (): string | null => {
    // 1. Check Env Override (for Docker)
    if (process.env.HOST_IP) {
        return process.env.HOST_IP;
    }

    // 2. Auto-detect
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return null;
};

router.get('/info', async (req, res) => {
    const localIp = getLocalIp();
    const publicIp = await getPublicIp();
    const port = parseInt(process.env.PORT || '8282', 10);

    const info: NetworkInfo = {
        localIp,
        publicIp,
        port
    };

    res.json(info);
});

export default router;
