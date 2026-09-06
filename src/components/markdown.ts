import type { MarkedExtension, Token } from 'marked';

// ── Markdown rendering with the ||spoiler|| extension ─────────────────────────
// Single entry point for `marked`: every markdown surface (card notes, .md
// attachments) goes through renderMarkdown(), so the spoiler syntax works
// everywhere. ||text|| renders as a click-to-reveal pill (Discord-style) and
// may nest inline markdown (**bold**, links…). Spoilers start hidden on every
// fresh render, so they re-hide naturally on each new study card.
//
// `getMarked` is deliberately NOT exported: marked passes raw HTML straight
// through (verified — `<img src=x onerror=…>` comes out untouched) and every
// caller writes the result into innerHTML. Notes are not always written by the
// person reading them — a shared card package carries someone else's markdown —
// so the parse and the sanitisation must be impossible to separate. Sanitising
// inside the only exported function is what makes that structural rather than
// a rule someone has to remember.

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
function getMarked(): Promise<typeof import('marked').marked> {
  if (!markedPromise) {
    markedPromise = import('marked').then(({ marked }) => {
      marked.use(spoilerExtension);
      return marked;
    });
    installSpoilerToggle();
  }
  return markedPromise;
}

let purifyPromise: Promise<typeof import('dompurify').default> | null = null;

/** Lazy-loads DOMPurify alongside marked — both are only needed the first time
 *  a markdown surface is rendered, and most sessions never open one. */
function getPurify(): Promise<typeof import('dompurify').default> {
  if (!purifyPromise) purifyPromise = import('dompurify').then(m => m.default);
  return purifyPromise;
}

/**
 * Parses markdown and returns HTML that is safe to assign to innerHTML.
 *
 * DOMPurify runs with its default profile, which was checked against what this
 * app actually renders: the spoiler span keeps its class and tabindex, links,
 * tables, task-list checkboxes and fenced code all survive, while `onerror` and
 * other event-handler attributes, `<script>`, and `javascript:` hrefs are
 * removed. No custom allow-list is needed, and not having one means nothing
 * silently rots as the defaults improve.
 */
export async function renderMarkdown(src: string): Promise<string> {
  const [marked, purify] = await Promise.all([getMarked(), getPurify()]);
  return purify.sanitize(marked.parse(src) as string);
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
