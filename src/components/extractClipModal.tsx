import { signal } from '@preact/signals';
import type { Card } from '../types';
import { t } from '../services/i18nService';
import { getContext, mutate } from '../store';
import { showModal, renderModalBody } from './modal';
import { CardSearchField } from './cardSearchField';
import { splitFileName } from '../services/attachmentNames';
import {
  AUDIO_LIMITS, clipPresets, type AudioSettings, type ClipRequest,
} from '../services/audioPresets';
import { attachmentFor, uploadAttachmentSoon } from '../services/attachmentStore';
import { base64ToBlob, fileToEntry, generateId } from '../utils';

// ── A clip cut from the audio player (2026-10-15) ────────────────────────────
// The region on screen, copied packet for packet into a file of its own (the
// same cut as an analysis's clips, clipExtract.ts), added to a card: the one
// the file is on by default, any other found in the dialog itself. Never in
// place of the file: removing the original afterwards is the user's own,
// ordinary gesture (the user's rule, 2026-10-15).
//
// The dialog is two fields and nothing else (the user, 2026-10-15): the
// clip's name, offered as "{the file} - Extract", and the card, through the
// shared card search (cardSearchField.tsx) in the mode where it NAMES one. No
// explanation above them, no list doubling a card already named.

/** The effects in the player's own notation — the name of the clip's preset
 *  when it had none. Only those that differ from the recording. */
function effectsText(s: AudioSettings): string {
  const parts: string[] = [];
  if (s.tempo !== AUDIO_LIMITS.tempo.def) parts.push(`${t('audioPlayer.tempo')} ${s.tempo}%`);
  if (s.transpose !== AUDIO_LIMITS.transpose.def) parts.push(`${t('audioPlayer.transpose')} ${s.transpose > 0 ? '+' : ''}${s.transpose} st`);
  if (s.pitch !== AUDIO_LIMITS.pitch.def) parts.push(`${t('audioPlayer.pitch')} ${s.pitch > 0 ? '+' : ''}${s.pitch} ¢`);
  return parts.join(' · ');
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; pct: number }
  | { kind: 'done'; card: string; file: string }
  | { kind: 'error'; msg: string };

export function showExtractClipModal(req: ClipRequest & {
  /** The card the file is on: the destination offered first. */
  defaultCardId?: string;
}): void {
  const { entry, settings, presetName } = req;
  const target = signal<string | undefined>(req.defaultCardId);
  /** Without the extension, which the cut decides: the clip keeps the
   *  recording's container (clipExtract.ts). */
  const name = signal(`${splitFileName(entry.name).base} - ${t('audioPlayer.clip.defaultName')}`);
  const status = signal<Status>({ kind: 'idle' });
  const busy = signal(false);
  /** Extract greyed: no name, no card, a cut under way, or this clip just
   *  added there — twice the same clip on a card is a slip, not a wish. Another
   *  name or another card makes it live again. */
  const blocked = signal(!req.defaultCardId);
  const settle = () => {
    blocked.value = !name.value.trim() || !target.value || busy.value || status.value.kind === 'done';
  };
  const edited = () => {
    if (!busy.value) status.value = { kind: 'idle' };
    settle();
  };

  const setTarget = (card: Card | undefined) => {
    target.value = card?.id;
    edited();
  };

  const extract = async () => {
    const cardId = target.value;
    if (!cardId || !name.value.trim() || busy.value) return;
    busy.value = true;
    settle();
    status.value = { kind: 'working', pct: 0 };
    try {
      const { extractRange } = await import('../session/audio/clipExtract');
      const clip = await extractRange(base64ToBlob(entry.data, entry.mimeType), settings.start, settings.end, ratio => {
        status.value = { kind: 'working', pct: Math.round(ratio * 100) };
      });
      // As typed: a name the user wrote is theirs (attachmentNames.ts).
      const fileName = `${name.value.trim()}.${clip.extension}`;
      const file = await fileToEntry(new File([clip.blob], fileName, { type: clip.blob.type }));
      // Through the same rule as any other file added to a card: a clip can be
      // big enough to be kept outside the synced state (attachmentStore.ts).
      const att = {
        ...(await attachmentFor(file, getContext().user)),
        // Named after the source preset, else after what it holds: the region's
        // times are the source file's, meaningless in the clip.
        ...clipPresets(settings, presetName ?? effectsText(settings), clip.duration, generateId()),
      };
      let added: Card | undefined;
      await mutate(s => {
        // The card may have been deleted while the clip was being cut.
        const card = s.cards[cardId];
        if (!card) return;
        card.content.attachments.push(att);
        added = card;
      });
      if (!added) throw new Error(t('audioPlayer.clip.cardGone'));
      uploadAttachmentSoon(att);
      status.value = { kind: 'done', card: added.name, file: fileName };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      status.value = {
        kind: 'error',
        msg: msg.startsWith('clip_format_unsupported') || msg.startsWith('clip_cannot_copy') ? t('audioPlayer.clip.unsupported') : msg,
      };
    } finally {
      busy.value = false;
      settle();
    }
  };

  function Body() {
    const st = status.value;
    return (
      <div class="space-y-3 text-sm">
        <div class="space-y-1.5">
          <label class="label" for="clip-name">{t('audioPlayer.clip.name')}</label>
          <input
            id="clip-name"
            type="text"
            class="input text-sm"
            value={name.value}
            disabled={busy.value}
            onInput={(e) => { name.value = (e.target as HTMLInputElement).value; edited(); }}
          />
        </div>
        <div class="space-y-1.5">
          <label class="label" for="clip-card-search">{t('audioPlayer.clip.to')}</label>
          <CardSearchField id="clip-card-search" initialCardId={req.defaultCardId} disabled={busy.value} onChange={setTarget} />
        </div>
        {st.kind === 'working' && <p class="text-xs text-dim font-mono tabular-nums">{t('sessions.extracting', { pct: st.pct })}</p>}
        {st.kind === 'done' && <p class="text-xs text-success break-words">{t('audioPlayer.clip.done', { card: st.card, file: st.file })}</p>}
        {st.kind === 'error' && <p class="text-xs text-danger break-words">{st.msg}</p>}
      </div>
    );
  }

  const { el, cleanup } = renderModalBody(<Body />);
  // No Close: the ✕, Escape and a click outside already say it, and once a
  // clip is added there is nothing to cancel (the user, 2026-10-15).
  showModal(t('audioPlayer.clip.dialog'), el, [
    {
      label: t('audioPlayer.clip.extract'), primary: true,
      disabled: blocked,
      onClick: extract,
    },
  ], { onDismiss: cleanup });
}
