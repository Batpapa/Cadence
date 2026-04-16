# Cadence

A spaced repetition app for learning Irish traditional music tunes.

Cadence helps you build and maintain a repertoire by scheduling tune reviews at the right moment — just before you'd forget them. It uses the [FSRS v4.5](https://github.com/open-spaced-repetition/fsrs4anki) algorithm, the current state of the art in spaced repetition research.

**[→ Open the app](https://YOUR_USERNAME.github.io/cadence/)**

---

## Features

- **Import tunes from TheSession** — search by name, import with all settings (keys, modes) as playable ABC notation files
- **ABC notation viewer** — rendered sheet music with audio playback and tempo control
- **Spaced repetition study** — FSRS-based scheduling with four rating levels (Again / Hard / Good / Easy)
- **Deck organisation** — group tunes into decks (by style, set, difficulty…), nest decks in folders
- **Knowledge tracking** — per-card and per-deck retention scores, weighted by importance
- **Works offline** — everything is stored locally in your browser (IndexedDB), nothing is sent to a server

## How to use

1. Open the app in your browser
2. Create a deck (e.g. *Reels I'm learning*)
3. Add cards — either manually or by importing from TheSession
4. Hit **Study** and rate each tune after playing it: how well did you remember it?
5. Come back regularly — Cadence will show you the tunes that need attention

## Tech stack

TypeScript · Webpack 5 · Tailwind CSS v3 · abcjs · IndexedDB (via idb)

## Development

```bash
npm install
npm run dev      # dev server at localhost:8080
npm run build    # production build → dist/
npm run deploy   # build + push to GitHub Pages
```
