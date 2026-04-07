document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('search-input');
  const bookmarkList = document.getElementById('bookmark-list');
  const emptyState = document.getElementById('empty-state');
  const statsEl = document.getElementById('stats');
  const settingsBtn = document.getElementById('settings-btn');
  const setupPrompt = document.getElementById('setup-prompt');
  const setupBtn = document.getElementById('setup-btn');

  const digestBtn = document.getElementById('digest-btn');
  const digestStatus = document.getElementById('digest-status');

  let allBookmarks = [];

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  setupBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  digestBtn.addEventListener('click', async () => {
    digestBtn.disabled = true;
    digestBtn.textContent = 'Generating...';
    digestStatus.style.display = 'block';
    digestStatus.className = 'digest-status loading';
    digestStatus.textContent = 'Analyzing bookmarks with AI...';

    try {
      const result = await chrome.runtime.sendMessage({ type: 'GENERATE_DIGEST' });
      if (result?.success) {
        digestStatus.className = 'digest-status success';
        digestStatus.textContent = `Digest generated: ${result.count} bookmarks from ${result.date}`;
      } else {
        digestStatus.className = 'digest-status error';
        digestStatus.textContent = result?.error || 'Failed to generate digest';
      }
    } catch (e) {
      digestStatus.className = 'digest-status error';
      digestStatus.textContent = 'Error: ' + e.message;
    }

    digestBtn.disabled = false;
    digestBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> Digest`;

    setTimeout(() => { digestStatus.style.display = 'none'; }, 5000);
  });

  searchInput.addEventListener('input', () => {
    renderBookmarks(filterBookmarks(searchInput.value));
  });

  checkSetup();
  loadBookmarks();

  async function checkSetup() {
    const result = await chrome.storage.sync.get('settings');
    if (!result.settings?.configured) {
      setupPrompt.style.display = 'block';
    }
  }

  async function loadBookmarks() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_BOOKMARKS' });
    const bookmarks = response?.bookmarks || {};

    allBookmarks = Object.values(bookmarks).sort((a, b) => {
      return new Date(b.savedAt) - new Date(a.savedAt);
    });

    statsEl.textContent = `${allBookmarks.length} bookmark${allBookmarks.length !== 1 ? 's' : ''} saved`;
    renderBookmarks(allBookmarks);
  }

  function filterBookmarks(query) {
    if (!query) return allBookmarks;
    const q = query.toLowerCase();
    return allBookmarks.filter(b => {
      return (
        b.text?.toLowerCase().includes(q) ||
        b.author?.toLowerCase().includes(q) ||
        b.handle?.toLowerCase().includes(q) ||
        b.tags?.some(t => t.toLowerCase().includes(q)) ||
        b.category?.toLowerCase().includes(q) ||
        b.summary?.toLowerCase().includes(q)
      );
    });
  }

  function renderBookmarks(bookmarks) {
    if (bookmarks.length === 0) {
      emptyState.style.display = 'block';
      const cards = bookmarkList.querySelectorAll('.bookmark-card');
      cards.forEach(c => c.remove());
      return;
    }

    emptyState.style.display = 'none';
    bookmarkList.innerHTML = '';

    for (const bookmark of bookmarks) {
      const card = createBookmarkCard(bookmark);
      bookmarkList.appendChild(card);
    }
  }

  function createBookmarkCard(bookmark) {
    const card = document.createElement('div');
    card.className = 'bookmark-card';

    const dateStr = formatDate(bookmark.savedAt);

    const sourceLabel = bookmark.source === 'linkedin' ? 'in' : '𝕏';
    const sourceClass = bookmark.source === 'linkedin' ? 'source-linkedin' : 'source-twitter';

    card.innerHTML = `
      <div class="bookmark-header">
        <span class="bookmark-source ${sourceClass}">${sourceLabel}</span>
        <span class="bookmark-author">${escapeHtml(bookmark.author)}</span>
        <span class="bookmark-handle">@${escapeHtml(bookmark.handle)}</span>
        <span class="bookmark-date">${dateStr}</span>
      </div>
      ${bookmark.summary ? `<div class="bookmark-summary">${escapeHtml(bookmark.summary)}</div>` : `<div class="bookmark-text">${escapeHtml(bookmark.text)}</div>`}
      <div class="bookmark-meta">
        ${bookmark.category ? `<span class="category">${escapeHtml(bookmark.category)}</span>` : ''}
        ${bookmark.tags?.length ? bookmark.tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('') : ''}
      </div>
      <div class="bookmark-actions">
        <button class="open-btn" title="Open on X">Open</button>
        <button class="obsidian-btn" title="Open in Obsidian">Obsidian</button>
        <button class="resync-btn" title="Re-download .md file">Re-save</button>
        <button class="delete-btn" title="Delete bookmark">Delete</button>
      </div>
    `;

    card.querySelector('.open-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: bookmark.url });
    });

    card.querySelector('.obsidian-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'OPEN_IN_OBSIDIAN', id: bookmark.id });
    });

    card.querySelector('.resync-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'RESYNC_TO_OBSIDIAN', id: bookmark.id });
    });

    card.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ type: 'DELETE_BOOKMARK', id: bookmark.id });
      loadBookmarks();
    });

    card.addEventListener('click', () => {
      chrome.tabs.create({ url: bookmark.url });
    });

    return card;
  }

  function formatDate(dateStr) {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diff = now - d;

      if (diff < 60000) return 'Just now';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
      if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;

      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
});
