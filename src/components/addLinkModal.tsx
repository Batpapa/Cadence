import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import type { Attachment, EmbedEntry, LinkMode } from '../types';
import { generateId, focusIfDesktop } from '../utils';
import { showModal, closeModal, renderModalBody } from './modal';
import { t } from '../services/i18nService';
import { detectPlatform, resolveEmbed, safeExternalUrl, linkMode } from '../services/embedService';

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
// One screen rather than two: unlike a file's source, the mode is not a
// question asked before the URL — it is a property OF the URL, and half the
// time the URL answers it on its own (see `canEmbed`).

/** What the footer's button reads — the body renders from its own state and
 *  writes here, being mounted outside the shell that owns the button. */
interface Draft { url: string; mode: LinkMode; name: string }

const MODES: ReadonlyArray<readonly [LinkMode, string]> = [
  ['embed', 'embed.mode.embed'],
  ['link',  'embed.mode.link'],
];

function LinkBody({ draft, disabled, busy, error, onSubmit }: {
  draft: Draft;
  disabled: Signal<boolean>;
  busy: Signal<boolean>;
  error: Signal<string>;
  onSubmit: () => void;
}) {
  const [url, setUrl] = useState(draft.url);
  const [mode, setMode] = useState<LinkMode>(draft.mode);
  const [name, setName] = useState(draft.name);
  const urlRef = useRef<HTMLInputElement>(null);

  // Deferred focus through focusIfDesktop for both of its properties: no
  // keyboard thrown up on a phone, and this tree is rendered detached and only
  // mounted by the modal shell afterwards, so focusing now would reach an
  // element in no document. Same reasoning as the paste dialog's box.
  useLayoutEffect(() => { if (urlRef.current) focusIfDesktop(urlRef.current); }, []);

  // An empty box is the one state where the embed option stands without a
  // platform behind it: nothing is known yet, so nothing is taken away.
  const canEmbed = url.trim() === '' || detectPlatform(url) !== null;

  const apply = (patch: Partial<Draft>) => {
    const nextUrl  = patch.url  ?? draft.url;
    const nextName = patch.name ?? draft.name;
    // A URL no platform claims can only be an external link, so the toggle
    // shows that choice already made rather than sitting on one that Add would
    // then refuse. Recomputed from the URL every time, so deleting a YouTube
    // link and pasting a blog post moves the toggle across by itself.
    const embeddable = nextUrl.trim() === '' || detectPlatform(nextUrl) !== null;
    const nextMode: LinkMode = embeddable ? (patch.mode ?? draft.mode) : 'link';

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

      {mode === 'link' && (
        <div>
          <label class="label">{t('embed.name')}</label>
          <input
            type="text"
            class="input text-xs"
            placeholder={t('embed.namePlaceholder')}
            value={name}
            onInput={(e) => apply({ name: (e.target as HTMLInputElement).value })}
            onKeyDown={onKeyDown}
          />
        </div>
      )}

      {/* The oEmbed round trip, which is the only thing here that takes time.
          Its own line rather than the error's — it used to be written into it,
          and "Checking…" came up in the red the box is otherwise only ever red
          for. */}
      {busy.value
        ? <p class="text-xs text-dim">{t('embed.checking')}</p>
        : error.value !== '' && <p class="text-xs text-danger">{error.value}</p>}
    </div>
  );
}

/** The entry the draft describes, or null with `error` set to why not.
 *
 *  Built fresh from the draft rather than spread over `base`, which is what
 *  makes a mode change a real change: an embed turned into a link loses the
 *  `embedUrl` that would otherwise still be sitting there, and a link turned
 *  into an embed loses the name the user typed in favour of the resolved one.
 *  The id is the one thing carried over — it identifies the attachment, not
 *  its contents. */
async function buildEntry(draft: Draft, base: EmbedEntry | undefined, error: Signal<string>): Promise<EmbedEntry | null> {
  const url = draft.url.trim();
  if (!url) return null;
  const id = base?.id ?? generateId();

  if (draft.mode === 'link') {
    if (!safeExternalUrl(url)) { error.value = t('embed.badUrl'); return null; }
    return { id, url, title: draft.name.trim(), mode: 'link' };
  }

  const meta = await resolveEmbed(url);
  if (!meta) { error.value = t('embed.error'); return null; }
  return { id, url, title: meta.title, embedUrl: meta.embedUrl, mode: 'embed' };
}

function showLinkModal(title: string, confirmLabel: string, base: EmbedEntry | undefined, onDone: (entry: EmbedEntry) => void): void {
  const draft: Draft = {
    url:  base?.url ?? '',
    mode: base ? linkMode(base) : 'embed',
    name: base?.title ?? '',
  };
  // Starts refused when there is nothing to act on — an addition always, an
  // edit never, its entry having passed this same test once already.
  const disabled = signal(draft.url.trim() === '' || (draft.mode === 'link' && draft.name.trim() === ''));
  const busy = signal(false);
  const error = signal('');

  let leave = () => {};
  // Barred while the oEmbed request is out, by the guard and by the greyed
  // button both: Enter and the footer reach the same place, and a slow answer
  // used to mean one fetch per impatient press.
  const commit = async () => {
    if (busy.value) return;
    busy.value = true; disabled.value = true; error.value = '';
    const entry = await buildEntry(draft, base, error);
    busy.value = false;
    if (!entry) { disabled.value = false; return; } // error on screen, dialog stays open
    leave();
    onDone(entry);
  };

  const { el, cleanup } = renderModalBody(
    <LinkBody draft={draft} disabled={disabled} busy={busy} error={error} onSubmit={() => { void commit(); }} />,
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

/** The pencil on a link row. Exists mostly for the mode: an embed that turned
 *  out not to play — a platform page oEmbed answered for but the iframe will
 *  not show — is one switch away from being usable as an external link, where
 *  before it had to be deleted and re-added. */
export function showEditLinkModal(entry: EmbedEntry, onSave: (entry: EmbedEntry) => void): void {
  showLinkModal(t('embed.editTitle'), t('common.save'), entry, onSave);
}
