const $ = id => document.getElementById(id);
let allBookmarks = [];
let filtered = [];
let rendered = 0;
const BATCH = 30;
let currentCategory = 'All';

// ===== INIT =====

// ===== PERMISSION CHECK =====
const permBanner = $('permission-banner');
const reconnectBtn = $('reconnect-btn');

// IndexedDB helpers (same as options.js)
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('social-bookmarks', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveFolderHandle(h) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(h, 'vaultFolder');
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function getFolderHandle() {
  try {
    const db = await openDB();
    return new Promise(r => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get('vaultFolder');
      req.onsuccess = () => r(req.result || null);
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

let permissionOk = false;

async function ensurePermission() {
  const handle = await getFolderHandle();
  if (!handle) return false;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return true;
    // Try silent re-request (works if panel was just opened/interacted)
    const newPerm = await handle.requestPermission({ mode: 'readwrite' });
    return newPerm === 'granted';
  } catch { return false; }
}

async function checkPermission() {
  permissionOk = await ensurePermission();
  permBanner.style.display = permissionOk ? 'none' : 'flex';
}

reconnectBtn.addEventListener('click', async () => {
  // First try re-request on existing handle
  if (await ensurePermission()) {
    permBanner.style.display = 'none';
    permissionOk = true;
    return;
  }
  // Pick new folder
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveFolderHandle(handle);
    permBanner.style.display = 'none';
    permissionOk = true;
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Reconnect failed:', e);
  }
});

// Don't check on load — only show banner when a write actually fails
// checkPermission();

// Listen for file write requests from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'VAULT_PERMISSION_LOST') {
    permBanner.style.display = 'flex';
  }
  if (msg.type === 'WRITE_FILES' && msg.files) {
    writeFiles(msg.files).then(r => sendResponse(r));
    return true;
  }
  if (msg.type === 'READ_WIKI') {
    readWikiFile(msg.folder, msg.filename).then(r => sendResponse(r));
    return true;
  }
});

async function writeFiles(files) {
  const handle = await getFolderHandle();
  if (!handle) return false;

  try {
    if (!await ensurePermission()) return false;

    for (const f of files) {
      let dir = handle;
      if (f.folder) {
        for (const part of f.folder.split('/').filter(Boolean)) {
          dir = await dir.getDirectoryHandle(part, { create: true });
        }
      }
      const fh = await dir.getFileHandle(`${f.filename}.md`, { create: true });
      const writable = await fh.createWritable();
      await writable.write(f.content);
      await writable.close();
    }
    console.log(`[Stash] Wrote ${files.length} files`);
    permissionOk = true;
    permBanner.style.display = 'none';
    return true;
  } catch (e) {
    console.warn('[Stash] Write failed:', e.message);
    permBanner.style.display = 'flex';
    return false;
  }
}

async function readWikiFile(folder, filename) {
  const handle = await getFolderHandle();
  if (!handle) return { success: false };
  try {
    let dir = handle;
    if (folder) {
      for (const part of folder.split('/').filter(Boolean)) {
        dir = await dir.getDirectoryHandle(part);
      }
    }
    const fh = await dir.getFileHandle(`${filename}.md`);
    const file = await fh.getFile();
    const content = await file.text();
    return { success: true, content };
  } catch { return { success: false }; }
}

// On load, drain any pending writes
(async () => {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_PENDING_WRITES' });
    if (r?.files?.length) await writeFiles(r.files);
  } catch {}
})();

// Auto-refresh: read directly from chrome.storage.local
let lastHash = '';
setInterval(async () => {
  try {
    const result = await chrome.storage.local.get('bookmarks');
    const bm = result.bookmarks || {};
    // Hash by count + latest savedAt to detect both new bookmarks and AI updates
    const vals = Object.values(bm);
    const latest = vals.length ? vals.reduce((a, b) => (a.savedAt > b.savedAt ? a : b)).savedAt : '';
    const hash = `${vals.length}-${latest}-${vals.filter(b => b.summary).length}`;
    if (hash !== lastHash) {
      lastHash = hash;
      allBookmarks = vals.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      applyFilters();
    }
  } catch {}
}, 2000);

