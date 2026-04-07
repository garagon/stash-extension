// MAIN world script — patches Twitter's fetch AND watches DOM for bookmark clicks
// Dual detection: network interception + DOM observation

(function () {
  'use strict';

  const CHANNEL = 'x-bookmarks-to-obsidian';
  const tweetCache = new Map();
  const MAX_CACHE_SIZE = 500;

  console.log('[X-Bookmarks] Injected script loading in MAIN world...');

  // ============================================================
  // METHOD 1: Fetch interception
  // ============================================================

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const [resource, config] = args;

    let url = '';
    let body = null;

    if (typeof resource === 'string') {
      url = resource;
      body = config?.body;
    } else if (resource instanceof Request) {
      url = resource.url;
      // For Request objects, body might be on the request itself
      body = config?.body;
    }

    let response;
    try {
      response = await originalFetch.apply(this, args);
    } catch (e) {
      throw e;
    }

    if (!url) return response;

    try {
      // Log all GraphQL calls for debugging
      if (url.includes('/graphql/') || url.includes('/i/api/')) {
        // Extract operation name from URL
        const urlParts = url.split('/');
        const opName = urlParts[urlParts.length - 1]?.split('?')[0];

        // Detect bookmark creation — match CreateBookmark, ignore DeleteBookmark
        if (
          url.includes('CreateBookmark') &&
          (config?.method === 'POST' || (resource instanceof Request && resource.method === 'POST'))
        ) {
          console.log('[X-Bookmarks] Detected bookmark API call:', opName, url);
          let tweetId = null;

          // Try to extract tweet_id from body
          if (body && typeof body === 'string') {
            try {
              const parsed = JSON.parse(body);
              tweetId = parsed?.variables?.tweet_id;
            } catch {}
          }

          // Also try reading from Request body if resource is a Request
          if (!tweetId && resource instanceof Request) {
            try {
              const cloned = resource.clone();
              const text = await cloned.text();
              const parsed = JSON.parse(text);
              tweetId = parsed?.variables?.tweet_id;
            } catch {}
          }

          if (tweetId) {
            console.log('[X-Bookmarks] Bookmark tweet ID:', tweetId);
            handleBookmarkCreated(tweetId, 'fetch');
          }
        }

        // Cache tweet data from responses
        if (isTweetDataEndpoint(opName || url)) {
          try {
            const cloned = response.clone();
            const data = await cloned.json();
            cacheTweetsFromResponse(data);
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[X-Bookmarks] Error in fetch interceptor:', e);
    }

    return response;
  };

  // Also patch XMLHttpRequest just in case
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._xbm_url = url;
    this._xbm_method = method;
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._xbm_url && this._xbm_url.includes('CreateBookmark') && this._xbm_method === 'POST') {
      console.log('[X-Bookmarks] XHR bookmark call detected:', this._xbm_url);
      if (body && typeof body === 'string') {
        try {
          const parsed = JSON.parse(body);
          const tweetId = parsed?.variables?.tweet_id;
          if (tweetId) {
            handleBookmarkCreated(tweetId, 'xhr');
          }
        } catch {}
      }
    }
    return originalXHRSend.call(this, body);
  };

  function isTweetDataEndpoint(name) {
    const endpoints = [
      'TweetDetail', 'HomeTimeline', 'HomeLatestTimeline',
      'SearchTimeline', 'UserTweets', 'Bookmarks',
      'ListLatestTweetsTimeline', 'CommunityTweetsTimeline',
      'TweetResultByRestId', 'Following', 'Followers',
      'ArticleDetail', 'NoteTweet',
    ];
    return endpoints.some(ep => name.includes(ep));
  }

  // DOM observer removed — fetch/XHR interception of CreateBookmark is sufficient
  // DOM observer was causing false positives (capturing tweet opens as bookmarks)

  function extractTweetFromArticle(article) {
    try {
      // Get tweet link to extract ID
      const timeLink = article.querySelector('a[href*="/status/"] time')?.parentElement;
      const statusLink = timeLink?.getAttribute('href') || '';
      const idMatch = statusLink.match(/\/status\/(\d+)/);
      const id = idMatch?.[1];

      if (!id) {
        // Try alternative: look for any link with /status/
        const allLinks = article.querySelectorAll('a[href*="/status/"]');
        for (const link of allLinks) {
          const m = link.getAttribute('href')?.match(/\/status\/(\d+)/);
          if (m) {
            return extractWithId(article, m[1]);
          }
        }
        return null;
      }

      return extractWithId(article, id);
    } catch (e) {
      console.warn('[X-Bookmarks] DOM extraction error:', e);
      return null;
    }
  }

  function extractWithId(article, id) {
    // Check cache first — might have richer data from GraphQL
    if (tweetCache.has(id)) {
      console.log('[X-Bookmarks] Found tweet in cache:', id);
      return tweetCache.get(id);
    }

    // Extract text — multiple strategies
    let text = '';

    // Try tweetText (standard tweets)
    const tweetText = article.querySelector('[data-testid="tweetText"]');
    if (tweetText) text = tweetText.innerText || tweetText.textContent || '';

    // Try note/article content
    if (!text) {
      const noteText = article.querySelector('[data-testid="noteText"]');
      if (noteText) text = noteText.innerText || noteText.textContent || '';
    }

    // Fallback: find the largest text block inside the article
    if (!text) {
      let longest = '';
      article.querySelectorAll('[dir="ltr"], [dir="auto"], [lang]').forEach(el => {
        // Skip user names, timestamps, buttons
        if (el.closest('[data-testid="User-Name"], button, a[role="link"]')) return;
        const t = (el.innerText || el.textContent || '').trim();
        if (t.length > longest.length) longest = t;
      });
      text = longest;
    }

    // Article title
    const articleTitle = article.querySelector('h1, [role="heading"]');
    if (articleTitle) {
      const title = articleTitle.textContent?.trim();
      if (title && title.length > 3 && !text.startsWith(title)) {
        text = title + '\n\n' + text;
      }
    }

    // Author / handle
    let author = '';
    let handle = '';
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    if (userNameEl) {
      // First link with href="/username" is the profile
      const links = userNameEl.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/^\/(\w+)$/);
        if (m) {
          handle = m[1];
          // Get display name — innerText of the link, excluding @handle
          const spans = link.querySelectorAll('span');
          for (const s of spans) {
            const t = s.textContent?.trim();
            if (t && !t.startsWith('@') && t.length > 0 && t.length < 50) {
              author = t;
              break;
            }
          }
          break;
        }
      }
    }
    if (!author) author = handle;

    // Get timestamp
    const timeEl = article.querySelector('time');
    const createdAt = timeEl?.getAttribute('datetime') || new Date().toISOString();

    // Get images
    const mediaUrls = [];
    const images = article.querySelectorAll('[data-testid="tweetPhoto"] img');
    for (const img of images) {
      const src = img.getAttribute('src');
      if (src && !src.includes('profile_images')) {
        mediaUrls.push({ url: src, type: 'photo', alt: img.getAttribute('alt') || '' });
      }
    }

    return {
      id,
      text,
      author,
      handle,
      createdAt,
      mediaUrls,
      quotedTweet: null,
      url: `https://x.com/${handle}/status/${id}`,
      metrics: {},
    };
  }

  // ============================================================
  // Tweet cache from GraphQL responses
  // ============================================================

  function cacheTweetsFromResponse(data) {
    const tweets = extractTweetsFromGraphQL(data);
    for (const tweet of tweets) {
      if (tweet.id) {
        tweetCache.set(tweet.id, tweet);
        if (tweetCache.size > MAX_CACHE_SIZE) {
          const firstKey = tweetCache.keys().next().value;
          tweetCache.delete(firstKey);
        }
      }
    }
    if (tweets.length > 0) {
      console.log(`[X-Bookmarks] Cached ${tweets.length} tweets (total: ${tweetCache.size})`);
    }
  }

  function extractTweetsFromGraphQL(data, results = []) {
    if (!data || typeof data !== 'object') return results;

    if (data.__typename === 'Tweet' || (data.legacy && data.legacy.full_text !== undefined)) {
      const tweet = parseTweetObject(data);
      if (tweet) results.push(tweet);
    }

    if (Array.isArray(data)) {
      for (const item of data) extractTweetsFromGraphQL(item, results);
    } else {
      for (const key of Object.keys(data)) {
        if (key === '__typename') continue;
        extractTweetsFromGraphQL(data[key], results);
      }
    }

    return results;
  }

  function parseTweetObject(tweetData) {
    try {
      const legacy = tweetData.legacy || tweetData;
      const core = tweetData.core?.user_results?.result;
      const userLegacy = core?.legacy;

      const id = legacy.id_str || tweetData.rest_id;
      if (!id) return null;

      // Get text — prefer note_tweet (articles/long posts) over legacy.full_text (truncated)
      let text = legacy.full_text || legacy.text || '';

      // note_tweet contains full article/long-form content
      const noteTweet = tweetData.note_tweet?.note_tweet_results?.result;
      if (noteTweet) {
        const noteText = noteTweet.text || '';
        if (noteText.length > text.length) {
          text = noteText;
        }
        // note_tweet may also have entity-based rich text and media
        const noteMedia = noteTweet.media?.inline_media || [];
        // We'll handle media below
      }

      // Also check card data for article titles
      const card = tweetData.card?.legacy?.binding_values;
      let articleTitle = '';
      if (card) {
        const titleVal = card.find?.(v => v.key === 'title');
        if (titleVal) articleTitle = titleVal.value?.string_value || '';
        // For array-style cards
        if (!articleTitle && Array.isArray(card)) {
          for (const item of card) {
            if (item.key === 'title') articleTitle = item.value?.string_value || '';
          }
        }
      }

      const author = userLegacy?.name || '';
      const handle = userLegacy?.screen_name || '';
      const createdAt = legacy.created_at || '';

      const mediaUrls = [];
      const media = legacy.extended_entities?.media || legacy.entities?.media || [];
      for (const m of media) {
        if (m.media_url_https) {
          mediaUrls.push({ url: m.media_url_https, type: m.type, alt: m.ext_alt_text || '' });
        }
      }

      let expandedText = text;

      // Expand URLs — use note_tweet entities if available, fallback to legacy
      const noteEntities = noteTweet?.entity_set?.urls || [];
      const legacyUrls = legacy.entities?.urls || [];
      const allUrls = noteEntities.length > 0 ? noteEntities : legacyUrls;
      for (const u of allUrls) {
        if (u.url && u.expanded_url) {
          expandedText = expandedText.replace(u.url, u.expanded_url);
        }
      }
      for (const m of media) {
        if (m.url) expandedText = expandedText.replace(m.url, '').trim();
      }

      // Prepend article title if available and not already in text
      if (articleTitle && !expandedText.startsWith(articleTitle)) {
        expandedText = `${articleTitle}\n\n${expandedText}`;
      }

      let quotedTweet = null;
      const quoted = tweetData.quoted_status_result?.result;
      if (quoted) quotedTweet = parseTweetObject(quoted);

      return {
        id,
        text: expandedText,
        author,
        handle,
        createdAt,
        mediaUrls,
        quotedTweet,
        url: `https://x.com/${handle}/status/${id}`,
        isArticle: !!noteTweet || !!articleTitle,
        metrics: {
          likes: legacy.favorite_count || 0,
          retweets: legacy.retweet_count || 0,
          replies: legacy.reply_count || 0,
          views: tweetData.views?.count ? parseInt(tweetData.views.count) : 0,
        },
      };
    } catch (e) {
      return null;
    }
  }

  // ============================================================
  // Send to extension
  // ============================================================

  const sentIds = new Set();

  function handleBookmarkCreated(tweetId, source) {
    // Strategy 1: cache hit (best data)
    let data = tweetCache.get(tweetId);
    if (data?.text) {
      sendBookmarkToExtension(data, source);
      return;
    }

    // Strategy 2: DOM article element
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      if (article.querySelector(`a[href*="/status/${tweetId}"]`)) {
        data = extractTweetFromArticle(article);
        if (data?.text) { sendBookmarkToExtension(data, source); return; }
      }
    }

    // Strategy 3: wait 1s for GraphQL to populate cache, then retry
    setTimeout(() => {
      let retry = tweetCache.get(tweetId);

      if (!retry?.text) {
        const arts = document.querySelectorAll('article[data-testid="tweet"]');
        for (const a of arts) {
          if (a.querySelector(`a[href*="/status/${tweetId}"]`)) {
            retry = extractTweetFromArticle(a);
            if (retry?.text) break;
          }
        }
      }

      if (!retry?.text) {
        const handle = window.location.pathname.match(/^\/(\w+)\/status\//)?.[1] || '';
        retry = {
          id: tweetId, text: '', author: handle || '', handle,
          createdAt: new Date().toISOString(), mediaUrls: [],
          quotedTweet: null, url: `https://x.com/${handle || 'i'}/status/${tweetId}`, metrics: {},
        };
      }

      sendBookmarkToExtension(retry, source);
    }, 1000);
  }

  // Extract tweet/article data from the current page DOM
  function extractFromCurrentPage(tweetId) {
    try {
      // Handle from URL — most reliable source
      const urlMatch = window.location.pathname.match(/^\/(\w+)\/status\//);
      const handle = urlMatch?.[1] || '';

      // Author: scan ALL links to the profile
      let author = '';
      if (handle) {
        const profileLinks = document.querySelectorAll(`a[href="/${handle}"], a[href*="/${handle}"]`);
        for (const link of profileLinks) {
          const spans = link.querySelectorAll('span');
          for (const span of spans) {
            const t = span.textContent?.trim();
            // Author name is usually short, not a URL, not @handle
            if (t && t.length > 1 && t.length < 50 && !t.startsWith('@') && !t.startsWith('/')) {
              author = t;
              break;
            }
          }
          if (author) break;
        }
      }
      if (!author) author = handle;

      // Collect ALL visible text on the page to find the article content
      // Strategy: find the largest text blocks that aren't navigation/sidebar
      const allTextBlocks = [];

      // H1 titles (articles have these)
      document.querySelectorAll('h1, h2').forEach(el => {
        const t = el.textContent?.trim();
        if (t && t.length > 5 && t !== 'Article' && t !== 'Post' && !t.includes('Explore')
            && !t.includes('Search') && !t.includes('Home')) {
          allTextBlocks.push({ text: t, type: 'title', len: t.length });
        }
      });

      // tweetText elements
      document.querySelectorAll('[data-testid="tweetText"]').forEach(el => {
        const t = el.textContent?.trim();
        if (t && t.length > 10) allTextBlocks.push({ text: t, type: 'tweet', len: t.length });
      });

      // Paragraph-like elements inside the main content area
      const mainContent = document.querySelector('article, [data-testid="tweet"], main');
      if (mainContent) {
        mainContent.querySelectorAll('p, [dir="auto"] > span, [dir="ltr"]').forEach(el => {
          const t = el.textContent?.trim();
          // Skip UI text, tooltips, keyboard shortcuts
          const isJunk = t.includes('keyboard shortcuts') || t.includes('View keyboard') ||
            t.includes('press question') || t.includes('Upgrade to') || t.includes('cookie');
          if (t && t.length > 30 && !isJunk && !el.closest('nav, header, [role="navigation"], [role="dialog"]')) {
            // Avoid duplicates
            if (!allTextBlocks.some(b => b.text === t || t.includes(b.text) || b.text.includes(t))) {
              allTextBlocks.push({ text: t, type: 'body', len: t.length });
            }
          }
        });
      }

      // Build the full text — title first, then longest text blocks
      const titles = allTextBlocks.filter(b => b.type === 'title').sort((a, b) => b.len - a.len);
      const bodies = allTextBlocks.filter(b => b.type !== 'title').sort((a, b) => b.len - a.len);

      let text = '';
      if (titles.length > 0) text = titles[0].text + '\n\n';
      // Add body text — the longest block is most likely the article content
      if (bodies.length > 0) {
        text += bodies[0].text;
      }

      // If we still have very little text, concatenate more blocks
      if (text.length < 100 && bodies.length > 1) {
        text = (titles[0]?.text || '') + '\n\n' + bodies.map(b => b.text).join('\n\n');
      }

      text = text.trim();

      // Timestamp
      const timeEl = document.querySelector('time[datetime]');
      const createdAt = timeEl?.getAttribute('datetime') || new Date().toISOString();

      // Metrics
      const metrics = {};
      document.querySelectorAll('[aria-label]').forEach(el => {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const numMatch = label.match(/([\d,.]+[kmb]?)\s/);
        if (!numMatch) return;
        const raw = numMatch[1].replace(/,/g, '');
        let num = parseFloat(raw);
        if (raw.endsWith('k') || raw.endsWith('K')) num *= 1000;
        if (raw.endsWith('m') || raw.endsWith('M')) num *= 1000000;
        num = Math.round(num);
        if (label.includes('like') || label.includes('gusta')) metrics.likes = num;
        if (label.includes('retweet') || label.includes('repost')) metrics.retweets = num;
        if (label.includes('repl') || label.includes('respuesta')) metrics.replies = num;
        if (label.includes('view') || label.includes('vista')) metrics.views = num;
      });

      // Images
      const mediaUrls = [];
      document.querySelectorAll('img[src*="pbs.twimg"], img[src*="media"]').forEach(img => {
        const src = img.getAttribute('src');
        if (src && !src.includes('profile_images') && !src.includes('emoji') && !src.includes('hashflag')) {
          mediaUrls.push({ url: src, type: 'photo', alt: img.getAttribute('alt') || '' });
        }
      });

      if (!text) {
        console.warn('[X-Bookmarks] Page extraction: no text found');
        return null;
      }

      console.log('[X-Bookmarks] Page extraction OK:', author, '/', text.substring(0, 80) + '...');

      return {
        id: tweetId, text, author, handle, createdAt, mediaUrls,
        quotedTweet: null,
        url: `https://x.com/${handle}/status/${tweetId}`,
        isArticle: titles.length > 0,
        metrics,
      };
    } catch (e) {
      console.warn('[X-Bookmarks] Page extraction failed:', e);
      return null;
    }
  }

  function sendBookmarkToExtension(tweetData, source) {
    // Single dedup gate — only send each ID once per 10 seconds
    if (sentIds.has(tweetData.id)) return;
    sentIds.add(tweetData.id);
    setTimeout(() => sentIds.delete(tweetData.id), 10000);

    console.log(`[X-Bookmarks] Sending bookmark (${source}):`, tweetData.id, tweetData.text?.substring(0, 50));
    window.postMessage({
      channel: CHANNEL,
      type: 'BOOKMARK_CREATED',
      tweet: tweetData,
      source: source,
      timestamp: Date.now(),
    }, '*');
  }

  // ============================================================
  // Init
  // ============================================================

  console.log('[X-Bookmarks] Injected script loaded. Fetch/XHR patched.');
})();
