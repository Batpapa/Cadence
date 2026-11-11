// The shared building blocks of the UI charter (review of 2026-11-11). Each one
// replaces a concept that used to be drawn again on every screen — see the
// classes of the same names in styles.css, which the vanilla-DOM code uses
// directly. Thin on purpose: a component here decides the LOOK, never what the
// control does.
import type { ComponentChildren, JSX } from 'preact';
import { CheckIcon, WarningTriangleIcon, CrossIcon } from './icons';

type ButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'label'>;

/** An icon control: a 32 px target at least (36 `md`, 44 `lg`), whatever is
 *  drawn inside. `label` is required — it is what a screen reader says and the
 *  tooltip a mouse gets; a finger has nothing else to go on but the drawing,
 *  so the drawing must say it too. */
export function IconButton({ label, size = 'sm', variant = 'ghost', on = false, class: cls = '', children, ...rest }: ButtonProps & {
  label: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'outline' | 'danger';
  /** A toggle that is set, or the one action of a row. */
  on?: boolean;
  class?: string;
  children: ComponentChildren;
}) {
  const sizeCls = size === 'md' ? ' icon-btn-md' : size === 'lg' ? ' icon-btn-lg' : '';
  const variantCls = variant === 'outline' ? ' icon-btn-outline' : variant === 'danger' ? ' icon-btn-danger' : '';
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      class={`group icon-btn${sizeCls}${variantCls}${on ? ' icon-btn-on' : ''}${cls ? ' ' + cls : ''}`}
    >
      {children}
    </button>
  );
}

/** An option that is on or off. One drawing for the whole app (the settings'
 *  34 × 18 and the study dialog's 36 × 20 are both gone): 36 × 20, a 16 px
 *  knob, inside a target as tall as every other one. */
export function Switch({ checked, onChange, disabled = false, label }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** For a screen reader when no visible label names it. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      class="inline-flex items-center min-h-8 shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
      onClick={() => onChange(!checked)}
    >
      <span class={`relative inline-flex h-5 w-9 rounded-full border-2 border-transparent transition-colors ${checked ? 'bg-accent' : 'bg-border'}`}>
        <span class={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </span>
    </button>
  );
}

export interface SegmentedOption<V extends string> {
  value: V;
  label?: ComponentChildren;
  icon?: ComponentChildren;
  /** Tooltip and screen-reader name, required when the option is icon-only. */
  title?: string;
  disabled?: boolean;
  tour?: string;
}

/** A choice among a few, side by side. `lg` is the 36 px row of the score
 *  viewer's faces. */
export function Segmented<V extends string>({ value, options, onChange, size = 'sm', class: cls = '' }: {
  value: V;
  options: SegmentedOption<V>[];
  onChange: (v: V) => void;
  size?: 'sm' | 'lg';
  class?: string;
}) {
  return (
    <div role="tablist" class={`seg${size === 'lg' ? ' seg-lg' : ''}${cls ? ' ' + cls : ''}`}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          title={o.title}
          aria-label={o.label ? undefined : o.title}
          disabled={o.disabled}
          data-tour={o.tour}
          class={`seg-btn${o.value === value ? ' seg-btn-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon}{o.label != null && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

/** A row of a dialog that offers a few ways on. The description is always on
 *  screen: it was a tooltip, and a tooltip does not exist under a finger. */
export function ChoiceCard({ icon, label, desc, trailing, tour, onClick, class: cls = '' }: {
  icon: ComponentChildren;
  label: ComponentChildren;
  desc?: ComponentChildren;
  /** What closes the row on the right. Default: nothing (the caller passes
   *  ArrowRightIcon where the row leads to a further step). */
  trailing?: ComponentChildren;
  tour?: string;
  onClick: () => void;
  class?: string;
}) {
  return (
    <button type="button" data-tour={tour} class={`choice-card${cls ? ' ' + cls : ''}`} onClick={onClick}>
      <span class="shrink-0 flex items-center text-accent">{icon}</span>
      <span class="flex-1 min-w-0">
        <span class="block text-sm font-medium text-primary">{label}</span>
        {desc && <span class="block text-xs text-muted mt-0.5 leading-snug">{desc}</span>}
      </span>
      {trailing && <span class="shrink-0 flex items-center text-dim">{trailing}</span>}
    </button>
  );
}

export type StatusTone = 'info' | 'success' | 'warn' | 'error';

const TONE_CLASS: Record<StatusTone, string> = {
  info: 'text-muted',
  success: 'text-success',
  warn: 'text-warn',
  error: 'text-danger',
};

/** A line saying how something went. An error is always red and marked; a
 *  status line that kept its errors grey is what this replaces. */
export function InlineStatus({ tone = 'info', children, class: cls = '' }: {
  tone?: StatusTone;
  children: ComponentChildren;
  class?: string;
}) {
  const icon = tone === 'error' ? <CrossIcon size={12} />
    : tone === 'warn' ? <WarningTriangleIcon size={12} />
    : tone === 'success' ? <CheckIcon size={12} />
    : null;
  return (
    <p role={tone === 'error' ? 'alert' : undefined} class={`flex items-start gap-1.5 text-xs ${TONE_CLASS[tone]}${cls ? ' ' + cls : ''}`}>
      {icon && <span class="shrink-0 flex items-center h-4">{icon}</span>}
      <span class="min-w-0">{children}</span>
    </p>
  );
}

/** What a list says when it has nothing to show. */
export function EmptyState({ children, action, class: cls = '' }: {
  children: ComponentChildren;
  action?: ComponentChildren;
  class?: string;
}) {
  return (
    <div class={`empty-state${cls ? ' ' + cls : ''}`}>
      <p>{children}</p>
      {action && <div class="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/** A labelled figure of a strip of statistics (a deck's, a card's) — the two
 *  pages each had their own identical copy, and they had drifted on the colour
 *  of a zero. */
export function Metric({ label, value, colorClass = 'text-primary' }: {
  label: ComponentChildren;
  value: ComponentChildren;
  colorClass?: string;
}) {
  return (
    <div class="flex items-baseline gap-2">
      <span class="text-2xs font-medium uppercase tracking-wider text-dim">{label}</span>
      <span class={`text-sm font-mono font-semibold ${colorClass}`}>{value}</span>
    </div>
  );
}
