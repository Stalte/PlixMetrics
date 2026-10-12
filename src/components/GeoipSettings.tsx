import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { geoipApi, GeoipStatus } from '../api/client';
import { useToast } from '../context/ToastContext';

/** MaxMind account ID and license key for more accurate stream locations. */
export const GeoipSettings: React.FC = () => {
    const { t } = useTranslation();
    const { addToast } = useToast();
    const [status, setStatus] = useState<GeoipStatus | null>(null);
    const [accountId, setAccountId] = useState('');
    const [licenseKey, setLicenseKey] = useState('');
    const [edition, setEdition] = useState('GeoLite2-City');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        geoipApi.getConfig().then((res) => {
            setStatus(res.data);
            setAccountId(res.data.account_id || '');
            setEdition(res.data.edition);
        }).catch(() => { /* section stays hidden */ });
    }, []);

    if (!status) return null;

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const res = await geoipApi.saveConfig({ account_id: accountId, license_key: licenseKey, edition });
            setStatus(res.data);
            setLicenseKey('');
            addToast(t('geoip.saved'), 'success');
        } catch (err: any) {
            addToast(err.response?.data?.error || err.message, 'error');
        } finally {
            setBusy(false);
        }
    };

    const handleDisable = async () => {
        setBusy(true);
        try {
            const res = await geoipApi.disable();
            setStatus(res.data);
            setAccountId('');
            setLicenseKey('');
        } finally {
            setBusy(false);
        }
    };

    const inputClass = 'w-full bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/50';

    return (
        <form onSubmit={handleSave} className="mt-6 pt-5 border-t border-slate-700/50 space-y-3">
            <h3 className="text-sm font-bold text-slate-300">{t('geoip.title')}</h3>
            <p className={`text-xs ${status.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                {status.enabled
                    ? t('geoip.usingMaxmind', { edition: status.edition, date: status.database_date })
                    : t('geoip.usingBuiltIn')}
            </p>
            {status.last_error && <p className="text-xs text-red-400">{status.last_error}</p>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('geoip.accountId')}</label>
                    <input type="text" inputMode="numeric" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={`${inputClass} font-mono`} placeholder="123456" />
                </div>
                <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('geoip.licenseKey')}</label>
                    <input
                        type="password"
                        value={licenseKey}
                        onChange={(e) => setLicenseKey(e.target.value)}
                        className={`${inputClass} font-mono`}
                        placeholder={status.has_license_key ? t('mapSettings.keySaved') : t('geoip.licenseKeyPlaceholder')}
                        autoComplete="off"
                    />
                </div>
            </div>
            <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">{t('geoip.edition')}</label>
                <select value={edition} onChange={(e) => setEdition(e.target.value)} className={inputClass}>
                    <option value="GeoLite2-City">GeoLite2 City ({t('geoip.free')})</option>
                    <option value="GeoIP2-City">GeoIP2 City ({t('geoip.paid')})</option>
                </select>
            </div>
            <a href="https://www.maxmind.com/en/geolite2/signup" target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-500 hover:text-cyan-400 inline-block">
                {t('geoip.getKey')}
            </a>

            <div className="flex gap-2">
                <button type="submit" disabled={busy} className="flex-1 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors disabled:opacity-50">
                    {busy ? t('geoip.downloading') : status.enabled ? t('geoip.update') : t('geoip.enable')}
                </button>
                {status.enabled && (
                    <button type="button" onClick={handleDisable} disabled={busy} className="px-4 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60 text-sm transition-colors disabled:opacity-50">
                        {t('geoip.disable')}
                    </button>
                )}
            </div>
        </form>
    );
};
