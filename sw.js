self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter((name) => name.startsWith('portfolio-')).map((name) => caches.delete(name)));
    await self.registration.unregister();
    await self.clients.claim();
  })());
});
