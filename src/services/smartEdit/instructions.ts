import { VIEW_FORMAT } from './view';
import { OPS_FORMAT } from './ops';

// ── Smart edit: the instructions (2026-10-11) ────────────────────────────────
// What anyone editing the library from outside needs to know — a script's
// author, an AI, a person writing operations by hand: the view that goes out,
// the operations that come back. No separate rules for an AI and for a human:
// a human can get it wrong too, and what deserves insisting on has its own
// section, for everyone.
//
// Given apart from the data, on purpose: a conversation with an AI starts
// with the instructions once, and the data can then be sent again — after
// each round of changes — without repeating them.
//
// English whatever the app's language: AI assistants follow English
// instructions most reliably, and what comes back is JSON either way.
//
// Every rule below has its twin in ops.ts, which refuses what breaks it. The
// text is the outside half of that contract; keep the two in step, and change
// the format names when a change breaks what was written against them.

const INSTRUCTIONS = `# Cadence — smart edit instructions

This document explains how to edit a library of **Cadence**, a spaced-repetition app, from outside the app: with a script, with an AI assistant, or by hand. Cards hold things to remember (vocabulary, course material, pieces of music…), decks group cards for study, folders group decks, and each profile keeps its own review history. Cadence also has a tune analyser that recognises the tunes played in a recording: its analyses are in the data **to read and query only** — nothing can change them.

It works in two directions:

1. **The data.** Cadence gives a view of the library: one JSON document, provided **separately** from these instructions, and sent again whenever it is needed.
2. **The answer.** You produce a list of **operations** that transforms the library. Cadence checks the whole list, shows the user what it will change, and applies it.

The data is a view to read, not a document to edit and send back. Every change goes through an operation.

## Formats

These instructions describe:

- the data in format **\`${VIEW_FORMAT}\`** — written in the data's \`format\` field;
- the answer in format **\`${OPS_FORMAT}\`** — which the answer must state.

Both may change in a later version of Cadence. **Check the \`format\` field of the data.** If it is not \`${VIEW_FORMAT}\`, these instructions do not match it: do not guess, get the instructions from the same version of Cadence as the data.

## The answer

- One JSON object: \`{"format": "${OPS_FORMAT}", "operations": [ ... ]}\`. The \`format\` field is **required**: a list without it is refused.
- It can be pasted or loaded as a file. Inside a longer text (an answer with explanations around it), put it in **one** fenced \`\`\`json code block: Cadence reads that block and ignores the text around it.
- Operations run **in order**, all or nothing: if a single one is invalid, Cadence rejects the whole list and lists the reasons, which can be fed back to whoever wrote the list so they can fix it.
- Write names, notes and tags in the language the request is written in, unless asked otherwise.
- If the list is very long, a file is easier to hand over than a pasted text.

## Read this carefully

These are the mistakes that are easy to make and costly for the user. They apply whoever writes the operations.

- **Do only what was asked.** Anything you do not mention stays exactly as it is — never restate something just to restate it.
- **If the request is unclear, or would delete things the user did not clearly ask to delete, ask** instead of producing operations.
- **Never make up a TheSession or irishtune.info id.** Only use one the user gave, or a detection's \`externalId\` from the analyses. A wrong id silently links a different tune (see "Tunes, sets, TheSession and irishtune.info").
- **\`tags\`, \`aliases\`, \`notes\` and \`tunes\` replace the whole current value** in an update: to add one tag, give the full list.
- **Deleting a card or a profile deletes its review history**, which cannot be rebuilt. Deleting a folder deletes the decks inside it.
- **Copy ids exactly** from the data, and **create something before referring to it.**
- **Say what you left out and why** (low confidence, ambiguous names, things you could not do), so the user can ask again.

## Ids

- Existing things are referred to by their \`id\` from the data, copied exactly.
- Something you create gets a temporary id of your choice that starts with \`new:\` — e.g. \`"new:reel-deck"\`, \`"new:card-1"\` — unique within the list. Use that same id to refer to it in later operations.
- An operation that uses a \`new:\` id created further down is rejected.

## The data

- \`format\`: \`"${VIEW_FORMAT}"\` (see "Formats"). \`exportedAt\`: when the view was made.
- \`profiles\`: \`{id, name, current?}\`. Each profile has its own review history. At least one must always remain.
- \`folders\`: \`{id, name, parentId}\` — \`parentId\` null means the top level.
- \`decks\`: \`{id, name, folderId, favorite?, cards: [{cardId, importance?}]}\` — \`importance\` here overrides the card's own for this deck only.
- \`cards\`: \`{id, name, type?, tags, aliases?, externalId?, defaultImportance, computedName?, tunes?, notes, attachments}\`.
  - \`type\`: absent for an ordinary card, \`"tune"\` for one piece of music, \`"tuneset"\` for a set of tunes played back to back.
  - \`defaultImportance\`: how often the card is prioritised — 1 normal, 2 twice as important, 0.5 half.
  - \`notes\`: Markdown. Cadence extra: \`||text||\` (on one line) is hidden until tapped — use it for answers and hints.
  - \`tunes\` (sets only): \`[{cardId, title, repeat?}]\`, in playing order; \`repeat\` = how many times that tune goes round (absent = once).
  - \`attachments\`: each has an \`index\` (its position on the card) and a \`type\`: \`"file"\` (\`name\`, \`mimeType\`, \`bytes\`, and \`text\` or \`base64\` when contents are included), \`"embed"\` (a link: \`url\`, \`mode\`, \`title?\`) or \`"card"\` (a reference to another card: \`cardId\`, \`title\`). A file with \`generated: true\` is a set's score, rebuilt by Cadence from its tunes.
- \`attachmentContentIncluded\`: when false, attachments are given by name and size only: what is inside them can be neither read nor changed.
- \`analyses\` (read only): \`{id, name, date, duration, source, folder, detections}\`, newest first. \`duration\` is in seconds, \`folder\` is the analysis's folder path (null at the top), \`source\` is \`"live"\` (recorded in the app) or \`"import"\` (a file). Each detection is one tune recognised at one moment: \`{tune, externalId, dance?, start, end, confidence, confirmed?, liked?, manual?, rated?}\` — \`start\`/\`end\` in seconds from the beginning of the recording; \`confidence\` from 0 to 1 (below about 0.5, the recogniser was unsure); \`confirmed\`: the user vouched for it; \`liked\`: the user marked it; \`manual\`: added by hand; \`rated\`: the rating given from the analysis in the current profile. A tune played twice in one recording is two detections.
- \`reviews\`: \`{profileId, cardId, entries: [[date, rating], …]}\`. \`date\` is ISO 8601 (UTC); \`rating\` is \`"again"\` (forgotten), \`"hard"\`, \`"good"\` or \`"easy"\`. An entry with a third element \`"linked"\` was given from Cadence's tune analyser: it can be removed, but not created.

## Operations

Every operation is an object with an \`"op"\` field and only the fields listed for it. Optional fields are marked with \`?\`; leave out what you do not change.

### Profiles
- \`{"op": "createProfile", "id": "new:…", "name": "…"}\`
- \`{"op": "renameProfile", "id": "…", "name": "…"}\`
- \`{"op": "deleteProfile", "id": "…"}\` — deletes that profile's whole review history. Not the last profile.

### Folders
- \`{"op": "createFolder", "id": "new:…", "name": "…", "parentId"?: "…" | null}\`
- \`{"op": "updateFolder", "id": "…", "name"?: "…", "parentId"?: "…" | null}\` — \`parentId\` moves it (null = top level); not into itself or one of its own sub-folders.
- \`{"op": "deleteFolder", "id": "…"}\` — also deletes its sub-folders and every deck inside them. The cards stay in the library.

### Decks
- \`{"op": "createDeck", "id": "new:…", "name": "…", "folderId"?: "…" | null, "favorite"?: true, "cards"?: [{"cardId": "…", "importance"?: 2}]}\`
- \`{"op": "updateDeck", "id": "…", "name"?: "…", "folderId"?: "…" | null, "favorite"?: true | false}\`
- \`{"op": "deleteDeck", "id": "…"}\` — the cards stay in the library.
- \`{"op": "addToDeck", "deckId": "…", "cards": [{"cardId": "…", "importance"?: 2}]}\` — a card already in the deck only has its importance updated.
- \`{"op": "removeFromDeck", "deckId": "…", "cardIds": ["…"]}\` — each card must be in the deck.

### Cards
- \`{"op": "createCard", "id": "new:…", "name": "…", "type"?: "tune" | "tuneset", "tags"?: […], "aliases"?: […], "defaultImportance"?: 1, "notes"?: "…", "externalId"?: "…", "preferredSetting"?: …, "tunes"?: […], "computedName"?: true, "attachments"?: […], "decks"?: ["deck id", …]}\`
  - \`name\` is required — except with an \`externalId\`, where it is left out (see "Tunes, sets, TheSession and irishtune.info" below).
- \`{"op": "updateCard", "id": "…", "name"?: "…", "type"?: "tune" | "tuneset" | null, "tags"?: […], "aliases"?: […], "defaultImportance"?: 1, "notes"?: "…", "tunes"?: […], "computedName"?: true | false, "removeAttachments"?: [{"index": 0, "match": "…"}], "addAttachments"?: […]}\`
  - \`tags\`, \`aliases\`, \`notes\` and \`tunes\` **replace** the whole current value.
  - \`removeAttachments\`: the attachment's \`index\` from the data, and \`match\` = its \`name\` (file), \`url\` (embed) or \`cardId\` (card reference), exactly. Put all removals for a card in one operation.
  - \`type\`: null makes it an ordinary card. A card that is a tune of some set must stay a tune. A card that stops being a set loses its tunes.
  - \`externalId\` can only be given when creating.
- \`{"op": "deleteCard", "id": "…"}\` — also deletes its reviews in every profile.

Attachments that can be added (in \`attachments\` or \`addAttachments\`):
1. A link. A YouTube, Spotify, Deezer or SoundCloud URL plays inside the app: \`{"type": "embed", "url": "https://…"}\`. Any other link opens in a new tab and needs a name: \`{"type": "embed", "url": "https://…", "mode": "link", "title": "Short name"}\`.
2. A file: \`{"type": "file", "name": "tune.abc", "text": "…"}\` for text (ABC notation, lyrics, tab…), or \`{"type": "file", "name": "…", "mimeType": "…", "base64": "…"}\` for anything else. Exactly one of \`text\` and \`base64\`.
3. A reference to another card: \`{"type": "card", "cardId": "…"}\`.

To change what is inside a file, remove it and add the new version — only possible when \`attachmentContentIncluded\` is true.

### Reviews
- \`{"op": "addReviews", "profileId": "…", "cardId": "…", "entries": [["2026-03-01T18:00:00.000Z", "good"], …]}\` — never in the future, and not at the exact date of an existing entry.
- \`{"op": "removeReviews", "profileId": "…", "cardId": "…", "dates": ["…"]}\` — each date copied exactly from the data; or \`"all": true\` instead of \`dates\` to clear that card's history in that profile.

## Questions about the analyses

- A detection's \`externalId\` is a TheSession tune; **a card is the same tune when its \`externalId\` is identical.** That is the only reliable link. A card without one (made by hand, or from irishtune.info) can only be matched by name: do so only when it is unambiguous, and say which ones were matched that way.
- "Detected more than 3 times" is ambiguous: 3 detections (passes), or 3 different analyses (evenings)? Count detections unless the user says otherwise — and say which was counted. Ask when it matters.
- A detected tune that has no card yet can be created from its \`externalId\` (see below): Cadence fetches it.

## Tunes, sets, TheSession and irishtune.info

- Give \`"type": "tune"\` to every card that is one piece of music.
- A set is its own card with \`"type": "tuneset"\` and a \`tunes\` list. Every card in \`tunes\` must be a tune card — create the tune cards first. Never a set inside a set. Do not invent sets: only make one when the user describes tunes played together.
- \`"computedName": true\` on a set makes its name follow its tunes ("Tune A / Tune B"); leave it out to keep the name given.
- **Linking a card to TheSession.org or irishtune.info.** Only when the user gave the exact numeric id themselves (a URL, or "id 1234"), or when it is a detection's \`externalId\` in the analyses (Cadence's recogniser wrote it, not memory). Never recall an id from memory because a tune's name is familiar: exact ids are easy to get wrong, and a wrong id silently links a different tune. With a confirmed id: \`"externalId": "thesession:1234"\` or \`"externalId": "irishtuneinfo:1234"\` on createCard. Cadence fetches the tune: its title, type, score and importance come from the source. **Leave \`name\` out** — Cadence names the card with the source's title; give a \`name\` only when the user explicitly wants the card called something else, since it then replaces that title. The \`tags\` given are added to the source's, the \`notes\` and \`attachments\` are kept. A tune already in the library (same \`externalId\`) cannot be created again — use the existing card.
- TheSession only, optional: \`"preferredSetting": 2\` (the 2nd setting listed — only if the user said so) or \`{"settingId": 5678}\` (only if they gave that id). Otherwise leave it out.
- Everything inferred or recognised by name alone is an ordinary card or tune, with no \`externalId\`.

## Example

The request: "Create a deck Reels in my Irish folder with two new tunes, Cooley's and The Wise Maid, as a set; and rename my profile to Fiddle."

\`\`\`json
{"format": "${OPS_FORMAT}", "operations": [
  {"op": "createDeck", "id": "new:reels", "name": "Reels", "folderId": "f3a1c2d4-…"},
  {"op": "createCard", "id": "new:cooleys", "name": "Cooley's", "type": "tune", "tags": ["reel"], "decks": ["new:reels"]},
  {"op": "createCard", "id": "new:wise-maid", "name": "The Wise Maid", "type": "tune", "tags": ["reel"], "decks": ["new:reels"]},
  {"op": "createCard", "id": "new:set", "name": "Cooley's / The Wise Maid", "type": "tuneset", "tunes": [{"cardId": "new:cooleys"}, {"cardId": "new:wise-maid"}], "decks": ["new:reels"]},
  {"op": "renameProfile", "id": "9b2e…", "name": "Fiddle"}
]}
\`\`\`
`;

/** The instructions, as one Markdown document. */
export function smartEditInstructions(): string {
  return INSTRUCTIONS;
}
