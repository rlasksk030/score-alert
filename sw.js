// OKGU Score Web Push service worker
const SCORE_URL = 'https://script.google.com/macros/s/AKfycbxlX0fc3nSvZE2JmWNNyaG7zQ-BKvUfMGmRdO3qhSmm_mv7lxLJhE_fKMvbeLLF5-Jd/exec';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {
    title: '옥구초 6학년 성적 알림',
    body: '새 성적 결과가 있습니다.',
    url: SCORE_URL,
    tag: 'okgu-score',
    icon: 'okgu_icon.png',
    badgeCount: 1
  };

  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (err) {
    try {
      data.body = event.data ? event.data.text() : data.body;
    } catch (_) {}
  }

  const badgeCount = Math.max(1, Number(data.badgeCount || data.unreadCount || 1) || 1);
  const tasks = [
    self.registration.showNotification(data.title || '옥구초 6학년 성적 알림', {
      body: data.body || '새 성적 결과가 있습니다.',
      icon: data.icon || 'okgu_icon.png',
      badge: data.icon || 'okgu_icon.png',
      tag: data.tag || 'okgu-score',
      renotify: true,
      data: { url: data.url || SCORE_URL }
    })
  ];

  if (self.registration.setAppBadge) {
    tasks.push(self.registration.setAppBadge(badgeCount).catch(() => {}));
  }

  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || SCORE_URL;

  const clearBadge = self.registration.clearAppBadge
    ? self.registration.clearAppBadge().catch(() => {})
    : Promise.resolve();

  event.waitUntil(
    clearBadge
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            client.focus();
            if ('navigate' in client) return client.navigate(url);
            return client;
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
        return undefined;
      })
  );
});
