import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import type { Attachment, EmbedEntry, LinkMode } from '../types';
import { generateId, focusIfDesktop } from '../utils';
import { showModal, closeModal, renderModalBody } from './modal';
import { t } from '../services/i18nService';
import { checkEmbed, checkLink, detectPlatform, safeExternalUrl, linkMode, embedAutoTitle, type LinkCheck, type EmbedPlatform } from '../services/embedService';
import { refusalMessage } from '../services/remoteFile';

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
// question asked before the URL — it is a property OF the URL. The dialog no
// longer answers it for the user, though (see `apply`).
//
// Since 2026-09-29 the in-app side also takes a plain file — audio, video,
// image, PDF, text, ABC — which then opens in Cadence's own viewers
// (remoteFile.ts). Whether it can is the server's say, not the URL's: it has
// to let a page read its answer (CORS). The typing-time check asks it, so a
// refusal is known here, where the other side of the toggle is one click away,
// rather than at the first click on the row.

/** What the footer's button reads — the body renders from its own state and
 *  writes here, being mounted outside the shell that owns the button.
 *  `name` is the label for an external link, and for an embed the name typed
 *  over the platform's — empty then meaning "the platform's". */
interface Draft { url: string; mode: LinkMode; name: string }

/** The platform's name for the entry being edited, and the URL it belongs to:
 *  it describes that URL and no other, so a box edited to a different video
 *  no longer has one to show. Null when adding, or editing an external link. */
interface KnownAuto { url: string; title: string }

/** The entry being edited, as it was saved. A URL that has not moved from it,
 *  on the side it was saved on, is not asked about again: it passed once, and
 *  asking would make a rename impossible offline (see buildEntry). */
interface Saved { url: string; mode: LinkMode }

/** The check for one URL on one side of the toggle — oEmbed or the file probe
 *  in-app, "does it lead anywhere" for a tab — shared by the check made while
 *  typing and by Save, so a Save pressed before the answer is in waits for
 *  that request rather than sending its own. See showLinkModal for what it
 *  keeps. */
type Lookup = (url: string, mode: LinkMode) => Promise<LinkCheck>;

/** What the typing-time check knows about one URL on one side — the ones in
 *  the dialog, or a moment ago the ones in the dialog, which is why it carries
 *  them: a verdict for the tab side says nothing about the in-app one. */
type Check =
  | { url: string; mode: LinkMode; state: 'pending' }
  | { url: string; mode: LinkMode; state: 'ok'; title: string }
  | { url: string; mode: LinkMode; state: 'bad'; message: string };

/** Long enough that typing a URL by hand is one request, short enough that a
 *  paste reads as answered at once. */
const CHECK_DELAY_MS = 400;

/** The in-app side's list, in the order the hint reads. Brand names as they
 *  write themselves, in every language; the last entry is ours to translate. */
const SUPPORTED: ReadonlyArray<readonly [EmbedPlatform | 'file', string | null]> = [
  ['youtube', 'YouTube'], ['spotify', 'Spotify'], ['deezer', 'Deezer'], ['soundcloud', 'SoundCloud'], ['file', null],
];

const MODES: ReadonlyArray<readonly [LinkMode, string]> = [
  ['embed', 'embed.mode.embed'],
  ['link',  'embed.mode.link'],
];

