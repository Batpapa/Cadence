import en from '../i18n/en.json';
import fr from '../i18n/fr.json';

export type Lang = 'en' | 'fr';
type Vars = Record<string, string | number>;

const LANGS: Record<Lang, Record<string, string>> = { en, fr };
let current: Record<string, string> = en;

export function setLanguage(lang: Lang): void {
  current = LANGS[lang] ?? en;
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
