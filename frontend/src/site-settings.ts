import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface SiteSettings {
  siteName: string;
  browserTitle: string;
  gardenSubtitle: string;
  footerText: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  gardenBackgroundUrl: string | null;
  updatedAt: string;
}

export const defaultSiteSettings: SiteSettings = {
  siteName: '智慧树',
  browserTitle: '智慧树 · 养成与 API',
  gardenSubtitle: '每天照料一点，让智慧慢慢生长。',
  footerText: '一棵树，一个慢慢生长的花园。',
  logoUrl: null,
  faviconUrl: null,
  gardenBackgroundUrl: null,
  updatedAt: '',
};

export const siteSettingsQueryKey = ['site-settings'] as const;
export const adminSiteSettingsQueryKey = ['admin', 'site-settings'] as const;

export function useSiteSettings() {
  const client = useQueryClient();
  return useQuery({
    queryKey: siteSettingsQueryKey,
    queryFn: async () => {
      const received = await api<SiteSettings>('/api/site-settings');
      const current = client.getQueryData<SiteSettings>(siteSettingsQueryKey);
      return current?.updatedAt && current.updatedAt > received.updatedAt ? current : received;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export function saveSiteSettingsCache(client: QueryClient, settings: SiteSettings) {
  const current = [client.getQueryData<SiteSettings>(adminSiteSettingsQueryKey), client.getQueryData<SiteSettings>(siteSettingsQueryKey)]
    .find(item => item?.updatedAt && settings.updatedAt && item.updatedAt > settings.updatedAt);
  // Text and image saves are independent. A late response from an earlier save
  // must not replace a newer configuration already received by this page.
  if (current) return;
  client.setQueryData(adminSiteSettingsQueryKey, settings);
  client.setQueryData(siteSettingsQueryKey, settings);
}