load();

// ===== TABS =====
document.querySelector('.tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  tab.classList.add('active');
  $(`view-${tab.dataset.tab}`).classList.add('active');
  if (tab.dataset.tab === 'discover') renderDiscover();
  if (tab.dataset.tab === 'settings') loadSettings();
  if (tab.dataset.tab === 'ask') $('ask-input').focus();
});

// ===== SUMMARY DROPDOWN =====
const summaryBtn = $('summary-btn');
const summaryDrop = $('summary-dropdown');
const digestStatus = $('digest-status');
summaryBtn.addEventListener('click', e => { e.stopPropagation(); summaryDrop.classList.toggle('open'); });
document.addEventListener('click', () => summaryDrop.classList.remove('open'));
summaryDrop.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-period]');
  if (!btn) return;
  summaryDrop.classList.remove('open');
  summaryBtn.disabled = true;
  digestStatus.style.display = 'block';
  digestStatus.className = 'status loading';
  digestStatus.textContent = `Generating ${btn.dataset.period} summary...`;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GENERATE_DIGEST', period: btn.dataset.period });
    digestStatus.className = r?.success ? 'status success' : 'status error';
    digestStatus.textContent = r?.success ? `Saved: ${r.filename} (${r.count} bookmarks)` : (r?.error || 'Failed');
  } catch (e) { digestStatus.className = 'status error'; digestStatus.textContent = e.message; }
  summaryBtn.disabled = false;
  setTimeout(() => digestStatus.style.display = 'none', 5000);
});

// ===== SEARCH =====
$('search-input').addEventListener('input', () => applyFilters());

function applyFilters() {
  const q = $('search-input').value.toLowerCase();
  filtered = allBookmarks.filter(b => {
    if (!q) return true;
    return (b.text || '').toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q) ||
      (b.handle || '').toLowerCase().includes(q) ||
      (b.category || '').toLowerCase().includes(q) ||
      (b.summary || '').toLowerCase().includes(q) ||
      (b.tags || []).some(t => t.includes(q));
  });
  filtered.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  renderFeed();
}

// ===== LAZY LOADING =====
const observer = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && rendered < filtered.length) renderBatch();
}, { rootMargin: '200px' });
observer.observe($('sentinel'));

// ===== LOAD =====
async function load() {
  try {
    const result = await chrome.storage.local.get('bookmarks');
    allBookmarks = Object.values(result.bookmarks || {}).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    lastHash = `${allBookmarks.length}-init`;
    applyFilters();
  } catch (e) { console.warn('[Stash] Load failed:', e); }
}

