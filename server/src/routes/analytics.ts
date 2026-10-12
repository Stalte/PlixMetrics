import { Router } from 'express';
import { getAllServersWithKeys } from './servers.js';
import { tautulli, isTemporarilyDown } from '../services/tautulli.js';
import { PlexServer } from '../types.js';
import { AnalyticsResponse, HourlyActivityItem, DevicePreferenceItem, PlaybackHealthItem, LibraryQualityItem, GenrePopularityItem } from '../types.js';

const router = Router();

/**
 * GET /api/analytics?days=30&server_id=all
 */
router.get('/', async (req, res) => {
    try {
        const days = parseInt(req.query.days as string) || 30;
        const server_id = req.query.server_id as string;

        let servers = getAllServersWithKeys();

        if (servers.length === 0) {
            console.warn('[Analytics] No servers found in DB.');
            return res.status(404).json({ error: 'No servers configured' });
        }

        // Filter by server_id if specified
        if (server_id && server_id !== 'all') {
            servers = servers.filter(s => s.id === parseInt(server_id, 10));
        }

        const hourlyActivityMap = new Map<number, number>();
        const deviceMap = new Map<string, number>();
        let totalDevicePlays = 0;
        let directPlayCount = 0;
        let directStreamCount = 0;
        let transcodeCount = 0;

        // For Library Quality
        const librariesQualityMap = new Map<string, { '4K': number, '1080p': number, '720p': number, 'SD': number }>();
        const genreMap = new Map<string, number>();

        // Each section is fetched independently and in parallel, so one slow or failing
        // Tautulli command no longer blocks (or wipes out) the rest of a server's analytics.
        const hourlySection = async (server: PlexServer) => {
            const data = await tautulli(server, 'get_plays_by_hourofday', { time_range: days, stats_type: 0 }); // 0 = plays
            const categories = data?.categories || [];
            (data?.series || []).forEach((serie: any) => {
                serie.data.forEach((count: number, index: number) => {
                    // Use category label to determine the hour, fallback to index
                    const hourLabel = categories[index];
                    const hour = hourLabel !== undefined ? parseInt(hourLabel, 10) : index;
                    hourlyActivityMap.set(hour, (hourlyActivityMap.get(hour) || 0) + count);
                });
            });
        };

        const platformsSection = async (server: PlexServer) => {
            const data = await tautulli(server, 'get_plays_by_top_10_platforms', { time_range: days });
            if (data?.categories && data?.series) {
                data.categories.forEach((platform: string, index: number) => {
                    let count = 0;
                    data.series.forEach((serie: any) => {
                        count += (serie.data[index] || 0);
                    });
                    deviceMap.set(platform, (deviceMap.get(platform) || 0) + count);
                    totalDevicePlays += count;
                });
            }
        };

        const healthSection = async (server: PlexServer) => {
            const data = await tautulli(server, 'get_stream_type_by_top_10_platforms', { time_range: days });
            (data?.series || []).forEach((s: any) => {
                const sum = s.data.reduce((a: number, b: number) => a + b, 0);
                if (s.name === 'Direct Play') directPlayCount += sum;
                else if (s.name === 'Direct Stream') directStreamCount += sum;
                else if (s.name === 'Transcode') transcodeCount += sum;
            });
        };

        // Genre Popularity (via Home Stats & Metadata)
        const genreSection = async (server: PlexServer) => {
            const homeData = await tautulli(server, 'get_home_stats', { time_range: days });
            const topItems: any[] = [];
            const collectItems = (statId: string) => {
                const stat = Array.isArray(homeData) ? homeData.find((s: any) => s.stat_id === statId) : null;
                if (stat && stat.rows) stat.rows.forEach((r: any) => topItems.push(r));
            };
            collectItems('top_movies');
            collectItems('top_tv');

            // Limit to top 20 items to avoid too many requests
            await Promise.allSettled(topItems.slice(0, 20).map(async (item) => {
                const meta = await tautulli(server, 'get_metadata', { rating_key: item.rating_key });
                if (meta?.genres && Array.isArray(meta.genres)) {
                    const plays = item.total_plays || 1;
                    meta.genres.forEach((g: string) => {
                        genreMap.set(g, (genreMap.get(g) || 0) + plays);
                    });
                }
            }));
        };

        // Library Quality
        const librarySection = async (server: PlexServer) => {
            const libraries = await tautulli(server, 'get_libraries');
            // Only process Movies for now as TV Shows are WIP
            const movieLibraries = (Array.isArray(libraries) ? libraries : []).filter((lib: any) => lib.section_type === 'movie');

            const mediaResults = await Promise.allSettled(movieLibraries.map((lib: any) =>
                tautulli(server, 'get_library_media_info', { section_id: lib.section_id, length: 5000 })
            ));

            for (const result of mediaResults) {
                if (result.status !== 'fulfilled') continue;
                const mediaRows = result.value?.data;
                if (!Array.isArray(mediaRows)) continue;

                const category = 'Movies';
                if (!librariesQualityMap.has(category)) {
                    librariesQualityMap.set(category, { '4K': 0, '1080p': 0, '720p': 0, 'SD': 0 });
                }
                const current = librariesQualityMap.get(category)!;

                for (const row of mediaRows) {
                    const res = String(row.video_resolution || '').toLowerCase();
                    const isShow = row.media_type === 'show';

                    if (res === '4k' || res === '2160' || res === 'uhd') {
                        current['4K']++;
                    } else if (res === '1080' || res === 'fhd') {
                        current['1080p']++;
                    } else if (res === '720' || res === 'hd') {
                        current['720p']++;
                    } else if (isShow && res === '') {
                        current['1080p']++;
                    } else {
                        current['SD']++;
                    }
                }
            }
        };

        // Fetch data from servers in parallel (failures are logged by the Tautulli client)
        await Promise.allSettled(servers
            .filter((server) => !isTemporarilyDown(server.id))
            .flatMap((server) => [
                hourlySection(server),
                platformsSection(server),
                healthSection(server),
                genreSection(server),
                librarySection(server)
            ]));

        // Construct response
        const hourly_activity: HourlyActivityItem[] = Array.from({ length: 24 }, (_, i) => ({
            hour: i,
            plays: hourlyActivityMap.get(i) || 0
        }));

        const allDevices = Array.from(deviceMap.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count);

        const topDevices = allDevices.slice(0, 4);
        const otherDevicesCount = allDevices.slice(4).reduce((sum, item) => sum + item.count, 0);

        const device_preferences: DevicePreferenceItem[] = topDevices.map(d => ({
            name: d.name,
            value: totalDevicePlays > 0 ? Math.round((d.count / totalDevicePlays) * 100) : 0
        }));

        if (otherDevicesCount > 0) {
            device_preferences.push({
                name: 'Others',
                value: totalDevicePlays > 0 ? Math.round((otherDevicesCount / totalDevicePlays) * 100) : 0
            });
        }

        const allGenres = Array.from(genreMap.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count);

        const topGenres = allGenres.slice(0, 8);
        const maxGenreCount = topGenres.length > 0 ? topGenres[0].count : 100;

        const genre_popularity: GenrePopularityItem[] = topGenres.map((g: { name: string, count: number }) => ({
            subject: g.name,
            A: g.count,
            fullMark: maxGenreCount
        }));

        const playback_health: PlaybackHealthItem[] = [
            { name: 'Direct Play', value: directPlayCount, color: '#10b981' },
            { name: 'Direct Stream', value: directStreamCount, color: '#f59e0b' },
            { name: 'Transcode', value: transcodeCount, color: '#ef4444' }
        ];

        const library_quality: LibraryQualityItem[] = Array.from(librariesQualityMap.entries()).map(([name, counts]) => ({
            name,
            ...counts
        }));

        const response: AnalyticsResponse = {
            hourly_activity,
            device_preferences,
            playback_health,
            library_quality,
            genre_popularity
        };

        res.json(response);

    } catch (error) {
        console.error('[Analytics] Critical error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
