import { signal } from '@preact/signals';
import type { AppState, AppContext, Route } from './types';
import { emptyState } from './utils';
import { saveUser } from './db';
import { syncToCloud } from './services/driveService';

export const appState    = signal<AppState>(emptyState());
export const routeSignal = signal<Route>({ view: 'folder', folderId: null });
export const canGoBack   = signal(false);
export const canGoForward = signal(false);

const _history: Route[] = [];
const _future:  Route[] = [];

export function navigate(route: Route): void {
  _history.push(routeSignal.value);
  if (_history.length > 50) _history.shift();
  _future.length     = 0;
  routeSignal.value  = route;
  canGoBack.value    = true;
  canGoForward.value = false;
}

export function replaceRoute(route: Route): void {
  routeSignal.value = route;
}

export function goBack(): void {
  const prev = _history.pop();
  if (!prev) return;
  _future.push(routeSignal.value);
  routeSignal.value  = prev;
  canGoBack.value    = _history.length > 0;
  canGoForward.value = true;
}

export function goForward(): void {
  const next = _future.pop();
  if (!next) return;
  _history.push(routeSignal.value);
  routeSignal.value  = next;
  canGoBack.value    = true;
  canGoForward.value = _future.length > 0;
}

export async function mutate(fn: (user: AppState) => void): Promise<void> {
  const next = structuredClone(appState.value);
  fn(next);
  appState.value = next;
  await saveUser(next);
  syncToCloud(next);
}

/** Apply data received from Drive without triggering a sync-back. */
export async function applyFromDrive(fn: (user: AppState) => void): Promise<void> {
  const next = structuredClone(appState.value);
  fn(next);
  appState.value = next;
  await saveUser(next);
}

export async function save(fn: (user: AppState) => void): Promise<void> {
  fn(appState.value);
  await saveUser(appState.value);
  syncToCloud(appState.value);
}

export function getContext(): AppContext {
  return {
    user:         appState.value,
    route:        routeSignal.value,
    navigate,
    back:         goBack,
    forward:      goForward,
    canGoBack:    canGoBack.value,
    canGoForward: canGoForward.value,
    mutate,
    save,
  };
}
