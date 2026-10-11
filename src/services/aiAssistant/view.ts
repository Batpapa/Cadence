import type { AppState, Attachment, Card } from '../../types';
import { resolveCardRef } from '../cardRefService';
import { findParentFolder } from '../deckService';
import { TUNE_ANALYSER_MODULE_KEY, type Analysis, type Detection, type TuneAnalyserModuleData } from '../../session/model';
import { folderPathOf, parentFolderOf, sessionTreeOf } from '../../session/sessionTree';
import { detectionReviewId } from '../../session/reviewLink';

// ── What the AI is shown of the library (2026-10-11) ─────────────────────────
// The user's own data as a plain document: cards, decks, folders, profiles and
// review history, plus the tune analyser's analyses to READ — "put the tunes
// detected more than three times in a deck" — which no operation can change.
// The settings are deliberately left out, and the AI cannot touch what it is
// not shown.
//
// Attachments come in two sizes, the user's choice: by name and size only, or
// with their content — text as text, anything else in base64. Measured on a
// real library (411 cards, 2026-10-11): about 35 000 tokens without content,
// about 470 000 with its 407 scores, which few assistants take in one go.
//
// Ids are the real ones. Long, but the same on every device the library syncs
// to, and an AI copies them faithfully; one it gets wrong is refused at Verify.

const VIEW_FORMAT = 'cadence-ai-1';

type AttachmentView =
  | { index: number; type: 'file'; name: string; mimeType: string; bytes: number; generated?: true; text?: string; base64?: string }
  | { index: number; type: 'embed'; url: string; mode: 'embed' | 'link'; title?: string }
  | { index: number; type: 'card'; cardId: string; title: string };

export interface AiView {
  format: string;
  exportedAt: string;
  attachmentContentIncluded: boolean;
  profiles: Array<{ id: string; name: string; current?: true }>;
  folders: Array<{ id: string; name: string; parentId: string | null }>;
  decks: Array<{ id: string; name: string; folderId: string | null; favorite?: true; cards: Array<{ cardId: string; importance?: number }> }>;
  cards: Array<Record<string, unknown>>;
  reviews: Array<{ profileId: string; cardId: string; entries: Array<[string, string] | [string, string, 'linked']> }>;
  analyses: AnalysisView[];
}

interface AnalysisView {
  id: string;
  name: string;
  date: string | null;
  /** Seconds. */
  duration: number;
  source: string;
  /** The analyses' own folder path ("2026 / Summer"), null at the top. */
  folder: string | null;
  detections: Array<Record<string, unknown>>;
}

/** A name as the screens show it: the recogniser keeps them lowercase, and
 *  every view capitalises each word (CSS `capitalize`, which this mimics). */
function displayed(name: string): string {
  return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The analyses, newest first, each detection reduced to what a question can
 *  be asked about. `externalId` is the bridge to the cards: a card imported
 *  from TheSession carries the same one. `rated` is the rating given from the
 *  analysis in the current profile, read off the card's history like the
 *  analysis screen itself does. Field defaults are left out to keep a large
 *  library small: no `confirmed`, `liked` or `manual` means false. */
function analysesView(state: AppState): AnalysisView[] {
  const mod = state.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  const sessions = Object.values(mod?.sessions ?? {}).filter(a => a.status !== 'recording');
  if (sessions.length === 0) return [];
  const tree = sessionTreeOf(state);
  const ratings = new Map<string, string>();
  for (const w of Object.values(state.cardWorks)) {
    if (w.profileId !== state.currentProfileId) continue;
    for (const h of w.history) if (h.id) ratings.set(h.id, h.rating);
  }
  const at = (a: Analysis) => (a.date ? Date.parse(a.date) : -Infinity);
  return sessions.sort((a, b) => at(b) - at(a)).map(a => {
    const folderId = parentFolderOf(tree, { type: 'session', id: a.id });
    return {
      id: a.id, name: a.name, date: a.date, duration: Math.round(a.duration), source: a.source,
      folder: folderId ? folderPathOf(tree, folderId) : null,
      detections: [...(a.annotations ?? [])].sort((x, y) => x.start - y.start).map(d => detectionView(a, d, ratings)),
    };
  });
}

function detectionView(a: Analysis, d: Detection, ratings: Map<string, string>): Record<string, unknown> {
  const rated = ratings.get(detectionReviewId(a.id, d.id));
  return {
    tune: displayed(d.displayName),
    externalId: `thesession:${d.tuneId}`,
    ...(d.dance ? { dance: d.dance } : {}),
    start: Math.round(d.start),
    end: d.end === null ? null : Math.round(d.end),
    confidence: Math.round(d.confidence * 100) / 100,
    ...(d.userConfirmed ? { confirmed: true } : {}),
    ...(d.liked ? { liked: true } : {}),
    ...(d.manual ? { manual: true } : {}),
    ...(rated ? { rated } : {}),
  };
}

/** Text an AI can read as text; anything else travels as base64. */
function isTextual(mimeType: string, name: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || /\.(abc|txt|md|csv|json)$/i.test(name);
}

function decodedLength(base64: string): number {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - pad);
}

