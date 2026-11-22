import { useEffect, useMemo, useState } from 'preact/hooks';
import { getSettingAbcMeta, getSettingAbcMetaSync, onTuneIndexCached, type SettingAbcMeta } from '../recognition/indexStore';
import { cardGuidOf, isCardId } from '../recognition/cardIndex';
import { theSessionKeyToAbc, findSettingInScore } from '../../services/theSessionService';
import { cardScoreIndex, decodeAbc, isAbcFile, isAbcLink, splitAbcTunes, buildHeardSetAbc, tunesetAbcFileName } from '../../services/abcService';
import { fetchAbcLink, peekAbcLink } from '../../services/abcLink';
import { hydratedEntry } from '../../services/attachmentStore';
import { getAttachmentBlob } from '../../services/attachmentDb';
import { arrayBufferToBase64 } from '../../utils';
import { showPreviewModal, type AudioSyncBinding } from '../../components/fileViewer';
import { theSessionEditGate } from '../../components/theSessionCopy';
import { updateCardFile } from '../../services/cardFiles';
import { getContext } from '../../store';
import type { AppContext, Attachment, Card, FileEntry } from '../../types';
import { MusicNoteIcon } from '../../components/icons';
import { transposeMode } from '../keyName';
import { transposeAbcText } from '../../services/abcTranspose';
import { t } from '../../services/i18nService';

// ── ABC preview of a matched FolkFriend setting ───────────────────────────────
// Builds a complete ABC tune (headers + body from the cached recognition index)
// and opens the existing file viewer, which renders the sheet AND plays it via
// the abcjs synth — ideal to compare a candidate against the session audio.
// showPreviewModal (components/fileViewer.ts) is shared, imperative, and out
// of scope for this migration — called as-is, same as modal.ts's helpers.

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** A whole ABC tune for a setting of the recognition index. A card's version
 *  (cardIndex.ts) already is one: the tune as its file has it. */
export function settingAbcText(displayName: string, settingId: string, meta: SettingAbcMeta): string {
  if (isCardId(settingId)) return meta.abc;
  return [
    'X: 1',
    `T: ${displayName}`,
    // Same URL shape as theSessionService.ts's settingToAbcBlock — verified
    // FolkFriend's settingId/tune_id are TheSession's own ids, not remapped.
    `S: https://thesession.org/tunes/${meta.tune_id}#setting${settingId}`,
    `R: ${meta.dance}`,
    `M: ${meta.meter}`,
    'L: 1/8',
    `K: ${theSessionKeyToAbc(meta.mode)}`,
    meta.abc.replace(/!/g, '\n'),
  ].join('\n');
}

/** The index's rendition of the setting, in the key it was played in
 *  (`keyOffset`, see abcTranspose.ts). */
async function showAbcPreview(displayName: string, settingId: string, meta: SettingAbcMeta, audioSync?: AudioSyncBinding, keyOffset?: number | null): Promise<void> {
  const abc = await transposeAbcText(settingAbcText(displayName, settingId, meta), keyOffset ?? 0);
  showPreviewModal({
    name: `${displayName}.abc`,
    mimeType: 'text/vnd.abc',
    data: toBase64(abc),
  }, undefined, { audioSync });
}

/** The score of a set heard in an analysis: its tunes fused into one, each in
 *  the version that was PLAYED — the setting each detection recognised, never
 *  a card's (the user's call, 2026-10-19), so it is there before any card is.
 *  A tune named by hand, whose version nobody heard, keeps its place as a
 *  labelled bar of silence. Greyed only when not a single tune has a score. */
