import { useEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import { t } from '../services/i18nService';
import {
  dateFormatPref, dateOrder, dateSeparator, uses12Hour, fieldValueText, parseFieldText, type DateFormat,
} from '../services/dateFormat';
import { CalendarFieldIcon } from './icons';

// ── A date field that writes dates the way the setting says ─────────────────
// A native <input type="date"> shows dates in the BROWSER's convention, and
// nothing lets a page change that (2026-10-13: no standard for it, confirmed by
// Chrome's own engineers). With a date format in the settings, the fields then
// disagreed with every other date on screen — the user's complaint.
//
// So: a text field, in the format, that reads what is typed when it is left
// (or on Enter); and the browser's calendar still there behind a button, opened
// with showPicker() on a native field kept invisible under it. The calendar is
// the part meant to be replaced later by one drawn by the app (Cally was the
// candidate) without touching how a date is typed. Where showPicker does not
// exist (Safari before 16), the button is not offered and typing is the way.
//
// Values are the native field's own — 'YYYY-MM-DD', or 'YYYY-MM-DDTHH:MM' in
// local time with `withTime` — so a caller swapping one in keeps its logic.

export interface DateFieldProps {
  value: string;
  /** A date was entered (typed then left, or picked). Return false to refuse
   *  it: the field goes back to showing `value`. */
  onChange: (value: string) => boolean | void;
  withTime?: boolean;
  /** Same shape as `value`; a date outside is refused without asking. */
  min?: string;
  max?: string;
  /** Whether "no date" is a value this field can hold. Default true: emptied
   *  (typed away, or the calendar's Clear) it gives ''. False for a date that
   *  must exist — a review has a moment, a period has two ends: an empty
   *  field, the calendar's Clear included, goes back. */
  allowEmpty?: boolean;
  /** Classes of the text field itself. */
  class?: string;
  title?: string;
}

const canShowPicker = typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype;

/** "dd/mm/yyyy hh:mm AM/PM" — the shape to type, in the letters of the
 *  interface's language. */
function placeholderFor(withTime: boolean, fmt: DateFormat): string {
  const letters = { d: t('dateField.dd'), m: t('dateField.mm'), y: t('dateField.yyyy') };
  const date = dateOrder(fmt).map(p => letters[p]).join(dateSeparator(fmt));
  if (!withTime) return date;
  return `${date} ${t('dateField.hhmm')}${uses12Hour(fmt) ? ' AM/PM' : ''}`;
}

export function DateField({ value, onChange, withTime = false, min, max, allowEmpty = true, class: cls, title }: DateFieldProps) {
  // Read during render, so a change of format redraws every field at once.
  const fmt = dateFormatPref.value;
  const shown = fieldValueText(value, withTime, fmt);
  const [text, setText] = useState(shown);
  // True from the first keystroke until the field is left: while someone is
  // typing, nothing from outside overwrites what they typed.
  const typing = useRef(false);
  useEffect(() => { if (!typing.current) setText(shown); }, [shown]);
  const nativeRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);

  /** The border goes red and fades back (styles.css, .date-field-refused):
   *  what was typed did not take, and the field going back to the old date
   *  would otherwise look like nothing happened at all. Restarted on every
   *  refusal, even one during the previous fade. Straight on the element
   *  rather than through a render: Preact leaves a class it did not set alone
   *  as long as the `class` prop itself does not change. */
  const flashRefused = (): void => {
    const el = frameRef.current;
    if (!el) return;
    el.classList.remove('date-field-refused');
    void el.offsetWidth; // a reflow, so the animation starts again from red
    el.classList.add('date-field-refused');
    el.addEventListener('animationend', () => el.classList.remove('date-field-refused'), { once: true });
  };

  /** Offers a value to the caller; true when it is the field's value now. */
  const offer = (next: string): boolean => {
    if (next !== '' && ((min && next < min) || (max && next > max))) return false;
    if (next === value) return true;
    return onChange(next) !== false;
  };

  /** What `typed` reads as, or null when it cannot be entered: not a date,
   *  outside min/max, or empty where the field may not be. The caller can
   *  still refuse a readable one (offer), but every rule it has passed down
   *  as min/max is known here, which is what the live red border goes by. */
  const readable = (typed: string): string | null => {
    const trimmed = typed.trim();
    if (trimmed === '') return allowEmpty ? '' : null;
    const next = parseFieldText(trimmed, withTime, fmt);
    if (next === null || (min && next < min) || (max && next > max)) return null;
    return next;
  };

  const commit = () => {
    if (!typing.current) return;
    typing.current = false;
    const next = readable(text);
    // Rewritten in the format either way: what was typed as "1.2.26" reads
    // back as 01/02/2026, and a refusal shows the date still in force.
    if (next !== null && offer(next)) { setText(fieldValueText(next, withTime, fmt)); return; }
    setText(shown);
    flashRefused();
  };

  // Red for as long as what is in the field could not be entered — while it is
  // being typed (the user's rule, 2026-10-13). Leaving it then puts the date
  // back and fades the red out (flashRefused). Inline, so it wins over the
  // focus colour of the frame.
  const invalidNow = typing.current && readable(text) === null;

  const placeholder = placeholderFor(withTime, fmt);
  const textRef = useRef<HTMLInputElement>(null);
  return (
    // Drawn like the native field it replaces (the user's ask, 2026-10-13):
    // the caller's classes — border, background, padding, width — go on this
    // frame, the text sits in it borderless, and the calendar icon is INSIDE
    // at the right, in the text's colour. A click on the frame's padding
    // lands in the text, as it does on a native field.
    <span
      ref={frameRef}
      class={`${cls ?? ''} relative inline-flex items-center gap-2 cursor-text focus-within:border-accent`}
      style={invalidNow ? { borderColor: 'var(--color-danger)' } : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) { e.preventDefault(); textRef.current?.focus(); }
      }}
    >
      <input
        ref={textRef}
        type="text"
        class="flex-1 min-w-0 px-0 py-px border-0 bg-transparent outline-none text-inherit placeholder-dim"
        style={{ font: 'inherit' }}
        value={text}
        placeholder={placeholder}
        title={title}
        // Wide enough for the shape it asks for: + 2 lands on the native field's
        // width, measured beside it (155 px against 158).
        size={Math.max(placeholder.length, shown.length) + 2}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => { typing.current = true; setText((e.target as HTMLInputElement).value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          // Undoes the typing. Marked handled only when there was some, so a
          // second Escape still closes the dialog around the field.
          if (e.key === 'Escape' && typing.current) { e.preventDefault(); typing.current = false; setText(shown); }
        }}
      />
      {canShowPicker && <>
          <button
            type="button"
            // Sized in em, like the native icon, which follows the field's
            // text size: small in the library's filter, larger in a form.
            class="shrink-0 flex items-center text-primary opacity-90 hover:opacity-100 cursor-pointer [&>svg]:w-[1.1em] [&>svg]:h-[1.1em]"
            // Not a tab stop, like the native icon: the keyboard types the date.
            tabIndex={-1}
            title={t('dateField.calendar')}
            // Inside the click: showPicker refuses to run without a gesture.
            onClick={() => { try { nativeRef.current?.showPicker(); } catch { /* not allowed here: typing still works */ } }}
          >
            <CalendarFieldIcon />
          </button>
          {/* Laid over the WHOLE frame, invisible and untouchable, rather than
              display:none: the browser anchors its calendar on this field — a
              field that is not rendered has no place to anchor it, and Chrome
              refuses to open it. Over the whole frame and not just the icon
              (the first version), so the calendar opens where the native
              field's did: under the field, from its left edge. */}
          <input
            ref={nativeRef}
            type={withTime ? 'datetime-local' : 'date'}
            tabIndex={-1}
            aria-hidden="true"
            // Over the border too (-inset-px): the box a native field anchors on is
            // its border box, and the frame's border is where the caller drew it.
            class="absolute -inset-px opacity-0 pointer-events-none"
            value={value}
            min={min}
            max={max}
            onChange={(e) => {
              // '' is the calendar's Clear — and was ignored until 2026-10-13,
              // which made that button do nothing. Chrome offers it on every
              // field, `required` or not (tried: nothing hides it), so on a
              // date that must exist it is refused like any other empty
              // entry, red fade included — the user's call over "back to a
              // default".
              const v = (e.target as HTMLInputElement).value;
              typing.current = false;
              if ((v !== '' || allowEmpty) && offer(v)) { setText(fieldValueText(v, withTime, fmt)); return; }
              setText(shown);
              flashRefused();
            }}
          />
      </>}
    </span>
  );
}

/** For a vanilla-built form: mounts a DateField in `host` and keeps it
 *  rendered with the latest value. `unmount` takes the tree down. */
export function mountDateField(
  host: HTMLElement,
  props: Omit<DateFieldProps, 'onChange'> & { onChange?: (value: string) => boolean | void },
): { getValue: () => string; unmount: () => void } {
  let current = props.value;
  const draw = () => render(
    <DateField
      {...props}
      value={current}
      onChange={(v) => {
        if (props.onChange?.(v) === false) return false;
        current = v;
        draw();
        return true;
      }}
    />,
    host,
  );
  draw();
  return { getValue: () => current, unmount: () => render(null, host) };
}
