import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { Button, Field, PanelTitle, QueryStatus, useAction } from './ui';
import UpdaterSettings from './UpdaterSettings';
import { adminSiteSettingsQueryKey, saveSiteSettingsCache, type SiteSettings } from './site-settings';

type TextSettings = Pick<SiteSettings, 'siteName' | 'browserTitle' | 'gardenSubtitle' | 'footerText'>;
type AssetSlot = 'logo' | 'favicon' | 'garden-background';
type AssetField = 'logoUrl' | 'faviconUrl' | 'gardenBackgroundUrl';
const textValues = (item: SiteSettings): TextSettings => ({ siteName: item.siteName, browserTitle: item.browserTitle, gardenSubtitle: item.gardenSubtitle, footerText: item.footerText });
const assets: { slot: AssetSlot; field: AssetField; title: string; help: string; restore: string }[] = [
  { slot: 'logo', field: 'logoUrl', title: '网站 Logo', help: '显示在导航栏。建议使用透明底横版图片；恢复默认后显示网站名称。', restore: '恢复文字品牌' },
  { slot: 'favicon', field: 'faviconUrl', title: '浏览器图标', help: '显示在浏览器标签页。建议使用正方形图片；上传后自动转换为小尺寸 PNG。', restore: '恢复默认图标' },
  { slot: 'garden-background', field: 'gardenBackgroundUrl', title: '花园背景', help: '替换游戏场景的背景，树与操作保持原有位置。建议使用 4:3 图片。', restore: '恢复原版背景' },
];
const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const maxImageBytes = 2 * 1024 * 1024;

export function validateSiteImage(file: Pick<File, 'size' | 'type'>): string | null {
  if (!allowedTypes.has(file.type)) return '请选择 PNG、JPEG 或 WebP 图片。';
  if (file.size === 0) return '图片文件为空，请重新选择。';
  if (file.size > maxImageBytes) return '图片超过 2 MB，请压缩后重新选择。';
  return null;
}

