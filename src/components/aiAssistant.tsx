import { useState } from 'preact/hooks';
import { appState } from '../store';
import { showModal, renderModalBody, closeModal } from './modal';
import { askIncompleteExport } from './incompleteExportModal';
import { t } from '../services/i18nService';
import { copyText, downloadTextFile, toDateStr } from '../utils';
import { inlineExternalAttachments, mutateWithRule } from '../services/attachmentStore';
import { exportBackup } from '../services/importExport';
import { aiView } from '../services/aiAssistant/view';
import { aiDocument } from '../services/aiAssistant/instructions';
import { applyOps, hasDeletions, parseAnswer, prepare, type ApplyContext, type OpError, type Summary } from '../services/aiAssistant/ops';
import { fetchExternalCards } from '../services/aiAssistant/fetchExternal';
import type { AppState } from '../types';

// ── The AI assistant (2026-10-11) ────────────────────────────────────────────
// One window, opened from Home, in three steps: hand the library to an AI,
// check what it sends back, then — once a backup is safely downloaded — apply
// it. The only way into AI editing: the "Generate with an AI" tab of the
// new-card window went with it, several entry points being more to maintain.
//
// The safety net is the user's own backup file, by decision: no restore
// machinery of its own, the ordinary Settings → Backup → Import puts it back.

interface Verified {
  ops: unknown[];
  ctx: ApplyContext;
  summary: Summary;
  /** The state the check ran on. Applying onto a different one re-runs the
   *  check first: a sync may have landed in between. */
  base: AppState;
}

type Outcome = { errors: OpError[] } | Verified;

function errorText(e: OpError): string {
  const message = t(`aiAssistant.error.${e.code}`, e.params ?? {});
  return e.op === 0 ? message : t('aiAssistant.errorLine', { n: e.op, name: e.name ?? '?', message });
}

async function buildDocument(withContent: boolean): Promise<string | null> {
  const state = appState.value;
  let cards = state.cards;
  if (withContent) {
    // A copy, filled with the bytes of every externalised file — never the
    // running state, whose `data` is empty on purpose (see importExport).
    const copy = structuredClone(state.cards);
    const missing = await inlineExternalAttachments(Object.values(copy));
    if (missing.length > 0 && !(await askIncompleteExport(missing))) return null;
    cards = copy;
  }
  return aiDocument(aiView(state, withContent, cards));
}

