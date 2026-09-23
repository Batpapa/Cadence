// @vitest-environment jsdom
// The point of these tests is the markup that exists BEFORE the app renders —
// the legal footer in index.html, which is raw HTML so it stays readable with
// JavaScript disabled, and which therefore starts out in English whatever the
// user's language is. A real document is the whole subject, so jsdom it is.
import { describe, expect, it, beforeEach } from 'vitest';
import { setLanguage, t, tIn } from './i18nService';

/** The footer as index.html ships it, English text and all. */
function plantFooter(): void {
  document.body.innerHTML = `
    <footer id="legal-footer">
      <a href="./privacy.html" data-i18n="settings.privacyPolicy">Privacy Policy</a>
      &nbsp;·&nbsp;
      <a href="./terms.html" data-i18n="settings.termsOfService">Terms of Service</a>
    </footer>`;
}

// Array.from, not a spread: the build's TypeScript lib does not give a NodeList
// an iterator, so `[...nodeList]` compiles under vitest and breaks `npm run build`.
const footerText = () => Array.from(document.querySelectorAll('#legal-footer a')).map(a => a.textContent);

describe('setLanguage and the pre-rendered markup', () => {
  beforeEach(() => { plantFooter(); document.documentElement.lang = 'en'; setLanguage('en'); });

  it('translates the static legal footer', () => {
    setLanguage('fr');
    expect(footerText()).toEqual(['Politique de confidentialité', "Conditions d'utilisation"]);
  });

  it('puts it back when the interface returns to English', () => {
    setLanguage('fr');
    setLanguage('en');
    expect(footerText()).toEqual(['Privacy Policy', 'Terms of Service']);
  });

  it('declares the language on the document, which is what a screen reader reads it from', () => {
    setLanguage('fr');
    expect(document.documentElement.lang).toBe('fr');
  });

  it('leaves a page with no such markup alone', () => {
    document.body.innerHTML = '';
    expect(() => setLanguage('fr')).not.toThrow();
  });

  it('keeps the two keys it relies on translated in both languages', () => {
    // A guard for the footer, not for the i18n files in general: these two keys
    // are read through `data-i18n` rather than a call site, so nothing else
    // would notice if one of them were dropped.
    for (const key of ['settings.privacyPolicy', 'settings.termsOfService']) {
      expect(tIn('en', key)).not.toBe(key);
      expect(tIn('fr', key)).not.toBe(key);
      expect(tIn('fr', key)).not.toBe(tIn('en', key));
    }
  });

  it('still answers in the language last set', () => {
    setLanguage('fr');
    expect(t('settings.privacyPolicy')).toBe('Politique de confidentialité');
  });
});
