import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi } from '../api/client';

const MAP_API_KEY_QUERY = ['mapApiKey'];

export const useMapApiKey = () => {
    const queryClient = useQueryClient();

    const query = useQuery<string>({
        queryKey: MAP_API_KEY_QUERY,
        queryFn: async () => {
            const response = await configApi.getMapKey();
            return response.data.apiKey || '';
        },
        staleTime: Infinity, // Only changes when saved from the modal
    });

    const mutation = useMutation({
        mutationFn: async (apiKey: string) => {
            const response = await configApi.setMapKey(apiKey);
            return response.data.apiKey as string;
        },
        onSuccess: (apiKey) => {
            queryClient.setQueryData(MAP_API_KEY_QUERY, apiKey);
        },
    });

    return {
        apiKey: query.data || '',
        // Settled once the request finished, even if it failed (map then uses keyless tiles)
        isReady: !query.isLoading,
        saveApiKey: mutation.mutateAsync,
        isSaving: mutation.isPending,
    };
};
