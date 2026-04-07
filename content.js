// Content script (ISOLATED world) — bridges injected.js ↔ service worker

(function () {
  'use strict';

  const CHANNEL = 'x-bookmarks-to-obsidian';
  const ALLOWED_ORIGINS = ['https://x.com', 'https://twitter.com'];
  const recentIds = new Set();

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!ALLOWED_ORIGINS.includes(event.origin)) return;
    if (!event.data || event.data.channel !== CHANNEL) return;
    if (event.data.type !== 'BOOKMARK_CREATED') return;

    const tweetId = event.data.tweet?.id;
    if (tweetId && recentIds.has(tweetId)) return;
    if (tweetId) {
      recentIds.add(tweetId);
      setTimeout(() => recentIds.delete(tweetId), 5000);
    }

    try {
      if (!chrome?.runtime?.id) throw new Error('invalid');
      await chrome.runtime.sendMessage({
        type: 'BOOKMARK_CREATED',
        tweet: event.data.tweet,
        timestamp: event.data.timestamp,
      });
    } catch (e) {
      if (!document.getElementById('stash-refresh-banner')) {
        const banner = document.createElement('div');
        banner.id = 'stash-refresh-banner';
        banner.innerHTML = `
          <div style="position:fixed;bottom:20px;right:20px;z-index:99999;
            background:#1a1a1a;color:#fff;padding:12px 20px;border-radius:12px;
            font:500 14px -apple-system,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.3);
            display:flex;align-items:center;gap:12px;cursor:pointer"
            onclick="location.reload()">
            <span>Stash updated — click to refresh</span>
          </div>
        `;
        document.body.appendChild(banner);
      }
    }
  });
})();
