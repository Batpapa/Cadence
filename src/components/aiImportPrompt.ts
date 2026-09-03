// English on purpose, regardless of the app's UI language — most AI assistants
// follow English instructions more reliably, and the output is JSON either way.
export const AI_IMPORT_PROMPT = `I use an app called Cadence, a spaced-repetition flashcard app. Convert the list of items I give you into Cadence's card import format.

Output ONLY a single JSON object with this exact shape, inside one fenced code block:

{
  "cards": [
    {
      "name": "string, required — the title of the item",
      "tags": ["optional", "short", "tags"],
      "defaultImportance": 1,
      "type": "optional — omit it unless the card is a tune or a set of tunes (see below)",
      "content": {
        "notes": "optional markdown notes",
        "attachments": []
      }
    }
  ]
}

Rules:
- Do NOT include "guid" or "schemaVersion" anywhere — the app assigns these automatically.
- Only include an "id" on a card if another card needs to reference it (see attachment type 3 below). Use a small negative integer, e.g. -1, -2, -3… (never a positive number or a made-up string) — the app replaces it with a real id automatically. Leave "id" out entirely on every other card.
- "defaultImportance" is a positive number controlling how often this card is prioritized (1 = normal, 2 = twice as important, 0.5 = half as important). Only change it if I give you a reason to; otherwise use 1.
- "tags" should be short, consistent labels inferred from what I give you — don't invent unrelated ones.
- "notes" is free-form markdown — use it for anything useful that doesn't fit "name"/"tags". One Cadence-specific extra: wrap text in double pipes, e.g. "||the answer||", to make it a click-to-reveal spoiler (starts hidden, click to show) — use this whenever I ask for an answer, a hint, or anything else that should stay hidden until actively revealed.
- One card per distinct item.
- This format cannot assign decks, folders, or user profiles — I will choose which deck(s) to file these cards into myself, inside the app, after importing.
- If I ask for anything this format can't represent (e.g. assigning a deck/folder/profile, an attachment type other than the three listed below, or anything else outside this schema), do NOT silently drop it or invent a workaround for it. Still output the JSON for everything you can convert, but also clearly tell me, outside the code block, what you couldn't do and why.
- Other than that one exception, output valid JSON and nothing else outside the code block — no explanations before or after.

Linking to TheSession.org / IrishTuneInfo.info — IMPORTANT, read carefully:
- Only do this if I explicitly gave you the exact numeric id myself (e.g. I pasted a URL or said "id 1234"). Do NOT guess or recall a numeric id from memory just because you recognize a tune's name — you are frequently wrong about exact database ids, and a wrong id silently links to a completely different tune.
- If you do have a confirmed id, "externalId" is a TOP-LEVEL field, a sibling of "id", never nested inside "content":
  {"id": -1, "externalId": "thesession:<numeric id>"}
  {"id": -1, "externalId": "irishtuneinfo:<numeric id>"}
  ("id" is optional here too, same negative-placeholder rule as above — only add it if another card references this one.)
- The app fetches the real tune from the source and merges it with whatever else you put on this card — it's not all discarded, but the fetch always wins for the tune's core identity/sheet music:
  - "name", if you include it, REPLACES the fetched title (leave it out to just keep the real title).
  - "tags", if you include any, are ADDED to the fetched tags (not a replacement).
  - "content.notes", if you include it, REPLACES the fetched notes (which are empty by default).
  - "content.attachments", if you include any, are ADDED after the fetched ones (e.g. the real sheet music stays, plus whatever you attach).
  - "defaultImportance" is NOT merged — the fetch always sets it from the tune's real popularity, so there's no point including it here.
- TheSession tunes only, optional: "preferredSetting" picks which setting (of possibly several) the sheet music opens on by default. Same rule as above — only use the "settingId" form if I gave you the real number myself (e.g. from a #setting1234 URL), never guessed:
  {"id": -1, "externalId": "thesession:<numeric id>", "preferredSetting": 2}
  {"id": -1, "externalId": "thesession:<numeric id>", "preferredSetting": {"settingId": <numeric setting id>}}
  A plain number is a 1-based position ("2" = the 2nd setting listed on the tune's page — only use this if I told you a position, e.g. "the second one"). If neither form applies, leave "preferredSetting" out entirely — never guess a position or a settingId.
- Everything else — anything you're inferring, summarizing, or recognizing by name alone — must be a normal card (the "name"/"tags"/"content" shape from the top of this prompt) with no "externalId" field anywhere.

Card types — "type" is a TOP-LEVEL field, a sibling of "name". Leave it out entirely unless one of these two applies:
- "type": "tune" — one piece of music (an Irish tune, but also any single melody). Give this to every card that is a tune, whether or not it also has an "externalId".
- "type": "tuneset" — a SET: several tunes played back to back as one unit, e.g. "Cooley's / The Wise Maid". The set is its own card, with its own name, and it lists its tunes in a TOP-LEVEL "tunes" array:
  {"name": "Cooley's / The Wise Maid", "type": "tuneset", "tunes": [{"id": -1, "title": "Cooley's"}, {"id": -2, "title": "The Wise Maid"}]}
- Rules for "tunes", all mandatory:
  - Order matters — list them in playing order.
  - Every card listed in "tunes" MUST also be output as its own card in the same batch, and MUST carry "type": "tune". A set whose tunes are missing is useless.
  - Reference them exactly like a "card" attachment: give each tune card a negative "id" (-1, -2…) and reuse that number in the "tunes" entry, plus a "title" for display.
  - "tunes" is the set's DEFINITION and takes tune cards only — never a set inside a set. Anything else the set merely relates to (a recording, a related set) goes in "content.attachments" as a "card" reference instead, NOT in "tunes".
- Do not invent sets. Only produce a "tuneset" card when I actually describe tunes played together as a set.

Attachments (optional, inside "content.attachments" — leave it as [] unless one of these three clearly applies):
1. A link (video, webpage, recording…): {"type": "embed", "url": "https://..."}
2. A text file to attach (e.g. sheet music in ABC notation, tab, lyrics): {"type": "file", "name": "filename.abc", "mimeType": "text/plain", "text": "the plain-text content"}
3. A reference to another card in this SAME batch (e.g. "see also", a related tune): {"type": "card", "id": -2, "title": "the other card's name, for display"}
   To make this work: give the TARGET card a temporary negative "id" (e.g. -2) at its top level, then use that same number in the "id" field of the "card" attachment pointing to it. This works even if the target card is an id-linked TheSession/IrishTuneInfo card.

Here is what I want converted:

[PASTE YOUR OWN LIST / NOTES / FORMAT HERE]`;
