import React, { useEffect, useState } from 'react';
import { Polygon, CircleMarker } from 'react-leaflet';
import { computeDayNight } from '../lib/solar';

/**
 * Shades the half of the world where it is currently night, with a marker at the
 * point where the sun is overhead. Updated every minute.
 */
export const DayNightLayer: React.FC = () => {
    const [state, setState] = useState(() => computeDayNight(new Date()));

    useEffect(() => {
        const timer = setInterval(() => setState(computeDayNight(new Date())), 60 * 1000);
        return () => clearInterval(timer);
    }, []);

    return (
        <>
            <Polygon
                positions={state.night}
                interactive={false}
                pathOptions={{ stroke: false, fillColor: '#020617', fillOpacity: 0.5, className: 'day-night-shade' }}
            />
            <CircleMarker
                center={state.subsolar}
                radius={7}
                interactive={false}
                pathOptions={{ stroke: true, color: '#fde68a', weight: 8, opacity: 0.25, fillColor: '#facc15', fillOpacity: 0.9 }}
            />
        </>
    );
};
