import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapApiKey } from '../hooks/useMapApiKey';
import { useToast } from '../context/ToastContext';

interface MapApiKeyModalProps {
    onClose: () => void;
}

const CARTO_API_KEY_URL = 'https://carto.com/basemaps/apikey';

export const MapApiKeyModal: React.FC<MapApiKeyModalProps> = ({ onClose }) => {
    const { addToast } = useToast();
    const { t } = useTranslation();
    const { apiKey: savedApiKey, saveApiKey, isSaving } = useMapApiKey();
    const [apiKey, setApiKey] = useState(savedApiKey);

    const save = async (value: string) => {
        try {
            await saveApiKey(value.trim());
            addToast(value.trim() ? t('liveMap.apiKeySaved') : t('liveMap.apiKeyRemoved'), 'success');
            onClose();
        } catch (err: any) {
            console.error("Error saving map API key:", err);
            addToast(err.response?.data?.error || t('liveMap.apiKeySaveFailed'), 'error');
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        save(apiKey);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl">
                <h2 className="text-xl font-bold text-slate-50 mb-2">{t('liveMap.apiKeyTitle')}</h2>
                <p className="text-sm text-slate-400 mb-4">
                    {t('liveMap.apiKeyDescription')}{' '}
                    <a
                        href={CARTO_API_KEY_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-400 hover:text-cyan-300 hover:underline"
                    >
                        {t('liveMap.getApiKey')}
                    </a>
                </p>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-400 mb-1">{t('liveMap.apiKey')}</label>
                        <input
                            type="text"
                            required
                            autoFocus
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 font-mono"
                            placeholder={t('liveMap.apiKeyPlaceholder')}
                        />
                    </div>

                    <div className="flex justify-end gap-3 mt-6">
                        {savedApiKey && (
                            <button
                                type="button"
                                onClick={() => save('')}
                                disabled={isSaving}
                                className="mr-auto px-4 py-2 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                            >
                                {t('liveMap.removeApiKey')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type="submit"
                            disabled={isSaving}
                            className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-600 text-white font-medium transition-colors disabled:opacity-50"
                        >
                            {isSaving ? t('liveMap.savingApiKey') : t('liveMap.saveApiKey')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