function buildCategoryPills() {
  const counts = {};
  allBookmarks.forEach(b => { const c = b.category || 'Other'; counts[c] = (counts[c] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const pills = $('category-pills');
  pills.innerHTML = `<button class="pill active" data-cat="All">All (${allBookmarks.length})</button>`;
  sorted.forEach(([cat, count]) => {
    pills.innerHTML += `<button class="pill" data-cat="${esc(cat)}">${esc(cat)} (${count})</button>`;
  });
}

// ===== FEED RENDERING =====
function renderFeed() {
  const list = $('feed-list');
  list.querySelectorAll('.date-header,.card').forEach(el => el.remove());
  $('empty-state').style.display = filtered.length ? 'none' : 'flex';
  rendered = 0;
  renderBatch();
}

function renderBatch() {
  const list = $('feed-list');
  const end = Math.min(rendered + BATCH, filtered.length);
  let lastDate = rendered > 0 ? getDateLabel(filtered[rendered - 1].savedAt) : null;

  for (let i = rendered; i < end; i++) {
    const b = filtered[i];
    const dateLabel = getDateLabel(b.savedAt);
    if (dateLabel !== lastDate) {
      const header = document.createElement('div');
      header.className = 'date-header';
      header.textContent = dateLabel;
      list.appendChild(header);
      lastDate = dateLabel;
    }
    list.appendChild(createCard(b));
  }
  rendered = end;
}

function createCard(b) {
  const card = document.createElement('div');
  card.className = 'card';
  const catClass = 'cat-' + (b.category || 'other').toLowerCase().replace(/\s+/g, '-');

  card.innerHTML = `
    <div class="card-top">
      <span class="card-author">${esc(b.author)}</span>
      <span class="card-handle">@${esc(b.handle)}</span>
      <span class="card-time">${ago(b.savedAt)}</span>
      <div class="card-menu">
        <button class="card-menu-btn">···</button>
        <div class="card-dropdown">
          <button class="act-open">Open on X</button>
          <button class="act-resync">Re-save file</button>
          <button class="del act-del">Delete</button>
        </div>
      </div>
    </div>
    ${b.summary ? `<div class="card-summary">${esc(b.summary)}</div>` : ''}
    ${b.text ? `<div class="card-text">${esc(b.text)}</div>` : ''}
    <div class="card-meta">
      ${b.category && b.category !== 'Uncategorized' ? `<span class="cat ${catClass}">${esc(b.category)}</span>` : ''}
      ${(b.tags || []).slice(0, 2).map(t => `<span class="tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}
    </div>
  `;
  // Tags click → search
  card.querySelectorAll('.tag').forEach(tag => {
    tag.addEventListener('click', e => {
      e.stopPropagation();
      $('search-input').value = tag.dataset.tag;
      applyFilters();
    });
  });
  // Category click → search
  const catEl = card.querySelector('.cat');
  if (catEl) {
    catEl.addEventListener('click', e => {
      e.stopPropagation();
      $('search-input').value = catEl.textContent;
      applyFilters();
    });
  }
  // Menu
  const menuBtn = card.querySelector('.card-menu-btn');
  const dropdown = card.querySelector('.card-dropdown');
  menuBtn.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.card-dropdown.open').forEach(d => d.classList.remove('open'));
    dropdown.classList.toggle('open');
  });
  card.querySelector('.act-open').addEventListener('click', e => { e.stopPropagation(); chrome.tabs.create({ url: b.url }); markViewed(b.id); });
  card.querySelector('.act-resync').addEventListener('click', e => { e.stopPropagation(); chrome.runtime.sendMessage({ type: 'RESYNC_TO_OBSIDIAN', id: b.id }); });
  card.querySelector('.act-del').addEventListener('click', e => { e.stopPropagation(); chrome.runtime.sendMessage({ type: 'DELETE_BOOKMARK', id: b.id }); load(); });
  card.addEventListener('click', () => { chrome.tabs.create({ url: b.url }); markViewed(b.id); });
  return card;
}

function markViewed(id) {
  chrome.runtime.sendMessage({ type: 'MARK_VIEWED', id }).catch(() => {});
}

// Close any open menu on outside click
document.addEventListener('click', () => document.querySelectorAll('.card-dropdown.open').forEach(d => d.classList.remove('open')));

// ===== EXPLORE VIEW =====
// ===== DISCOVER VIEW (unified Explore + Insights) =====
async function renderDiscover() {
  const now = new Date();
  const weekAgo = new Date(now - 7 * 86400000);
  const thisWeek = allBookmarks.filter(b => new Date(b.savedAt) >= weekAgo);

  // Stats
  const catCounts = {};
  thisWeek.forEach(b => { const c = b.category || 'Other'; catCounts[c] = (catCounts[c] || 0) + 1; });
  const maxCat = Math.max(...Object.values(catCounts), 1);

  $('stats-card').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
      <div>
        <span style="font:700 28px var(--font)">${thisWeek.length}</span>
        <span style="font:400 12px var(--font);color:var(--t3);margin-left:4px">this week</span>
      </div>
      <span style="font:500 12px var(--font);color:var(--t3)">${allBookmarks.length} total</span>
    </div>
    ${Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cat, count]) => `
      <div class="bar-row">
        <span class="bar-label">${esc(cat)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(count / maxCat * 100)}%"></div></div>
        <span class="bar-count">${count}</span>
      </div>
    `).join('')}
  `;

  // Topics (from topic registry)
  const cats = {};
  allBookmarks.forEach(b => { const c = b.category || 'Other'; cats[c] = (cats[c] || 0) + 1; });
  $('cat-grid').innerHTML = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([cat, count]) =>
    `<div class="cat-card" data-cat="${esc(cat)}">
      <div class="cat-card-name">${esc(cat)}</div>
      <div class="cat-card-count">${count}</div>
    </div>`
  ).join('');
  $('cat-grid').onclick = e => {
    const c = e.target.closest('.cat-card');
    if (!c) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="feed"]').classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $('view-feed').classList.add('active');
    $('search-input').value = c.dataset.cat;
    applyFilters();
  };

  // Authors
  const authors = {};
  allBookmarks.forEach(b => {
    if (!authors[b.handle]) authors[b.handle] = { name: b.author, handle: b.handle, count: 0 };
    authors[b.handle].count++;
  });
  $('author-list').innerHTML = Object.values(authors).sort((a, b) => b.count - a.count).slice(0, 8).map(a => `
    <div class="author-row">
      <div class="author-avatar" style="background:${getAvatarColor(a.handle)}">${(a.name || '?')[0].toUpperCase()}</div>
      <div><div class="author-name">${esc(a.name)}</div><div class="author-handle">@${esc(a.handle)}</div></div>
      <span class="author-count">${a.count}</span>
    </div>
  `).join('');

}

function gemCard(b) {
  return `<div class="gem-card" onclick="chrome.tabs.create({url:'${b.url}'})">
    <div class="gem-top"><span class="gem-author">@${esc(b.handle)}</span><span class="gem-time">${ago(b.savedAt)}</span></div>
    <div class="gem-text">${esc(b.summary || b.text)}</div>
    <div class="gem-meta">
      ${b.category ? `<span class="cat" style="font-size:8px">${esc(b.category)}</span>` : ''}
      ${b.metrics?.likes ? `<span class="gem-stat">♥ ${b.metrics.likes}</span>` : ''}
      ${b.metrics?.retweets ? `<span class="gem-stat">↻ ${b.metrics.retweets}</span>` : ''}
    </div>
  </div>`;
}

// ===== UTILS =====
function getDateLabel(d) {
  const date = new Date(d);
  const now = new Date();
  // Compare by calendar date, not timestamp difference
  const dateStr = date.toDateString();
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === todayStr) return 'Today';
  if (dateStr === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function ago(d) {
  try {
    const ms = Date.now() - new Date(d);
    if (ms < 60000) return 'now';
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`;
    if (ms < 604800000) return `${Math.floor(ms / 86400000)}d`;
    return new Date(d).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function esc(t) {
  if (!t) return '';
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

const AVATAR_COLORS = ['#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6'];
function getAvatarColor(str) {
  let hash = 0;
  for (let i = 0; i < (str||'').length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ===== INLINE SETTINGS =====
const PROVIDERS = {
  claude: { placeholder:'sk-ant-...', help:'<a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>',
    models:[{id:'claude-haiku-4-5-20251001',label:'Haiku 4.5'},{id:'claude-sonnet-4-6',label:'Sonnet 4.6'},{id:'claude-opus-4-6',label:'Opus 4.6'}],
    defaultTag:'claude-haiku-4-5-20251001', defaultDigest:'claude-sonnet-4-6' },
  openai: { placeholder:'sk-...', help:'<a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>',
    models:[{id:'gpt-4o-mini',label:'GPT-4o Mini'},{id:'gpt-4o',label:'GPT-4o'},{id:'o3-mini',label:'o3-mini'}],
    defaultTag:'gpt-4o-mini', defaultDigest:'gpt-4o' },
  openrouter: { placeholder:'sk-or-...', help:'<a href="https://openrouter.ai/keys" target="_blank">openrouter.ai</a>',
    models:[{id:'anthropic/claude-haiku',label:'Claude Haiku'},{id:'anthropic/claude-sonnet',label:'Claude Sonnet'},{id:'openai/gpt-4o-mini',label:'GPT-4o Mini'},{id:'openai/gpt-4o',label:'GPT-4o'}],
    defaultTag:'anthropic/claude-haiku', defaultDigest:'anthropic/claude-sonnet' },
  local: { placeholder:'http://127.0.0.1:8080', help:'llama-server, Ollama, or any OpenAI-compatible local server',
    models:[{id:'local',label:'Local Model'}],
    defaultTag:'local', defaultDigest:'local' },
};

let settingsProvider = 'claude';

async function loadSettings() {
  const r = await chrome.storage.local.get('settings');
  const s = r.settings || {};
  $('settings-enable-ai').checked = s.enableAiTagging !== false;
  settingsProvider = s.aiProvider || 'claude';
  $('settings-api-key').value = s.apiKey || '';
  $('settings-server-url').value = s.localServerUrl || 'http://127.0.0.1:8080';
  $('settings-limit').value = s.spendingLimit || '';
  updateSettingsProvider();
  if (s.tagModel) $('settings-tag-model').value = s.tagModel;
  if (s.digestModel) $('settings-digest-model').value = s.digestModel;
  $('settings-ai-config').style.display = $('settings-enable-ai').checked ? 'block' : 'none';

  // Folder
  const handle = await getFolderHandle();
  if (handle) {
    $('settings-folder-path').textContent = handle.name;
    $('settings-folder-display').classList.add('has-folder');
  }

  // Usage
  try {
    const ur = await chrome.runtime.sendMessage({ type: 'GET_USAGE' });
    const u = ur?.usage || { totalCalls:0, byModel:{} };
    const costs = { haiku:{i:.001,o:.005,l:'Tagging'}, sonnet:{i:.003,o:.015,l:'Digest'}, opus:{i:.015,o:.075,l:'Digest'},
      'gpt-4o-mini':{i:.00015,o:.0006,l:'Tagging'}, 'gpt-4o':{i:.005,o:.015,l:'Digest'} };
    let cloudCost = 0, cloudCalls = 0, localCalls = 0, cloudRows = '', localRows = '';
    for (const [m, d] of Object.entries(u.byModel || {})) {
      if (m === 'local') {
        localCalls += d.calls;
        localRows += `<div style="display:flex;justify-content:space-between;font-size:12px;color:#888;padding:2px 0"><span>Local (${d.calls})</span><span style="color:#16a34a">free</span></div>`;
      } else {
        let cost = 0, label = m;
        for (const [k, c] of Object.entries(costs)) { if (m.toLowerCase().includes(k)) { cost = (d.inputChars/4000*c.i)+(d.outputChars/4000*c.o); label = c.l; break; } }
        cloudCost += cost;
        cloudCalls += d.calls;
        cloudRows += `<div style="display:flex;justify-content:space-between;font-size:12px;color:#888;padding:2px 0"><span>${label} (${d.calls})</span><span>$${cost.toFixed(4)}</span></div>`;
      }
    }
    let html = `<div style="display:flex;justify-content:space-between;margin-bottom:6px"><div><span style="font:700 20px var(--font)">${u.totalCalls}</span> <span style="font-size:11px;color:#999">calls</span></div>`;
    if (cloudCost > 0) html += `<div><span style="font:700 20px var(--font)">$${cloudCost.toFixed(3)}</span> <span style="font-size:11px;color:#999">cloud cost</span></div>`;
    html += `</div>`;
    if (cloudRows) html += `<div style="font:500 11px var(--font);color:#999;margin-bottom:2px">CLOUD</div>${cloudRows}`;
    if (localRows) html += `<div style="font:500 11px var(--font);color:#999;margin:6px 0 2px">LOCAL</div>${localRows}`;
    $('settings-usage').innerHTML = html;
  } catch { $('settings-usage').innerHTML = '<span style="font-size:12px;color:#999">No data</span>'; }
}

function updateSettingsProvider() {
  const info = PROVIDERS[settingsProvider];
  const isLocal = settingsProvider === 'local';
  $('settings-key-section').style.display = isLocal ? 'none' : 'block';
  $('settings-url-section').style.display = isLocal ? 'block' : 'none';
  if (!isLocal) {
    $('settings-api-key').placeholder = info.placeholder;
    $('settings-api-help').innerHTML = info.help;
  }
  document.querySelectorAll('.sp').forEach(b => b.classList.toggle('active', b.dataset.provider === settingsProvider));
  const tm = $('settings-tag-model'), dm = $('settings-digest-model');
  const st = tm.value, sd = dm.value;
  tm.innerHTML = ''; dm.innerHTML = '';
  info.models.forEach(m => { tm.add(new Option(m.label, m.id)); dm.add(new Option(m.label, m.id)); });
  tm.value = info.models.find(m => m.id === st) ? st : info.defaultTag;
  dm.value = info.models.find(m => m.id === sd) ? sd : info.defaultDigest;
}

$('settings-providers').addEventListener('click', e => {
  const b = e.target.closest('.sp');
  if (!b) return;
  settingsProvider = b.dataset.provider;
  updateSettingsProvider();
});

$('settings-enable-ai').addEventListener('change', () => {
  $('settings-ai-config').style.display = $('settings-enable-ai').checked ? 'block' : 'none';
});

$('settings-toggle-key').addEventListener('click', () => {
  const inp = $('settings-api-key');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

$('settings-browse-btn').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveFolderHandle(handle);
    $('settings-folder-path').textContent = handle.name;
    $('settings-folder-display').classList.add('has-folder');
    permBanner.style.display = 'none';
    permissionOk = true;
  } catch (e) { if (e.name !== 'AbortError') console.error(e); }
});

$('settings-save').addEventListener('click', async () => {
  const settings = {
    enableAiTagging: $('settings-enable-ai').checked,
    aiProvider: settingsProvider,
    apiKey: $('settings-api-key').value.trim(),
    localServerUrl: $('settings-server-url').value.trim() || 'http://127.0.0.1:8080',
    tagModel: $('settings-tag-model').value,
    digestModel: $('settings-digest-model').value,
    spendingLimit: parseFloat($('settings-limit').value) || 0,
    autoSaveFile: true,
    configured: true,
  };
  await chrome.storage.local.set({ settings });
  // Go back to feed
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-feed').classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'feed'));
});

$('settings-export-json').addEventListener('click', async () => {
  const r = await chrome.storage.local.get('bookmarks');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r.bookmarks||{},null,2)], {type:'application/json'}));
  a.download = 'stash-bookmarks.json'; a.click();
});

$('settings-export-md').addEventListener('click', async () => {
  const r = await chrome.storage.local.get('bookmarks');
  const bm = Object.values(r.bookmarks||{});
  if (!bm.length) return;
  const md = bm.map(b => `## @${b.handle}\n> ${(b.text||'').split('\n').join('\n> ')}\n${(b.tags||[]).map(t=>'#'+t).join(' ')}\n---\n`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], {type:'text/markdown'}));
  a.download = 'stash-bookmarks.md'; a.click();
});

$('settings-reset').addEventListener('click', async () => {
  if (!confirm('Delete ALL bookmarks, settings, and vault connection?')) return;
  await chrome.storage.local.clear();
  await chrome.storage.local.clear();
  try { indexedDB.deleteDatabase('social-bookmarks'); } catch {}
  alert('All data cleared. Reload the extension.');
});

// ===== HEALTH CHECK =====
$('lint-btn').addEventListener('click', async () => {
  $('lint-results').innerHTML = '<span style="font-size:11px;color:var(--t3)">Checking...</span>';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'RUN_LINT' });
    const issues = r?.issues || [];
    $('lint-results').innerHTML = issues.length === 0
      ? '<span style="font-size:12px;color:#16a34a">All good! No issues found.</span>'
      : issues.map(i => `<div class="lint-item"><span class="lint-badge ${i.severity}">${i.severity}</span><span>${esc(i.message)}</span></div>`).join('');
  } catch (e) { $('lint-results').innerHTML = `<span style="font-size:11px;color:#dc2626">${e.message}</span>`; }
});

