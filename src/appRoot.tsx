import { render } from 'preact';
import { useRef, useLayoutEffect } from 'preact/hooks';
import { getContext, routeSignal } from './store';
import { renderSidebar } from './components/sidebar';
import { FolderView } from './views/folder';
import { DeckView } from './views/deck';
import { CardView } from './views/card';
import { LibraryView } from './views/library';
import { StudyView } from './views/study';

// Routes to the appropriate Preact component.
// key= on stateful views forces a remount when the ID changes (resets local state).
function ContentSwitch() {
  const route = routeSignal.value;
  if (route.view === 'study')   return <StudyView deckId={route.deckId} strategy={route.strategy} currentCardId={route.currentCardId} />;
  if (route.view === 'deck')    return <DeckView   key={route.deckId}   deckId={route.deckId} />;
  if (route.view === 'library') return <LibraryView />;
  if (route.view === 'card')    return <CardView   key={route.cardId}   cardId={route.cardId} />;
  if (route.view === 'folder')  return <FolderView key={route.folderId ?? 'root'} folderId={route.folderId} />;
  const _: never = route; return _;
}

function AppRoot() {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const ctx = getContext();

  useLayoutEffect(() => {
    sidebarRef.current!.replaceChildren(renderSidebar(ctx));
  });

  return (
    <div class="flex flex-1 overflow-hidden">
      <div ref={sidebarRef} class="shrink-0 flex overflow-hidden" />
      <main class="flex-1 overflow-hidden bg-bg">
        <ContentSwitch />
      </main>
    </div>
  );
}

export function mountApp(root: HTMLElement): void {
  root.innerHTML = '';
  render(<AppRoot />, root);
}
