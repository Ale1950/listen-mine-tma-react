// Minimal service worker for Listen & Mine. Does not cache or intercept
// anything — just keeps the app installed so the browser treats this tab
// as a persistent web app (reduces background throttling on some desktop
// browsers). Mining logic stays in the Web Worker + main thread.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through: don't handle fetches. The app reads its assets from the
// network / HTTP cache directly.
self.addEventListener('fetch', () => { /* noop */ });
