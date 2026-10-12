import { useQuery } from '@tanstack/react-query';
import { mapApi, MapConfig } from '../api/client';

export const useMapConfig = () => {
    return useQuery<MapConfig>({
        queryKey: ['mapConfig'],
        queryFn: async () => (await mapApi.getConfig()).data,
        staleTime: 10 * 60 * 1000,
    });
};
