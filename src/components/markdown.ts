import type { MarkedExtension, Token } from 'marked';

// ── Markdown rendering with the ||spoiler|| extension ─────────────────────────
// Single entry point for `marked`: every markdown surface (card notes, .md
// attachments) goes through getMarked(), so the spoiler syntax works
// everywhere. ||text|| renders as a click-to-reveal pill (Discord-style) and
// may nest inline markdown (**bold**, links…). Spoilers start hidden on every
// fresh render, so they re-hide naturally on each new study card.

const spoilerExtension: MarkedExtension = {
  extensions: [{
    name: 'spoiler',
    level: 'inline',
    start(src: string) {
      const i = src.indexOf('||');
      return i === -1 ? undefined : i;
    },
    tokenizer(src: string) {
      // Single-line, non-greedy; single pipes are allowed inside (||a|b||).
      const match = /^\|\|([^\n]+?)\|\|/.exec(src);
      if (!match) return undefined;
      const token = { type: 'spoiler', raw: match[0], tokens: [] as Token[] };
      this.lexer.inline(match[1]!, token.tokens);
      return token;
    },
    renderer(token) {
      return `<span class="spoiler" tabindex="0">${this.parser.parseInline(token.tokens as Token[])}</span>`;
    },
  }],
};

let markedPromise: Promise<typeof import('marked').marked> | null = null;

/** Lazy-loads marked with the spoiler extension registered (once). */
export function getMarked(): Promise<typeof import('marked').marked> {
  if (!markedPromise) {
    markedPromise = import('marked').then(({ marked }) => {
      marked.use(spoilerExtension);
      return marked;
    });
    installSpoilerToggle();
  }
  return markedPromise;
}

/** Delegated listeners so spoilers work on every innerHTML-rendered surface.
 *  A hidden spoiler swallows its click (a link inside must reveal, not
 *  navigate); a revealed one re-hides on click except when following a link. */
function installSpoilerToggle(): void {
  if (typeof document === 'undefined') return; // vitest runs in node

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const spoiler = target.closest?.('.spoiler') as HTMLElement | null;
    if (!spoiler) return;
    if (!spoiler.classList.contains('spoiler-revealed')) {
      e.preventDefault();
      e.stopPropagation();
      spoiler.classList.add('spoiler-revealed');
    } else if (!target.closest('a')) {
      spoiler.classList.remove('spoiler-revealed');
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if ((e.key !== 'Enter' && e.key !== ' ') || !el?.classList?.contains('spoiler')) return;
    e.preventDefault();
    el.classList.toggle('spoiler-revealed');
  });
}
