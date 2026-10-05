import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SiteSettings } from './site-settings';

export function useSiteHead(site: Pick<SiteSettings, 'browserTitle' | 'faviconUrl'>) {
  useEffect(() => {
    document.title = site.browserTitle;
    const existing = document.head.querySelector<HTMLLinkElement>('link[data-site-favicon]');
    if (!site.faviconUrl) { existing?.remove(); return; }
    const icon = existing || document.createElement('link');
    icon.rel = 'icon'; icon.type = 'image/png'; icon.dataset.siteFavicon = 'true';
    icon.href = site.faviconUrl;
    if (!existing) document.head.append(icon);
  }, [site.browserTitle, site.faviconUrl]);
}

export function SiteBrand({ site }: { site: Pick<SiteSettings, 'siteName' | 'logoUrl'> }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLogo = Boolean(site.logoUrl && failedUrl !== site.logoUrl);
  return <Link to="/" className="brand" title={site.siteName}>
    {showLogo ? <img className="site-logo" src={site.logoUrl!} alt={site.siteName} onError={() => setFailedUrl(site.logoUrl)} /> : <span className="site-name">{site.siteName}</span>}
  </Link>;
}
