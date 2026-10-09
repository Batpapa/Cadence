// The Cadence mark, on its own: the welcome screen draws it, and so does the
// app's update screen (native/updateOverlay.tsx), which starts before the rest
// of the app is loaded.

// Same three strokes as src/icons/icon.svg, unchanged — the app-icon tile
// (#2a2f34 background) is deliberately NOT shown here, just the mark itself
// on the app's own background. pathLength="1" normalizes each stroke so
// stroke-dasharray:1 / stroke-dashoffset:1→0 (styles.css's markDraw
// animation) works regardless of each path's real length.
const MARK_D = [
  'm 34.938038,224.24193 h 10.133205 c 1.692805,0.10418 2.467388,2.8912 3.546623,2.91329 2.519211,0.059 5.745988,-14.81212 8.23323,-14.69314 4.502632,-0.13544 4.030544,32.52667 8.866558,32.55292 4.826937,0.1718 2.180009,-18.57973 8.106564,-38.88618 4.102301,-11.90735 14.733752,-17.72954 24.461728,-19.40917 10.274454,-1.57623 18.489864,1.90532 26.287504,7.83787',
  'm 98.480177,220.92875 c 0.911732,-3.01425 2.599123,-5.4052 6.607143,-5.32315 5.03033,0.18731 8.56327,3.7084 8.82115,9.29411 0.10954,4.84835 -3.36941,9.73281 -9.25204,10.8233 -6.81755,0.98296 -15.452109,-2.92859 -17.514598,-13.7119 -1.710174,-14.80596 11.955842,-20.09785 18.376398,-20.042 12.17048,0.0505 23.53117,10.26188 23.26864,23.84318 -0.18698,16.28832 -15.16462,23.78684 -23.20916,23.95198 -11.725849,0.41409 -21.101004,-7.15282 -27.113393,-16.75287',
  'm 174.01374,224.85436 h -10.1332 c -1.69281,-0.10418 -2.46739,-2.8912 -3.54663,-2.91329 -2.51921,-0.059 -5.74599,14.81212 -8.23323,14.69314 -4.50263,0.13544 -4.03054,-32.52667 -8.86655,-32.55292 -4.82694,-0.1718 -2.18001,18.57973 -8.10657,38.88618 -4.1023,11.90735 -14.73375,17.72954 -24.46172,19.40917 -10.27446,1.57623 -18.489872,-1.90532 -26.287512,-7.83787',
];

/** Couleur littérale, hors palette applicative — l'accent violet reste
 *  réservé à l'UI (avatars, boutons) ; le cyan #6cf6e9 est la couleur de
 *  marque du logo, volontairement identique quel que soit le thème actif
 *  (light/green ne le retintent pas — comportement voulu pour un logo). */
/** `looping`: erased and drawn again for as long as it is on screen, instead
 *  of drawn once. */
export function CadenceMark({ size = 78, looping = false }: { size?: number; looping?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 154 154"
      class={`cadence-mark block overflow-visible${looping ? ' looping' : ''}`}
      aria-hidden="true"
    >
      <g
        transform="translate(-27.564509,-147.72464)"
        fill="none"
        stroke="#6cf6e9"
        stroke-width="3.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {MARK_D.map(d => <path key={d} d={d} pathLength="1" />)}
      </g>
    </svg>
  );
}
