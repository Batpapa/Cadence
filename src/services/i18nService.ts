import en from '../i18n/en.json';
import fr from '../i18n/fr.json';

export type Lang = 'en' | 'fr';
type Vars = Record<string, string | number>;

const LANGS: Record<Lang, Record<string, string>> = { en, fr };
let current: Record<string, string> = en;

export function setLanguage(lang: Lang): void {
  current = LANGS[lang] ?? en;
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
