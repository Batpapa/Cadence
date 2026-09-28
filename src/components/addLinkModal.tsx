import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import type { Attachment, EmbedEntry, LinkMode } from '../types';
import { generateId, focusIfDesktop } from '../utils';
import { showModal, closeModal, renderModalBody } from './modal';
import { t } from '../services/i18nService';
import { detectPlatform, resolveEmbed, safeExternalUrl, linkMode, embedAutoTitle, type EmbedMeta } from '../services/embedService';

// ── Adding, and editing, a link attachment ───────────────────────────────────
// A link does one of two things when it is opened, and until 2026-09-22 it
// only did the first: play in a modal iframe, which four platforms support and
// nothing else does. Every other link on the web — a forum thread, a tutorial
// page, a session listing — had no way in at all.
//
// So the dialog now asks which of the two it is. The second needs a name and
// the first does not: an embed's title comes back from oEmbed, whereas nothing
// can be read off a cross-origin page, and a row reading
// "thesession.org/discussions/48219" is not a name anyone recognises later.
//
// An embed can take one all the same since 2026-09-28 (asked for from the
// field: the platform says "Nightride", the user wants to see whose). Left
// empty, the box means the platform's name, which is what it shows greyed out.
//
// One screen rather than two: unlike a file's source, the mode is not a
// question asked before the URL — it is a property OF the URL, and half the
// time the URL answers it on its own (see `canEmbed`).

/** What the footer's button reads — the body renders from its own state and
 *  writes here, being mounted outside the shell that owns the button.
 *  `name` is the label for an external link, and for an embed the name typed
 *  over the platform's — empty then meaning "the platform's". */
interface Draft { url: string; mode: LinkMode; name: string }

/** The platform's name for the entry being edited, and the URL it belongs to:
 *  it describes that URL and no other, so a box edited to a different video
 *  no longer has one to show. Null when adding, or editing an external link. */
interface KnownAuto { url: string; title: string }

/** oEmbed for one URL, shared by the check made while typing and by Save — so
 *  a Save pressed before the answer is in waits for that request rather than
 *  sending its own. See showLinkModal for what it keeps. */
type Lookup = (url: string) => Promise<EmbedMeta | null>;

/** What the typing-time check knows about one URL — the one in the box, or
 *  a moment ago the one in the box, which is why it carries it. */
type Check =
  | { url: string; state: 'pending' }
  | { url: string; state: 'ok'; title: string }
  | { url: string; state: 'bad' };

/** Long enough that typing a URL by hand is one request, short enough that a
 *  paste reads as answered at once. */
const CHECK_DELAY_MS = 400;

const MODES: ReadonlyArray<readonly [LinkMode, string]> = [
  ['embed', 'embed.mode.embed'],
  ['link',  'embed.mode.link'],
];

