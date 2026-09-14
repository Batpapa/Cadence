// ── Attachment file names ─────────────────────────────────────────────────────
// Everything that reads meaning into, or writes meaning out of, an attachment's
// name. Kept together because the rules interlock: a rename must never touch
// the extension (isAbcFile recognises TheSession scores by it — they are typed
// text/plain), a copy is numbered by looking at the names already there, and a
// clip used to be recognised by a tag inside its name.

/** `The Silver Spear.abc` → `{ base: 'The Silver Spear', ext: '.abc' }`. A
 *  leading dot is not an extension (`.gitignore` is all name), and a name with
 *  no dot has none. */
export function splitFileName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
}

/** `name` with `newBase` in front of its unchanged extension. Null when there
 *  is nothing to do: an empty base, or the same name as before. */
export function renamedFileName(name: string, newBase: string): string | null {
  const base = newBase.trim();
  if (!base) return null;
  const next = base + splitFileName(name).ext;
  return next === name ? null : next;
}

/** The name of a copy of `name`: `{base} (N){ext}`, N the smallest number no
 *  name in `existingNames` uses — so deleting copy (1) frees (1) again. */
export function copyFileName(name: string, existingNames: readonly string[]): string {
  const { base, ext } = splitFileName(name);
  const taken = new Set(existingNames);
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The tag a clip carried at the end of its NAME until 2026-09-15 — ` [3f9a2c1b·750]`,
 *  just before the extension — so an analysis could tell it was already
 *  attached. It lives in `clipOf` now. */
const LEGACY_CLIP_TAG = /\s*\[([^[\]\s·]+·\d+)\](?=(\.[^.\s]+)?$)/;

/** A legacy clip tag read out of `name`: its key, and the name without it. */
export function legacyClipTag(name: string): { key: string; name: string } | null {
  const m = LEGACY_CLIP_TAG.exec(name);
  if (!m) return null;
  return { key: m[1]!, name: name.slice(0, m.index) + name.slice(m.index + m[0].length) };
}

/** Schema V7 → V8 for one raw card: every clip's tag moves from its name into
 *  `clipOf`. Audio files only, the only ones ever named with one. Idempotent,
 *  and shared by the whole-state migration and the card-package import so the
 *  two cannot drift. */
export function migrateClipTags(card: Record<string, unknown>): void {
  const content = card['content'] as Record<string, unknown> | undefined;
  const attachments = content?.['attachments'];
  if (!Array.isArray(attachments)) return;
  for (const raw of attachments) {
    if (!raw || typeof raw !== 'object') continue;
    const att = raw as Record<string, unknown>;
    if (att['type'] !== 'file' || typeof att['name'] !== 'string') continue;
    if (typeof att['mimeType'] !== 'string' || !att['mimeType'].startsWith('audio/')) continue;
    const found = legacyClipTag(att['name']);
    if (!found) continue;
    att['clipOf'] ??= found.key;
    att['name'] = found.name;
  }
}