// ===== ASK Q&A =====
$('ask-submit').addEventListener('click', submitQuestion);
$('ask-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitQuestion(); });

async function submitQuestion() {
  const input = $('ask-input');
  const q = input.value.trim();
  if (!q) return;

  const history = $('ask-history');
  // Clear empty state
  const empty = history.querySelector('.ask-empty');
  if (empty) empty.remove();

  // Show question
  const qDiv = document.createElement('div');
  qDiv.className = 'ask-q';
  qDiv.textContent = q;
  history.appendChild(qDiv);

  // Show loading with agent avatar
  const loadDiv = document.createElement('div');
  loadDiv.className = 'ask-loading';
  loadDiv.innerHTML = '<div class="ask-a-avatar"><svg viewBox="0 0 32 32" fill="none" width="14" height="14"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="#fff"/><rect x="18" y="6" width="8" height="8" rx="1.5" fill="#fff" opacity=".5"/><rect x="6" y="18" width="8" height="8" rx="1.5" fill="#fff" opacity=".5"/><rect x="18" y="18" width="8" height="8" rx="1.5" fill="#fff" opacity=".2"/></svg></div> Searching...';
  history.appendChild(loadDiv);

  input.value = '';
  input.disabled = true;
  $('ask-submit').disabled = true;
  history.scrollTop = history.scrollHeight;

  try {
    const r = await chrome.runtime.sendMessage({ type: 'ASK_QUESTION', question: q });
    loadDiv.remove();

    const aDiv = document.createElement('div');
    aDiv.className = 'ask-a';
    aDiv.innerHTML = `
      <div class="ask-a-header">
        <div class="ask-a-avatar"><svg viewBox="0 0 32 32" fill="none" width="14" height="14"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="#fff"/><rect x="18" y="6" width="8" height="8" rx="1.5" fill="#fff" opacity=".5"/><rect x="6" y="18" width="8" height="8" rx="1.5" fill="#fff" opacity=".5"/><rect x="18" y="18" width="8" height="8" rx="1.5" fill="#fff" opacity=".2"/></svg></div>
        <span class="ask-a-name">Stash</span>
      </div>
      <div class="ask-a-body">${simpleMarkdown(r?.answer || 'No answer generated.')}</div>
    `;
    const srcParts = [];
    if (r?.wikiCount) srcParts.push(`${r.wikiCount} wiki article${r.wikiCount > 1 ? 's' : ''}`);
    if (r?.bookmarkCount) srcParts.push(`${r.bookmarkCount} bookmark${r.bookmarkCount > 1 ? 's' : ''}`);
    if (srcParts.length) {
      aDiv.innerHTML += `<div class="ask-sources">${srcParts.join(' · ')}</div>`;
    }
    history.appendChild(aDiv);
  } catch (e) {
    loadDiv.textContent = 'Error: ' + e.message;
  }

  input.disabled = false;
  $('ask-submit').disabled = false;
  input.focus();
  history.scrollTop = history.scrollHeight;
}

function simpleMarkdown(text) {
  return text
    .replace(/^### (.*$)/gm, '<h4 style="font:600 13px var(--font);margin:8px 0 4px">$1</h4>')
    .replace(/^## (.*$)/gm, '<h3 style="font:600 14px var(--font);margin:10px 0 4px">$1</h3>')
    .replace(/^# (.*$)/gm, '<h2 style="font:700 15px var(--font);margin:12px 0 6px">$1</h2>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code style="background:#f1f1f1;padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
    .replace(/^- (.*$)/gm, '<div style="padding-left:12px;margin:2px 0">• $1</div>')
    .replace(/^> (.*$)/gm, '<div style="border-left:3px solid #ddd;padding-left:10px;color:#666;margin:4px 0">$1</div>')
    .replace(/@(\w+)/g, '<a href="https://x.com/$1" target="_blank" style="color:#0070F3;text-decoration:none;font-weight:500">@$1</a>')
    .replace(/\[\[wiki\/(.*?)\]\]/g, '<span style="color:#0070F3;font-weight:500">$1</span>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}
