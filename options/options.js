const PROVIDERS = {
  claude: {
    placeholder: 'sk-ant-...',
    help: '<a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    ],
    defaultTag: 'claude-haiku-4-5-20251001',
    defaultDigest: 'claude-sonnet-4-6',
  },
  openai: {
    placeholder: 'sk-...',
    help: '<a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'o3-mini', label: 'o3-mini' },
    ],
    defaultTag: 'gpt-4o-mini',
    defaultDigest: 'gpt-4o',
  },
  openrouter: {
    placeholder: 'sk-or-...',
    help: '<a href="https://openrouter.ai/keys" target="_blank">openrouter.ai</a>',
    models: [
      { id: 'anthropic/claude-haiku', label: 'Claude Haiku' },
      { id: 'anthropic/claude-sonnet', label: 'Claude Sonnet' },
      { id: 'anthropic/claude-opus', label: 'Claude Opus' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
    defaultTag: 'anthropic/claude-haiku',
    defaultDigest: 'anthropic/claude-sonnet',
  },
};

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

document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const enableAi = $('enable-ai');
  const apiKey = $('api-key');
  const apiKeyHelp = $('api-key-help');
  const aiConfig = $('ai-config');
  const providerCards = $('provider-cards');
  const tagModel = $('tag-model');
  const digestModel = $('digest-model');
  const folderDisplay = $('folder-display');
  const folderPath = $('folder-path');
  const statsBar = $('stats-bar');
  const saveStatus = $('save-status');
  $('close-btn').addEventListener('click', () => window.close());

  let provider = 'claude';

  // Load
  chrome.storage.local.get('settings', (r) => {
    const s = r.settings || {};
    enableAi.checked = s.enableAiTagging !== false;
    provider = s.aiProvider || 'claude';
    apiKey.value = s.apiKey || '';
    updateUI();
    if (s.tagModel) tagModel.value = s.tagModel;
    if (s.digestModel) digestModel.value = s.digestModel;
    toggleAI();
  });
  loadFolder();
  loadStats();

  // Folder
  $('pick-folder-btn').addEventListener('click', async () => {
    try {
      const h = await window.showDirectoryPicker({ mode: 'readwrite' });
      await saveFolderHandle(h);
      folderPath.textContent = h.name;
      folderDisplay.classList.add('has-folder');
    } catch (e) { if (e.name !== 'AbortError') console.error(e); }
  });

  async function loadFolder() {
    const h = await getFolderHandle();
    if (h) { folderPath.textContent = h.name; folderDisplay.classList.add('has-folder'); }
  }

  async function loadStats() {
    const r = await chrome.storage.local.get('bookmarks');
    const n = Object.keys(r.bookmarks || {}).length;
    statsBar.textContent = n;
  }

  // Provider tabs
  providerCards.addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    providerCards.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    provider = t.dataset.provider;
    updateUI();
  });

  function updateUI() {
    const info = PROVIDERS[provider];
    apiKey.placeholder = info.placeholder;
    apiKeyHelp.innerHTML = info.help;
    providerCards.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.provider === provider));
    const st = tagModel.value, sd = digestModel.value;
    tagModel.innerHTML = ''; digestModel.innerHTML = '';
    for (const m of info.models) {
      tagModel.add(new Option(m.label, m.id));
      digestModel.add(new Option(m.label, m.id));
    }
    tagModel.value = info.models.find(m => m.id === st) ? st : info.defaultTag;
    digestModel.value = info.models.find(m => m.id === sd) ? sd : info.defaultDigest;
  }

  // AI toggle
  enableAi.addEventListener('change', toggleAI);
  function toggleAI() { aiConfig.style.display = enableAi.checked ? 'block' : 'none'; }

  // Key visibility
  $('toggle-key').addEventListener('click', () => {
    apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
  });

  // Save
  $('save-btn').addEventListener('click', save);
  $('settings-form').addEventListener('submit', e => { e.preventDefault(); save(); });

  function save() {
    chrome.storage.local.set({ settings: {
      enableAiTagging: enableAi.checked,
      aiProvider: provider,
      apiKey: apiKey.value.trim(),
      tagModel: tagModel.value,
      digestModel: digestModel.value,
      spendingLimit: parseFloat(spendingLimit.value) || 0,
      autoSaveFile: true,
      configured: true,
    }}, () => {
      saveStatus.textContent = 'Saved';
      saveStatus.classList.add('visible');
      setTimeout(() => saveStatus.classList.remove('visible'), 2000);
      // Ask the service worker to drain any bookmarks that were skipped for the spending limit.
      chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
    });
  }

  // Export
  $('export-btn').addEventListener('click', async () => {
    const r = await chrome.storage.local.get('bookmarks');
    dl(JSON.stringify(r.bookmarks || {}, null, 2), 'bookmarks.json', 'application/json');
  });
  $('export-md-btn').addEventListener('click', async () => {
    const r = await chrome.storage.local.get('bookmarks');
    const bm = Object.values(r.bookmarks || {});
    if (!bm.length) return;
    let md = bm.map(b => `## @${b.handle}\n\n> ${(b.text||'').split('\n').join('\n> ')}\n\n${(b.tags||[]).map(t=>'#'+t).join(' ')}\n\n---\n`).join('\n');
    dl(md, 'bookmarks.md', 'text/markdown');
  });

  // Usage display
  const spendingLimit = $('spending-limit');
  loadUsage();

  async function loadUsage() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_USAGE' });
      const u = r?.usage || { totalCalls: 0, totalInputChars: 0, totalOutputChars: 0, byModel: {} };
      const costs = {
        'haiku': { input: 0.001, output: 0.005, label: 'Tagging' },
        'sonnet': { input: 0.003, output: 0.015, label: 'Digest' },
        'opus': { input: 0.015, output: 0.075, label: 'Digest' },
        'gpt-4o-mini': { input: 0.00015, output: 0.0006, label: 'Tagging' },
        'gpt-4o': { input: 0.005, output: 0.015, label: 'Digest' },
      };
      let totalCost = 0;
      let rows = '';
      for (const [model, data] of Object.entries(u.byModel || {})) {
        const inTok = Math.round(data.inputChars / 4);
        const outTok = Math.round(data.outputChars / 4);
        let cost = 0, label = model;
        for (const [key, c] of Object.entries(costs)) {
          if (model.toLowerCase().includes(key)) { cost = (inTok/1000*c.input)+(outTok/1000*c.output); label = c.label; break; }
        }
        totalCost += cost;
        rows += `<div style="display:flex;justify-content:space-between;font-size:12px;color:#666;padding:2px 0"><span>${label} (${data.calls} calls)</span><span>$${cost.toFixed(4)}</span></div>`;
      }
      $('usage-display').innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div><span style="font-size:22px;font-weight:700">${u.totalCalls}</span> <span style="font-size:12px;color:#999">calls</span></div>
          <div style="text-align:right"><span style="font-size:22px;font-weight:700">$${totalCost.toFixed(3)}</span> <span style="font-size:12px;color:#999">spent</span></div>
        </div>
        ${rows}
      `;
    } catch { $('usage-display').innerHTML = '<div style="font-size:12px;color:#999">No usage data</div>'; }
  }

  // Load spending limit
  chrome.storage.local.get('settings', (r) => {
    spendingLimit.value = r.settings?.spendingLimit || '';
  });

  $('clear-btn').addEventListener('click', async () => {
    if (!confirm('This will delete ALL bookmarks, settings, and vault connection. Are you sure?')) return;
    await chrome.storage.local.clear();
    await chrome.storage.local.clear();
    try { indexedDB.deleteDatabase('social-bookmarks'); } catch {}
    alert('All data cleared. Reload the extension to start fresh.');
    window.close();
  });

  function dl(c, n, t) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([c], { type: t }));
    a.download = n; a.click();
  }
});
