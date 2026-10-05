import { registerPlugin, type PermissionState, type PluginListenerHandle } from '@capacitor/core';

/**
 * The app's own native plugin (android/…/LiveNotificationPlugin.java and
 * LiveRecordingService.java): the live analysis's foreground service and its
 * lock-screen notification. Imported dynamically, and only when isNative().
 */
export interface LiveNotificationState {
  title: string;
  text: string;
  /** Recording time so far, pauses excluded — anchors the system chronometer. */
  elapsedMs: number;
  paused: boolean;
  labels: { pause: string; resume: string; stop: string };
  /** The channel's name in Android's notification settings (set once). */
  channelName: string;
}

export type LiveNotificationAction = 'pause' | 'resume' | 'stop';

interface LiveNotificationPlugin {
  show(state: LiveNotificationState): Promise<void>;
  stop(): Promise<void>;
  checkPermissions(): Promise<{ display: PermissionState }>;
  requestPermissions(): Promise<{ display: PermissionState }>;
  addListener(event: 'action', fn: (e: { action: LiveNotificationAction }) => void): Promise<PluginListenerHandle>;
}

export const LiveNotification = registerPlugin<LiveNotificationPlugin>('LiveNotification');
