import type { Attachment, AudioPreset, FileAttachment } from '../types';

// ── Audio presets (2026-10-10) ──────────────────────────────────────────────
// Settings of the audio player saved by name on the audio attachment itself —
// "the B part, at 80 %" — asked for by a tester who works a tune part by part
// (the way Up Tempo or Anytune keep loops). On the attachment rather than in a
// table of their own: they travel with the card (sync, export, snapshots), and
// a file kept inside the card has no stable id to key a table by.
//
// "No preset" is not stored: it is the whole file at neutral settings, the
// player as it always was. Saving it creates a preset.

/** What a preset sets, and what the player shows. */
export type AudioSettings = Omit<AudioPreset, 'id' | 'name'>;

/** The player's ranges, one place for the sliders and for the cleaning. */
export const AUDIO_LIMITS = {
  tempo: { min: 30, max: 200, def: 100 },
  transpose: { min: -12, max: 12, def: 0 },
  pitch: { min: -100, max: 100, def: 0 },
} as const;

/** A region is never shorter than this. */
export const MIN_REGION_S = 0.5;

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
}

/** "No preset": the whole file, as recorded, looping. */
export function neutralSettings(duration: number): AudioSettings {
  return {
    start: 0, end: duration,
    tempo: AUDIO_LIMITS.tempo.def, transpose: AUDIO_LIMITS.transpose.def, pitch: AUDIO_LIMITS.pitch.def,
    repeat: true,
  };
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Brought inside what this file and this player can do — a preset saved on a
 *  file since replaced by a shorter one, or arriving from an import. A region
 *  that no longer fits at all becomes the whole file rather than a sliver. */
export function fitSettings(s: AudioSettings, duration: number): AudioSettings {
  let start = clamp(s.start, 0, duration);
  let end = clamp(s.end, 0, duration);
  if (end - start < Math.min(MIN_REGION_S, duration)) { start = 0; end = duration; }
  return {
    start, end,
    tempo: clamp(Math.round(s.tempo), AUDIO_LIMITS.tempo.min, AUDIO_LIMITS.tempo.max),
    transpose: clamp(Math.round(s.transpose), AUDIO_LIMITS.transpose.min, AUDIO_LIMITS.transpose.max),
    pitch: clamp(Math.round(s.pitch), AUDIO_LIMITS.pitch.min, AUDIO_LIMITS.pitch.max),
    repeat: s.repeat,
  };
}

/** Whether two settings are the same as far as anyone can hear — the bounds to
 *  the hundredth of a second: a handle let go where it was taken must not
 *  count as a change, and a dragged position is never a round number. */
export function sameSettings(a: AudioSettings, b: AudioSettings): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.01;
  return near(a.start, b.start) && near(a.end, b.end)
    && a.tempo === b.tempo && a.transpose === b.transpose && a.pitch === b.pitch && a.repeat === b.repeat;
}

/** The name offered for a new preset: its region, which is what tells one part
 *  of a tune from another until the user says better. */
export function suggestedPresetName(s: AudioSettings): string {
  return `${fmtTime(s.start)} → ${fmtTime(s.end)}`;
}

export function settingsOf(p: AudioPreset): AudioSettings {
  return { start: p.start, end: p.end, tempo: p.tempo, transpose: p.transpose, pitch: p.pitch, repeat: p.repeat };
}

// ── From a file someone else wrote ──────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One preset as read from an import, or null if it cannot be one. Optional
 *  fields absent fall back to neutral; the ones a preset cannot do without (an
 *  id, a region) make it unusable. Ranges are left to fitSettings, which knows
 *  the file's length. */
function cleanPreset(raw: unknown): AudioPreset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !r['id'] || !isNum(r['start']) || !isNum(r['end'])) return null;
  return {
    id: r['id'],
    name: typeof r['name'] === 'string' && r['name'].trim() ? r['name'] : suggestedPresetName({ start: r['start'], end: r['end'] } as AudioSettings),
    start: r['start'], end: r['end'],
    tempo: isNum(r['tempo']) ? r['tempo'] : AUDIO_LIMITS.tempo.def,
    transpose: isNum(r['transpose']) ? r['transpose'] : AUDIO_LIMITS.transpose.def,
    pitch: isNum(r['pitch']) ? r['pitch'] : AUDIO_LIMITS.pitch.def,
    repeat: typeof r['repeat'] === 'boolean' ? r['repeat'] : true,
  };
}

/** Cleans a file attachment's presets in place, for an import: drops what is
 *  not a preset (and duplicate ids), and a default that names none of them. */
export function sanitizeAudioPresets(att: Record<string, unknown>): void {
  if ('audioPresets' in att) {
    const seen = new Set<string>();
    const presets = Array.isArray(att['audioPresets'])
      ? att['audioPresets'].map(cleanPreset).filter((p): p is AudioPreset => !!p && !seen.has(p.id) && !!seen.add(p.id))
      : [];
    if (presets.length) att['audioPresets'] = presets; else delete att['audioPresets'];
  }
  const presets = att['audioPresets'] as AudioPreset[] | undefined;
  if ('defaultAudioPreset' in att && !presets?.some(p => p.id === att['defaultAudioPreset'])) delete att['defaultAudioPreset'];
}

// ── Writing them back to the right attachment ───────────────────────────────

/** What the player is handed: the presets as they are, and where to send the
 *  whole list each time the user saves, renames, stars or deletes one. Absent
 *  where there is no attachment to keep them on (a link to a remote file). */
export interface AudioPresetsBinding {
  presets: AudioPreset[];
  defaultId?: string;
  onChange: (presets: AudioPreset[], defaultId: string | undefined) => void;
}

/** The list replaces what was there, both fields written or removed: absent
 *  means none, as everywhere an optional field is read here. */
export function writeAudioPresets(att: FileAttachment, presets: AudioPreset[], defaultId: string | undefined): void {
  if (presets.length) att.audioPresets = presets; else delete att.audioPresets;
  if (defaultId && presets.some(p => p.id === defaultId)) att.defaultAudioPreset = defaultId;
  else delete att.defaultAudioPreset;
}

/** What tells an attachment apart, taken when the player opens: its position
 *  in the card's list is how it is written back, but a sync arriving during a
 *  long practice can reorder that list, and a save must not land on another
 *  file. */
export interface AttachmentIdentity { mimeType: string; externalId?: string; dataLength: number }

/** Not the name: the player's own title renames the file, and the presets
 *  saved after that must still find it. */
export function identityOf(att: FileAttachment): AttachmentIdentity {
  return { mimeType: att.mimeType, externalId: att.external?.id, dataLength: att.data.length };
}

function matches(att: Attachment | undefined, id: AttachmentIdentity): att is FileAttachment {
  if (att?.type !== 'file') return false;
  if (id.externalId) return att.external?.id === id.externalId;
  return !att.external && att.mimeType === id.mimeType && att.data.length === id.dataLength;
}

/** The attachment the player was opened on: at `index` if it is still there,
 *  else wherever it moved to. Null when it is gone — the save is then dropped
 *  rather than written to whatever took its place. */
export function locateFileAttachment(atts: Attachment[], index: number, id: AttachmentIdentity): FileAttachment | null {
  const there = atts[index];
  if (matches(there, id)) return there;
  return atts.find((a): a is FileAttachment => matches(a, id)) ?? null;
}
