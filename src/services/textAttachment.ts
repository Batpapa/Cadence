// ── Text pasted in rather than picked from a disk ─────────────────────────────
// A card reads three text formats — ABC, markdown and plain text — and until
// now the only way to attach one was to have it in a file already. They almost
// never arrive that way: an ABC comes off a forum post, a set of notes out of
// another app, both through the clipboard. This is what the paste dialog has
// to decide before an attachment exists — what the text IS, and what to call
// it — kept apart from the dialog so both answers can be tested on their own.
//
// The mime types below are the ones the rest of the app keys on, and they are
// the whole point of getting this right: `text/vnd.abc` is half of isAbcFile(),
// `text/markdown` half of isMarkdown(), and a file typed as neither falls
// through to the plain-text view.

import type { Attachment } from '../types';
import { arrayBufferToBase64 } from '../utils';
import { sanitizeFileBase } from './attachmentNames';

export type TextFormatId = 'abc' | 'txt' | 'md';

/** In the order the picker offers them: the one this app is for, then the two
 *  ways of writing anything else down. */
export const TEXT_FORMAT_IDS: readonly TextFormatId[] = ['abc', 'txt', 'md'];

export const TEXT_FORMATS: Record<TextFormatId, { ext: string; mimeType: string; labelKey: string }> = {
  abc: { ext: '.abc', mimeType: 'text/vnd.abc',  labelKey: 'fileViewer.paste.format.abc' },
  txt: { ext: '.txt', mimeType: 'text/plain',    labelKey: 'fileViewer.paste.format.txt' },
  md:  { ext: '.md',  mimeType: 'text/markdown', labelKey: 'fileViewer.paste.format.md' },
};

/** What a pasted text looks like, as a SUGGESTION — the picker beside it stays
 *  free, and one touch of it stops this being consulted at all.
 *
 *  ABC is recognised on the same `X:` header splitAbcTunes keys its blocks on,
 *  so a paste labelled ABC here is one the viewer can really split and draw.
 *  Everything else is plain text: markdown has no header to recognise, and
 *  guessing it from a `#` or a `*` would relabel ordinary notes — a chord
 *  chart, a list of tunes — at least as often as it would help. */
export function detectTextFormat(text: string): TextFormatId {
  return /^X:\s*\d+/m.test(text) ? 'abc' : 'txt';
}

/** The name to propose for a pasted text, or '' when the text names nothing.
 *
 *  Only ABC says its own name: the `T:` title line, which is what the file
 *  would have been called had it been downloaded rather than copied. Sanitised
 *  because it is a name DERIVED from something never meant to be a filename —
 *  what the user types by hand afterwards is their business. */
export function suggestedTextName(text: string, format: TextFormatId): string {
  if (format !== 'abc') return '';
  const title = /^T:\s*(.+)/m.exec(text);
  return title ? sanitizeFileBase(title[1]!) : '';
}

/** The attachment itself, from a base name (extension excluded — the dialog
 *  shows it fixed beside the field, as the rename row does) and the text.
 *
 *  Line endings are normalised on the way in: a paste from a web page carries
 *  CRLF on Windows, while splitAbcTunes splits on '\n' alone and would leave a
 *  stray carriage return at the end of every ABC line.
 *
 *  Base64 through arrayBufferToBase64 rather than abcService's encodeAbc: that
 *  one spreads the whole byte array into a call and blows the stack on a long
 *  paste, which a generated score is never big enough to reach. */
export function textAttachment(base: string, text: string, format: TextFormatId): Attachment {
  const { ext, mimeType } = TEXT_FORMATS[format];
  const body = text.replace(/\r\n?/g, '\n');
  return {
    type: 'file',
    name: base.trim() + ext,
    mimeType,
    data: arrayBufferToBase64(new TextEncoder().encode(body).buffer),
  };
}
