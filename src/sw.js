const CACHE = 'cadence-v2';

// The SPA shell. Resolved against the SW scope, so it is the same URL the
// manifest's start_url ("./") points at. Deliberately NOT a list of bundle
// filenames: those are contenthashed at build time and unknowable here — the
// cache-first branch below picks them up on first request instead.
const SHELL = new URL('./', self.location).href;

self.addEventListener('install', e => {
  // Precache the shell and the assets it boots from, rather than waiting for a
  // later navigation to warm them. This is what makes the *first* visit enough:
  // a worker only starts controlling the page after it activates, so the very
  // first load's bundle/CSS requests bypass the fetch handler below entirely and
  // would otherwise never be cached. `cache: 'reload'` bypasses the HTTP cache
  // so we store the freshly deployed document, not a stale one.
  e.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      const res = await fetch(new Request(SHELL, { cache: 'reload' }));
      if (res.ok) {
        await cache.put(SHELL, res.clone());
        // The bundle and stylesheet are contenthashed at build time, so read
        // their names out of the markup we just fetched instead of hardcoding
        // a list that would go stale on every deploy. Lazily-loaded chunks and
        // the wasm blobs are deliberately left out — they are large and only
        // some users ever reach them; the cache-first branch below picks up
        // whichever ones actually get requested.
        const html = await res.text();
        const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)|manifest\.json)"/g)]
          .map(m => new URL(m[1], SHELL).href)
          .filter(u => u.startsWith(self.location.origin));
        await cache.addAll(assets);
        await Promise.all(assets.filter(u => u.endsWith('.css')).map(async href => {
          // Font files are only requested once a glyph in their unicode-range
          // is actually painted, so a face the user never happened to see
          // while online (the monospace one, typically) would be missing
          // offline. Precache the latin subsets from the stylesheet — the ones
          // essentially every user needs — and leave the cyrillic/greek/
          // vietnamese ones, plus the legacy .woff fallbacks, to be fetched on
          // demand. Any browser with a service worker supports woff2.
          const css = await (await cache.match(href)).text();
          const fonts = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)]
            .map(m => new URL(m[1].replace(/["']/g, ''), href).href)
            .filter(u => /latin/.test(u));
          await cache.addAll([...new Set(fonts)]);
        }));
      }
    } catch { /* installed while offline — the fetch handler warms it later */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Never intercept cross-origin requests (API calls to TheSession, YouTube oEmbed, etc.)
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML and the manifest so updates are picked up immediately,
  // but keep a copy so there is something to boot from when the network is gone.
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.html') || url.pathname.endsWith('manifest.json')) {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(e.request, clone));
          }
          return response;
        })
        .catch(async () => {
          // Exact match first (covers privacy.html / terms.html / manifest.json),
          // then the shell for any in-app URL — the router lives in the client,
          // so every SPA route resolves to the same document. ignoreSearch keeps
          // deep links like ?mode=recovery working offline.
          const exact = await caches.match(e.request, { ignoreVary: true });
          if (exact) return exact;
          if (e.request.mode === 'navigate') {
            const shell = await caches.match(SHELL, { ignoreSearch: true, ignoreVary: true });
            if (shell) return shell;
          }
          return Response.error();
        })
    );
    return;
  }

  // Cache-first for JS, CSS, fonts, icons
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => Response.error());
    })
  );
});
