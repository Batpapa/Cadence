// FIRST: the page is one folder down from the bundles (abcjs, for a tune's
// score, is loaded on demand).
import '../thesessionEmbed/publicPath';
import '../styles.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { setLanguage, tIn, type Lang } from '../services/i18nService';
import { welcomeLanguage } from '../services/userService';
import { applyTheme } from '../services/themeService';
import { applyZoom } from '../services/zoomService';
import { initPWA } from '../services/pwaService';
import { ModalHost } from '../components/modal';
import { TrendingModule, type TrendingEnv, type TrendingRouteParams } from '../trending/ui/trendingModule';
import { fetchPublishedHistory } from '../trending/publishedHistory';
import type { GainMode } from '../services/trendingService';
import { StandaloneShell } from './shell';

// ── Trending/: TheSession's trending tunes, for a look (2026-10-26) ──────────
// The app's Trending module with nothing behind it: the history is the one
// published with the site (scripts/build-popularity.mjs, every Monday), read
// in one request instead of synced week by week; no "+" to make a card, every
// name leading to The Session; the filters kept in the address, so that a
// view can be shared as a link.

applyTheme();
applyZoom();
// At once, as main.ts does: the browser's install offer comes once per page.
initPWA();

function paramsFromUrl(): TrendingRouteParams {
  const q = new URLSearchParams(location.search);
  const n = q.get('min');
  return {
    from: q.get('from') ?? undefined,
    to: q.get('to') ?? undefined,
    gainMode: (q.get('gain') as GainMode | null) ?? undefined,
    minTunebooks: n !== null && Number.isFinite(Number(n)) ? Number(n) : undefined,
    deflate: q.has('deflate') ? q.get('deflate') !== '0' : undefined,
  };
}

const ENV: TrendingEnv = {
  load: async () => {
    const db = await fetchPublishedHistory('../data/popularity.json');
    if (!db) throw new Error('no published history');
    return db;
  },
  saveParams: p => {
    const q = new URLSearchParams();
    if (p.from) q.set('from', p.from);
    if (p.to) q.set('to', p.to);
    if (p.gainMode) q.set('gain', p.gainMode);
    if (p.minTunebooks !== undefined) q.set('min', String(p.minTunebooks));
    if (p.deflate !== undefined) q.set('deflate', p.deflate ? '1' : '0');
    const query = q.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  },
  library: false,
};

function TrendingPage() {
  const [lang, setLang] = useState<Lang>(welcomeLanguage);
  // The module's strings are read through t(): it is mounted again in the
  // new language rather than told about it.
  const [key, setKey] = useState(0);

  useEffect(() => {
    setLanguage(lang);
    document.documentElement.lang = lang;
    document.title = `${tIn(lang, 'standalone.trending.title')} — Cadence`;
  }, [lang]);

  // WelcomePrefs, in the header, has already switched the language.
  const onLanguageChange = () => {
    setLang(welcomeLanguage());
    setKey(k => k + 1);
  };

  return (
    <StandaloneShell lang={lang} onLanguageChange={onLanguageChange} scroll>
      <TrendingModule key={key} env={ENV} initial={paramsFromUrl()} />
      <ModalHost />
    </StandaloneShell>
  );
}

setLanguage(welcomeLanguage());
render(<TrendingPage />, document.getElementById('app')!);
