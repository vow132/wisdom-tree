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

export function latestSiteSettings(client: QueryClient, received: SiteSettings): SiteSettings {
  let latest = received;
  for (const key of [adminSiteSettingsQueryKey, siteSettingsQueryKey]) {
    const cached = client.getQueryData<SiteSettings>(key);
    if (cached?.updatedAt && cached.updatedAt > latest.updatedAt) latest = cached;
  }
  return latest;
}

export function useSiteSettings() {
  const client = useQueryClient();
  return useQuery({
    queryKey: siteSettingsQueryKey,
    queryFn: async () => {
      const received = await api<SiteSettings>('/api/site-settings');
      return latestSiteSettings(client, received);
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export function saveSiteSettingsCache(client: QueryClient, settings: SiteSettings) {
  // Text and image saves are independent. A late response from an earlier save
  // must not replace a newer configuration already received by this page.
  const latest = latestSiteSettings(client, settings);
  client.setQueryData(adminSiteSettingsQueryKey, latest);
  client.setQueryData(siteSettingsQueryKey, latest);
}
