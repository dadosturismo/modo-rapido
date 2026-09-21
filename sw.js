const CACHE = 'atendimentos-pwa-v36';
const ARQUIVOS = ['./','./index.html','./rapido/','./rapido/index.html','./app.js','./manifest.webmanifest','./logo.png','./icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => { if (e.request.method === 'GET' && new URL(e.request.url).origin === location.origin) e.respondWith(caches.open(CACHE).then(cache => cache.match(e.request).then(r => r || fetch(e.request)))); });
