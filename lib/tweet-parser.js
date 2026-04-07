// Normalizes raw tweet data into a clean structure
// Used by both content script (inline) and service worker

export function normalizeTweet(raw) {
  return {
    id: raw.id || '',
    text: (raw.text || '').trim(),
    author: raw.author || 'Unknown',
    handle: raw.handle || '',
    createdAt: raw.createdAt || new Date().toISOString(),
    url: raw.url || `https://x.com/i/status/${raw.id}`,
    mediaUrls: raw.mediaUrls || [],
    quotedTweet: raw.quotedTweet ? normalizeTweet(raw.quotedTweet) : null,
    metrics: {
      likes: raw.metrics?.likes || 0,
      retweets: raw.metrics?.retweets || 0,
      replies: raw.metrics?.replies || 0,
      views: raw.metrics?.views || 0,
    },
    savedAt: raw.savedAt || new Date().toISOString(),
    tags: raw.tags || [],
    userNote: raw.userNote || '',
  };
}

export function generateFilename(tweet) {
  const date = formatDate(tweet.createdAt || tweet.savedAt);
  const handle = tweet.handle || 'unknown';
  const slug = slugify(tweet.text);
  return `${date}-${handle}-${slug}`.substring(0, 100);
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

function slugify(text) {
  if (!text) return 'tweet';
  return text
    .substring(0, 60)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'tweet';
}
