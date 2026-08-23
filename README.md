# Cadence

A spaced repetition app for building and maintaining a long-term repertoire of anything.

When you sit down to practice, Cadence helps you make the most of your session by choosing what to review first — prioritising items that are about to be forgotten. It uses the [FSRS v4.5](https://github.com/open-spaced-repetition/fsrs4anki) algorithm, the current state of the art in spaced repetition research.

**[→ Open the app](https://batpapa.github.io/Cadence/)**

---

## Features

- **Flashcard-based study** — rate each card after review (Again / Hard / Good / Easy), FSRS tracks how well you know each item and prioritises accordingly
- **Deck organisation** — group cards into decks, nest decks in folders, study a folder or the whole library at once
- **Knowledge tracking** — per-card and per-deck retention scores, weighted by contextual importance
- **Rich cards** — attach notes, images, sheet music (ABC notation, rendered with [abcjs](https://github.com/paulrosen/abcjs)), audio, or any document to a card
- **Session recording & tune recognition** — record a session (or import a recording), and Cadence identifies which tunes are being played and when, entirely on-device, then lets you clip and save extracts straight onto cards
- **Import from TheSession.org and IrishTuneInfo.com** — search and import tunes by name, with all available settings brought in as ABC
- **Import / export** — share individual cards or full backups (`.cdc` / `.cdb`), export a deck as CSV, or hand a pack to someone else with a short one-time share key
- **Local-first** — card data and study history live in your browser (IndexedDB); no account needed.

## Tech stack

TypeScript · Preact · Webpack 5 · Tailwind CSS v3 · abcjs · IndexedDB (via idb) · WebCodecs / web-demuxer (audio) · [FolkFriend](https://github.com/TomWyllie/folkfriend) (WASM, on-device tune recognition)

## Development

```bash
npm install
npm run dev      # dev server at localhost:8080
npm run build    # production build → dist/
npm run deploy   # build + push to GitHub Pages
npm run deploy --msg="your message"   # with a custom commit message
```

## Server dependency

TheSession.org import talks directly to `thesession.org` from the browser. IrishTuneInfo import and the share-by-key
feature depend on a small companion server ([`irishtuneinfo-scraper-api`](https://github.com/Batpapa/irishtuneinfo-scraper-api))
run on a Render free-tier instance, which sleeps after inactivity — the first request after a while can take up to
~1 minute to wake it back up (this is handled/surfaced in the UI; see `scraperServerStatus.ts`). If you fork Cadence,
these two features will hit *the author's* instance unless you deploy your own and repoint `SCRAPER_BASE` (see
Self-hosting below).

## Self-hosting / configuration

Cadence is AGPL-licensed specifically so it's easy to redeploy your own copy. Two values are hard-coded and should be
changed if you do:

- **`GOOGLE_CLIENT_ID`** (`src/config.ts`) — an OAuth 2.0 Client ID for the optional Google Drive sync feature. Create
  your own at [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials, and add your
  deployment's origin under "Authorized JavaScript origins".
- **`SCRAPER_BASE`** (`src/services/scraperServerStatus.ts`) — the base URL of the companion scraper/share server
  described above. Deploy your own copy of [`irishtuneinfo-scraper-api`](https://github.com/Batpapa/irishtuneinfo-scraper-api)
  (e.g. on Render) and point this at it, or IrishTuneInfo import and sharing-by-key will hit the author's instance.

## Acknowledgments

The session tune-recognition feature is powered by [FolkFriend](https://github.com/TomWyllie/folkfriend) by Tom Wyllie, compiled to WebAssembly and run fully on-device — no audio ever leaves the browser for *recognition*. (Audio does leave the browser if you explicitly share a recorded session with its audio attached — see the [Privacy Policy](https://batpapa.github.io/Cadence/privacy.html).) FolkFriend is GPL-3.0-licensed; see [`vendor/folkfriend/README.md`](vendor/folkfriend/README.md) for the vendored build details.

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html)
