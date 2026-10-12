import React, { useMemo, useRef, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Pane, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { ActiveSession } from '../types';
import { useMapConfig } from '../hooks/useMapConfig';
import { getMapLabelsUrl, getMapTileUrl } from '../api/client';
import { DayNightLayer } from './DayNightLayer';

interface InteractiveMapProps {
    sessions: ActiveSession[];
    enableClustering?: boolean;
    onUserClick?: (username: string, serverId?: number | string) => void;
    hideControls?: boolean;
    /** Re-fit the map to all sessions whenever one starts or stops (Zen mode). */
    followSessions?: boolean;
    /** Pixels covered by overlays on each side, kept clear when fitting (Zen mode). */
    fitInsets?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_INSETS = { top: 50, right: 50, bottom: 50, left: 50 };

// Component to handle auto-zooming to fit markers
const AutoZoom = ({ sessions, follow, insets }: { sessions: ActiveSession[]; follow: boolean; insets: typeof DEFAULT_INSETS }) => {
    const map = useMap();
    const hasZoomed = useRef(false);

    // Changes only when a session starts or stops (or moves), not on every progress update
    const sessionKey = useMemo(
        () => sessions.map(s => `${s.session_id}@${s.latitude!.toFixed(2)},${s.longitude!.toFixed(2)}`).sort().join('|'),
        [sessions]
    );
    const insetKey = `${insets.top},${insets.right},${insets.bottom},${insets.left}`;

    useEffect(() => {
        if (sessions.length === 0 || (hasZoomed.current && !follow)) return;

        const fit = () => {
            const points = sessions.map(s => [s.latitude!, s.longitude!] as [number, number]);
            const options = {
                paddingTopLeft: L.point(insets.left, insets.top),
                paddingBottomRight: L.point(insets.right, insets.bottom),
                maxZoom: sessions.length === 1 ? 6 : 10,
                animate: true,
                duration: 1.5
            };
            if (follow) map.flyToBounds(L.latLngBounds(points), options);
            else map.fitBounds(L.latLngBounds(points), options);
        };

        fit();
        hasZoomed.current = true;

        if (!follow) return;
        // Keep everything in view when the window (e.g. a TV browser) is resized
        let timer: ReturnType<typeof setTimeout>;
        const onResize = () => { clearTimeout(timer); timer = setTimeout(fit, 300); };
        map.on('resize', onResize);
        return () => { clearTimeout(timer); map.off('resize', onResize); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionKey, insetKey, follow, map]);

    return null;
};

// Custom Zoom Control component
const CustomZoomControl = () => {
    const map = useMap();

    return (
        <div className="absolute top-4 right-4 z-[400] flex flex-col gap-2">
            <button
                onClick={() => map.zoomIn()}
                className="w-9 h-9 bg-slate-900/90 backdrop-blur-md border border-slate-700/50 rounded-xl text-cyan-400 hover:bg-cyan-500 hover:text-white hover:border-cyan-400 transition-all shadow-xl flex items-center justify-center group"
                title="Zoom In"
                aria-label="Zoom In"
            >
                <svg className="w-5 h-5 transform group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                </svg>
            </button>
            <button
                onClick={() => map.zoomOut()}
                className="w-9 h-9 bg-slate-900/90 backdrop-blur-md border border-slate-700/50 rounded-xl text-cyan-400 hover:bg-cyan-500 hover:text-white hover:border-cyan-400 transition-all shadow-xl flex items-center justify-center group"
                title="Zoom Out"
                aria-label="Zoom Out"
            >
                <svg className="w-5 h-5 transform group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M20 12H4" />
                </svg>
            </button>
        </div>
    );
};

// Custom pulsing icon using Tailwind classes
const createPulsingIcon = () => {
    return L.divIcon({
        className: 'bg-transparent',
        html: `
            <div class="relative flex items-center justify-center w-5 h-5 -ml-2.5 -mt-2.5 group cursor-pointer">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-25" style="animation-duration: 3s;"></span>
                <span class="absolute inline-flex h-3 w-3 rounded-full bg-cyan-400 opacity-40 blur-[1.5px]"></span>
                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,1)] transition-transform duration-300 group-hover:scale-125"></span>
            </div>
        `,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
    });
};

// Custom cluster icon matching the theme
const createClusterCustomIcon = (cluster: any) => {
    const count = cluster.getChildCount();
    let size = 'w-8 h-8';
    let textSize = 'text-xs';

    if (count > 10) {
        size = 'w-10 h-10';
        textSize = 'text-sm';
    }
    if (count > 50) {
        size = 'w-12 h-12';
        textSize = 'text-base';
    }

    return L.divIcon({
        html: `
            <div class="relative flex items-center justify-center w-full h-full group cursor-pointer">
                 <span class="absolute inline-flex h-full w-full rounded-full bg-cyan-500 opacity-20 animate-ping" style="animation-duration: 2s;"></span>
                 <span class="absolute inline-flex h-[115%] w-[115%] rounded-full bg-cyan-400/10 animate-pulse"></span>
                 <div class="relative flex items-center justify-center ${size} rounded-full bg-slate-900/80 border-2 border-cyan-400 text-cyan-400 font-bold shadow-[0_0_15px_rgba(34,211,238,0.3)] backdrop-blur-md transition-all duration-300 transform group-hover:scale-110 group-hover:border-cyan-300 group-hover:text-cyan-300 group-hover:shadow-[0_0_25px_rgba(34,211,238,0.6)]">
                      <span class="${textSize} drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">${count}</span>
                 </div>
            </div>
        `,
        className: 'custom-marker-cluster',
        iconSize: L.point(40, 40, true),
    });
};

const InteractiveMap: React.FC<InteractiveMapProps> = ({ sessions, enableClustering = true, onUserClick, hideControls = false, followSessions = false, fitInsets = DEFAULT_INSETS }) => {
    const { data: mapConfig } = useMapConfig();
    const validSessions = useMemo(() => {
        return sessions.filter(s =>
            s.latitude !== undefined &&
            s.longitude !== undefined &&
            !isNaN(s.latitude) &&
            !isNaN(s.longitude)
        );
    }, [sessions]);

    const defaultCenter: [number, number] = [40.4168, -3.7038];
    const center: [number, number] = validSessions.length > 0
        ? [validSessions[0].latitude!, validSessions[0].longitude!]
        : defaultCenter;

    const getJitteredPosition = (lat: number, lon: number, index: number) => {
        const jitterAmount = 0.0001 * (index % 5);
        return [lat + jitterAmount, lon + jitterAmount] as [number, number];
    };

    return (
        <MapContainer
            center={center}
            zoom={3}
            scrollWheelZoom={true}
            style={{ height: "100%", width: "100%", background: '#0f172a' }}
            zoomControl={false}
            attributionControl={!hideControls}
            // Zen mode may zoom out to the whole world so streams on every continent fit
            minZoom={followSessions ? 2 : 3}
            maxZoom={12}
        >
            <AutoZoom sessions={validSessions} follow={followSessions} insets={fitInsets} />
            {!hideControls && <CustomZoomControl />}

            {mapConfig && (
                <TileLayer
                    key={`${mapConfig.provider}-${mapConfig.version}`}
                    url={getMapTileUrl(mapConfig.version)}
                    attribution={mapConfig.attribution}
                    maxNativeZoom={mapConfig.max_zoom}
                    maxZoom={20}
                />
            )}
            {mapConfig?.day_night && <DayNightLayer />}
            {mapConfig?.labels && (
                // Above the night shading so names stay readable, below the stream markers
                <Pane name="map-labels" style={{ zIndex: 450, pointerEvents: 'none' }}>
                    <TileLayer
                        url={getMapLabelsUrl()}
                        attribution={mapConfig.labels_attribution}
                        maxNativeZoom={mapConfig.labels_max_zoom}
                        maxZoom={20}
                    />
                </Pane>
            )}

            {enableClustering ? (
                <MarkerClusterGroup
                    chunkedLoading
                    iconCreateFunction={createClusterCustomIcon}
                    maxClusterRadius={35}
                    spiderfyOnMaxZoom={true}
                    showCoverageOnHover={false}
                >
                    {validSessions.map((session, idx) => (
                        <Marker
                            key={session.session_id}
                            position={getJitteredPosition(session.latitude!, session.longitude!, idx)}
                            icon={createPulsingIcon()}
                        >
                            <Popup
                                closeButton={false}
                                className="custom-popup"
                            >
                                <div className="bg-slate-800 text-slate-200 p-2 rounded-lg border border-slate-700 shadow-xl w-max max-w-[200px]">
                                    <div
                                        className={`font-bold text-cyan-400 text-sm mb-1 truncate ${onUserClick ? 'cursor-pointer hover:text-cyan-300 hover:underline' : ''}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (onUserClick) onUserClick(session.user, session.server_id);
                                        }}
                                    >
                                        {session.user}
                                    </div>
                                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium truncate">
                                        {session.server_name || 'Unknown Server'}
                                    </div>
                                </div>
                            </Popup>
                        </Marker>
                    ))}
                </MarkerClusterGroup>
            ) : (
                validSessions.map((session, idx) => (
                    <Marker
                        key={session.session_id}
                        position={getJitteredPosition(session.latitude!, session.longitude!, idx)}
                        icon={createPulsingIcon()}
                    >
                        <Popup
                            closeButton={false}
                            className="custom-popup"
                        >
                            <div className="bg-slate-800 text-slate-200 p-2 rounded-lg border border-slate-700 shadow-xl w-max max-w-[200px]">
                                <div
                                    className={`font-bold text-cyan-400 text-sm mb-1 truncate ${onUserClick ? 'cursor-pointer hover:text-cyan-300 hover:underline' : ''}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onUserClick) onUserClick(session.user, session.server_id);
                                    }}
                                >
                                    {session.user}
                                </div>
                                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium truncate">
                                    {session.server_name || 'Unknown Server'}
                                </div>
                            </div>
                        </Popup>
                    </Marker>
                ))
            )}

            <style>{`
                .leaflet-popup-content-wrapper, .leaflet-popup-tip {
                    background: transparent;
                    box-shadow: none;
                    padding: 0;
                }
                .leaflet-popup-content {
                    margin: 0;
                }
                .custom-marker-cluster {
                    background: transparent;
                    border: none;
                }
            `}</style>
        </MapContainer>
    );
};

export default InteractiveMap;
