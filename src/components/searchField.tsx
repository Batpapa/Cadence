import { useRef } from 'preact/hooks';
import { t } from '../services/i18nService';
import { focusIfDesktop } from '../utils';
import { CrossIcon } from './icons';
import { IconButton } from './ui';

/** A list's search box, with a cross at its end to empty it once something is
 *  typed (user's call, 2026-11-01). Drawn here rather than left to
 *  `type="search"`: the browser's own cross is missing from some browsers and
 *  cannot be styled in the others.
 *
 *  Emptied, the field takes the caret back on a computer only — on a phone the
 *  keyboard would spring up for a field just cleared, not one about to be
 *  typed in. */
export function SearchField({ value, onInput, placeholder, tour }: {
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
  /** The walkthrough's handle on the field itself (data-tour), which is what
   *  its `clear` acts on. */
  tour?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div class="relative flex-1 min-w-0">
      <input
        ref={ref}
        type="text"
        placeholder={placeholder}
        data-tour={tour}
        class="input pr-9"
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
      {/* A 32 px target inside the field's end (a bare 20 px one before);
          emptying a search is redone by typing, so it goes at once. */}
      {value !== '' && (
        <IconButton
          class="absolute right-0.5 top-1/2 -translate-y-1/2"
          label={t('search.clear')}
          onClick={() => { onInput(''); if (ref.current) focusIfDesktop(ref.current); }}
        >
          <CrossIcon size={12} />
        </IconButton>
      )}
    </div>
  );
}