function base64ToText(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function attachmentView(att: Attachment, index: number, cards: Record<string, Card>, withContent: boolean): AttachmentView {
  if (att.type === 'embed') {
    return { index, type: 'embed', url: att.url, mode: att.mode === 'link' ? 'link' : 'embed', ...(att.title ? { title: att.title } : {}) };
  }
  if (att.type === 'card') {
    return { index, type: 'card', cardId: resolveCardRef(att, cards)?.id ?? att.id, title: att.title };
  }
  const generated = att.generatedBy === 'tuneset';
  const view: AttachmentView = {
    index, type: 'file', name: att.name, mimeType: att.mimeType,
    bytes: att.data ? decodedLength(att.data) : att.external?.bytes ?? 0,
    ...(generated ? { generated: true as const } : {}),
  };
  // `data` is filled in for an externalised file only when the content was
  // asked for (the copy was inlined first, see buildAiView).
  if (withContent && att.data && !generated) {
    if (isTextual(att.mimeType, att.name)) view.text = base64ToText(att.data);
    else view.base64 = att.data;
  }
  return view;
}

/** The view of `state`. `cards` replaces the state's own when the caller has
 *  inlined a copy (attachment content asked for). */
export function aiView(state: AppState, withContent: boolean, cards: Record<string, Card> = state.cards, now = Date.now()): AiView {
  const folders: AiView['folders'] = [];
  const seen = new Set<string>();
  const walk = (ids: string[], parentId: string | null) => {
    for (const id of ids) {
      const f = state.folders[id];
      if (!f || seen.has(id)) continue;
      seen.add(id);
      folders.push({ id, name: f.name, parentId });
      walk(f.folderIds, id);
    }
  };
  walk(state.rootFolderIds, null);

  const deckOrder = [...state.rootDeckIds, ...folders.flatMap(f => state.folders[f.id]!.deckIds)];
  const deckIds = [...new Set([...deckOrder, ...Object.keys(state.decks)])].filter(id => state.decks[id]);

  return {
    format: VIEW_FORMAT,
    exportedAt: new Date(now).toISOString(),
    attachmentContentIncluded: withContent,
    profiles: state.profileIds.filter(id => state.profiles[id]).map(id => ({
      id, name: state.profiles[id]!.name, ...(id === state.currentProfileId ? { current: true as const } : {}),
    })),
    folders,
    decks: deckIds.map(id => {
      const d = state.decks[id]!;
      return {
        id, name: d.name, folderId: findParentFolder(id, 'deck', state),
        ...(d.favorite ? { favorite: true as const } : {}),
        cards: d.entries.map(e => (e.importance === undefined ? { cardId: e.cardId } : { cardId: e.cardId, importance: e.importance })),
      };
    }),
    cards: Object.values(state.cards).map(c => {
      const card = cards[c.id] ?? c;
      return {
        id: card.id,
        name: card.name,
        ...(card.type ? { type: card.type } : {}),
        tags: card.tags ?? [],
        ...(card.aliases?.length ? { aliases: card.aliases } : {}),
        ...(card.externalId ? { externalId: card.externalId } : {}),
        defaultImportance: card.defaultImportance,
        ...(card.computedName ? { computedName: true } : {}),
        ...(card.tunes ? {
          tunes: card.tunes.map(r => ({
            cardId: resolveCardRef(r, state.cards)?.id ?? r.id, title: r.title, ...(r.repeat && r.repeat > 1 ? { repeat: r.repeat } : {}),
          })),
        } : {}),
        notes: card.content?.notes ?? '',
        attachments: (card.content?.attachments ?? []).map((a, i) => attachmentView(a, i, state.cards, withContent)),
      };
    }),
    reviews: Object.values(state.cardWorks)
      .filter(w => w.history.length > 0 && state.profiles[w.profileId] && state.cards[w.cardId])
      .map(w => ({
        profileId: w.profileId,
        cardId: w.cardId,
        entries: w.history.map(h => (h.id
          ? [new Date(h.ts).toISOString(), h.rating, 'linked'] as [string, string, 'linked']
          : [new Date(h.ts).toISOString(), h.rating] as [string, string])),
      })),
    analyses: analysesView(state),
  };
}

/** The view as JSON an AI reads easily and a person can scan: one profile,
 *  folder, deck, card or review list per line, and nothing indented beyond
 *  that — indentation would cost tokens on every line of a large library. */
export function viewJson(view: AiView): string {
  const lines: string[] = ['{'];
  const entries = Object.entries(view);
  entries.forEach(([key, value], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`"${key}": []${comma}`); return; }
      lines.push(`"${key}": [`);
      value.forEach((item, j) => lines.push(JSON.stringify(item) + (j < value.length - 1 ? ',' : '')));
      lines.push(`]${comma}`);
    } else {
      lines.push(`"${key}": ${JSON.stringify(value)}${comma}`);
    }
  });
  lines.push('}');
  return lines.join('\n');
}
