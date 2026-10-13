import { useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';
import { playbackGain, playbackVolumePercent } from '../services/playbackVolume';

/** Keeps a native <audio> at the app's playback volume (playbackVolume.ts).
 *
 *  Reading the signal during render is what subscribes the component, so a
 *  move of the settings slider re-renders it and the effect applies the new
 *  level. No dependency list on purpose: the element behind the ref can be
 *  mounted later than the component (an <audio> shown once its source has
 *  loaded), and a write of `volume` costs nothing. */
export function useMediaVolume(ref: RefObject<HTMLMediaElement>): void {
  const gain = playbackGain(playbackVolumePercent.value);
  useEffect(() => {
    if (ref.current && ref.current.volume !== gain) ref.current.volume = gain;
  });
}
