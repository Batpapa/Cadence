# FolkFriend tune index — recovered builder

The pipeline that produces `folkfriend-non-user-data.json`, the ~34 MB file
Cadence downloads to recognise tunes. **It is not in FolkFriend's maintained
repository any more**; this directory is an archaeological recovery from its git
history, kept because one day we may need to run it ourselves.

Nothing here runs as part of Cadence. It is documentation plus four Python files
recovered verbatim.

## Why this exists

The index is a single point of failure that nobody is watching.

`TomWyllie/folkfriend-app-data` is regenerated **weekly** — commit messages are
the meta JSON itself (`{"v": 2441, "size": 34463416}`). But that repository
contains **no workflow**: only `firebase.json` and the two data files. The build
therefore runs on a private machine, invisible from GitHub. Meanwhile
`TomWyllie/folkfriend` itself has not been touched since **December 2024**.

If that private job ever stops, there is no notification. The only signal would
be `nud-meta.json` quietly ceasing to advance — and Cadence would keep serving a
frozen index without complaining, because a stale index still works
(see `INDEX_MAX_AGE_DAYS` in `src/session/sessionConfig.ts`).

## Where it came from

Two commits, both on **2021-10-07**, removed the two halves together — the day
the Rust CLI switched to downloading a prebuilt index instead of making one.

| File | Recovered from | Removing commit | Blob SHA |
|---|---|---|---|
| `recovered/build_non_user_data.py` | `d64ed25^:scripts/index-builder/build_non_user_data.py` | `d64ed25` "Auto download index, updated readme, tidied some old scripts" | `2649637e` |
| `recovered/midi.py` | `eff363c^:utils/folkfriend/data/midi.py` | `eff363c` "Restructured old directories" | `2cfcb873` |
| `recovered/ff_config.py` | `eff363c^:utils/folkfriend/ff_config.py` | `eff363c` | `d121fbeb` |
| `recovered/abc.py` | `eff363c^:utils/folkfriend/data/abc.py` | `eff363c` | `75022368` |

To re-fetch any of them:

```bash
git clone https://github.com/TomWyllie/folkfriend.git
git -C folkfriend show d64ed25^:scripts/index-builder/build_non_user_data.py
```

`abc.py` is the **reverse** direction (contour → ABC), the Python ancestor of
the WASM's `contour_to_abc`. It is not part of the build path; it is kept
because it documents the same note alphabet from the other side.

## The pipeline

`build_non_user_data.py` is the entry point (`--dir`, default `./index-data`).

**1. Input.** Downloads `json/tunes.json` and `json/aliases.json` from
[`adactio/TheSession-data`](https://github.com/adactio/TheSession-data) — the
official TheSession dump. Note that **Cadence already syncs that repository**
(`trendingSyncService.ts`, `tuneNameIndexService.ts`, `tuneIndexDb.ts`), so the
input side is already solved on our end.

**2. Clean.** Drops `date`, `username` and per-setting `name` (identical across
settings of one tune, so stored once in the aliases instead). Renames `type` to
`dance` — "type" collided with a keyword downstream.

**3. Aliases.** Merges each tune's `name` in first (TheSession's own name is
usually the common one), then the alias records, then deduplicates: lowercase,
strip non-letters, drop stop words, trim trailing `s`, normalise
`favorite`→`favourite`, and finally remove any alias whose cleaned word-set is a
subset of another's.

**4. Contour** — the heavy step, run with `process_map` across all settings.
See below.

**5. Output.** `{settings: {setting_id: {tune_id, meter, mode, abc, dance,
contour}}, aliases: {tune_id: [names]}}`. This matches `rust/src/index/schema.rs`
upstream and `IndexSetting` in `src/session/recognition/indexStore.ts` here.

The original comment states the design intent plainly: ABC syntax is non-trivial
to parse, so it is parsed **once**, offline, and shipped pre-digested. The raw
ABC string is kept alongside because contour → ABC is a non-unique mapping and
the sheet music has to come from somewhere.

