const LS_META = 'cadence-meta';

export interface WorkspaceDescriptor {
  id: string;            // = currentUserId of that workspace's AppState
  name: string;          // display name shown in the selector
  ownerGoogleId?: string;
  ownerEmail?: string;   // hint for display only
}

interface CadenceMeta {
  workspaces: WorkspaceDescriptor[];
  lastWorkspaceId?: string;
}

function readRaw(): CadenceMeta {
  try {
    return (JSON.parse(localStorage.getItem(LS_META) ?? 'null') as CadenceMeta | null)
      ?? { workspaces: [] };
  } catch {
    return { workspaces: [] };
  }
}

function write(meta: CadenceMeta): void {
  localStorage.setItem(LS_META, JSON.stringify(meta));
}

export function getWorkspaces(): WorkspaceDescriptor[] {
  return readRaw().workspaces;
}

export function getLastWorkspaceId(): string | undefined {
  return readRaw().lastWorkspaceId;
}

export function setLastWorkspace(id: string): void {
  const meta = readRaw();
  meta.lastWorkspaceId = id;
  write(meta);
}

export function upsertWorkspace(desc: WorkspaceDescriptor): void {
  const meta = readRaw();
  const idx  = meta.workspaces.findIndex(w => w.id === desc.id);
  if (idx >= 0) meta.workspaces[idx] = { ...meta.workspaces[idx], ...desc };
  else          meta.workspaces.push(desc);
  write(meta);
}

export function removeWorkspace(id: string): void {
  const meta = readRaw();
  meta.workspaces = meta.workspaces.filter(w => w.id !== id);
  if (meta.lastWorkspaceId === id) meta.lastWorkspaceId = meta.workspaces[0]?.id;
  write(meta);
}
