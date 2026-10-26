import type { ComponentChildren } from 'preact';
import { t } from '../services/i18nService';
import { FolderIcon, DeckIcon, MusicNoteIcon, ModulesIcon, WaveformIcon, TrendIcon, ArrowRightIcon } from './icons';

// ── What Cadence does, on the welcome screen (2026-10-26) ────────────────────
// Two sections under the user list, as tiles of uneven sizes ("bento", picked
// from mockups): the core first — organising, reviewing, sharing — since
// Cadence is for anything worth remembering; then Irish trad, the TheSession
// connection and the two modules that open without an account (their
// standalone pages, TuneAnalyser/ and Trending/). Those two are the only links
// and the only tinted tiles, so that what can be clicked shows at a glance.
//
// The pictures are drawings of the app, not screenshots: the same icons, the
// knowledge bar's four colours, a forgetting curve. Examples ("Reels", the
// share key) are illustrations, never figures about anyone's data.
//
// The brand cyan draws them on the dark theme; on the light ones it would not
// show against white, hence --tour-brand (styles.css).

/** Relative to the app, which sits at the site's root. */
const ANALYSER_URL = 'TuneAnalyser/';
const TRENDING_URL = 'Trending/';

/** A waveform's bars as one path: a drawing, the same every time. */
function wavePath(bars: number, step: number, mid: number, amp: number): string {
  let d = '';
  for (let i = 0; i < bars; i++) {
    const h = 3 + Math.round(Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.43)) * amp) + (i % 4);
    d += `M${3 + i * step} ${mid - h / 2}V${mid + h / 2}`;
  }
  return d;
}
const MODULE_WAVE = wavePath(34, 4, 15, 18);

/** Notes of a reel, two beamed groups, the third note the one playing. */
const NOTES: ReadonlyArray<[number, number]> = [[20, 23], [34, 20], [48, 17], [62, 20], [80, 14], [94, 17], [108, 23]];

function Section({ label, title, children }: { label: string; title: string; children: ComponentChildren }) {
  return (
    <section>
      <span class="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tour-brand)]">{label}</span>
      <h2 class="mt-2 mb-4 text-2xl lg:text-[30px] font-extralight leading-tight tracking-[-0.01em] text-primary text-balance">{title}</h2>
      <div class="grid grid-cols-2 gap-2.5 lg:gap-3">{children}</div>
    </section>
  );
}

function Tile({ wide, class: extra = '', children }: { wide?: boolean; class?: string; children: ComponentChildren }) {
  return (
    <div class={`${wide ? 'col-span-2 ' : ''}rounded-[18px] bg-surface border border-border p-4 ${extra}`}>
      {children}
    </div>
  );
}

function TileTitle({ children }: { children: ComponentChildren }) {
  return <span class="block text-[15px] font-medium leading-snug text-primary">{children}</span>;
}

function TileText({ children }: { children: ComponentChildren }) {
  return <span class="block text-xs leading-relaxed text-muted text-pretty">{children}</span>;
}

/** The card drawn in the "organise" tile: one card, its tags and files, with
 *  two more behind it. */
function CardPile() {
  return (
    <div class="relative w-[128px] h-[124px] shrink-0" aria-hidden="true">
      <div class="absolute top-3 left-4 w-[100px] h-[112px] rounded-[10px] bg-elevated border border-border rotate-[7deg] opacity-60" />
      <div class="absolute top-2 left-2.5 w-[100px] h-[112px] rounded-[10px] bg-elevated border border-border -rotate-[4deg] opacity-80" />
      <div class="absolute top-1.5 left-3 w-[104px] h-[116px] rounded-[10px] bg-elevated border border-border p-2.5 flex flex-col gap-1.5 shadow-lg">
        <span class="text-[11.5px] font-medium leading-tight text-primary">Drowsy Maggie</span>
        <span class="flex flex-wrap gap-[3px]">
          <span class="text-[9.5px] px-1.5 rounded-full bg-accent-dim text-accent">reel</span>
          <span class="text-[9.5px] px-1.5 rounded-full bg-accent-dim text-accent">session</span>
        </span>
        <span class="mt-auto flex items-center gap-1 text-[9.5px] text-dim"><MusicNoteIcon size={10} />{t('welcome.tour.organise.score')}</span>
        <span class="flex items-center gap-1 text-[9.5px] text-dim">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
          {t('welcome.tour.organise.video')}
        </span>
      </div>
    </div>
  );
}