export function readSiteImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
    reader.onabort = () => reject(new Error('图片读取已取消，请重新选择。'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const separator = value.indexOf(',');
      if (separator < 0) reject(new Error('图片读取失败，请重新选择。'));
      else resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export default function SiteSettingsPanel() {
  const query = useQuery({ queryKey: adminSiteSettingsQueryKey, queryFn: ({ signal }) => api<SiteSettings>('/api/admin/site-settings', { signal }) });
  return <div className="site-settings-workspace">
    <section className="panel site-settings-panel">
      <PanelTitle title="网站设置" description="修改网站名称、页面文案与图片，保存后在本站生效。" />
      <QueryStatus query={query}>{query.data && <>
        <SiteTextForm item={query.data} />
        <section className="site-assets" aria-labelledby="site-images-heading">
          <h3 id="site-images-heading">网站图片</h3>
          <p className="site-settings-help">支持静态 PNG、JPEG 和 WebP，每张不超过 2 MB。选择图片仅预览，点击“上传图片”后保存。</p>
          {assets.map(asset => <SiteAssetEditor key={asset.slot} asset={asset} item={query.data!} />)}
        </section>
      </>}</QueryStatus>
    </section>
    <UpdaterSettings />
  </div>;
}

function SiteTextForm({ item }: { item: SiteSettings }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<TextSettings>(() => textValues(item));
  const [saved, setSaved] = useState(false);
  const save = useAction<TextSettings>(body => api<SiteSettings>('/api/admin/site-settings', { method: 'PATCH', body }), '网站文案已保存。', result => {
    const next = result as SiteSettings;
    saveSiteSettingsCache(client, next);
    setDraft(textValues(next));
    setSaved(true);
  }, []);
  const change = (key: keyof TextSettings, value: string) => { setDraft(current => ({ ...current, [key]: value })); setSaved(false); save.reset(); };
  return <form className="site-text-form" aria-label="网站基本信息" onSubmit={event => { event.preventDefault(); setSaved(false); save.mutate(draft); }}>
    <h3>基本信息</h3>
    <div className="form-grid">
      <Field label="网站名称" help="导航栏文字品牌；上传 Logo 后用作图片的名称。"><input name="siteName" value={draft.siteName} onChange={event => change('siteName', event.target.value)} required maxLength={60} disabled={save.isPending} /></Field>
      <Field label="浏览器标题" help="浏览器标签页显示的标题。"><input name="browserTitle" value={draft.browserTitle} onChange={event => change('browserTitle', event.target.value)} required maxLength={120} disabled={save.isPending} /></Field>
    </div>
    <Field label="花园说明" help="显示在花园标题下方，留空隐藏。"><textarea name="gardenSubtitle" value={draft.gardenSubtitle} onChange={event => change('gardenSubtitle', event.target.value)} rows={2} maxLength={200} disabled={save.isPending} /></Field>
    <Field label="页脚文案" help="显示在网站底部，留空隐藏。"><textarea name="footerText" value={draft.footerText} onChange={event => change('footerText', event.target.value)} rows={2} maxLength={300} disabled={save.isPending} /></Field>
    <div className="site-text-preview" aria-label="文案预览"><span>文案预览</span><strong>{draft.siteName}</strong>{draft.gardenSubtitle && <p>{draft.gardenSubtitle}</p>}{draft.footerText && <p className="site-preview-footer">{draft.footerText}</p>}</div>
    {save.error && <p className="site-settings-error" role="alert">{save.error.message}</p>}
    <div className="site-settings-save-row"><Button type="submit" pending={save.isPending}>保存基本信息</Button>{saved && <p role="status">网站文案已保存。</p>}</div>
  </form>;
}

function SiteAssetEditor({ asset, item }: { asset: typeof assets[number]; item: SiteSettings }) {
  const client = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [validation, setValidation] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    if (!selected) { setPreview(null); return; }
    const url = URL.createObjectURL(selected);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selected]);
  const clearSelection = () => { setSelected(null); setValidation(''); if (fileInput.current) fileInput.current.value = ''; };
  const done = (result: unknown, message: string) => { saveSiteSettingsCache(client, result as SiteSettings); clearSelection(); setSaved(message); };
  const upload = useAction<File>(async file => {
    const error = validateSiteImage(file);
    if (error) throw new Error(error);
    return api<SiteSettings>(`/api/admin/site-settings/assets/${asset.slot}`, { method: 'POST', body: { data: await readSiteImage(file), mimeType: file.type } });
  }, `${asset.title}已上传。`, result => done(result, '图片已上传并生效。'), []);
  const restore = useAction<void>(() => api<SiteSettings>('/api/admin/site-settings', { method: 'PATCH', body: { [asset.field]: null } }), `${asset.title}已恢复默认。`, result => done(result, '已恢复默认。'), []);
  const busy = upload.isPending || restore.isPending;
  const current = item[asset.field];
  const shown = preview || current;
  const error = validation || upload.error?.message || restore.error?.message;
  return <section className={`site-asset-row site-asset-${asset.slot}`} aria-labelledby={`site-asset-${asset.slot}-heading`}>
    <div className="site-asset-description"><h4 id={`site-asset-${asset.slot}-heading`}>{asset.title}</h4><p>{asset.help}</p></div>
    <div className="site-asset-preview" aria-label={`${asset.title}预览`}>
      {shown ? <img src={shown} alt={`${asset.title}${selected ? '待上传' : '当前'}预览`} /> : asset.slot === 'logo' ? <strong className="site-logo-fallback">{item.siteName}</strong> : asset.slot === 'favicon' ? <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 7.5h14M5 16.5h14" /></svg> : <img src="/assets/images/IMAGE_REANIM_TREE_BG.png" alt="原版花园背景预览" />}
    </div>
    <div className="site-asset-controls">
      <Field label={`选择${asset.title}`}><input ref={fileInput} type="file" name={`asset-${asset.slot}`} accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => {
        const file = event.target.files?.[0];
        setSaved(''); upload.reset(); restore.reset();
        if (!file) { clearSelection(); return; }
        const invalid = validateSiteImage(file);
        if (invalid) { setSelected(null); setValidation(invalid); event.target.value = ''; return; }
        setValidation(''); setSelected(file);
      }} /></Field>
      {selected && <p className="site-file-selection">待上传：{selected.name}<span>（{Math.max(1, Math.ceil(selected.size / 1024))} KB）</span></p>}
      {error && <p className="site-settings-error" role="alert">{error}</p>}
      <div className="button-row"><Button type="button" disabled={!selected || busy} pending={upload.isPending} onClick={() => selected && upload.mutate(selected)}>上传图片</Button>{selected && <Button type="button" variant="quiet" disabled={busy} onClick={() => { clearSelection(); upload.reset(); }}>取消选择</Button>}<Button type="button" variant="secondary" disabled={!current || busy} pending={restore.isPending} onClick={() => restore.mutate()}>{asset.restore}</Button></div>
      {saved && <p className="site-asset-saved" role="status">{saved}</p>}
    </div>
  </section>;
}
