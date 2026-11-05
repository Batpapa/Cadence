# Cadence

Spaced repetition, for everything you want to remember.

Cadence keeps a long-term repertoire alive — vocabulary, course material, pieces of music, anything. When you sit down
to practise, it picks what to review first: the items you are about to forget. Scheduling uses
[FSRS v4.5](https://github.com/open-spaced-repetition/fsrs4anki), the current state of the art in spaced repetition.

Cadence plans *when* to come back to something; it never prescribes *how* to learn it.

**[→ Open the app](https://batpapa.github.io/Cadence/)** ·
**[Get it on Google Play](https://play.google.com/store/apps/details?id=io.github.batpapa.cadence)** ·
installable as a web app (PWA), works offline · English and French

---

## What Cadence does

- **Cards, decks, folders, tags** — a card holds whatever helps you remember: notes, images, PDFs, audio, video,
  sheet music, links (YouTube, Spotify, Deezer, SoundCloud, or any file on the web, played in the app).
- **Review at the right time** — rate each card after review (Again / Hard / Good / Easy); FSRS spaces it out
  accordingly. Per-card and per-deck knowledge, weighted by how much each card matters in its deck.
- **Study strategies** — optimal, optimal stochastic, sequential or random; study a deck, a folder or the whole
  library.
- **Share** — a six-character one-time key, or a file: card packs (`.cdc`), full backups (`.cdb`), decks as CSV.
- **Smart edit** — Cadence describes your library as JSON with written instructions; a script, an AI assistant of
  your choice, or you by hand, answers with operations that Cadence checks, previews and applies. Cadence itself never
  talks to an AI service: the text goes across by clipboard or file, in your hands.
- **Your data stays yours** — everything lives on your device. Optional Google Drive sync (only the files Cadence
  creates) for backups and several devices, with versioning and snapshots so a sync never silently overwrites work.
- **Guided tours and built-in help** for every screen.

## For Irish traditional music

An optional extension, chosen when a user is created (and changeable in Settings → Extensions). Cadence is general
first; this is what it adds for trad musicians.

- **TheSession.org** — search a tune or a set and turn it into a card, with all its settings as ABC. A sample library
  can be built from TheSession when you start. [irishtune.info](https://www.irishtune.info) as an optional second
  source.
- **Scores** — ABC rendered with [abcjs](https://github.com/paulrosen/abcjs), with playback and a cursor; score and
  ABC text side by side, edited live, with syntax checking; swing for jigs and reels.
- **Audio sync** — attach a recording (or link to one) and the score follows it as it plays. With several
  recordings, Cadence can rank them by how well they match.
- **Play-along** — through the microphone, the score follows what you play, and suggests another version of the tune
  if it fits what you play better.
- **Tune analyser** — record a session live, or import a recording (audio or video, up to several hours), and Cadence
  recognises which tunes and sets are played and when — entirely on-device. Edit the boundaries, see each tune's
  tempo, clip extracts straight onto cards, export the list as CSV, back a live recording up to Drive as it goes. On
  Android it can also listen to what the phone itself is playing.
- **Trending** — which tunes are rising in TheSession members' tunebooks, corrected for the site's own growth.

Both modules can be tried without an account:
**[Tune analyser](https://batpapa.github.io/Cadence/TuneAnalyser/)** ·
**[Trending](https://batpapa.github.io/Cadence/Trending/)** — nothing is kept, and finished analyses can be carried
into the app.

## Tech stack

TypeScript · Preact (+ signals) · Webpack 5 · Tailwind CSS v3 · IndexedDB (via idb) · abcjs · Web Workers, Web Audio
and AudioWorklet · WebCodecs, [mediabunny](https://github.com/Vanilagy/mediabunny) and
[web-demuxer](https://github.com/bilibili/web-demuxer) (decoding) ·
[signalsmith-stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) (speed and pitch) ·
[FolkFriend](https://github.com/TomWyllie/folkfriend) (WASM, on-device tune recognition) ·
[pdf.js](https://github.com/mozilla/pdf.js) · DOMPurify · driver.js (guided tours) ·
[Capacitor](https://capacitorjs.com) (Android app, with over-the-air web updates)

## Development

```bash
npm install          # also applies the patches in patches/ (abcjs)
npm run dev          # dev server at localhost:8080
npm test             # unit tests (vitest)
npm run build        # production build → dist/
npm run deploy       # commit everything and push; GitHub Actions builds and publishes
npm run deploy --msg="your message"   # with a custom commit message
```

- **Deployment** — `.github/workflows/deploy.yml` builds the site on every push to `main`, packs the over-the-air
  bundle for the Android app (`scripts/ota-bundle.js`) and precomputes the Trending data
  (`scripts/build-popularity.mjs` → `data/popularity.json`). It also runs every Monday to refresh that data.
- **Trending in dev** — `node scripts/build-popularity.mjs --out src/data/popularity.json` once, or the standalone
  Trending page starts empty.
- **Android** — `npm run cap:run` builds and runs on a device or emulator; `npm run cap:dev` runs with live reload.
  The native project is in `android/`.

## Server dependency

TheSession.org import talks directly to `thesession.org` from the browser. irishtune.info import and the
share-by-key feature depend on a small companion server
([`irishtuneinfo-scraper-api`](https://github.com/Batpapa/irishtuneinfo-scraper-api)) run on a Render free-tier
instance, which sleeps after inactivity — the first request after a while can take up to ~1 minute to wake it up
(surfaced in the UI; see `scraperServerStatus.ts`). Shared content is held in memory only, for 10 minutes.

Public data comes from GitHub: TheSession's open data
([`adactio/TheSession-data`](https://github.com/adactio/TheSession-data)) for name search and Trending, and
FolkFriend's tune index ([`TomWyllie/folkfriend-app-data`](https://github.com/TomWyllie/folkfriend-app-data)) for
recognition.

## Self-hosting / configuration

Cadence is AGPL-licensed specifically so it's easy to redeploy your own copy. These values are hard-coded and should
be changed if you do:

- **`GOOGLE_CLIENT_ID`** (`src/config.ts`) — an OAuth 2.0 Client ID for the optional Google Drive sync. Create your
  own at [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials, and add your
  deployment's origin under "Authorized JavaScript origins".
- **`SCRAPER_BASE`** (`src/services/scraperServerStatus.ts`) — the companion scraper/share server described above.
  Deploy your own copy and point this at it, or irishtune.info import and sharing by key will hit the author's
  instance.
- **`PUBLISHED`** (`src/trending/publishedHistory.ts`) — where the precomputed Trending data is read from.
- **The Android app** — its application id (`capacitor.config.ts`, `android/`), `PLAY_STORE_URL`
  (`src/components/installOffer.tsx`) and the over-the-air update source (`src/native/otaUpdate.ts`), which reads the
  deployed site's `version.json`. A fork that keeps them would point at the author's app.

## Acknowledgments

- Tune recognition is powered by [FolkFriend](https://github.com/TomWyllie/folkfriend) by Tom Wyllie, compiled to
  WebAssembly and run fully on-device — no audio ever leaves the device for recognition, audio sync or play-along.
  (Audio leaves it only if you share an analysis with its audio, or back it up to your own Google Drive — see the
  [Privacy Policy](https://batpapa.github.io/Cadence/privacy.html).) FolkFriend is GPL-3.0-licensed; see
  [`vendor/folkfriend/README.md`](vendor/folkfriend/README.md) for the vendored build details.
- Scheduling follows [FSRS](https://github.com/open-spaced-repetition) by the Open Spaced Repetition project.
- Scores are drawn and played by [abcjs](https://github.com/paulrosen/abcjs) by Paul Rosen.
- Tunes and popularity data come from [TheSession.org](https://thesession.org), created by Jeremy Keith, and its
  members; tunes and recordings also from [irishtune.info](https://www.irishtune.info) by Alan Ng.

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html)
