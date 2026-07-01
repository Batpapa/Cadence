import type { Attachment, Card, FileEntry } from '../types';
import { arrayBufferToBase64, generateId } from '../utils';

const BASE = 'https://irishtuneinfo-scraper-api.onrender.com';

// The Render free-tier instance sleeps after inactivity; the first request after
// a while can take up to ~1 min to wake it up. Tracked so the UI can warn once.
let serverWarm = false;
export function isServerWarm(): boolean { return serverWarm; }

// ── API shapes (normalized to `name`, matching theSessionService's convention) ──

export interface TuneSearchResult {
  id: number;
  name: string;
  rhythm: string;
  key: string;
}

export interface DiscographyEntry {
  year: string;
  track: string;
  album: string;
  audioUrl: string | null;
}

export interface TuneDetail {
  id: number;
  name: string;
  rhythm: string;
  bars: number;
  structure: string;
  mode: string;
  titles: string[];
  featuredAudioUrl: string | null;
  discography: DiscographyEntry[];
  sourceUrl: string;
}

export interface PlaylistTune {
  id: number;
  name: string;
}

interface RawSearchResult { id: number; title: string; rhythm: string; key: string }
interface RawSearchResponse { count: number; results: RawSearchResult[] }
interface RawTuneResponse {
  id: number; title: string; rhythm: string; bars: number; structure: string; mode: string;
  titles: string[]; featuredAudioUrl: string | null; discography: DiscographyEntry[]; sourceUrl: string;
}
interface RawPlaylistTune { id: number; title: string }
interface RawPlaylistResponse { username: string; tunes: RawPlaylistTune[] }

// ── API calls ─────────────────────────────────────────────────────────────────

/** Reads the scraper's `{ error, message }` JSON error body, falling back to a generic message + status code. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (body?.message) return body.error ? `${body.error}: ${body.message}` : body.message;
  } catch { /* not JSON or empty body */ }
  return `${fallback}: ${res.status}`;
}

export async function searchTunes(term: string): Promise<TuneSearchResult[]> {
  const res = await fetch(`${BASE}/search?term=${encodeURIComponent(term)}`);
  if (!res.ok) throw new Error(await errorMessage(res, 'IrishTuneInfo search failed'));
  serverWarm = true;
  const data = (await res.json()) as RawSearchResponse;
  return (data.results ?? []).map(r => ({ id: r.id, name: r.title, rhythm: r.rhythm, key: r.key }));
}

export async function fetchTuneById(id: number): Promise<TuneDetail> {
  const res = await fetch(`${BASE}/tune/${id}`);
  if (!res.ok) throw new Error(await errorMessage(res, 'IrishTuneInfo fetch failed'));
  serverWarm = true;
  const data = (await res.json()) as RawTuneResponse;
  return {
    id: data.id,
    name: data.title,
    rhythm: data.rhythm,
    bars: data.bars,
    structure: data.structure,
    mode: data.mode,
    titles: data.titles ?? [],
    featuredAudioUrl: data.featuredAudioUrl,
    discography: data.discography ?? [],
    sourceUrl: data.sourceUrl,
  };
}

export async function fetchPlaylist(username: string): Promise<{ username: string; tunes: PlaylistTune[] }> {
  const res = await fetch(`${BASE}/playlist/${encodeURIComponent(username)}`);
  if (res.status === 404) throw new Error('PlaylistNotFound');
  if (!res.ok) throw new Error(await errorMessage(res, 'IrishTuneInfo playlist fetch failed'));
  serverWarm = true;
  const data = (await res.json()) as RawPlaylistResponse;
  return { username: data.username, tunes: (data.tunes ?? []).map(t => ({ id: t.id, name: t.title })) };
}

export interface PlaylistTuneResult {
  tune: TuneDetail;
  audioFile: FileEntry | null;
}

