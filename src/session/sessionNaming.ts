import { t } from '../services/i18nService';
import { fmtDate, fmtTime, fmtDateTime } from '../services/dateFormat';
import { TUNE_ANALYSER_MODULE_KEY, type Analysis, type TuneAnalyserModuleData } from './model';

// ── What a session is called ─────────────────────────────────────────────────
// A session's name is DATA, not a rendering. It is written once, when the
// session is saved (or backfilled by db.ts's migrateSession for sessions
// recorded before this existed), and every screen afterwards just reads
// `session.name`. Nothing rewrites it afterwards but the user — not a change
// of date format, not the name template (the user's rule, 2026-10-16). A name
// generated with a date keeps that date in the format of its day; the library
// prints the date again beside every name, in today's format, and reads none
// out of the name (2026-10-16, "no exception here").
//
// What this replaced, from 2026-10-13: generated names rewritten when the
// format changed, and the date left out beside a name found to contain it.
// Both rested on recognising dates inside names in every convention, which a
// name template made a guess. Recomputing names from a formula stored on each
// analysis was turned down the same day — an older build renaming an analysis
// would not mark it as hand-named, and the formula would write over the name.
//
// It used to be derived at display time instead, which meant the same session
// could read differently in the library, on a card's detection list and in a
// downloaded filename, and that renaming had to fight a fallback. One stored
// string removes all of that.

/** Start date and time of day — the pair that actually tells two sessions
 *  apart. A festival day produces several, so the date alone identifies
 *  nothing. */
export function fmtSessionDateTime(dateIso: string): string {
  return fmtDateTime(dateIso);
}

/** The name a newly saved session gets, naming what it actually is: captured
 *  device audio and a microphone recording are different enough acts that
 *  someone scanning thirty of them wants to know which is which at a glance.
 *
 *  Imports never come here — a file already has a name, and it is a better one
 *  than anything this could invent.
 *
 *  `template` is the user's own (nameTemplateSetting), when there is one; the
 *  usual name is a template too, the language's (defaultNameTemplate). */
export function generatedSessionName(source: Analysis['source'], dateIso: string | null, template?: string | null): string {
  if (!dateIso) return typeWord(source);
  return (template && templatedSessionName(template, source, dateIso))
    || templatedSessionName(defaultNameTemplate(), source, dateIso);
}

/** The usual name, as a template: "{Type} of {date} {time}" — what the
 *  settings field shows until the user writes their own. In the interface's
 *  language, and so never stored: a user who leaves it as it is gets it in
 *  whichever language they read the app in. */
export function defaultNameTemplate(): string {
  return t('sessions.defaultName.template');
}

const typeWord = (source: Analysis['source']) =>
  t(source === 'device' ? 'sessions.defaultName.device.undated' : 'sessions.defaultName.mic.undated');

// ── The user's own template ──────────────────────────────────────────────────
// Asked for by the group (2026-10-16), after the recorder app they used before:
// a festival's recordings named "261016 2214 celticime26" without typing it
// thirty times. Plain text with fields in braces; everything else is kept as
// typed. Lives and captures only — an import keeps its file's name (above).
//
// One name per field, the same in every language (the user's call,
// 2026-10-16): the template is synced, and one typed on a phone in French must
// read the same on a computer in English. Only the VALUES follow the language
// and the date format. Braces are the whole syntax. A template that does not
// parse is never a failure at save time — what is not a field stays text, and
// the settings say so.
//
// {folder} is the one field that can be empty: a recording started at the
// root of the library has none. Rather than a conditional syntax, a template
// using it comes with a second one, for the root (the user's design,
// 2026-10-16); left empty, the first is used with {folder} as nothing. The
// folder is the one the recording is STARTED in, written into the template as
// text at that moment (launchNameTemplate) — moving the recording to another
// folder while it runs files it there and leaves its name alone.

type TemplateField = 'folder' | 'Type' | 'type' | 'date' | 'aaaa' | 'aa' | 'mm' | 'dd' | 'time';

/** Every field, by the name written in braces, with what it stands for.
 *  Spelt out, so the key check (i18nKeys.test.ts) sees them. */
export const TEMPLATE_FIELDS: ReadonlyArray<readonly [TemplateField, string]> = [
  ['folder', 'sessions.nameTemplate.field.folder'],
  ['Type', 'sessions.nameTemplate.field.Type'],
  ['type', 'sessions.nameTemplate.field.type'],
  ['date', 'sessions.nameTemplate.field.date'],
  ['aaaa', 'sessions.nameTemplate.field.aaaa'],
  ['aa', 'sessions.nameTemplate.field.aa'],
  ['mm', 'sessions.nameTemplate.field.mm'],
  ['dd', 'sessions.nameTemplate.field.dd'],
  ['time', 'sessions.nameTemplate.field.time'],
];

