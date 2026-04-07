// Offscreen document — handles FileSystemDirectoryHandle writes
// Service workers can't reliably use FileSystemDirectoryHandle,
// but offscreen documents can since they're a full page context.

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('social-bookmarks', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getFolderHandle() {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get('vaultFolder');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'WRITE_FILE') {
    writeFile(message.folder, message.filename, message.content).then(r => sendResponse(r));
    return true;
  }

  if (message.type === 'CHECK_PERMISSION') {
    checkPermission().then(r => sendResponse(r));
    return true;
  }

  if (message.type === 'READ_FILE') {
    readFile(message.folder, message.filename).then(r => sendResponse(r));
    return true;
  }
});

async function checkPermission() {
  const handle = await getFolderHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    return { ok: perm === 'granted', reason: perm !== 'granted' ? 'expired' : null };
  } catch { return { ok: false, reason: 'error' }; }
}

async function readFile(folder, filename) {
  const rootHandle = await getFolderHandle();
  if (!rootHandle) return { success: false, content: null };
  try {
    const perm = await rootHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return { success: false, content: null };
    let dir = rootHandle;
    if (folder) {
      for (const part of folder.split('/').filter(Boolean)) {
        dir = await dir.getDirectoryHandle(part);
      }
    }
    const fh = await dir.getFileHandle(`${filename}.md`);
    const file = await fh.getFile();
    const content = await file.text();
    return { success: true, content };
  } catch { return { success: false, content: null }; }
}

async function writeFile(folder, filename, content) {
  const rootHandle = await getFolderHandle();
  if (!rootHandle) {
    console.warn('[Offscreen] No vault folder configured');
    return { success: false, error: 'No vault folder' };
  }

  try {
    let perm = await rootHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      // Try to request permission (may fail without user gesture)
      try { perm = await rootHandle.requestPermission({ mode: 'readwrite' }); } catch {}
    }
    if (perm !== 'granted') {
      console.warn('[Offscreen] No write permission. Re-select folder in settings.');
      return { success: false, error: 'Permission expired — re-select folder in Settings' };
    }

    // Create subfolders
    let dir = rootHandle;
    if (folder) {
      for (const part of folder.split('/').filter(Boolean)) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }
    }

    // Write file
    const fileHandle = await dir.getFileHandle(`${filename}.md`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();

    console.log('[Offscreen] Written:', folder ? `${folder}/${filename}.md` : `${filename}.md`);
    return { success: true };
  } catch (e) {
    console.error('[Offscreen] Write failed:', e);
    return { success: false, error: e.message };
  }
}
