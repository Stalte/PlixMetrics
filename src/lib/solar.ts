/**
 * Day/night terminator and subsolar point.
 * Solar position math follows Leaflet.Terminator (Jörg Dietrich, MIT license).
 */

const rad = Math.PI / 180;

function julianDate(date: Date): number {
    return date.getTime() / 86400000 + 2440587.5;
}

function greenwichSiderealHours(jd: number): number {
    const d = jd - 2451545.0;
    return ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
}

function sunPosition(jd: number): { alpha: number; delta: number } {
    const n = jd - 2451545.0;
    const L = (280.46 + 0.9856474 * n) % 360;
    const g = (357.528 + 0.9856003 * n) % 360;
    const lambda = L + 1.915 * Math.sin(g * rad) + 0.02 * Math.sin(2 * g * rad);

    const T = n / 36525;
    const epsilon = 23.43929111 - T * (46.836769 / 3600 - T * (0.0001831 / 3600 + T * (0.0020034 / 3600 - T * (0.576e-6 / 3600 - T * 4.34e-8 / 3600))));

    let alpha = Math.atan(Math.cos(epsilon * rad) * Math.tan(lambda * rad)) / rad;
    const delta = Math.asin(Math.sin(epsilon * rad) * Math.sin(lambda * rad)) / rad;
    // Put the right ascension in the same quadrant as the ecliptic longitude
    alpha += Math.floor(lambda / 90) * 90 - Math.floor(alpha / 90) * 90;
    return { alpha, delta };
}

export interface SunState {
    night: Array<Array<[number, number]>>;
    subsolar: [number, number];
}

export function computeDayNight(date: Date): SunState {
    const jd = julianDate(date);
    const gst = greenwichSiderealHours(jd);
    const sun = sunPosition(jd);

    const edge: Array<[number, number]> = [];
    for (let i = 0; i <= 720; i++) {
        const lng = -180 + i / 2;
        const hourAngle = (gst + lng / 15) * 15 - sun.alpha;
        const lat = Math.atan(-Math.cos(hourAngle * rad) / Math.tan(sun.delta * rad)) / rad;
        edge.push([lat, lng]);
    }
    // Close the polygon over the pole that is in darkness
    const pole = sun.delta < 0 ? 90 : -90;
    const base: Array<[number, number]> = [...edge, [pole, 180], [pole, -180]];

    // Copies either side so the shading continues when the map wraps around
    const night = [-360, 0, 360].map((offset) => base.map(([lat, lng]) => [lat, lng + offset] as [number, number]));

    let subsolarLng = sun.alpha - gst * 15;
    subsolarLng = ((subsolarLng + 540) % 360) - 180;
    return { night, subsolar: [sun.delta, subsolarLng] };
}