const FIELD_BY_NAME = new Map<string, TemplateField>(TEMPLATE_FIELDS.map(([field]) => [field, field]));

export interface ParsedTemplate {
  parts: Array<string | { field: TemplateField }>;
  /** What was written in braces and is no field, as written. */
  unknown: string[];
  /** A `{` with no `}` after it — kept as text. */
  unclosed: boolean;
}

/** `{{` and `}}` are a literal brace. A field's name is read whatever spaces
 *  surround it, but in its exact case: {Type} and {type} are two fields
 *  (2026-10-16), so `{Date}` is no field and is said to be one. */
export function parseNameTemplate(template: string): ParsedTemplate {
  const parts: ParsedTemplate['parts'] = [];
  const unknown: string[] = [];
  let unclosed = false;
  let text = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if ((c === '{' || c === '}') && template[i + 1] === c) { text += c; i++; continue; }
    if (c !== '{') { text += c; continue; }
    const end = template.indexOf('}', i + 1);
    if (end < 0) { unclosed = true; text += template.slice(i); break; }
    const raw = template.slice(i + 1, end);
    const field = FIELD_BY_NAME.get(raw.trim());
    if (field) {
      if (text) parts.push(text);
      text = '';
      parts.push({ field });
    } else {
      unknown.push(raw);
      text += template.slice(i, end + 1);
    }
    i = end;
  }
  if (text) parts.push(text);
  return { parts, unknown, unclosed };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function fieldValue(field: TemplateField, source: Analysis['source'], dateIso: string): string {
  // Local time, as everywhere a date is shown: the recording started at the
  // hour on the clock in the room.
  const d = new Date(dateIso);
  switch (field) {
    // Already written in as text when the recording started — see
    // launchNameTemplate. One still here was never resolved: nothing.
    case 'folder': return '';
    // {Type} capitalised, {type} not: "Capture du …" and "… — capture"
    // (2026-10-16).
    case 'Type': return typeWord(source);
    case 'type': return typeWord(source).toLowerCase();
    case 'date': return fmtDate(dateIso);
    case 'aaaa': return String(d.getFullYear());
    case 'aa': return pad2(d.getFullYear() % 100);
    case 'mm': return pad2(d.getMonth() + 1);
    case 'dd': return pad2(d.getDate());
    // Hours and minutes as ONE field, written as the date format writes a
    // time: separate {hh} and {min} lasted an afternoon (2026-10-16) — on a
    // 12-hour clock they gave "0600" for six in the evening, with nowhere to
    // put the PM.
    case 'time': return fmtTime(dateIso);
  }
}

/** The template filled in — trimmed, and empty when there is nothing left,
 *  which generatedSessionName answers with the usual name. */
export function templatedSessionName(template: string, source: Analysis['source'], dateIso: string): string {
  return parseNameTemplate(template).parts
    .map(p => typeof p === 'string' ? p : fieldValue(p.field, source, dateIso))
    .join('')
    .trim();
}

export interface NameTemplates {
  template: string;
  /** For a recording started outside any folder, when `template` uses
   *  {folder}. Null: `template` with {folder} as nothing. */
  noFolder: string | null;
}

const filled = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

/** The templates stored in the settings, or null for the usual name. Anything
 *  but a string with something in it reads as none. */
export function nameTemplateSetting(user: { modules?: Record<string, unknown> }): NameTemplates | null {
  const mod = user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  const template = filled(mod?.nameTemplate);
  return template ? { template, noFolder: filled(mod?.nameTemplateNoFolder) } : null;
}

export function usesFolder(template: string): boolean {
  return parseNameTemplate(template).parts.some(p => typeof p !== 'string' && p.field === 'folder');
}

/** The template a recording started in `folderName` (null: at the root) is
 *  named with, the folder written into it as text — or null for the usual
 *  name. Read once, when the recording starts. */
export function launchNameTemplate(templates: NameTemplates | null, folderName: string | null): string | null {
  if (!templates) return null;
  const chosen = folderName === null && templates.noFolder && usesFolder(templates.template)
    ? templates.noFolder
    : templates.template;
  // Written back as a template, so the folder's name is TEXT in it: its own
  // braces doubled, never read as fields.
  const escape = (s: string) => s.replace(/[{}]/g, c => c + c);
  return parseNameTemplate(chosen).parts
    .map(p => typeof p === 'string' ? escape(p) : p.field === 'folder' ? escape(folderName ?? '') : `{${p.field}}`)
    .join('');
}
