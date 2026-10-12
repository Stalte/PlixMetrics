import React from 'react';
import { useTranslation } from 'react-i18next';
import { ActiveSession } from '../types';
import { getImageProxyUrl } from '../api/client';

const countryNames = (() => {
    try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; }
})();

/** "City, Region, Country" from whatever parts are known. */
function formatLocation(session: ActiveSession): string {
    let country = session.location_country;
    if (country && countryNames) {
        try { country = countryNames.of(country) || country; } catch { /* keep the code */ }
    }
    const region = session.location_region && session.location_region !== session.location_city ? session.location_region : undefined;
    return [session.location_city, region, country].filter(Boolean).join(', ');
}

interface SessionCardProps {
    session: ActiveSession;
    onUserClick?: (username: string, serverId?: number | string) => void;
    hideBackground?: boolean;
}

export const SessionCard: React.FC<SessionCardProps> = ({ session, onUserClick, hideBackground }) => {
    const { t } = useTranslation();
    // ... (rest of the code same until return)
    const getImageUrl = (path: string | undefined, serverId: number | string | undefined, w = 300) => {
        if (!path || !serverId) return '';
        return getImageProxyUrl(serverId, path, w);
    };

    const progress = session.duration ? (session.view_offset || 0) / session.duration * 100 : 0;
    const timeLeftMs = (session.duration || 0) - (session.view_offset || 0);
    const timeLeftMins = Math.ceil(timeLeftMs / 60000);

    const isShow = session.media_type === 'episode';
    const primaryTitle = isShow ? session.grandparent_title : session.title;
    const seasonInfo = isShow ? `S${session.parent_media_index} • E${session.media_index}` : '';

    const location = session.is_local ? t('session.localNetwork') : formatLocation(session);

    const formatTimeLeft = (mins: number) => {
        if (!Number.isFinite(mins) || mins < 0) return '';
        if (mins >= 60) {
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            return t('session.hoursMinutesLeft', { h, m });
        }
        return t('session.minutesLeft', { m: mins });
    };

    return (
        <div className={`relative h-[116px] w-full rounded-lg overflow-hidden group transition-all duration-300 ${hideBackground ? '' : 'bg-slate-800/60 shadow-lg border border-white/5 hover:bg-slate-800/80'}`}>
            {/* Background Art */}
            <div
                className={`absolute inset-0 bg-cover bg-center blur-sm pointer-events-none ${hideBackground ? 'opacity-40' : 'opacity-20'}`}
                style={{ backgroundImage: `url(${getImageUrl(session.art || session.thumb, session.server_id, 150)})` }}
            ></div>
            {!hideBackground && <div className="absolute inset-0 bg-gradient-to-r from-slate-900 via-slate-900/40 to-transparent pointer-events-none"></div>}

            {/* Content */}
            <div className="relative h-full flex items-center p-2 gap-3">
                {/* Device Badge (Top Right) - More compact */}
                <div className="absolute top-2 right-2 z-20 bg-black/60 backdrop-blur-sm px-1.5 py-0.5 rounded border border-white/5 flex items-center gap-1 scale-90 origin-top-right">
                    {session.stream_container_decision === 'transcode' && (
                        <svg className="w-2.5 h-2.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    )}
                    <span className="text-[9px] text-slate-300 font-bold uppercase tracking-tighter">
                        {session.player}
                    </span>
                </div>

                {/* Poster - Full height, crisp */}
                <div className="h-full aspect-[2/3] rounded-md overflow-hidden shadow-md relative flex-shrink-0 bg-slate-900 ring-1 ring-white/10">
                    <img
                        src={getImageUrl(session.grandparent_thumb || session.thumb, session.server_id, 180)}
                        alt={session.title}
                        className="h-full w-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        loading="lazy"
                    />
                    {session.status === 'paused' && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                            <svg className="w-6 h-6 text-white/80" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                        </div>
                    )}
                </div>

                {/* Text Info - Very dense */}
                <div className="flex-1 min-w-0 flex flex-col h-full z-10 relative py-1">
                    {/* Level 1: Series Name / Movie Name */}
                    <h4 className="flex-shrink-0 font-bold text-white text-[13px] leading-tight truncate pr-16" title={primaryTitle}>
                        {primaryTitle || 'Unknown'}
                    </h4>

                    {/* Level 2: S1 . E4 (if applicable) */}
                    {isShow && seasonInfo && (
                        <div className="flex-shrink-0 text-[10px] leading-tight text-amber-400 font-extrabold uppercase tracking-tighter mt-0.5">
                            {seasonInfo}
                        </div>
                    )}

                    {/* Level 3: Episode Title / Year */}
                    <div className="flex-shrink-0 text-[11px] text-slate-300 font-medium truncate mt-0.5 leading-tight">
                        {isShow ? session.title : session.year}
                    </div>

                    {/* Level 4: Server - User */}
                    <div className="flex-shrink-0 text-[10px] leading-tight text-slate-400 font-medium truncate mt-0.5 flex items-center gap-1">
                        <span className="text-indigo-400/80 font-bold">{session.server_name}</span>
                        <span className="opacity-40">•</span>
                        <span
                            onClick={(e) => {
                                e.stopPropagation();
                                onUserClick && onUserClick(session.user, session.server_id);
                            }}
                            className={`transition-colors ${onUserClick ? 'cursor-pointer hover:text-cyan-400 hover:underline hover:decoration-cyan-400/50' : ''}`}
                            title={onUserClick ? t('session.viewUserProfile') : undefined}
                        >
                            {session.user}
                        </span>
                    </div>

                    <div className="flex-shrink-0 mt-auto flex justify-between items-end w-full gap-2">
                        <div className="min-w-0 text-[9px] text-slate-500 font-mono leading-tight">
                            {location && (
                                <div className="flex items-center gap-0.5 truncate text-slate-400" title={location}>
                                    <svg className="w-2.5 h-2.5 flex-shrink-0 text-cyan-500/80" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
                                    </svg>
                                    <span className="truncate">{location}</span>
                                </div>
                            )}
                            <div className="truncate">
                                {session.ip_address && <span className="text-slate-400">{session.ip_address} • </span>}
                                {((session.bandwidth || 0) / 1000).toFixed(1)} Mbps
                            </div>
                        </div>
                        <div className="flex-shrink-0 text-[12px] text-white font-bold tracking-tight leading-none">
                            {formatTimeLeft(timeLeftMins)}
                        </div>
                    </div>
                </div>
            </div>

            {/* Progress Bar - Thinner */}
            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-slate-900/50">
                <div
                    className={`h-full ${session.status === 'paused' ? 'bg-amber-500' : 'bg-emerald-500'} transition-all duration-1000`}
                    style={{ width: `${progress}%` }}
                ></div>
            </div>
        </div>
    );
};