/** Reviews spaced out: memory fades, a review brings it back, and each time
 *  it lasts longer before reaching the mastery threshold. */
function ForgettingCurve() {
  return (
    <svg viewBox="0 0 318 78" class="w-full h-auto" aria-hidden="true">
      <line x1="2" y1="74" x2="316" y2="74" class="stroke-border" />
      <line x1="2" y1="40" x2="316" y2="40" class="stroke-dim" stroke-opacity="0.5" stroke-dasharray="3 4" />
      <g fill="none" stroke-width="2" stroke-linecap="round" class="stroke-accent">
        <path d="M4 8 C 16 22, 30 34, 46 40" />
        <path d="M46 8 C 76 20, 104 34, 132 40" />
        <path d="M132 8 C 196 16, 258 30, 314 37" />
      </g>
      <g stroke-width="1" stroke-dasharray="2 3" class="stroke-[color:var(--tour-brand)]">
        <path d="M46 40 V 8" />
        <path d="M132 40 V 8" />
      </g>
      <circle cx="46" cy="8" r="3.5" class="fill-[color:var(--tour-brand)]" />
      <circle cx="132" cy="8" r="3.5" class="fill-[color:var(--tour-brand)]" />
    </svg>
  );
}

/** The knowledge bar, as decks show it. */
function KnowledgeBar() {
  return (
    <div class="flex gap-0.5 h-1.5" aria-hidden="true">
      <span class="rounded-[3px] bg-danger" style="flex:10" />
      <span class="rounded-[3px] bg-warn" style="flex:16" />
      <span class="rounded-[3px] bg-accent" style="flex:28" />
      <span class="rounded-[3px] bg-success" style="flex:46" />
    </div>
  );
}

/** A share key, as the share window gives it. */
function ShareKey() {
  return (
    <span class="flex gap-[3px] font-mono text-[13px] font-medium text-primary" aria-hidden="true">
      {'K7Q2XM'.split('').map((c, i) => (
        <span key={i} class={`w-5 h-[26px] rounded-[5px] bg-elevated border flex items-center justify-center ${i === 5 ? 'border-[color:var(--tour-brand)]' : 'border-border'}`}>{c}</span>
      ))}
    </span>
  );
}

/** A TheSession tune once imported: its card, its score. */
function ImportedTune() {
  return (
    <div class="w-[136px] shrink-0 rounded-[10px] bg-elevated border border-border p-2.5" aria-hidden="true">
      <div class="text-[11.5px] font-medium text-primary">Drowsy Maggie</div>
      <div class="text-[9.5px] text-dim">Reel · Edor · thesession.org</div>
      <svg viewBox="0 0 118 38" class="mt-1.5 block w-[118px] h-[38px]">
        <path d="M0 8H118M0 14H118M0 20H118M0 26H118M0 32H118" class="stroke-border" stroke-width="0.8" />
        {NOTES.map(([x, y], i) => (
          <ellipse key={x} cx={x} cy={y} rx="3.2" ry="2.3" transform={`rotate(-20 ${x} ${y})`} class={i === 2 ? 'fill-[color:var(--tour-brand)]' : 'fill-muted'} />
        ))}
        <path d="M23 22V4M37 19V4M51 16V4M65 19V4M83 13V2M97 16V2M111 22V2" class="stroke-muted" stroke-width="0.9" />
        <path d="M23 4.5H65M83 2.5H111" class="stroke-muted" stroke-width="2.2" />
      </svg>
      <div class="mt-0.5 flex items-center gap-1 text-[9.5px] text-accent">
        <svg viewBox="0 0 24 24" width="9" height="9" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
        {t('welcome.tour.thesession.playable')}
      </div>
    </div>
  );
}

/** One of the modules that open here without an account: the whole tile is
 *  the link, to the module's standalone page. */
function ModuleTile({ href, icon, name, text, picture }: {
  href: string; icon: ComponentChildren; name: string; text: string; picture: ComponentChildren;
}) {
  return (
    <a
      href={href}
      class="group flex flex-col gap-1.5 min-h-[196px] rounded-[18px] p-3.5 bg-accent-dim border border-accent/45 hover:border-accent transition-colors text-primary no-underline"
      title={t('welcome.tour.try')}
    >
      <span class="flex items-center justify-between">
        <span class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-[color:var(--tour-brand)] bg-surface">{icon}</span>
        <span class="w-7 h-7 rounded-full bg-accent text-bg flex items-center justify-center transition-transform group-hover:translate-x-0.5">
          <ArrowRightIcon size={14} />
        </span>
      </span>
      <span class="mt-1.5 text-sm font-medium leading-snug">{name}</span>
      <TileText>{text}</TileText>
      <span class="mt-auto pt-1 text-[color:var(--tour-brand)] opacity-80" aria-hidden="true">{picture}</span>
    </a>
  );
}

