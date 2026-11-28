import { useEffect, useMemo, useState } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import { t } from '../../services/i18nService';
import { navigate, appState } from '../../store';
import { showModal, closeModalOf, renderModalBody, alertModal, confirmModal, MODAL_W } from '../../components/modal';
import { AudioPlayer, type AudioPlayerHooks } from '../../components/audioPlayer';
import { fmtTime, TitleRow } from '../../session/ui/sessionUiShared';
import { CustomSelect } from '../../components/customSelect';
import { transcribeAudio, decodeAudioSpan } from '../../session/scoreFollowClient';
import { failureText } from '../../session/ui/ScoreFollowView';
import { extractAudioOnly } from '../../session/audio/clipExtract';
import { MicIcon, DeviceAudioIcon, FileAudioIcon, ExternalLinkIcon } from '../../components/icons';
import { transcriptionModuleOf, type TranscriptionSettings, type TranscriptionSource } from '../model';
import { addTranscription, replaceDraft, wholeTune } from '../actions';
import { getTranscriptionAudio } from '../audioDb';
import { DANCES, MODES, TONIC_PCS, keyLabel, metreValid, transcribeSettingsOf } from '../settings';
import { irishTradEnabled } from '../../services/extensions';
import type { Mode } from '../../session/recognition/transcription';
import { setup, baseName, endSetup, type Setup } from './state';

// ── Setting a transcription up ───────────────────────────────────────────────
// The recording chosen, what is transcribed of it — the passage, what the user
// says of it (dance, metre, key), its name — then the transcription,
// in the worker (scoreFollowWorker.ts), the dialog saying how far it is. Only
// once it is done is anything stored (actions.ts).

export const SOURCE_ICON: Record<TranscriptionSource, (p: { size?: number }) => preact.JSX.Element> = {
  mic: MicIcon, device: DeviceAudioIcon, file: FileAudioIcon, link: ExternalLinkIcon,
};

/** Where a recording came from, in a word. The keys written out: a key built
 *  in a template is one the i18n test cannot check (i18nKeys.test.ts). */
const SOURCE_NAME: Record<TranscriptionSource, string> = {
  mic: 'transcription.source.mic', device: 'transcription.source.device',
  file: 'transcription.source.file', link: 'transcription.source.link',
};
export const sourceName = (source: TranscriptionSource): string => t(SOURCE_NAME[source]);

/** A select's trigger here: the add-file dialog's (addFileModal.tsx), the
 *  width of its column. */
const SELECT_TRIGGER = 'flex items-center gap-2 w-full text-sm bg-bg border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent';

/** A setting: its name, then what sets it and a word on it — one line each
 *  on a phone too (2026-11-28, the user: the rows of pills took the screen). */
function Setting({ label, hint, children }: { label: string; hint?: string; children: preact.ComponentChildren }) {
  return (
    <>
      <span class="label mb-0 mt-2 sm:mt-0 sm:pt-2">{label}</span>
      <div class="min-w-0" role="group" aria-label={label}>
        {children}
        {hint && <p class="text-xs mt-1 text-dim">{hint}</p>}
      </div>
    </>
  );
}

/** The metre, typed as M: writes it. Said wrong only once the field is left —
 *  "2+" is on its way to "2+2+3/8", not a mistake (the review of
 *  2026-11-28); Transcribe waits for it all along. */