## The contour format

This is the part worth preserving; everything else is bookkeeping.

**ABC parsing is delegated to `abc2midi`** (the abcMIDI toolkit) via a
subprocess. A minimal header is synthesised per setting:

```
X:1
T:
M:{meter}
K:{mode}
{abc body, with backslashes and CRs stripped}
```

The MIDI is read back through `py_midicsv`, turned into note on/off pairs, and
`CSVMidiNoteReader.to_midi_contour()` does two things:

**Quantisation to quavers**, at a fixed tempo of 125 BPM. A note lasting *n*
quavers is repeated *n* times in the string. When the duration is not an integer
multiple, the rounding direction depends on whether the music clock is ahead of
or behind the output clock — a drift corrector, not a plain round. The original
comment is candid about it:

> This results in some distortion of the melody but it should closely resemble
> the original; if both the training data and the data file builder use this
> same function then tune query searching should be relatively unaffected.

The contour does not need to be *faithful*. It needs to be computed **the same
way on both sides**. That is the constraint any reimplementation must respect —
matching FolkFriend's output bit for bit matters far more than being musically
correct.

**Octave folding, then encoding.** Each pitch is folded into the range by ±12
semitones, offset by `MIDI_LOW`, and encoded with `string.ascii_letters[:48]`.

```python
MIDI_LOW  = 48   # C2
MIDI_HIGH = 95   # B6
MIDI_NUM  = 48
MIDI_MAP_ = string.ascii_letters[:48]     # 'a'..'z' then 'A'..'V'
```

One subtlety, easy to get wrong: `rel_pitch()` folds with **strict**
inequalities (`while pitch <= MIDI_LOW: pitch += 12` and
`while pitch >= MIDI_HIGH: pitch -= 12`), so both endpoints are excluded. The
alphabet actually emitted is therefore **46 characters, `b` through `U`** — not
48. That is deliberate: the decoder needs frequency content on both sides of the
bin it is considering.

## Running it today

Untested — recovered, read and documented, never executed. Expect friction:

- **`abc2midi`** must be on `PATH` (Debian/Ubuntu: `abcmidi`; Homebrew:
  `abcmidi`). This is the load-bearing external dependency, and the reason
  reimplementing the pipeline in another language is not as bad as it sounds:
  nobody has to write an ABC parser.
- **`py_midicsv`**, `numpy`, `requests`, `tqdm` from PyPI. `py_midicsv` is the
  one most likely to have rotted since 2021.
- The imports are `from folkfriend import ...`, so the four files need to sit in
  a package laid out as the original was (`folkfriend/ff_config.py`,
  `folkfriend/data/midi.py`, `folkfriend/data/abc.py`) with the builder outside
  it — they are stored flat here on purpose, to keep the recovery honest rather
  than reshaped.
- It writes one `.midi` file per setting into `{dir}/midis/` and skips any that
  already exist, so a re-run resumes. At ~55 000 settings that is a lot of small
  files.

**Before trusting any output, diff it against the real thing.** Build the index,
then compare the `contour` field of a sample of settings against the same
settings in the live `folkfriend-non-user-data.json`. If the contours do not
match exactly, the index is worse than useless — it will fail to recognise
tunes while looking perfectly well-formed.

## When we would need this

- The weekly upstream build stops, and `nud-meta.json` stalls.
- We want an index built from a source other than TheSession. Note that the two
  reasons this was rejected for abcnotation.com in 2026-09 were **scale** (34 MB
  for ~55 000 settings; an aggregator indexes ~800 000 tunes) and **detection
  quality** (the 0.20 operating point was calibrated against this candidate
  pool, and aggregators carry many undeduplicated transcriptions of one tune) —
  not the absence of a builder. Recovering it does not reopen that case.
- We want to change the contour representation itself. That would mean
  rebuilding the index *and* changing the decoder in lockstep, since both sides
  must agree.
