self.addEventListener('push', function (event) {
  let data = { title: 'FidélyPass', body: 'Nouvelle notification' };
  try { data = event.data.json(); } catch (e) {}

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [100, 50, 100]
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function (clientList) {
      if (clientList.length > 0) return clientList[0].focus();
      return clients.openWindow('/');
    })
  );
});
