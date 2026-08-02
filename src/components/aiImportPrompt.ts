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
- "notes" is free-form markdown — use it for anything useful that doesn't fit "name"/"tags".
- One card per distinct item.
- This format cannot assign decks, folders, or user profiles — I will choose which deck(s) to file these cards into myself, inside the app, after importing.
- If I ask for anything this format can't represent (e.g. assigning a deck/folder/profile, an attachment type other than the three listed below, or anything else outside this schema), do NOT silently drop it or invent a workaround for it. Still output the JSON for everything you can convert, but also clearly tell me, outside the code block, what you couldn't do and why.
- Other than that one exception, output valid JSON and nothing else outside the code block — no explanations before or after.

Linking to TheSession.org / IrishTuneInfo.info — IMPORTANT, read carefully:
- Only do this if I explicitly gave you the exact numeric id myself (e.g. I pasted a URL or said "id 1234"). Do NOT guess or recall a numeric id from memory just because you recognize a tune's name — you are frequently wrong about exact database ids, and a wrong id silently links to a completely different tune.
- If you do have a confirmed id, that card's entire JSON object must look EXACTLY like one of these two — "externalId" is a TOP-LEVEL field, a sibling of "id", never nested inside "content", and there must be no "name"/"tags"/"content"/"defaultImportance" at all:
  {"id": -1, "externalId": "thesession:<numeric id>"}
  {"id": -1, "externalId": "irishtuneinfo:<numeric id>"}
  ("id" is optional here too, same negative-placeholder rule as above — only add it if another card references this one.) The app fetches the real tune from the source and fully replaces this entry with it, so anything else you added would just be discarded — don't write anything else.
- Everything else — anything you're inferring, summarizing, or recognizing by name alone — must be a normal card (the "name"/"tags"/"content" shape from the top of this prompt) with no "externalId" field anywhere.

Attachments (optional, inside "content.attachments" — leave it as [] unless one of these three clearly applies):
1. A link (video, webpage, recording…): {"type": "embed", "url": "https://..."}
2. A text file to attach (e.g. sheet music in ABC notation, tab, lyrics): {"type": "file", "name": "filename.abc", "mimeType": "text/plain", "text": "the plain-text content"}
3. A reference to another card in this SAME batch (e.g. "see also", a related tune): {"type": "card", "id": -2, "title": "the other card's name, for display"}
   To make this work: give the TARGET card a temporary negative "id" (e.g. -2) at its top level, then use that same number in the "id" field of the "card" attachment pointing to it. This works even if the target card is an id-linked TheSession/IrishTuneInfo card.

Here is what I want converted:

[PASTE YOUR OWN LIST / NOTES / FORMAT HERE]`;
