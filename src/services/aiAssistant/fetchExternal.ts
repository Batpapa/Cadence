import type { AppState, Card } from '../../types';
import { fetchTuneById, tuneResultToCard, type TuneSetting } from '../theSessionService';
import { fetchTuneById as fetchIriTuneById, tuneToCard as iriTuneToCard } from '../irishTuneInfoService';
import { tuneFetchStatus, withTuneIdentity } from '../tuneFetchError';
import type { OpError } from './ops';

// ── Tunes an AI asks for by their source id ─────────────────────────────────
// Moved here from the "Generate with an AI" tab of the new-card window, which
// the assistant replaced (2026-10-11). The source is authoritative for a
// tune's identity and its score — the whole reason for fetching: an AI that
// recalls an id from memory is often wrong, and its id is only accepted
// because the user gave it. What the AI adds on top is merged in ops.ts.
//
// Run at Verify, before the batch: the batch itself never waits on the
// network, so the same fetched cards serve the check and the real run.

/** `preferredSetting` from an AI: a 1-based position ("the 2nd setting"), or
 *  {"settingId": N} — a real TheSession setting id. Resolved against the
 *  settings actually fetched, never trusted blindly. */
function preferredSettingIndex(pref: unknown, settings: TuneSetting[]): number | undefined {
  if (typeof pref === 'number') {
    const idx = Math.trunc(pref) - 1;
    return idx >= 0 && idx < settings.length ? idx : undefined;
  }
  if (pref && typeof pref === 'object' && 'settingId' in pref) {
    const settingId = Number((pref as { settingId: unknown }).settingId);
    const idx = settings.findIndex(s => s.id === settingId);
    return idx === -1 ? undefined : idx;
  }
  return undefined;
}

async function fetchOne(externalId: string, preferredSetting: unknown): Promise<Card> {
  const [source, raw] = externalId.split(':') as [string, string];
  const id = parseInt(raw, 10);
  return withTuneIdentity(externalId, undefined, async () => {
    if (source === 'thesession') {
      const tune = await fetchTuneById(id);
      const card = tuneResultToCard(tune);
      const idx = preferredSettingIndex(preferredSetting, tune.settings);
      const abc = card.content.attachments.find(a => a.type === 'file');
      if (idx !== undefined && abc?.type === 'file') abc.preferredIndex = idx;
      return card;
    }
    return iriTuneToCard(await fetchIriTuneById(id));
  });
}

/** Fetches every tune the batch creates by id, one after the other. A tune
 *  already in the library is skipped: the batch refuses it anyway. */
export async function fetchExternalCards(
  ops: unknown[], state: AppState, onProgress?: (done: number, total: number) => void,
): Promise<{ fetched: Map<string, Card>; errors: OpError[] }> {
  const wanted: Array<{ index: number; key: string; externalId: string; pref: unknown }> = [];
  ops.forEach((raw, index) => {
    const op = raw as Record<string, unknown> | null;
    if (op?.['op'] !== 'createCard' || typeof op['id'] !== 'string') return;
    const externalId = typeof op['externalId'] === 'string' ? op['externalId'].trim() : '';
    if (!/^(thesession|irishtuneinfo):\d+$/.test(externalId)) return;
    if (Object.values(state.cards).some(c => c.externalId === externalId)) return;
    wanted.push({ index, key: op['id'], externalId, pref: op['preferredSetting'] });
  });
  const fetched = new Map<string, Card>();
  const errors: OpError[] = [];
  for (let i = 0; i < wanted.length; i++) {
    onProgress?.(i, wanted.length);
    const w = wanted[i]!;
    try {
      fetched.set(w.key, await fetchOne(w.externalId, w.pref));
    } catch (e) {
      errors.push({ op: w.index + 1, name: 'createCard', code: 'fetchFailed', params: { message: tuneFetchStatus(e, 'theSession.error') } });
    }
  }
  onProgress?.(wanted.length, wanted.length);
  return { fetched, errors };
}