function AiAssistant({ onClose }: { onClose: () => void }) {
  const [withContent, setWithContent] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [size, setSize] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'verify' | 'apply' | null>(null);
  const [progress, setProgress] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [backupLaunched, setBackupLaunched] = useState(false);
  const [kept, setKept] = useState(false);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState(false);
  const [errorsCopied, setErrorsCopied] = useState(false);

  const withDocument = async (use: (doc: string) => Promise<void> | void) => {
    setPreparing(true);
    try {
      const doc = await buildDocument(withContent);
      if (doc === null) return;
      setSize(doc.length);
      await use(doc);
    } finally {
      setPreparing(false);
    }
  };

  const copy = () => withDocument(async (doc) => {
    if (await copyText(doc)) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  });
  const download = () => withDocument(doc => downloadTextFile(doc, `cadence-ia-${toDateStr(new Date())}.md`, 'text/markdown'));

  const changeAnswer = (text: string) => {
    setAnswer(text);
    setOutcome(null);
    setBackupLaunched(false);
    setKept(false);
    setStale(false);
    setDone(false);
  };

  const loadFile = async (file: File | undefined) => {
    if (file) changeAnswer(await file.text());
  };

  const verify = async () => {
    setBusy('verify');
    setOutcome(null);
    setStale(false);
    try {
      const parsed = parseAnswer(answer);
      if ('error' in parsed) { setOutcome({ errors: [parsed.error] }); return; }
      const base = appState.value;
      const prep = prepare(parsed.ops);
      const ext = await fetchExternalCards(parsed.ops, base, (n, total) => {
        setProgress(total > 0 && n < total ? t('aiAssistant.fetching', { done: n, total }) : '');
      });
      const ctx: ApplyContext = { newIds: prep.newIds, fetched: ext.fetched, now: Date.now() };
      const run = applyOps(structuredClone(base), parsed.ops, ctx);
      const errors = [...prep.errors, ...ext.errors, ...run.errors].sort((a, b) => a.op - b.op);
      setOutcome(errors.length > 0 ? { errors } : { ops: parsed.ops, ctx, summary: run.summary, base });
    } finally {
      setProgress('');
      setBusy(null);
    }
  };

  const backup = async () => {
    if (await exportBackup(appState.value, askIncompleteExport)) setBackupLaunched(true);
  };

  const apply = async (v: Verified) => {
    setBusy('apply');
    try {
      if (appState.value !== v.base) {
        const again = applyOps(structuredClone(appState.value), v.ops as never, v.ctx);
        if (again.errors.length > 0) { setStale(true); return; }
      }
      await mutateWithRule(s => { applyOps(s, v.ops as never, v.ctx); });
      setDone(true);
    } finally {
      setBusy(null);
    }
  };

  const verified = outcome && 'summary' in outcome ? outcome : null;
  const errors = outcome && 'errors' in outcome ? outcome.errors : null;

  return (
    <div class="space-y-5 text-sm">
      <p class="text-muted leading-relaxed">{t('aiAssistant.intro')}</p>

      {/* ── 1. Prepare ── */}
      <section class="space-y-2">
        <h3 class="section-title">{t('aiAssistant.step1')}</h3>
        <label class="flex items-start gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            class="card-checkbox mt-0.5"
            checked={withContent}
            onChange={(e) => { setWithContent((e.target as HTMLInputElement).checked); setSize(null); }}
          />
          <span>
            <span class="text-primary">{t('aiAssistant.withContent')}</span>
            <span class="block text-xs text-dim leading-relaxed">{t('aiAssistant.withContentHint')}</span>
          </span>
        </label>
        <div class="flex gap-2">
          <button class="btn-ghost border border-border flex-1" disabled={preparing} onClick={() => { void copy(); }}>
            {copied ? t('aiAssistant.copied') : t('aiAssistant.copy')}
          </button>
          <button class="btn-ghost border border-border flex-1" disabled={preparing} onClick={() => { void download(); }}>
            {t('aiAssistant.download')}
          </button>
        </div>
        <p class="text-xs text-dim leading-relaxed">
          {preparing ? t('aiAssistant.preparing')
            : size !== null ? t('aiAssistant.size', { chars: size.toLocaleString(), tokens: Math.round(size / 4).toLocaleString() })
            : t('aiAssistant.howTo')}
        </p>
      </section>

      {/* ── 2. Paste and verify ── */}
      <section class="space-y-2">
        <h3 class="section-title">{t('aiAssistant.step2')}</h3>
        <textarea
          class="input text-xs font-mono min-h-[7rem] resize-y"
          placeholder={t('aiAssistant.answerPlaceholder')}
          value={answer}
          onInput={(e) => changeAnswer((e.target as HTMLTextAreaElement).value)}
        />
        <div class="flex gap-2">
          <label class="btn-ghost border border-border flex-1 text-center cursor-pointer">
            {t('aiAssistant.loadFile')}
            <input
              type="file"
              accept=".json,.md,.txt,application/json,text/plain,text/markdown"
              class="hidden"
              onChange={(e) => { const input = e.target as HTMLInputElement; void loadFile(input.files?.[0]); input.value = ''; }}
            />
          </label>
          <button class="btn-primary flex-1" disabled={busy !== null || !answer.trim()} onClick={() => { void verify(); }}>
            {busy === 'verify' ? t('aiAssistant.verifying') : t('aiAssistant.verify')}
          </button>
        </div>
        {progress && <p class="text-xs text-dim">{progress}</p>}

        {errors && (
          <div class="space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-3">
            <p class="text-danger font-medium">
              {t(errors.length === 1 ? 'aiAssistant.errorsTitle' : 'aiAssistant.errorsTitlePlural', { count: errors.length })}
            </p>
            <ul class="space-y-1 text-xs text-primary list-disc pl-4">
              {errors.map((e, i) => <li key={i} class="break-words">{errorText(e)}</li>)}
            </ul>
            <button
              class="btn-ghost text-xs px-2"
              onClick={() => {
                void copyText(errors.map(errorText).join('\n')).then(ok => {
                  if (ok) { setErrorsCopied(true); setTimeout(() => setErrorsCopied(false), 2000); }
                });
              }}
            >
              {errorsCopied ? t('aiAssistant.copied') : t('aiAssistant.copyErrors')}
            </button>
          </div>
        )}

        {verified && <SummaryView summary={verified.summary} />}
      </section>

      {/* ── 3. Back up, then apply ── */}
      {verified && verified.summary.changes.length + verified.summary.reviewsAdded + verified.summary.reviewsRemoved > 0 && (
        <section class="space-y-2">
          <h3 class="section-title">{t('aiAssistant.step3')}</h3>
          {done ? (
            <p class="text-success">{t('aiAssistant.done')}</p>
          ) : (
            <>
              <p class="text-muted leading-relaxed">{t('aiAssistant.backupHint')}</p>
              <button class="btn-ghost border border-border w-full" disabled={busy !== null} onClick={() => { void backup(); }}>
                {t('aiAssistant.backup')}
              </button>
              {backupLaunched && (
                <label class="flex items-center gap-2 cursor-pointer select-none text-primary">
                  <input type="checkbox" class="card-checkbox" checked={kept} onChange={(e) => setKept((e.target as HTMLInputElement).checked)} />
                  <span>{t('aiAssistant.backupKept')}</span>
                </label>
              )}
              {stale && <p class="text-xs text-danger">{t('aiAssistant.stale')}</p>}
              <button
                class={`${hasDeletions(verified.summary) ? 'btn-danger' : 'btn-primary'} w-full`}
                disabled={!kept || busy !== null || stale}
                onClick={() => { void apply(verified); }}
              >
                {busy === 'apply' ? t('aiAssistant.applying') : t('aiAssistant.apply')}
              </button>
            </>
          )}
        </section>
      )}
      {done && (
        <div class="flex justify-end">
          <button class="btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      )}
    </div>
  );
}

/** What the answer will change, deletions in red. */
function SummaryView({ summary }: { summary: Summary }) {
  const total = summary.changes.length + summary.reviewsAdded + summary.reviewsRemoved;
  if (total === 0) return <p class="text-muted">{t('aiAssistant.nothing')}</p>;
  const fieldList = (fields: string[]) => fields.map(f => t(`aiAssistant.field.${f}`)).join(', ');
  return (
    <div class="space-y-2 rounded-lg border border-border bg-elevated p-3">
      <p class="text-primary font-medium">{t('aiAssistant.summaryTitle')}</p>
      <ul class="space-y-1 text-xs list-disc pl-4">
        {summary.changes.map(c => {
          let line = t(`aiAssistant.change.${c.kind}.${c.action}`, { name: c.name });
          if (c.action === 'update' && c.fields.length) line += ` (${fieldList(c.fields)})`;
          if (c.lostReviews) line += t(c.lostReviews === 1 ? 'aiAssistant.lostReviews' : 'aiAssistant.lostReviewsPlural', { count: c.lostReviews });
          if (c.lostDecks?.length) line += t('aiAssistant.lostDecks', { list: c.lostDecks.join(', ') });
          return <li key={`${c.kind}:${c.id}`} class={`break-words ${c.action === 'delete' ? 'text-danger' : 'text-primary'}`}>{line}</li>;
        })}
        {summary.reviewsAdded > 0 && <li class="text-primary">{t('aiAssistant.reviewsAdded', { count: summary.reviewsAdded })}</li>}
        {summary.reviewsRemoved > 0 && <li class="text-danger">{t('aiAssistant.reviewsRemoved', { count: summary.reviewsRemoved })}</li>}
      </ul>
    </div>
  );
}

export function showAiAssistant(): void {
  const body = renderModalBody(<AiAssistant onClose={closeModal} />);
  showModal(t('aiAssistant.title'), body.el, [], { maxWidth: '40rem', onDismiss: body.cleanup });
}
