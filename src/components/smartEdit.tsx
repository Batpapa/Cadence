import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { appState } from '../store';
import { showModal, renderModalBody, closeModal } from './modal';
import { askIncompleteExport } from './incompleteExportModal';
import { CheckIcon, ClipboardIcon, CopyIcon, FileIcon, HelpIcon, ImportTrayIcon, SaveIcon, UploadIcon, WandIcon, WarningTriangleIcon } from './icons';
import { t } from '../services/i18nService';
import { copyText, copyTextWhenReady, downloadTextFile, toDateStr } from '../utils';
import { inlineExternalAttachments, mutateWithRule } from '../services/attachmentStore';
import { exportBackup } from '../services/importExport';
import { smartView, viewJson } from '../services/smartEdit/view';
import { smartEditInstructions } from '../services/smartEdit/instructions';
import { applyOps, hasDeletions, parseAnswer, prepare, type ApplyContext, type OpError, type Summary } from '../services/smartEdit/ops';
import { fetchExternalCards } from '../services/smartEdit/fetchExternal';
import type { AppState } from '../types';

// ── Smart edit (2026-10-11) ──────────────────────────────────────────────────
// Editing the library with an external tool — a script, an AI. One window,
// opened from Home, in three steps: take the instructions and the data out,
// check the operations that come back, then — once a backup is safely
// downloaded — apply them. The only way into it: the "Generate with an AI" tab
// of the new-card window went with it, several entry points being more to
// maintain.
//
// Instructions and data are taken apart, by decision: a conversation with an
// AI starts with the instructions once, and the data can then be sent again
// after each round without repeating them.
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
  const message = t(`smartEdit.error.${e.code}`, e.params ?? {});
  return e.op === 0 ? message : t('smartEdit.errorLine', { n: e.op, name: e.name ?? '?', message });
}

async function buildData(withContent: boolean): Promise<string | null> {
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
  return viewJson(smartView(state, withContent, cards));
}

/** "Copied!" for two seconds on the button that copied. */
function useFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  return [on, () => { setOn(true); setTimeout(() => setOn(false), 2000); }];
}

