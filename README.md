# Cadence

A spaced repetition app for building and maintaining a long-term repertoire of anything.

When you sit down to practice, Cadence helps you make the most of your session by choosing what to review first — prioritising items that are about to be forgotten. It uses the [FSRS v4.5](https://github.com/open-spaced-repetition/fsrs4anki) algorithm, the current state of the art in spaced repetition research.

**[→ Open the app](https://batpapa.github.io/cadence/)**

---

## Features

- **Flashcard-based study** — rate each card after review (Again / Hard / Good / Easy), FSRS tracks how well you know each item and prioritises accordingly
- **Deck organisation** — group cards into decks, nest decks in folders
- **Knowledge tracking** — per-card and per-deck retention scores, weighted by importance
- **Rich cards** — attach notes, images, sheet music, audio files, or any document to a card
- **Works offline** — everything is stored locally in your browser (IndexedDB), nothing is sent to a server

## TheSession integration

Cadence includes built-in support for [TheSession.org](https://thesession.org), a community library of folk and traditional music. You can search and import any tune directly by name — all available settings (keys and modes) are imported as ABC notation files, rendered as sheet music with audio playback and tempo control inside the app.

## Tech stack

TypeScript · Webpack 5 · Tailwind CSS v3 · abcjs · IndexedDB (via idb)

## Development

```bash
npm install
npm run dev      # dev server at localhost:8080
npm run build    # production build → dist/
npm run deploy   # build + push to GitHub Pages
npm run deploy --msg="your message"   # with a custom commit message
```