function LinkBody({ draft, known, lookup, disabled, busy, error, onSubmit }: {
  draft: Draft;
  known: KnownAuto | null;
  lookup: Lookup;
  disabled: Signal<boolean>;
  busy: Signal<boolean>;
  error: Signal<string>;
  onSubmit: () => void;
}) {
  const [url, setUrl] = useState(draft.url);
  const [mode, setMode] = useState<LinkMode>(draft.mode);
  const [name, setName] = useState(draft.name);
  const [check, setCheck] = useState<Check | null>(null);
  /** The URL once typing has paused on it — what an external link's error
   *  waits for, so that "h", "ht", "htt" are not each called malformed. */
  const [settled, setSettled] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);

  // Deferred focus through focusIfDesktop for both of its properties: no
  // keyboard thrown up on a phone, and this tree is rendered detached and only
  // mounted by the modal shell afterwards, so focusing now would reach an
  // element in no document. Same reasoning as the paste dialog's box.
  useLayoutEffect(() => { if (urlRef.current) focusIfDesktop(urlRef.current); }, []);

  // An empty box is the one state where the embed option stands without a
  // platform behind it: nothing is known yet, so nothing is taken away.
  const canEmbed = url.trim() === '' || detectPlatform(url) !== null;

  // The link is tried as it is typed, not only on Save: the platform's name
  // turning up under the box is the confirmation that the link is good, and a
  // bad one is said while it is still in front of the user. The saved entry's
  // own URL is never asked about — what the platform said is already stored,
  // and it is what Save will keep (see buildEntry).
  const trimmed = url.trim();
  const isKnown = known !== null && trimmed === known.url;
  useEffect(() => {
    if (trimmed === '') { setSettled(''); return; }
    const asks = mode === 'embed' && !isKnown;
    // "Checking…" from the first keystroke rather than after the pause, so
    // the line never shows the previous URL's verdict under the new one.
    if (asks) setCheck(c => (c?.url === trimmed && c.state === 'ok' ? c : { url: trimmed, state: 'pending' }));
    const timer = setTimeout(() => {
      setSettled(trimmed);
      if (!asks) return;
      void lookup(trimmed).then((meta) => {
        // An answer for a URL since replaced is dropped: the check in state
        // is always about the box's content, or about nothing.
        setCheck(c => (c?.url !== trimmed ? c
          : meta ? { url: trimmed, state: 'ok', title: meta.title }
          : { url: trimmed, state: 'bad' }));
      });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [trimmed, mode, isKnown, lookup]);

  const current = check?.url === trimmed ? check : null;

  // Empty rather than unknown when there is none: oEmbed can answer without a
  // title, and an empty name is no better a placeholder than none.
  const autoFor = (u: string) => {
    const k = u.trim();
    if (known && k === known.url) return known.title;
    return check?.url === k && check.state === 'ok' ? check.title : '';
  };
  const auto = autoFor(url);

  const apply = (patch: Partial<Draft>) => {
    const nextUrl  = patch.url  ?? draft.url;
    let nextName   = patch.name ?? draft.name;
    // A URL no platform claims can only be an external link, so the toggle
    // shows that choice already made rather than sitting on one that Add would
    // then refuse. Recomputed from the URL every time, so deleting a YouTube
    // link and pasting a blog post moves the toggle across by itself.
    const embeddable = nextUrl.trim() === '' || detectPlatform(nextUrl) !== null;
    const nextMode: LinkMode = embeddable ? (patch.mode ?? draft.mode) : 'link';

    // The box means something else on each side of the toggle — optional over
    // an embed, the whole label of an external link — so crossing it carries
    // the platform's name along where it is known. Into a link, it fills the
    // box that would otherwise refuse Save (and was what a link made from an
    // embed started with before embeds had a box). Back out, it is emptied
    // again, being exactly what an empty box means there. A name the user
    // typed is kept both ways.
    const nextAuto = autoFor(nextUrl);
    if (nextAuto !== '' && nextMode !== draft.mode) {
      if (nextMode === 'link' && nextName.trim() === '') nextName = nextAuto;
      else if (nextMode === 'embed' && nextName.trim() === nextAuto) nextName = '';
    }

    draft.url = nextUrl; draft.name = nextName; draft.mode = nextMode;
    setUrl(nextUrl); setName(nextName); setMode(nextMode);
    // A link with no name is the row's label missing: an external one shows
    // the name and nothing else, and the URL it would fall back to is exactly
    // what the name exists to replace.
    disabled.value = nextUrl.trim() === '' || (nextMode === 'link' && nextName.trim() === '');
    error.value = '';
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !disabled.value) { e.preventDefault(); onSubmit(); }
  };

  return (
    <div class="space-y-3">
      <div>
        <label class="label">{t('embed.url')}</label>
        <input
          ref={urlRef}
          type="url"
          class="input text-xs"
          placeholder={t('embed.placeholder')}
          value={url}
          onInput={(e) => apply({ url: (e.target as HTMLInputElement).value })}
          onKeyDown={onKeyDown}
        />
      </div>

      {/* The session library's segmented control, to the class: a background
          pill holding the two choices, rather than two loose buttons. */}
      <div class="flex gap-1 p-1 bg-bg rounded-lg">
        {MODES.map(([id, key]) => {
          const off = id === 'embed' && !canEmbed;
          return (
            <button
              key={id}
              type="button"
              disabled={off}
              title={off ? t('embed.mode.hint') : undefined}
              class={`flex-1 px-3 py-1 text-xs font-medium rounded transition-colors ${
                off ? 'text-dim opacity-50 cursor-not-allowed'
                  : mode === id ? 'bg-accent text-white cursor-pointer'
                  : 'text-muted hover:text-primary hover:bg-elevated cursor-pointer'}`}
              onClick={() => apply({ mode: id })}
            >
              {t(key)}
            </button>
          );
        })}
      </div>

      {/* Said out loud rather than left to a disabled button nobody hovers:
          the reason the choice is gone is a property of the URL just pasted,
          and it is not guessable from the greyed-out half alone. */}
      {!canEmbed && <p class="text-[11px] text-dim leading-relaxed">{t('embed.mode.hint')}</p>}

      <div>
        <label class="label">{t('embed.name')}</label>
        {/* "Automatic" in italics, the platform's own name upright: the first
            describes what will be there, the second IS what will be there,
            and the slant is what tells them apart at a glance. */}
        <input
          type="text"
          class={`input text-xs ${mode === 'embed' && !auto ? 'placeholder:italic' : ''}`}
          placeholder={mode === 'link' ? t('embed.namePlaceholder') : auto || t('embed.namePlaceholderAuto')}
          value={name}
          onInput={(e) => apply({ name: (e.target as HTMLInputElement).value })}
          onKeyDown={onKeyDown}
        />
      </div>

      {/* The oEmbed round trip, which is the only thing here that takes time.
          Its own line rather than the error's — it used to be written into it,
          and "Checking…" came up in the red the box is otherwise only ever red
          for. Save's own error first, being the newest thing said; then the
          typing-time verdict on the URL in the box. */}
      {busy.value || (mode === 'embed' && current?.state === 'pending')
        ? <p class="text-xs text-dim">{t('embed.checking')}</p>
        : error.value !== '' ? <p class="text-xs text-danger">{error.value}</p>
        : mode === 'embed' && current?.state === 'bad' ? <p class="text-xs text-danger">{t('embed.error')}</p>
        : mode === 'link' && trimmed !== '' && settled === trimmed && !safeExternalUrl(trimmed)
          && <p class="text-xs text-danger">{t('embed.badUrl')}</p>}
    </div>
  );
}

/** The entry the draft describes, or null with `error` set to why not.
 *
 *  Built fresh from the draft rather than spread over `base`, which is what
 *  makes a mode change a real change: an embed turned into a link loses the
 *  `embedUrl` and `autoTitle` that would otherwise still be sitting there.
 *  The id is the one thing carried over — it identifies the attachment, not
 *  its contents.
 *
 *  An embed whose URL has not moved keeps what oEmbed said the first time
 *  instead of asking again: nothing the platform could answer has changed, and
 *  asking made a rename impossible offline — Save would fail on a request
 *  whose only possible news was the title about to be typed over. */
async function buildEntry(draft: Draft, base: EmbedEntry | undefined, lookup: Lookup, error: Signal<string>): Promise<EmbedEntry | null> {
  const url = draft.url.trim();
  if (!url) return null;
  const id = base?.id ?? generateId();
  const name = draft.name.trim();

  if (draft.mode === 'link') {
    if (!safeExternalUrl(url)) { error.value = t('embed.badUrl'); return null; }
    return { id, url, title: name, mode: 'link' };
  }

  // `title` holds the label whatever it came from, so that a device on an
  // older bundle, which reads nothing else, still shows the user's name.
  if (base && linkMode(base) === 'embed' && base.url === url && base.embedUrl) {
    const autoTitle = embedAutoTitle(base) ?? '';
    return { id, url, title: name || autoTitle, autoTitle, embedUrl: base.embedUrl, mode: 'embed' };
  }

  const meta = await lookup(url);
  if (!meta) { error.value = t('embed.error'); return null; }
  return { id, url, title: name || meta.title, autoTitle: meta.title, embedUrl: meta.embedUrl, mode: 'embed' };
}

function showLinkModal(title: string, confirmLabel: string, base: EmbedEntry | undefined, onDone: (entry: EmbedEntry) => void): void {
  // An embed's box opens empty unless a name was typed over the platform's —
  // a title equal to it being no name of the user's, since an empty box would
  // save exactly the same entry.
  const baseAuto = base ? embedAutoTitle(base) : undefined;
  const known: KnownAuto | null = base && baseAuto ? { url: base.url, title: baseAuto } : null;
  const draft: Draft = {
    url:  base?.url ?? '',
    mode: base ? linkMode(base) : 'embed',
    name: base?.title && base.title !== baseAuto ? base.title : '',
  };
  // Starts refused when there is nothing to act on — an addition always, an
  // edit never, its entry having passed this same test once already.
  const disabled = signal(draft.url.trim() === '' || (draft.mode === 'link' && draft.name.trim() === ''));
  const busy = signal(false);
  const error = signal('');

  // One request per URL for the dialog's life, answers kept — going back to a
  // URL already tried, or pressing Save on the one just checked, costs
  // nothing. Failures are not kept: most are the network, and Save is then
  // the retry, which a cached "no" would turn into the same refusal forever.
  const lookups = new Map<string, Promise<EmbedMeta | null>>();
  const lookup: Lookup = (url) => {
    let answer = lookups.get(url);
    if (!answer) {
      answer = resolveEmbed(url).then((meta) => { if (!meta) lookups.delete(url); return meta; });
      lookups.set(url, answer);
    }
    return answer;
  };

  let leave = () => {};
  // Barred while the oEmbed request is out, by the guard and by the greyed
  // button both: Enter and the footer reach the same place, and a slow answer
  // used to mean one fetch per impatient press.
  const commit = async () => {
    if (busy.value) return;
    busy.value = true; disabled.value = true; error.value = '';
    const entry = await buildEntry(draft, base, lookup, error);
    busy.value = false;
    if (!entry) { disabled.value = false; return; } // error on screen, dialog stays open
    leave();
    onDone(entry);
  };

  const { el, cleanup } = renderModalBody(
    <LinkBody draft={draft} known={known} lookup={lookup} disabled={disabled} busy={busy} error={error} onSubmit={() => { void commit(); }} />,
  );
  leave = () => { closeModal(); cleanup(); };

  showModal(title, el, [
    { label: t('common.cancel'), onClick: leave },
    { label: confirmLabel, primary: true, disabled, onClick: () => { void commit(); } },
  ], { maxWidth: '26rem', onDismiss: cleanup });
}

/** The "Link" entry of the attachment list's "+" menu. */
export function showAddLinkModal(onAdd: (a: Attachment) => void): void {
  showLinkModal(t('embed.addTitle'), t('common.add'), undefined, (entry) => onAdd({ type: 'embed', ...entry }));
}

/** The pencil on a link row. Exists first for the mode: an embed that turned
 *  out not to play — a platform page oEmbed answered for but the iframe will
 *  not show — is one switch away from being usable as an external link, where
 *  before it had to be deleted and re-added. And, since embeds have a name
 *  box, for renaming one. */
export function showEditLinkModal(entry: EmbedEntry, onSave: (entry: EmbedEntry) => void): void {
  showLinkModal(t('embed.editTitle'), t('common.save'), entry, onSave);
}