/** Fetches every tune's full detail for a playlist, skipping IDs already in the library. Audio is only fetched when `includeAudio` is true. */
export async function fetchPlaylistTunes(
  username: string,
  onProgress: (loaded: number, total: number) => void,
  skipId?: (id: number) => boolean,
  includeAudio = false,
): Promise<{ tunes: PlaylistTuneResult[]; skippedCount: number }> {
  const playlist = await fetchPlaylist(username);
  const ids = skipId ? playlist.tunes.map(t => t.id).filter(id => !skipId(id)) : playlist.tunes.map(t => t.id);
  const skippedCount = playlist.tunes.length - ids.length;
  const tunes: PlaylistTuneResult[] = [];
  for (let i = 0; i < ids.length; i++) {
    const tune = await fetchTuneById(ids[i]!);
    const audioFile = includeAudio && tune.featuredAudioUrl ? await fetchAudioFile(tune.featuredAudioUrl, `${tune.name}.mp3`) : null;
    tunes.push({ tune, audioFile });
    onProgress(i + 1, ids.length);
  }
  return { tunes, skippedCount };
}

// ── Audio ─────────────────────────────────────────────────────────────────────

const ALBUM_PREFIX = 'https://www.irishtune.info/album/';

/** "https://www.irishtune.info/album/MC/2_19_2.mp3" → "MC/2_19_2", or null if the URL doesn't match the expected shape. */
function audioPathFromUrl(url: string): string | null {
  if (!url.startsWith(ALBUM_PREFIX) || !url.endsWith('.mp3')) return null;
  return url.slice(ALBUM_PREFIX.length, -'.mp3'.length);
}

/** Downloads the tune's featured audio via the scraper's /audio/* proxy. Returns null on any failure — audio is optional. */
export async function fetchAudioFile(featuredAudioUrl: string, fileName: string): Promise<FileEntry | null> {
  const path = audioPathFromUrl(featuredAudioUrl);
  if (!path) return null;
  try {
    const res = await fetch(`${BASE}/audio/${path}`);
    if (!res.ok) return null;
    serverWarm = true;
    const mimeType = res.headers.get('content-type') ?? 'audio/mpeg';
    const data = arrayBufferToBase64(await res.arrayBuffer());
    return { name: fileName, data, mimeType };
  } catch {
    return null;
  }
}

// ── Card builder ──────────────────────────────────────────────────────────────

/** "G Major" → "Gmajor" — matches TheSession's concatenated, lowercase-mode key format. */
function toTheSessionKeyFormat(mode: string): string {
  const words = mode.trim().split(/\s+/);
  return words.map((w, i) => i === words.length - 1 ? w.toLowerCase() : w).join('');
}

// IrishTuneInfo rhythm name → TheSession tune type.
const RHYTHM_TO_THESESSION_TYPE: Record<string, string> = {
  'reel':        'reel',
  'hornpipe':    'hornpipe',
  'double jig':  'jig',
  'slip jig':    'slip jig',
  'single jig':  'jig',
  'slide':       'slide',
  'polka':       'polka',
  'barn dance':  'barndance',
  'strathspey':  'strathspey',
  'mazurka':     'mazurka',
  'waltz':       'waltz',
  'march':       'march',
};
function toTheSessionType(rhythm: string): string {
  return RHYTHM_TO_THESESSION_TYPE[rhythm.toLowerCase()] ?? rhythm.toLowerCase();
}

export function tuneToCard(tune: TuneDetail, audioFile?: FileEntry | null): Card {
  const tags: string[] = ['IrishTuneInfo'];
  if (tune.rhythm) tags.push(toTheSessionType(tune.rhythm));
  if (tune.mode) tags.push(toTheSessionKeyFormat(tune.mode));
  const attachments: Attachment[] = audioFile ? [{ type: 'file', ...audioFile }] : [];
  return {
    id: generateId(),
    guid: generateId(),
    name: tune.name,
    defaultImportance: 1,
    tags,
    externalId: `irishtuneinfo:${tune.id}`,
    content: {
      notes: `[↗ IrishTune.info](${tune.sourceUrl})`,
      attachments,
    },
  };
}