export function WelcomeTour() {
  return (
    <div class="welcome-tour w-full flex flex-col gap-12">
      <Section label={t('welcome.tour.core.label')} title={t('welcome.tour.core.title')}>
        <Tile wide class="flex gap-2.5 min-h-[172px]">
          <div class="flex-1 min-w-0 flex flex-col gap-1.5">
            <TileTitle>{t('welcome.tour.organise.title')}</TileTitle>
            <TileText>{t('welcome.tour.organise.text')}</TileText>
            <span class="mt-auto flex flex-wrap gap-1" aria-hidden="true">
              <span class="inline-flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded-full border border-border text-muted">
                <FolderIcon size={10} />{t('welcome.tour.organise.folder')}
              </span>
              <span class="inline-flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded-full border border-border text-muted">
                <span class="flex text-[color:var(--tour-brand)]"><DeckIcon size={10} /></span>Reels
              </span>
            </span>
          </div>
          <CardPile />
        </Tile>

        <Tile wide class="flex flex-col gap-2.5">
          <div class="flex items-baseline justify-between gap-2.5">
            <TileTitle>{t('welcome.tour.review.title')}</TileTitle>
            <span class="text-[10.5px] text-dim whitespace-nowrap">{t('welcome.tour.review.scale')}</span>
          </div>
          <ForgettingCurve />
          <TileText>{t('welcome.tour.review.text')}</TileText>
          <KnowledgeBar />
        </Tile>

        <Tile class="flex flex-col gap-2">
          <span class="text-sm font-medium leading-snug text-primary">{t('welcome.tour.strategies.title')}</span>
          <span class="mt-0.5 flex flex-col gap-1.5">
            {(['optimal', 'stochastic', 'sequential', 'random'] as const).map((s, i) => (
              <span key={s} class={`text-[11px] px-2 py-1 rounded-lg border ${i === 0 ? 'bg-accent-dim border-accent/40 text-accent' : 'border-border text-muted'}`}>
                {t(`deck.strategy.${s}`)}
              </span>
            ))}
          </span>
        </Tile>

        <Tile class="flex flex-col gap-2">
          <span class="text-sm font-medium leading-snug text-primary">{t('welcome.tour.share.title')}</span>
          <ShareKey />
          <TileText>{t('welcome.tour.share.text')}</TileText>
        </Tile>
      </Section>

      <Section label={t('welcome.tour.trad.label')} title={t('welcome.tour.trad.title')}>
        <Tile wide class="flex gap-3">
          <div class="flex-1 min-w-0 flex flex-col gap-1.5">
            <TileTitle>{t('welcome.tour.thesession.title')}</TileTitle>
            <TileText>{t('welcome.tour.thesession.text')}</TileText>
          </div>
          <ImportedTune />
        </Tile>

        {/* The ⊞ the modules sit under in the app, shown here so that it is
            recognised there. */}
        <div class="col-span-2 mt-1.5 flex items-center gap-2 text-xs text-muted">
          <span class="flex text-[color:var(--tour-brand)]"><ModulesIcon size={15} /></span>
          <span><span class="text-primary font-medium">{t('modules.title')}</span> · {t('welcome.tour.modules.hint')}</span>
        </div>

        <ModuleTile
          href={ANALYSER_URL}
          icon={<WaveformIcon size={18} />}
          name={t('sessions.moduleTitle')}
          text={t('welcome.tour.analyser.text')}
          picture={(
            <svg viewBox="0 0 140 30" class="w-full max-w-[140px] h-[30px]">
              <path d={MODULE_WAVE} stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          )}
        />
        <ModuleTile
          href={TRENDING_URL}
          icon={<TrendIcon size={18} />}
          name={t('trending.moduleTitle')}
          text={t('welcome.tour.trending.text')}
          picture={(
            <svg viewBox="0 0 140 30" class="w-full max-w-[140px] h-[30px]">
              <polyline points="2,27 22,26 42,25 62,23 82,20 102,15 122,9 138,3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            </svg>
          )}
        />
      </Section>
    </div>
  );
}