function MetreField({ value, ok, onInput }: { value: string | undefined; ok: boolean; onInput: (metre: string | undefined) => void }) {
  const [left, setLeft] = useState(false);
  const wrong = !ok && left;
  return (
    <>
      <label class="label mb-0 mt-2 sm:mt-0 sm:pt-2" for="transcription-metre">{t('transcription.setup.metre')}</label>
      <div class="min-w-0">
        <input
          id="transcription-metre"
          type="text" autocomplete="off" spellcheck={false}
          class={`input py-1.5 text-sm font-mono ${wrong ? 'border-danger' : ''}`}
          placeholder={t('transcription.setup.metreAuto')}
          aria-invalid={wrong}
          aria-describedby="transcription-metre-note"
          value={value ?? ''}
          onInput={(e) => { const v = (e.target as HTMLInputElement).value; onInput(v.trim() ? v : undefined); }}
          onBlur={() => setLeft(true)}
          onFocus={() => setLeft(false)}
        />
        <p id="transcription-metre-note" class={`text-xs mt-1 ${wrong ? 'text-danger' : 'text-dim'}`}>
          {t(wrong ? 'transcription.setup.metreInvalid' : 'transcription.setup.metreHint')}
        </p>
      </div>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: preact.ComponentChildren }) {
  return (
    <div class="mt-4" role="group" aria-label={label}>
      <div class="flex items-baseline justify-between gap-3 mb-1.5">
        <span class="label mb-0">{label}</span>
        {hint && <span class="text-xs text-dim text-right">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const MODE_KEY: Record<string, string> = { maj: 'transcription.mode.maj', min: 'transcription.mode.min', dor: 'transcription.mode.dor', mix: 'transcription.mode.mix' };

/** Bars of the passage's waveform: more than a card's player has (120), the
 *  passage being chosen on it. */
const PASSAGE_BARS = 200;

/** The passage, chosen on the recording's waveform in the player a card's
 *  recording opens in (components/audioPlayer.tsx), bare: its region is the
 *  passage — the handles, ⇤ ⇥ at the head, "Reset" for the whole. It was the
 *  analyser's bound editor in a dialog until 2026-11-28 (the user: too much
 *  for this). Decoded in the worker, mono, as the transcription will be. */
function PassagePlayer({ s }: { s: Setup }) {
  const audio = s.source.audio;
  const stop = useMemo(() => new AbortController(), [audio]);
  useEffect(() => () => stop.abort(), [stop]);
  const hooks = useMemo<AudioPlayerHooks>(() => ({
    load: async (engine) => {
      const d = await decodeAudioSpan(audio, 0, s.source.duration, stop.signal);
      if (!d) throw new Error(t('transcription.unreadable'));
      return engine.loadSamples([d.pcm], d.rate, PASSAGE_BARS);
    },
    region: { start: s.from, end: s.to },
    bare: true,
    onRegion: (r) => {
      const cur = setup.value;
      if (cur && cur.source.audio === audio && (cur.from !== r.start || cur.to !== r.end)) setup.value = { ...cur, from: r.start, to: r.end };
    },
    // eslint-disable-next-line
  }), [audio]);
  return (
    <div class="rounded-lg border border-border bg-bg">
      <AudioPlayer key={s.source.label} hooks={hooks} />
    </div>
  );
}

function Working({ name, ratio }: { name: string; ratio: Signal<number> }) {
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted break-words">{t('transcribe.working', { name })}</p>
      {/* The analyser's import bar (ImportAnalysis.tsx). */}
      <div class="h-1.5 rounded-full bg-elevated overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio.value * 100)}>
        <div class="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(ratio.value * 100)}%` }} />
      </div>
    </div>
  );
}

/** Transcribes what `s` says, in the worker, then stores it and opens it. Its Cancel stops
 *  the work, and nothing is stored — the only way out: a long recording's
 *  minutes of work are not lost to a tap beside the dialog (the review of
 *  2026-11-28). */
function run(s: Setup): void {
  const ratio = signal(0);
  const stop = new AbortController();
  const { el, cleanup } = renderModalBody(<Working name={s.name} ratio={ratio} />);
  const done = () => { closeModalOf(el); cleanup(); };
  showModal(t('transcribe.title'), el, [
    { label: t('common.cancel'), onClick: () => { stop.abort(); done(); } },
  ], { maxWidth: MODAL_W.m, dismissable: false });
  const settings = transcribeSettingsOf(s.settings);
  void (async () => {
    try {
      const result = await transcribeAudio(s.source.audio, (r) => { ratio.value = r * 0.95; }, stop.signal, { from: s.from, to: s.to, settings });
      if (stop.signal.aborted) return;
      if (typeof result === 'string') {
        done();
        alertModal(t('transcribe.title'), result === 'no_contour' ? t('transcribe.noNotes') : failureText(result));
        return;
      }
      const draft = wholeTune(result.abc, s.name);
      if (s.redo) {
        // its own recording, its own place: the draft replaced
        if (!transcriptionModuleOf(appState.value)?.transcriptions[s.redo.id]) { done(); alertModal(t('transcribe.title'), t('transcription.notFound')); return; }
        await replaceDraft(s.redo.id, { name: s.name, draft, from: s.from, to: s.to, settings: s.settings });
        const id = s.redo.id;
        done();
        endSetup();
        navigate({ view: 'transcriptions', id });
        return;
      }
      // a film's sound only, when it can be had without re-encoding (the
      // analyser's rule, clipExtract.ts): the picture is never read here
      let audio: Blob = s.source.audio;
      try { audio = (await extractAudioOnly(audio))?.blob ?? audio; } catch { /* kept whole */ }
      if (stop.signal.aborted) return;
      const id = await addTranscription({
        name: s.name, createdAt: Date.now(), source: s.source.source, origin: s.source.label,
        duration: s.source.duration, mimeType: audio.type || s.source.mimeType,
        from: s.from, to: s.to, settings: s.settings, draft,
      }, audio, s.folder ?? null);
      // stored: from here it is the transcription's, whatever happens next
      done();
      endSetup();
      navigate({ view: 'transcriptions', id });
    } catch (e) {
      if (stop.signal.aborted) return;
      console.warn('[transcription] failed', e);
      done();
      alertModal(t('transcribe.title'), t('transcribe.failed'));
    }
  })();
}

/** Abandoning the setup — the title row's bin, as an analysis being imported
 *  has it (ImportAnalysis.tsx): a recording made here exists nowhere else,
 *  which the question says. A transcription done again stays as it was. */
function abandonTexts(s: Setup): { label: string; title: string; message: string; confirm: string } {
  const recorded = !s.redo && (s.source.source === 'mic' || s.source.source === 'device');
  return {
    label: t('transcription.setup.abandon'),
    title: t(recorded ? 'transcription.setup.leaveTitle' : 'transcription.setup.abandonTitle'),
    message: t(recorded ? 'transcription.setup.leaveRecording' : s.redo ? 'transcription.setup.abandonRedo' : 'transcription.setup.abandonFile'),
    confirm: t('transcription.setup.abandon'),
  };
}

/** Abandoned: a transcription done again is gone back to. */
function abandonSetup(): void {
  const redo = setup.value?.redo;
  endSetup();
  if (redo) navigate({ view: 'transcriptions', id: redo.id });
}

/** Transcribing a stored transcription again (2026-11-28, the user): its
 *  recording, its passage, its settings and its name to start from; its draft
 *  replaced when done — asked first, always, as re-analysing is; its
 *  corrections said to go with it when it has some. Its recording from this
 *  device, else from `fromDrive` once the question is answered — a recording
 *  only on Drive is brought down for it, not kept (the analyser's re-analysis,
 *  2026-11-05); null when it could not be had, the user told why. */
export async function startRedo(id: string, fromDrive?: () => Promise<Blob | null>): Promise<void> {
  const r = transcriptionModuleOf(appState.value)?.transcriptions[id];
  if (!r) return;
  const local = await getTranscriptionAudio(id);
  if (!local && !fromDrive) { alertModal(t('transcribe.title'), t('transcription.audioElsewhere')); return; }
  const go = async () => {
    const audio = local ?? await fromDrive!();
    // gone meanwhile, or not to be had
    if (!audio || !transcriptionModuleOf(appState.value)?.transcriptions[id]) return;
    setup.value = {
      source: { audio, label: r.origin ?? r.name, source: r.source, duration: r.duration, mimeType: r.mimeType },
      from: r.from, to: r.to, settings: { ...r.settings }, name: r.name, redo: { id },
    };
    navigate({ view: 'transcriptions' });
  };
  confirmModal(t('transcription.redo.title'), t(r.abc === undefined ? 'transcription.redo.message' : 'transcription.redo.corrected'), t('transcription.menu.redo'), () => { void go(); }, { destructive: false });
}

export function SetupScreen({ s }: { s: Setup }) {
  const update = (patch: Partial<Setup>) => { setup.value = { ...s, ...patch }; };
  const set = (patch: Partial<TranscriptionSettings>) => {
    const next: TranscriptionSettings = { ...s.settings, ...patch };
    for (const k of Object.keys(next) as (keyof TranscriptionSettings)[]) if (next[k] === undefined) delete next[k];
    update({ settings: next });
  };
  const whole = s.from <= 0.05 && s.to >= s.source.duration - 0.05;
  const SourceIcon = SOURCE_ICON[s.source.source];
  const key = s.settings.key;
  const metreOk = metreValid(s.settings.metre);
  // the Irish extension's dances; none without it, and then no choice at all
  // (2026-11-28, the user)
  const dances = irishTradEnabled() ? DANCES : [];
  /** The metre the dance chosen preset, to tell whether it was changed since. */
  const danceMetre = DANCES.find(d => d.id === s.settings.dance)?.metre;
  return (
    <div>
      {/* The name on top, as the transcription will show it (screen.tsx) —
          renamed by a tap (2026-11-28, the user); the bin abandons, as an
          import's in the analyser. */}
      <TitleRow
        getName={() => s.name}
        getDefaultName={() => baseName(s.source.label)}
        onRename={(name) => update({ name })}
        onDelete={abandonSetup}
        deleteTexts={abandonTexts(s)}
      />
      {/* The recording, as the analyses' list shows one (AnalysisBrowser's
          Card): its source's glyph, where it came from, its length. */}
      <div class="mt-1 text-xs text-dim flex items-start gap-1.5">
        <span class="shrink-0 flex items-center h-4" title={sourceName(s.source.source)}><SourceIcon size={12} /></span>
        <span class="min-w-0 name-wrap">{s.source.label} · {fmtTime(s.source.duration)}</span>
      </div>

      {/* Its length said only for a part: the whole one's is right above. */}
      <Field label={t('transcription.setup.passage')}
        hint={whole ? undefined : t('transcription.setup.passageLength', { d: fmtTime(s.to - s.from) })}>
        <PassagePlayer s={s} />
      </Field>

      {/* The controls no wider than they need on a wide screen. */}
      <div class="mt-4 grid grid-cols-1 sm:grid-cols-[auto_minmax(0,28rem)] sm:justify-start gap-x-4 gap-y-1 sm:gap-y-3 items-start">
        {/* Not heard, only said (2026-11-28, the user): it presets its
            metre, and names the card's type. */}
        {dances.length > 0 && (
          <Setting label={t('transcription.setup.dance')} hint={t('transcription.setup.danceHint')}>
            <CustomSelect
              value={s.settings.dance ?? ''}
              options={[{ value: '', label: t('transcription.setup.danceNone') }, ...dances.map(d => ({ value: d.id, label: d.id }))]}
              onChange={(dance) => {
                const preset = DANCES.find(d => d.id === dance)?.metre;
                // the metre follows the dance while it is the dance's own; one
                // typed since stays
                const metre = s.settings.metre === undefined || s.settings.metre === danceMetre ? preset : s.settings.metre;
                set({ dance: dance || undefined, metre });
              }}
              triggerClass={SELECT_TRIGGER}
              ariaLabel={t('transcription.setup.dance')}
            />
          </Setting>
        )}
        {/* Any metre ABC writes (transcription.ts parseMetre), typed: a list
            would be a finite one (2026-11-28, the user). */}
        <MetreField value={s.settings.metre} ok={metreOk} onInput={(metre) => set({ metre })} />
        {/* The key sets the signature: each tonic named as the circle of
            fifths names it in that mode, its sharps or flats beside it; the
            mode said, or told from the notes (2026-11-28, the user). */}
        <Setting label={t('transcription.setup.key')} hint={t('transcription.setup.keyHint')}>
          <div class="flex gap-2">
            <div class="flex-1 min-w-0">
              <CustomSelect
                value={key ? String(key.tonic) : ''}
                options={[{ value: '', label: t('transcription.setup.auto') }, ...TONIC_PCS.map(pc => {
                  const l = keyLabel(pc, key?.mode ?? 'maj');
                  return { value: String(pc), label: key?.mode && l.signature ? `${l.tonic} (${l.signature})` : l.tonic };
                })]}
                onChange={(v) => set({ key: v === '' ? undefined : { tonic: Number(v), ...(key?.mode ? { mode: key.mode } : {}) } })}
                triggerClass={SELECT_TRIGGER}
                ariaLabel={t('transcription.setup.tonic')}
              />
            </div>
            {key && (
              <div class="flex-1 min-w-0">
                <CustomSelect
                  value={key.mode ?? ''}
                  options={[{ value: '', label: t('transcription.setup.modeAuto') }, ...MODES.map(m => ({ value: m, label: t(MODE_KEY[m]!) }))]}
                  onChange={(m) => set({ key: { tonic: key.tonic, ...(m ? { mode: m as Mode } : {}) } })}
                  triggerClass={SELECT_TRIGGER}
                  ariaLabel={t('transcription.setup.mode')}
                />
              </div>
            )}
          </div>
        </Setting>
      </div>

      <button type="button" class="btn-primary w-full justify-center mt-6" disabled={!metreOk} onClick={() => run(s)}>
        {t(s.redo ? 'transcription.menu.redo' : 'transcription.setup.go')}
      </button>
    </div>
  );
}