function LinkBody({ draft, known, saved, lookup, disabled, busy, error, onSubmit }: {
  draft: Draft;
  known: KnownAuto | null;
  saved: Saved | null;
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
  const urlRef = useRef<HTMLInputElement>(null);

  // Deferred focus through focusIfDesktop for both of its properties: no
  // keyboard thrown up on a phone, and this tree is rendered detached and only
  // mounted by the modal shell afterwards, so focusing now would reach an
  // element in no document. Same reasoning as the paste dialog's box.
  useLayoutEffect(() => { if (urlRef.current) focusIfDesktop(urlRef.current); }, []);

  // The link is tried as it is typed, not only on Save, and on both sides of
  // the toggle: the platform's name turning up under the box is the
  // confirmation that the link is good, and a bad one is said while it is
  // still in front of the user. The saved entry's own URL is never asked about
  // — what was learnt is already stored, and it is what Save will keep.
  const trimmed = url.trim();
  const unchanged = saved !== null && trimmed === saved.url && mode === saved.mode;
  /** What the dialog shows NOW, for an answer to tell whether it still
   *  concerns anything on screen — one for a URL since replaced, or for the
   *  side just left, is dropped. */
  const shown = useRef({ url: trimmed, mode });
  shown.current = { url: trimmed, mode };
  useEffect(() => {
    if (trimmed === '' || unchanged) return;
    // "Checking…" from the first keystroke rather than after the pause, so
    // the line never shows the previous URL's verdict under the new one — but
    // not for what is not a URL yet: "h", "ht"… get their verdict after the
    // pause, rather than a wait for a request that will never be sent.
    if (safeExternalUrl(trimmed)) {
      setCheck(c => (c?.url === trimmed && c.mode === mode && c.state === 'ok' ? c : { url: trimmed, mode, state: 'pending' }));
    }
    const timer = setTimeout(() => {
      void lookup(trimmed, mode).then((answer) => {
        if (shown.current.url !== trimmed || shown.current.mode !== mode) return;
        setCheck(answer.ok ? { url: trimmed, mode, state: 'ok', title: answer.title }
          : { url: trimmed, mode, state: 'bad', message: refusalMessage(answer.refusal) });
      });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [trimmed, mode, unchanged, lookup]);

  const current = check?.url === trimmed && check.mode === mode && !unchanged ? check : null;
  // Which of the in-app side's kinds this URL is, once that is known: a check
  // that passed, or the saved embed itself, which passed when it was added.
  const supported: EmbedPlatform | 'file' | null =
    mode === 'embed' && trimmed !== '' && (unchanged || current?.state === 'ok')
      ? detectPlatform(trimmed) ?? 'file'
      : null;

  // Empty rather than unknown when there is none: oEmbed can answer without a
  // title, and an empty name is no better a placeholder than none. Only an
  // in-app check has one — a tab's learns nothing but "it leads somewhere".
  const autoFor = (u: string) => {
    const k = u.trim();
    if (known && k === known.url) return known.title;
    return check?.url === k && check.mode === 'embed' && check.state === 'ok' ? check.title : '';
  };
  const auto = autoFor(url);

  const apply = (patch: Partial<Draft>) => {
    const nextUrl  = patch.url  ?? draft.url;
    let nextName   = patch.name ?? draft.name;
    // The toggle moves under the user's hand and nothing else. Until
    // 2026-09-29 a URL no platform claimed pushed it to the external side by
    // itself, which was right while only four platforms could play in the
    // app; with files there, any URL may belong on either side, and a toggle
    // jumping away from what was chosen — in answer to a refusal, or to a
    // guess from the URL's shape — read as the dialog arguing back (user's
    // call). A refusal is said in red under the side it concerns instead.
    const nextMode: LinkMode = patch.mode ?? draft.mode;

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

  // The platform's name stays greyed out — the mark that it is automatic —
  // until the box is clicked: then it becomes text to edit, with the caret
  // where the click landed (2026-10-09, user's design). Written into the
  // field on pointerdown, BEFORE the browser places the caret: the click is
  // then measured against the very letters that were showing, the placeholder
  // and the text sharing font, size and padding. Left untouched, it goes back
  // to grey on the way out, where an empty box means the same name.
  const autoShown = mode === 'embed' && auto !== '';
  const revealAuto = (input: HTMLInputElement) => {
    if (!autoShown || input.value !== '') return;
    input.value = auto;
    apply({ name: auto });
  };
  const hideAuto = (input: HTMLInputElement) => {
    if (autoShown && input.value.trim() === auto) apply({ name: '' });
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
        {MODES.map(([id, key]) => (
          <button
            key={id}
            type="button"
            class={`flex-1 px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
              mode === id ? 'bg-accent text-white' : 'text-muted hover:text-primary hover:bg-elevated'}`}
            onClick={() => apply({ mode: id })}
          >
            {t(key)}
          </button>
        ))}
      </div>

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
          // Not once inside: a box emptied on purpose stays empty under the next click.
          onPointerDown={(e) => { if (document.activeElement !== e.currentTarget) revealAuto(e.currentTarget); }}
          // Reached by Tab rather than a click: the whole name, caret at its end.
          onFocus={(e) => revealAuto(e.currentTarget)}
          onBlur={(e) => hideAuto(e.currentTarget)}
          onKeyDown={onKeyDown}
        />
        {/* What the in-app side takes, and only there: a new tab opens
            anything, and has nothing to list. The item the URL turned out to
            be lights up once it is confirmed — the list doubles as the
            verdict, and says WHICH of them it is. */}
        {mode === 'embed' && (
          <p class="mt-1 text-[11px] text-dim leading-relaxed">
            {t('embed.mode.hintLabel')}{' '}
            {SUPPORTED.map(([id, label], i) => (
              <span key={id}>
                {i > 0 && ', '}
                <span class={supported === id ? 'text-success font-medium' : undefined}>
                  {label ?? t('embed.mode.hintFiles')}
                </span>
              </span>
            ))}
          </p>
        )}
      </div>

      {/* The one line that takes time — oEmbed, the file probe, or "does it
          lead anywhere" — and its verdict. Its own line rather than the
          error's — it used to be written into it, and "Checking…" came up in
          the red the box is otherwise only ever red for. Save's own error
          first, being the newest thing said; then the typing-time verdict on
          what is in the dialog. */}
      {busy.value || current?.state === 'pending'
        ? <p class="text-xs text-dim">{t('embed.checking')}</p>
        : error.value !== '' ? <p class="text-xs text-danger">{error.value}</p>
        : current?.state === 'bad' && <p class="text-xs text-danger">{current.message}</p>}
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

  if (!safeExternalUrl(url)) { error.value = t('embed.badUrl'); return null; }
  const unchanged = base !== undefined && base.url === url && linkMode(base) === draft.mode;

  if (draft.mode === 'link') {
    if (!unchanged) {
      const answer = await lookup(url, 'link');
      if (!answer.ok) { error.value = refusalMessage(answer.refusal); return null; }
    }
    return { id, url, title: name, mode: 'link' };
  }

  // `title` holds the label whatever it came from, so that a device on an
  // older bundle, which reads nothing else, still shows the user's name.
  if (unchanged && base.embedUrl) {
    const autoTitle = embedAutoTitle(base) ?? '';
    return { id, url, title: name || autoTitle, autoTitle, embedUrl: base.embedUrl, mode: 'embed' };
  }

  const answer = await lookup(url, 'embed');
  if (!answer.ok) { error.value = refusalMessage(answer.refusal); return null; }
  return { id, url, title: name || answer.title, autoTitle: answer.title, embedUrl: answer.embedUrl, mode: 'embed' };
}

function showLinkModal(title: string, confirmLabel: string, base: EmbedEntry | undefined, onDone: (entry: EmbedEntry) => void): void {
  // An embed's box opens empty unless a name was typed over the platform's —
  // a title equal to it being no name of the user's, since an empty box would
  // save exactly the same entry. The platform's name shows greyed out, and
  // turns into text to edit the moment the box is clicked (see LinkBody).
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

  // One request per URL and side for the dialog's life, answers kept — going
  // back to a URL already tried, or pressing Save on the one just checked,
  // costs nothing. Failures are not kept: most are the network, and Save is
  // then the retry, which a cached "no" would turn into the same refusal
  // forever.
  const lookups = new Map<string, Promise<LinkCheck>>();
  const lookup: Lookup = (url, mode) => {
    const key = mode + ' ' + url;
    let answer = lookups.get(key);
    if (!answer) {
      answer = (mode === 'embed' ? checkEmbed(url) : checkLink(url))
        .then((check) => { if (!check.ok) lookups.delete(key); return check; });
      lookups.set(key, answer);
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
    <LinkBody draft={draft} known={known} saved={base ? { url: base.url, mode: linkMode(base) } : null} lookup={lookup} disabled={disabled} busy={busy} error={error} onSubmit={() => { void commit(); }} />,
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
