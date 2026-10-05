import { useEffect, useRef, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';
const storageKey = 'wisdom-tree-theme';
const isTheme = (value: string | null): value is Theme => value === 'light' || value === 'dark' || value === 'system';
function savedTheme(): Theme {
  try { const value = localStorage.getItem(storageKey); return isTheme(value) ? value : 'system'; }
  catch { return 'system'; }
}

function ThemeIcon({ kind }: { kind: 'sun' | 'moon' | 'system' }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'moon' ? <path d="M20.8 13.1A8.9 8.9 0 0 1 10.9 3.2a9 9 0 1 0 9.9 9.9Z" /> : kind === 'sun' ? <><circle cx="12" cy="12" r="3.8" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></> : <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>}
  </svg>;
}
const choices: { value: Theme; label: string; icon: 'sun' | 'moon' | 'system' }[] = [
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
  { value: 'system', label: '随系统', icon: 'system' },
];

export default function ThemeSelector() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [darkMode, setDarkMode] = useState(() => document.documentElement.dataset.colorMode === 'dark');
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && system.matches);
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.colorMode = dark ? 'dark' : 'light';
      setDarkMode(dark);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#142019' : '#27533c');
    };
    const sync = (event: StorageEvent) => { if (event.key === storageKey) setTheme(isTheme(event.newValue) ? event.newValue : 'system'); };
    apply();
    system.addEventListener('change', apply);
    window.addEventListener('storage', sync);
    return () => { system.removeEventListener('change', apply); window.removeEventListener('storage', sync); };
  }, [theme]);
  useEffect(() => {
    if (!open) return;
    options.current[choices.findIndex(choice => choice.value === theme)]?.focus();
    const dismiss = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, theme]);
  const choose = (value: Theme) => {
    setTheme(value);
    try { localStorage.setItem(storageKey, value); } catch { /* The choice still applies to this open page. */ }
    setOpen(false); trigger.current?.focus();
  };
  const label = choices.find(choice => choice.value === theme)?.label || '随系统';
  return <div className="theme-selector" ref={wrapper} onKeyDown={event => {
    if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const current = options.current.findIndex(option => option === document.activeElement);
      options.current[(current + (event.key === 'ArrowDown' ? 1 : 2)) % choices.length]?.focus();
    }
  }}>
    <button ref={trigger} className={`theme-icon-button ${darkMode ? 'moon' : 'sun'}`} type="button" aria-label={`切换主题，当前${label}`} title={`主题：${label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><ThemeIcon kind={darkMode ? 'moon' : 'sun'} /></button>
    {open && <div className="theme-menu" role="menu" aria-label="主题"><span className="theme-menu-label">外观</span>{choices.map((choice, index) => <button key={choice.value} ref={element => { options.current[index] = element; }} type="button" role="menuitemradio" aria-checked={theme === choice.value} onClick={() => choose(choice.value)}><ThemeIcon kind={choice.icon} /><span>{choice.label}</span>{theme === choice.value && <svg className="theme-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>}</button>)}</div>}
  </div>;
}
