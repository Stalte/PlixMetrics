import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { mapApi } from '../api/client';
import { useMapConfig } from '../hooks/useMapConfig';
import { useToast } from '../context/ToastContext';

/** Choose the Live User Map's tile provider and enter its API key. */
export const MapSettings: React.FC = () => {
    const { t } = useTranslation();
    const { addToast } = useToast();
    const queryClient = useQueryClient();
    const { data: config } = useMapConfig();

    const [provider, setProvider] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [customUrl, setCustomUrl] = useState('');
    const [dayNight, setDayNight] = useState(true);
    const [labels, setLabels] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (config) {
            setProvider(config.provider);
            setCustomUrl(config.custom_url || '');
            setDayNight(config.day_night);
            setLabels(config.labels);
        }
    }, [config]);

    if (!config) return null;

    const selected = config.providers.find(p => p.id === provider);
    const keySaved = config.has_api_key && provider === config.provider;

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            const res = await mapApi.saveConfig({ provider, api_key: apiKey, custom_url: customUrl, day_night: dayNight, labels });
            queryClient.setQueryData(['mapConfig'], res.data);
            setApiKey('');
            addToast(t('mapSettings.saved'), 'success');
        } catch (err: any) {
            addToast(err.response?.data?.error || err.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    const inputClass = 'w-full bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/50';

    return (
        <form onSubmit={handleSave} className="mt-6 pt-5 border-t border-slate-700/50 space-y-3">
            <h3 className="text-sm font-bold text-slate-300">{t('mapSettings.title')}</h3>
            <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">{t('mapSettings.provider')}</label>
                <select value={provider} onChange={(e) => setProvider(e.target.value)} className={inputClass}>
                    {config.providers.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
            </div>

            {selected?.requires_key && (
                <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('mapSettings.apiKey')}</label>
                    <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={keySaved ? t('mapSettings.keySaved') : t('mapSettings.apiKeyPlaceholder')}
                        className={`${inputClass} font-mono`}
                        autoComplete="off"
                    />
                    {selected.signup_url && (
                        <a href={selected.signup_url} target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-500 hover:text-cyan-400 mt-1 inline-block">
                            {t('mapSettings.getKey')}
                        </a>
                    )}
                </div>
            )}

            {provider === 'custom' && (
                <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{t('mapSettings.customUrl')}</label>
                    <input
                        type="text"
                        value={customUrl}
                        onChange={(e) => setCustomUrl(e.target.value)}
                        placeholder="https://tiles.example.com/{z}/{x}/{y}.png?key={key}"
                        className={`${inputClass} font-mono`}
                    />
                    <p className="text-[11px] text-slate-500 mt-1">{t('mapSettings.customUrlHint')}</p>
                </div>
            )}

            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={dayNight} onChange={(e) => setDayNight(e.target.checked)} className="accent-cyan-500" />
                {t('mapSettings.dayNight')}
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} className="accent-cyan-500" />
                {t('mapSettings.labels')}
            </label>

            <button
                type="submit"
                disabled={saving}
                className="w-full px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
                {saving ? t('mapSettings.testing') : t('mapSettings.save')}
            </button>
        </form>
    );
};