function SmartEdit({ onClose }: { onClose: () => void }) {
  const [withContent, setWithContent] = useState(false);
  const [contentHintOpen, setContentHintOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [size, setSize] = useState<number | null>(null);
  const [instructionsCopied, flashInstructions] = useFlash();
  const [dataCopied, flashData] = useFlash();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'verify' | 'apply' | null>(null);
  const [progress, setProgress] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [backupLaunched, setBackupLaunched] = useState(false);
  const [kept, setKept] = useState(false);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState(false);
  const [manualPaste, setManualPaste] = useState(false);
  const [errorsCopied, flashErrors] = useFlash();

  const copyInstructions = async () => {
    if (await copyText(smartEditInstructions())) flashInstructions();
  };
  const downloadInstructions = () => downloadTextFile(smartEditInstructions(), 'cadence-smart-edit-instructions.md', 'text/markdown');

  // The copy has to START within the press, before the data is built
  // (copyTextWhenReady says why).
  const copyData = async () => {
    setPreparing(true);
    try {
      const data = buildData(withContent);
      void data.then(d => { if (d !== null) setSize(d.length); }, () => { /* reported by the copy below */ });
      if (await copyTextWhenReady(data)) flashData();
    } finally {
      setPreparing(false);
    }
  };
  const downloadData = async () => {
    setPreparing(true);
    try {
      const data = await buildData(withContent);
      if (data === null) return;
      setSize(data.length);
      downloadTextFile(data, `cadence-smart-view-${toDateStr(new Date())}.json`, 'application/json');
    } finally {
      setPreparing(false);
    }
  };

  const changeAnswer = (text: string) => {
    setAnswer(text);
    setOutcome(null);
    setBackupLaunched(false);
    setKept(false);
    setStale(false);
    setDone(false);
  };

  /** Operations received — pasted or loaded — are checked at once: there is
   *  nothing to edit them in, so nothing to wait for. */
  const receive = (text: string) => {
    changeAnswer(text);
    void verify(text);
  };

  const loadFile = async (file: File | undefined) => {
    if (file) receive(await file.text());
  };

  // The clipboard read can be refused (a permission prompt on Chromium, the
  // Android app's WebView) or missing: the box to paste into then appears,
  // the way the attachments' paste dialog works everywhere (addFileModal).
  const paste = async () => {
    let text: string | null = null;
    try { text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : null; } catch { text = null; }
    if (text === null) { setManualPaste(true); return; }
    setManualPaste(false);
    receive(text);
  };

  const verify = async (text: string) => {
    setBusy('verify');
    setOutcome(null);
    setStale(false);
    try {
      const parsed = parseAnswer(text);
      if ('error' in parsed) { setOutcome({ errors: [parsed.error] }); return; }
      const base = appState.value;
      const prep = prepare(parsed.ops);
      const ext = await fetchExternalCards(parsed.ops, base, (n, total) => {
        setProgress(total > 0 && n < total ? t('smartEdit.fetching', { done: n, total }) : '');
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
    <div class="space-y-3.5 text-sm">
      <div class="flex items-start gap-3 mb-1">
        <span class="w-8 h-8 rounded-[9px] bg-accent-dim text-accent flex items-center justify-center shrink-0"><WandIcon size={15} /></span>
        <p class="text-muted leading-relaxed">{t('smartEdit.intro')}</p>
      </div>

      {/* ── 0. The instructions ── */}
      <StepCard badge={<FileIcon size={13} />} title={t('smartEdit.instructions')} ext=".md">
        <p class="text-xs text-dim leading-relaxed">{t('smartEdit.instructionsHint')}</p>
        <div class="flex flex-wrap gap-2">
          <button class={`btn-soft ${ACTION} ${instructionsCopied ? 'text-success' : ''}`} onClick={() => { void copyInstructions(); }}>
            {instructionsCopied ? <CheckIcon size={12} /> : <CopyIcon size={13} />}
            {instructionsCopied ? t('smartEdit.copied') : t('smartEdit.copy')}
          </button>
          <button class={`btn-ghost border border-border ${ACTION}`} onClick={downloadInstructions}>
            <ImportTrayIcon size={13} />
            {t('smartEdit.download')}
          </button>
        </div>
      </StepCard>

      {/* ── 1. The data ── */}
      <StepCard badge="1" title={t('smartEdit.stepData')} ext=".json">
        <p class="text-xs text-dim leading-relaxed">{t('smartEdit.dataHint')}</p>
        <div>
          <div class="flex items-center gap-1.5">
            <label class="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                class="card-checkbox"
                checked={withContent}
                onChange={(e) => { setWithContent((e.target as HTMLInputElement).checked); setSize(null); }}
              />
              <span class="text-primary">{t('smartEdit.withContent')}</span>
            </label>
            {/* Outside the label: opening the explanation must not tick the box. */}
            <button
              class={`flex items-center p-0.5 rounded-full transition-colors cursor-pointer shrink-0 ${contentHintOpen ? 'text-accent' : 'text-dim hover:text-primary'}`}
              title={t('settings.explain')}
              aria-expanded={contentHintOpen}
              onClick={() => setContentHintOpen(o => !o)}
            >
              <HelpIcon size={14} />
            </button>
          </div>
          {contentHintOpen && (
            <p class="text-xs text-dim leading-relaxed mt-2 px-3 py-2 rounded-lg border border-border bg-surface">{t('smartEdit.withContentHint')}</p>
          )}
        </div>
        <div class="flex flex-wrap gap-2">
          <button class={`btn-soft ${ACTION} ${dataCopied ? 'text-success' : ''}`} disabled={preparing} onClick={() => { void copyData(); }}>
            {dataCopied ? <CheckIcon size={12} /> : <CopyIcon size={13} />}
            {dataCopied ? t('smartEdit.copied') : t('smartEdit.copy')}
          </button>
          <button class={`btn-ghost border border-border ${ACTION}`} disabled={preparing} onClick={() => { void downloadData(); }}>
            <ImportTrayIcon size={13} />
            {t('smartEdit.download')}
          </button>
        </div>
        {(preparing || size !== null) && (
          <p class="font-mono text-[11px] text-dim leading-relaxed">
            {preparing ? t('smartEdit.preparing')
              : t('smartEdit.size', { chars: size!.toLocaleString() })}
          </p>
        )}
      </StepCard>

      {/* ── 2. The operations, checked as soon as they come in ── */}
      <StepCard badge="2" title={t('smartEdit.step2')}>
        <p class="text-xs text-dim leading-relaxed">{t('smartEdit.answerHint')}</p>
        <div class="flex flex-wrap gap-2">
          <button class={`btn-soft ${ACTION}`} disabled={busy !== null} onClick={() => { void paste(); }}>
            <ClipboardIcon size={13} />
            {t('smartEdit.paste')}
          </button>
          <label class={`btn-ghost border border-border ${ACTION} cursor-pointer`}>
            <UploadIcon size={13} />
            {t('smartEdit.loadFile')}
            <input
              type="file"
              accept=".json,.md,.txt,application/json,text/plain,text/markdown"
              class="hidden"
              onChange={(e) => { const input = e.target as HTMLInputElement; void loadFile(input.files?.[0]); input.value = ''; }}
            />
          </label>
        </div>
        {manualPaste && (
          <div class="space-y-2">
            <p class="text-xs text-dim leading-relaxed">{t('smartEdit.pasteHere')}</p>
            <textarea
              class="input text-xs font-mono min-h-[5rem] resize-y"
              placeholder={t('smartEdit.answerPlaceholder')}
              value={answer}
              onInput={(e) => changeAnswer((e.target as HTMLTextAreaElement).value)}
            />
            <button class="btn-primary w-full" disabled={busy !== null || !answer.trim()} onClick={() => { void verify(answer); }}>
              {t('smartEdit.verify')}
            </button>
          </div>
        )}
        {busy === 'verify' && <p class="text-xs text-dim">{progress || t('smartEdit.verifying')}</p>}

        {errors && (
          <div class="space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-3">
            <p class="text-danger font-medium">
              {t(errors.length === 1 ? 'smartEdit.errorsTitle' : 'smartEdit.errorsTitlePlural', { count: errors.length })}
            </p>
            <ul class="space-y-1 text-xs text-primary list-disc pl-4">
              {errors.map((e, i) => <li key={i} class="break-words">{errorText(e)}</li>)}
            </ul>
            <button
              class="btn-ghost text-xs px-2"
              onClick={() => { void copyText(errors.map(errorText).join('\n')).then(ok => { if (ok) flashErrors(); }); }}
            >
              {errorsCopied ? t('smartEdit.copied') : t('smartEdit.copyErrors')}
            </button>
          </div>
        )}

        {verified && (
          <div class="border-t border-border pt-3">
            <SummaryView summary={verified.summary} />
          </div>
        )}
      </StepCard>

      {/* ── 3. Back up, then apply ── */}
      {verified && verified.summary.changes.length + verified.summary.reviewsAdded + verified.summary.reviewsRemoved > 0 && (
        <StepCard badge="3" title={t('smartEdit.step3')} warn={!done}>
          {done ? (
            <div class="flex items-center gap-2.5 px-3.5 py-3 rounded-[10px] bg-success/[0.08] text-success">
              <span class="w-[22px] h-[22px] rounded-full bg-success/20 flex items-center justify-center"><CheckIcon size={11} /></span>
              <span class="font-medium">{t('smartEdit.done')}</span>
            </div>
          ) : (
            <>
              <div class="flex items-start gap-2.5">
                <span class="text-warn mt-0.5 shrink-0"><WarningTriangleIcon size={14} /></span>
                <p class="text-muted leading-relaxed text-[13px]">{t('smartEdit.backupHint')}</p>
              </div>
              <button
                class={`btn-ghost border border-border w-full ${ACTION} ${backupLaunched ? 'text-success' : ''}`}
                disabled={busy !== null}
                onClick={() => { void backup(); }}
              >
                {backupLaunched ? <CheckIcon size={12} /> : <SaveIcon size={13} />}
                {t('smartEdit.backup')}
              </button>
              {backupLaunched && (
                <label class="flex items-center gap-2 cursor-pointer select-none text-primary">
                  <input type="checkbox" class="card-checkbox" checked={kept} onChange={(e) => setKept((e.target as HTMLInputElement).checked)} />
                  <span>{t('smartEdit.backupKept')}</span>
                </label>
              )}
              {stale && (
                <div class="flex items-center gap-2">
                  <p class="text-xs text-danger flex-1">{t('smartEdit.stale')}</p>
                  <button class="btn-ghost border border-border text-xs px-2 shrink-0" disabled={busy !== null} onClick={() => { void verify(answer); }}>
                    {t('smartEdit.verifyAgain')}
                  </button>
                </div>
              )}
              <button
                class={`${hasDeletions(verified.summary) ? 'btn-danger' : 'btn-primary'} w-full rounded-lg h-[34px]`}
                disabled={!kept || busy !== null || stale}
                onClick={() => { void apply(verified); }}
              >
                {busy === 'apply' ? t('smartEdit.applying') : t('smartEdit.apply')}
              </button>
            </>
          )}
        </StepCard>
      )}
      {done && (
        <div class="flex justify-end">
          <button class="btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      )}
    </div>
  );
}

/** The classes every action button shares, icon on the left of its label.
 *  `flex-1` with a natural basis: a pair wraps onto two lines only when the
 *  window is too narrow for both labels. */
const ACTION = 'flex-1 inline-flex items-center justify-center gap-2 rounded-lg h-[34px] whitespace-nowrap';

/** One step of the window: a numbered (or iconed) badge, a title, the file
 *  type it hands out if any, and its content. `warn` tints the step that
 *  writes to the library. */
function StepCard({ badge, title, ext, warn, children }: {
  badge: ComponentChildren; title: string; ext?: string; warn?: boolean; children: ComponentChildren;
}) {
  return (
    <section class={`rounded-xl border p-4 ${warn ? 'border-warn/25 bg-warn/[0.04]' : 'border-border bg-bg'}`}>
      <div class="flex items-center gap-2.5 mb-3">
        <span class={`w-6 h-6 rounded-[7px] flex items-center justify-center shrink-0 font-mono text-xs font-semibold ${
          warn ? 'bg-warn/15 text-warn' : 'bg-accent-dim text-accent'}`}>{badge}</span>
        <h3 class="text-sm font-medium text-primary flex-1">{title}</h3>
        {ext && <span class="font-mono text-[10.5px] text-dim px-1.5 py-0.5 rounded bg-surface">{ext}</span>}
      </div>
      <div class="space-y-3">{children}</div>
    </section>
  );
}

const MARK = {
  add: { glyph: '+', mark: 'bg-success/[0.12] text-success', text: 'text-primary' },
  update: { glyph: '~', mark: 'bg-accent-dim text-accent', text: 'text-primary' },
  remove: { glyph: '−', mark: 'bg-danger/[0.12] text-danger', text: 'text-danger' },
} as const;

function SummaryLine({ kind, line }: { kind: keyof typeof MARK; line: string }) {
  const m = MARK[kind];
  return (
    <li class="flex items-center gap-2.5">
      <span class={`w-[18px] h-[18px] rounded-[5px] flex items-center justify-center shrink-0 font-mono text-xs font-semibold ${m.mark}`}>{m.glyph}</span>
      <span class={`text-[13px] break-words ${m.text}`}>{line}</span>
    </li>
  );
}

/** What the answer will change: created, updated, deleted, each with its mark. */
function SummaryView({ summary }: { summary: Summary }) {
  const total = summary.changes.length + summary.reviewsAdded + summary.reviewsRemoved;
  if (total === 0) return <p class="text-muted">{t('smartEdit.nothing')}</p>;
  const fieldList = (fields: string[]) => fields.map(f => t(`smartEdit.field.${f}`)).join(', ');
  return (
    <div>
      <p class="text-xs font-medium text-muted mb-2.5">{t('smartEdit.summaryTitle')}</p>
      <ul class="space-y-1.5">
        {summary.changes.map(c => {
          let line = t(`smartEdit.change.${c.kind}.${c.action}`, { name: c.name });
          if (c.action === 'update' && c.fields.length) line += ` (${fieldList(c.fields)})`;
          if (c.lostReviews) line += t(c.lostReviews === 1 ? 'smartEdit.lostReviews' : 'smartEdit.lostReviewsPlural', { count: c.lostReviews });
          if (c.lostDecks?.length) line += t('smartEdit.lostDecks', { list: c.lostDecks.join(', ') });
          const kind = c.action === 'create' ? 'add' : c.action === 'update' ? 'update' : 'remove';
          return <SummaryLine key={`${c.kind}:${c.id}`} kind={kind} line={line} />;
        })}
        {summary.reviewsAdded > 0 && <SummaryLine kind="add" line={t('smartEdit.reviewsAdded', { count: summary.reviewsAdded })} />}
        {summary.reviewsRemoved > 0 && <SummaryLine kind="remove" line={t('smartEdit.reviewsRemoved', { count: summary.reviewsRemoved })} />}
      </ul>
    </div>
  );
}

export function showSmartEdit(): void {
  const body = renderModalBody(<SmartEdit onClose={closeModal} />);
  showModal(t('smartEdit.title'), body.el, [], { maxWidth: '40rem', onDismiss: body.cleanup });
}