export function HeardSetAbc({ title, tunes, size = 12 }: {
  title: string;
  /** `keyOffset`: each tune in the key it was played in (keyOffsetOf). */
  tunes: Array<{ label: string; settingId: string | null; keyOffset?: number | null }>;
  size?: number;
}) {
  const key = tunes.map(x => x.settingId ?? '-').join(',');
  const [metas, setMetas] = useState<{ key: string; list: Array<SettingAbcMeta | null> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(tunes.map(x => (x.settingId ? getSettingAbcMeta(x.settingId) : Promise.resolve(null))))
      .then(list => { if (!cancelled) setMetas({ key, list }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [key]);
  const list = metas?.key === key ? metas.list : null;
  const playable = !!list && list.some(m => !!m?.abc);

  // A 24 px disc inside a 32 px target (styles.css, .icon-disc); greyed out
  // by the button's own disabled look.
  const base = 'group icon-btn hover:bg-transparent';
  const icon = <span style={{ transform: 'translateX(-1px)' }}><MusicNoteIcon size={size} /></span>;
  if (!playable) {
    return (
      <button disabled class={base} title={list ? t('sessions.abcUnavailable') : t('sessions.listenAbc')}>
        <span class="icon-disc">{icon}</span>
      </button>
    );
  }
  return (
    <button
      class={base}
      title={t('sessions.listenAbc')}
      onClick={(e) => {
        e.stopPropagation();
        void Promise.all(tunes.map((x, i) => {
          const meta = list[i];
          return meta?.abc && x.settingId
            ? transposeAbcText(settingAbcText(x.label, x.settingId, meta), x.keyOffset ?? 0)
            : Promise.resolve(null);
        })).then(texts => {
          const abc = buildHeardSetAbc(title, tunes.map((x, i) => ({ label: x.label, abc: texts[i] ?? null })));
          if (!abc) return;
          showPreviewModal({ name: `${tunesetAbcFileName(title)}`, mimeType: 'text/vnd.abc', data: toBase64(abc) });
        });
      }}
    >
      <span class="icon-disc">{icon}</span>
    </button>
  );
}


/** A setting's entry in the recognition index: undefined while the index is
 *  loading, null when the setting is not in it.
 *
 *  Feeds re-render on every recognition event, so the entry is read
 *  synchronously once the map is loaded and nothing flashes. And it is read on
 *  EVERY render rather than kept in state, which is what AbcPreview did until
 *  2026-10-15: a detection's setting changes under the same component when
 *  another tune is picked for it, and the state still held the first one's —
 *  its score included. */
export function useSettingMeta(settingId: string): SettingAbcMeta | null | undefined {
  const sync = getSettingAbcMetaSync(settingId);
  // Only for the wait: what the load returned, tagged with the setting it was
  // for, so an answer that lands after the setting changed is not shown.
  const [loaded, setLoaded] = useState<{ settingId: string; meta: SettingAbcMeta | null } | null>(null);
  const pending = sync === undefined;
  // The map stays unloaded when the device has no index yet: asked again once
  // a recognition has brought it in (indexStore.ts's noteTuneIndexCached).
  const [indexArrivals, setIndexArrivals] = useState(0);
  useEffect(() => (pending ? onTuneIndexCached(() => setIndexArrivals(n => n + 1)) : undefined), [pending]);
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    void getSettingAbcMeta(settingId).then(meta => { if (!cancelled) setLoaded({ settingId, meta }); });
    return () => { cancelled = true; };
  }, [settingId, pending, indexArrivals]);
  if (!pending) return sync;
  return loaded?.settingId === settingId ? loaded.meta : undefined;
}

/** "reel · 4/4 · Dmajor" — a tune's type, meter and key, wherever a detection
 *  or a candidate is described. The key comes from the recognition index by
 *  setting rather than being stored on the detection, so analyses saved before
 *  it was shown (2026-10-15) get it too; it is left out while the index loads
 *  and for a setting the index does not hold. Spelled as TheSession does, like
 *  the key chips of the detection library.
 *
 *  `settingId` only when the recogniser matched that setting (see
 *  model.ts's hasRecognisedSetting): a key is a property of a VERSION, and a
 *  tune named by hand has none that was heard. Without it: type and meter.
 *
 *  `keyOffset`: the semitones the recording plays the setting above its
 *  written key (model.ts's keyOffsetOf) — the key shown is the one PLAYED,
 *  with nothing to say it differs from the score's (the user's call,
 *  2026-11-07: nobody minds which key TheSession wrote it in).
 *
 *  A component rather than a bare hook so a list can use it per row. Text
 *  only: the caller's element carries the styling. */
export function TuneFacts({ dance, meter, settingId, keyOffset }: { dance: string; meter?: string; settingId?: string; keyOffset?: number | null }) {
  // Called either way: a hook may not be skipped. '' resolves to nothing.
  const meta = useSettingMeta(settingId ?? '');
  const mode = settingId && meta?.mode ? transposeMode(meta.mode, keyOffset ?? 0) : undefined;
  return <>{dance}{meter && <> · {meter}</>}{mode && <> · {mode}</>}</>;
}

/** The card's OWN score, opened on the version that was just played.
 *
 *  Preferred over the index-built stand-in whenever it exists, because it is
 *  the score the user will actually practise from — and because the viewer's
 *  ordinary ★ then works with no special case at all: the file is the card's,
 *  so "make this the default version" acts on exactly what is on screen. The
 *  version nav comes along too, so a detection lands you on what was played
 *  with the other settings one arrow away.
 *
 *  Null whenever there is nothing better to show than the stand-in: the tune
 *  is not in the library, or its card holds no ABC carrying this setting.
 *  Which of the card's scores is findSettingInScore's call: the TheSession
 *  score first, then any ABC carrying the setting — asking the FILE, so a score
 *  predating the `generatedBy` marker is never passed over for a label. */
async function cardScorePreview(settingId: string, givenCardId: string | undefined, ctx: AppContext | undefined, audioSync?: AudioSyncBinding, keyOffset?: number | null) {
  if (!ctx) return null;
  // A version of a card's own ABC (cardIndex.ts, "card:<guid>:<hash>", or
  // "card:<guid>" named by hand): no `S:` to look for, the card is the one its
  // guid names, and the version is the block whose text the resolver gives
  // (cardIndexSource.ts) — the version itself, or the score as it is now once
  // that version has been edited away. Before this, the id read as NaN and
  // every card detection opened that one block alone (reported 2026-11-16).
  const guid = cardGuidOf(settingId);
  const cardId = guid !== null ? Object.values(getContext().user.cards).find(c => c.guid === guid)?.id : givenCardId;
  if (!cardId) return null;
  const card = getContext().user.cards[cardId];
  const id = parseInt(settingId, 10);
  const wanted = guid !== null ? (await getSettingAbcMeta(settingId))?.abc : undefined;
  if (!card || (guid === null ? !Number.isFinite(id) : !wanted)) return null;
  // Resolved FIRST, on a copy. `findSettingInScore` reads the `S:` line out of
  // the ABC text, so a score kept outside the blob — `data` empty — carried no
  // setting it could find: the card's own score was silently swapped for the
  // index's rendition of it, ★ and version nav included. Told apart only by
  // the title, which then came from the detection's lowercase displayName
  // (reported 2026-09-25, reproduced at a threshold of zero).
  //
  // Only the ABC attachments, and only until one matches: resolving the rest
  // would pull a card's audio clips down to draw a stave. A failure falls back
  // to the index stand-in rather than raising anything — that rendition IS
  // what was recognised, so it is an answer, not an error.
  //
  // A link to an ABC file the same way (2026-11-04): read, and put in the
  // link's place on the copy, as an attached score would be.
  const resolved = structuredClone(card);
  const attachments = resolved.content?.attachments ?? [];
  for (const [i, att] of attachments.entries()) {
    if (isAbcLink(att)) {
      try { attachments[i] = await fetchAbcLink(att); } catch { /* findSettingInScore will not match it */ }
      continue;
    }
    if (att.type !== 'file' || !att.external || !isAbcFile(att)) continue;
    try {
      att.data = (await hydratedEntry(att, true)).data;
      delete att.external;
    } catch { /* left as it was; findSettingInScore simply will not match it */ }
  }
  const target = guid !== null ? findVersionInScore(resolved, wanted!) : findSettingInScore(resolved, id);
  if (!target) return null;
  const entry = resolved.content.attachments[target.attachmentIndex];
  if (!entry || entry.type !== 'file') return null;

  /** The card's file at `at`, `shown` as read in, opened at `version` — on
   *  the editor's face when `edit`. Written from here too (2026-11-22, the
   *  user: the score is corrected along its recording): the user's own files
   *  saved as on the card, TheSession's edited on a copy (theSessionCopy.ts),
   *  a set's fused score and a link not at all. */
  const show = (shown: FileEntry, at: number, version: number, favourite: number | undefined, edit: boolean): void => {
    const att = getContext().user.cards[cardId]?.content.attachments[at];
    // None on a link: it keeps nothing but its URL.
    const isFile = att?.type === 'file';
    const fromTheSession = isFile && att.generatedBy === 'thesession';
    const writable = isFile && !fromTheSession && att.generatedBy !== 'tuneset';
    showPreviewModal(shown, writable ? (data) => updateCardFile(cardId, at, data) : undefined, {
      audioSync,
      initialIndex: version,
      initialFace: edit ? 'both' : undefined,
      // In the key it was played in: the card's file is the user's and is never
      // rewritten, so the viewer opens it transposed (abcTranspose.ts).
      initialTranspose: keyOffset ?? undefined,
      // The star stays where the card put it, NOT on the version we opened at.
      favoriteIndex: favourite,
      onSetPreferredIndex: !isFile ? undefined : (index) => {
        void ctx.mutate(s => {
          const a = s.cards[cardId]?.content.attachments[at];
          if (a && a.type === 'file') {
            if (index === undefined) delete a.preferredIndex; else a.preferredIndex = index;
          }
        });
      },
      editGate: fromTheSession ? (v) => void theSessionEditGate(cardId, at, v, (to, tv) => void showCopy(to, tv)) : undefined,
    });
  };
  /** The copy of TheSession's score, just made or found, on its editor. */
  const showCopy = async (at: number, version: number): Promise<void> => {
    const att = getContext().user.cards[cardId]?.content.attachments[at];
    if (att?.type !== 'file') return;
    let shown: FileEntry;
    try { shown = await hydratedEntry(att, true); } catch { return; }
    show(shown, at, version, att.preferredIndex, true);
  };
  return () => show(entry, target.attachmentIndex, target.blockIndex, target.preferredIndex, false);
}

/** findSettingInScore for a card's own version: the ABC file holding a block
 *  that IS this text, the card's score first (cardScoreIndex), on a card whose
 *  ABC has been read in (`card` a resolved copy). A set's fused score is left
 *  out, as the cards' index leaves it out (cardIndexSource.ts's abcSources). */
function findVersionInScore(card: Card, abc: string): { attachmentIndex: number; blockIndex: number; preferredIndex: number | undefined } | null {
  const attachments = card.content?.attachments ?? [];
  const score = cardScoreIndex(attachments);
  const order = attachments.map((_, i) => i).sort((a, b) => Number(b === score) - Number(a === score));
  for (const i of order) {
    const a = attachments[i];
    if (!a || a.type !== 'file' || !isAbcFile(a) || a.generatedBy === 'tuneset') continue;
    let blocks: string[];
    try { blocks = splitAbcTunes(decodeAbc(a)); } catch { continue; }
    const blockIndex = blocks.indexOf(abc);
    if (blockIndex !== -1) return { attachmentIndex: i, blockIndex, preferredIndex: a.preferredIndex };
  }
  return null;
}

/** Whether the library card holds a score carrying this setting: what lets the
 *  button open on a device without the recognition index — a fresh install
 *  that received its analyses through Drive (2026-10-29). Asked only when the
 *  index has nothing to show. Never through the network: an inline score is
 *  read as it is, an externalised one only when this device holds its bytes,
 *  since drawing a row of detections must not send each of them to Drive. */
function useCardCarries(settingId: string, card: Card | undefined, ask: boolean): boolean {
  const id = parseInt(settingId, 10);
  const look = ask && !!card && Number.isFinite(id);
  const inline = useMemo(() => look && findSettingInScore(card!, id) !== null, [look, card, id]);
  const [held, setHeld] = useState<{ card: Card; id: number } | null>(null);
  useEffect(() => {
    if (!look || inline) return;
    // A link to an ABC file only as far as this session has already read it.
    const linkRead = (a: Attachment) => isAbcLink(a) && !!peekAbcLink(a.url);
    const external = (card!.content?.attachments ?? []).some(a => (a.type === 'file' && a.external && isAbcFile(a)) || linkRead(a));
    if (!external) return;
    let cancelled = false;
    void (async () => {
      const copy = structuredClone(card!);
      for (const [i, att] of copy.content.attachments.entries()) {
        if (isAbcLink(att)) {
          const file = peekAbcLink(att.url);
          if (file) copy.content.attachments[i] = file;
          continue;
        }
        if (att.type !== 'file' || !att.external || !isAbcFile(att)) continue;
        const blob = await getAttachmentBlob(att.external.id).catch(() => undefined);
        if (!blob) continue;
        att.data = arrayBufferToBase64(await blob.arrayBuffer());
        delete att.external;
      }
      if (!cancelled && findSettingInScore(copy, id)) setHeld({ card: card!, id });
    })();
    return () => { cancelled = true; };
  }, [look, inline, card, id]);
  return inline || (!!held && held.card === card && held.id === id);
}

/**
 * Small music-note button opening the sheet+synth preview of a setting.
 * Starts inert; becomes clickable once a score is confirmed available — the
 * index's, or the card's own — and stays greyed out (non-clickable) when there
 * is none. Same geometry as the slice play button: w-6 h-6 circle, icon
 * flex-centered.
 */
export function AbcPreview({ settingId, displayName, size = 12, cardId, ctx, audioSync, keyOffset }: {
  settingId: string;
  displayName: string;
  size?: number;
  /** The semitones the recording plays this setting above its written key
   *  (model.ts's keyOffsetOf): the score opens in the key PLAYED. */
  keyOffset?: number | null;
  /** The library card this setting belongs to, when it is already there. Given
   *  both this and `ctx`, the preview carries the ★ that makes this version the
   *  one the card opens on — the same gesture the file viewer already uses for a
   *  multi-version score, in the one place where the version is on screen. */
  cardId?: string;
  ctx?: AppContext;
  /** The detection's recording, to play the score along (PassRow.tsx's
   *  detectionAudioSync) — any version of the tune. */
  audioSync?: AudioSyncBinding;
}) {
  const meta = useSettingMeta(settingId);
  const cardCarries = useCardCarries(settingId, cardId ? ctx?.user.cards[cardId] : undefined, meta !== undefined && !meta?.abc);

  // A 24 px disc inside a 32 px target (styles.css, .icon-disc); greyed out
  // by the button's own disabled look.
  const base = 'group icon-btn hover:bg-transparent';
  // The glyph's visual mass sits right of its geometric centre — nudge left.
  const icon = <span style={{ transform: 'translateX(-1px)' }}><MusicNoteIcon size={size} /></span>;

  // `!meta?.abc` covers still-loading (meta===undefined), resolved-but-not-found
  // (null), AND a resolved entry with an empty abc string — all three render
  // disabled, unless the card's own score carries the setting.
  if (!meta?.abc && !cardCarries) {
    return (
      <button disabled class={base} title={meta === undefined ? t('sessions.listenAbc') : t('sessions.abcUnavailable')}>
        <span class="icon-disc">{icon}</span>
      </button>
    );
  }

  return (
    <button
      class={base}
      title={t('sessions.listenAbc')}
      onClick={(e) => {
        e.stopPropagation();
        // Asynchronous now: the card's score may have to come back from Drive
        // before we can even tell whether it carries this setting.
        void cardScorePreview(settingId, cardId, ctx, audioSync, keyOffset)
          .then(fromCard => {
            if (fromCard) fromCard();
            else if (meta?.abc) void showAbcPreview(displayName, settingId, meta, audioSync, keyOffset);
          });
      }}
    >
      <span class="icon-disc">{icon}</span>
    </button>
  );
}
