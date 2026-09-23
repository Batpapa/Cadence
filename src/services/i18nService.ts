import en from '../i18n/en.json';
import fr from '../i18n/fr.json';

export type Lang = 'en' | 'fr';
type Vars = Record<string, string | number>;

const LANGS: Record<Lang, Record<string, string>> = { en, fr };
let current: Record<string, string> = en;

export function setLanguage(lang: Lang): void {
  current = LANGS[lang] ?? en;
  translateStaticMarkup(lang);
}

/** The legal footer is written in raw index.html rather than rendered by the
 *  app, so the links stay crawlable with JavaScript disabled (Google's OAuth
 *  review reads the page that way) — which also means it is hardcoded in
 *  English before a single line of ours runs, and stayed English in a French
 *  interface (reported 2026-09-15). Moving it into the app tree would undo the
 *  reason it exists, so it is retranslated in place instead, here rather than
 *  at one call site: this is the one function every language change goes
 *  through, boot and settings alike.
 *
 *  Keyed off `data-i18n` so anything else that must exist before the app boots
 *  can join by adding the attribute. Guarded for the test environment, which
 *  has no document. */
function translateStaticMarkup(lang: Lang): void {
  if (typeof document === 'undefined') return;
  // Not cosmetic: it is what a screen reader picks its voice from, and the
  // document claimed English whatever the interface said.
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (key) el.textContent = tIn(lang, key);
  });
}

/** A string in a NAMED language, whatever the interface is currently set to.
 *  For text written into data at creation time, where the language that counts
 *  is the one the data belongs to — `t` answers in whichever language was last
 *  applied, which before a user is opened is not necessarily theirs. */
export function tIn(lang: Lang, key: string): string {
  return LANGS[lang]?.[key] ?? en[key as keyof typeof en] ?? key;
}

export function t(key: string, vars?: Vars): string {
  let str = current[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}
