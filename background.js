// Service Worker — orchestrates bookmark saving, AI tagging, and Obsidian integration

// ---- Storage helpers ----

async function getSettings() {
  const defaults = {
    vaultName: '',
    folderName: 'SocialBookmarks',
    aiProvider: 'claude',
    apiKey: '',
    tagModel: 'claude-haiku-4-5-20251001',
    digestModel: 'claude-sonnet-4-6',
    autoSaveFile: true,
    enableAiTagging: true,
  };
  const result = await chrome.storage.local.get('settings');
  return { ...defaults, ...result.settings };
}

async function saveBookmark(tweet) {
  const result = await chrome.storage.local.get('bookmarks');
  const bookmarks = result.bookmarks || {};
  bookmarks[tweet.id] = tweet;
  await chrome.storage.local.set({ bookmarks });
}

async function getBookmarks() {
  const result = await chrome.storage.local.get('bookmarks');
  return result.bookmarks || {};
}

// ---- Tweet normalization ----

function normalizeTweet(raw) {
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
    topics: raw.topics || [],
    compiledAt: raw.compiledAt || null,
    compiledInto: raw.compiledInto || [],
    userNote: raw.userNote || '',
  };
}

function generateFilename(tweet) {
  const date = formatDateISO(tweet.createdAt || tweet.savedAt);
  const handle = tweet.handle || 'unknown';
  const slug = slugify(tweet.text);
  return `${date}-${handle}-${slug}`.substring(0, 100);
}

function formatDateISO(dateStr) {
  try { return new Date(dateStr).toISOString().split('T')[0]; }
  catch { return new Date().toISOString().split('T')[0]; }
}

function slugify(text) {
  if (!text) return 'tweet';
  return text.substring(0, 60).toLowerCase()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '') || 'tweet';
}

// ---- Markdown generation (Obsidian-optimized) ----

function tweetToMarkdown(tweet) {
  const source = tweet.source === 'linkedin' ? 'linkedin' : 'twitter';
  const sourceLabel = source === 'linkedin' ? 'LinkedIn' : 'X/Twitter';

  const fm = [
    '---',
    `source: ${source}`,
    `category: "${tweet.category || 'Uncategorized'}"`,
    `author: "${tweet.author}"`,
    `handle: "@${tweet.handle}"`,
    `date: ${formatDateISO(tweet.createdAt)}`,
    `saved: ${formatDateISO(tweet.savedAt)}`,
    `url: "${tweet.url}"`,
    tweet.tags.length > 0
      ? `tags:\n${tweet.tags.map(t => `  - ${t}`).join('\n')}`
      : 'tags: []',
    tweet.summary ? `summary: "${tweet.summary}"` : null,
    '---',
  ].filter(Boolean).join('\n');

  const parts = [];

  // Summary callout
  if (tweet.summary) {
    parts.push(`> [!abstract] ${tweet.summary}\n`);
  }

  // Content
  parts.push(`> ${tweet.text.split('\n').join('\n> ')}\n`);

  // Attribution
  const profileUrl = source === 'linkedin'
    ? `https://linkedin.com/in/${tweet.handle}`
    : `https://x.com/${tweet.handle}`;
  parts.push(`\u2014 **${tweet.author}** ([@${tweet.handle}](${profileUrl})) \u00B7 ${formatDateHuman(tweet.createdAt)} \u00B7 [${sourceLabel}](${tweet.url})\n`);

  // Media
  if (tweet.mediaUrls.length > 0) {
    for (const m of tweet.mediaUrls) {
      if (m.type === 'photo') {
        parts.push(`![${m.alt || 'image'}](${m.url})\n`);
      } else {
        parts.push(`[Video](${m.url})\n`);
      }
    }
  }

  // Quoted tweet
  if (tweet.quotedTweet) {
    const qt = tweet.quotedTweet;
    parts.push(`> [!quote] @${qt.handle}`);
    parts.push(`> ${qt.text.split('\n').join('\n> ')}`);
    parts.push(`> [Link](${qt.url})\n`);
  }

  // Tags as Obsidian inline tags
  if (tweet.tags.length > 0) {
    parts.push(`${tweet.tags.map(t => `#${t}`).join(' ')}\n`);
  }

  // Backlinks
  parts.push(`---`);
  parts.push(`[[${tweet.category || 'Uncategorized'}]] \u00B7 [[Weekly/${getWeekId(tweet.savedAt)}]]`);

  return `${fm}\n\n${parts.join('\n')}`;
}

function getWeekId(dateStr) {
  try {
    const d = new Date(dateStr);
    const year = d.getFullYear();
    const jan1 = new Date(year, 0, 1);
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
  } catch {
    return 'Unknown';
  }
}

function formatDateHuman(dateStr) {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return 'Unknown date'; }
}

function truncate(text, maxLen) {
  if (!text) return '';
  const cleaned = text.replace(/\n/g, ' ');
  return cleaned.length <= maxLen ? cleaned : cleaned.substring(0, maxLen) + '...';
}

// ---- AI Categorization (multi-provider) ----

const AI_PROMPT = `Analyze this social media post and return a JSON object with:
- "category": a single broad topic (one of: AI, Programming, Tech, Design, Science, Business, Culture, Politics, Personal, Other)
- "tags": 3-5 specific lowercase tags (single words or hyphenated)
- "topics": 1-2 specific wiki topic slugs for knowledge base compilation (lowercase, hyphenated, more specific than category but broader than tags, e.g. "ai-agents", "prompt-engineering", "web-performance")
- "summary": a one-line summary (max 100 chars) in the same language as the post

Return ONLY valid JSON, nothing else. Example:
{"category":"AI","tags":["agents","open-source","benchmarks"],"topics":["ai-agents","open-source-ai"],"summary":"New open-source agent optimization library"}`;

async function analyzePost(text, settings) {
  const { aiProvider, apiKey } = settings;
  if (!apiKey || !text) return null;

  try {
    const prompt = `${AI_PROMPT}\n\nPost: "${text.substring(0, 500)}"`;
    let responseText = '';

    const model = settings.tagModel; // fast model for tagging
    if (aiProvider === 'claude') {
      responseText = await callClaude(prompt, apiKey, model);
    } else if (aiProvider === 'openai') {
      responseText = await callOpenAI(prompt, apiKey, model);
    } else if (aiProvider === 'openrouter') {
      responseText = await callOpenRouter(prompt, apiKey, model);
    } else if (aiProvider === 'local') {
      responseText = await callLocal(prompt, settings.localServerUrl, model);
    }

    console.log('[Stash] AI response:', responseText);

    const match = responseText.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        category: parsed.category || 'Other',
        tags: (parsed.tags || []).filter(t => typeof t === 'string').map(t => t.toLowerCase().replace(/\s+/g, '-')).slice(0, 5),
        topics: (parsed.topics || []).filter(t => typeof t === 'string').map(t => t.toLowerCase().replace(/\s+/g, '-')).slice(0, 2),
        summary: parsed.summary || '',
      };
    }
    return null;
  } catch (e) {
    console.warn('[Stash] AI analysis failed:', e);
    return null;
  }
}

// ---- Token tracking ----

async function trackUsage(inputChars, outputChars, model) {
  const result = await chrome.storage.local.get('usage');
  const usage = result.usage || { totalCalls: 0, totalInputChars: 0, totalOutputChars: 0, byModel: {} };
  usage.totalCalls++;
  usage.totalInputChars += inputChars;
  usage.totalOutputChars += outputChars;
  if (!usage.byModel[model]) usage.byModel[model] = { calls: 0, inputChars: 0, outputChars: 0 };
  usage.byModel[model].calls++;
  usage.byModel[model].inputChars += inputChars;
  usage.byModel[model].outputChars += outputChars;
  await chrome.storage.local.set({ usage });
}

async function getUsage() {
  const result = await chrome.storage.local.get('usage');
  return result.usage || { totalCalls: 0, totalInputChars: 0, totalOutputChars: 0, byModel: {} };
}

async function checkSpendingLimit() {
  const settings = await getSettings();
  const limit = settings.spendingLimit || 0;
  if (limit <= 0) return true; // unlimited

  const usage = await getUsage();
  const costs = {
    'haiku': { input: 0.001, output: 0.005 },
    'sonnet': { input: 0.003, output: 0.015 },
    'opus': { input: 0.015, output: 0.075 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4o': { input: 0.005, output: 0.015 },
  };
  let totalCost = 0;
  for (const [model, data] of Object.entries(usage.byModel || {})) {
    const inTok = Math.round(data.inputChars / 4);
    const outTok = Math.round(data.outputChars / 4);
    for (const [key, c] of Object.entries(costs)) {
      if (model.toLowerCase().includes(key)) {
        totalCost += (inTok / 1000 * c.input) + (outTok / 1000 * c.output);
        break;
      }
    }
  }
  if (totalCost >= limit) {
    console.warn(`[Stash] Spending limit reached: $${totalCost.toFixed(3)} >= $${limit}`);
    return false;
  }
  return true;
}

async function callClaude(prompt, apiKey, model) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    console.warn('[Stash] Claude API error:', response.status, await response.text().catch(() => ''));
    return '';
  }
  const data = await response.json();
  const output = data.content?.[0]?.text || '';
  trackUsage(prompt.length, output.length, model || 'claude-haiku-4-5-20251001');
  return output;
}

async function callOpenAI(prompt, apiKey, model) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    console.warn('[Stash] OpenAI API error:', response.status);
    return '';
  }
  const data = await response.json();
  const output = data.choices?.[0]?.message?.content || '';
  trackUsage(prompt.length, output.length, model || 'gpt-4o-mini');
  return output;
}

async function callOpenRouter(prompt, apiKey, model) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'anthropic/claude-haiku',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    console.warn('[Stash] OpenRouter API error:', response.status);
    return '';
  }
  const data = await response.json();
  const output = data.choices?.[0]?.message?.content || '';
  trackUsage(prompt.length, output.length, model || 'anthropic/claude-haiku');
  return output;
}

async function callLocal(prompt, endpoint, model) {
  const baseUrl = (endpoint || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const url = baseUrl + '/v1/chat/completions';
  console.log('[Stash] Local AI call to:', url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn('[Stash] Local server error:', response.status, errText);
      return '';
    }
    const data = await response.json();
    const output = data.choices?.[0]?.message?.content || '';
    console.log('[Stash] Local AI response:', output.substring(0, 100));
    trackUsage(prompt.length, output.length, 'local');
    return output;
  } catch (e) {
    console.error('[Stash] Local AI failed:', e.message);
    return '';
  }
}

// ---- File saving via offscreen document ----

// ---- Raw markdown format (v3: for raw/ folder) ----

function tweetToRawMarkdown(tweet) {
  const topics = (tweet.topics || []).map(t => `  - ${t}`).join('\n');
  const tags = (tweet.tags || []).map(t => `  - ${t}`).join('\n');
  const topicLinks = (tweet.topics || []).map(t => `[[wiki/${t}]]`).join(' | ');

  // Media
  let mediaMd = '';
  if (tweet.mediaUrls && tweet.mediaUrls.length > 0) {
    mediaMd = '\n' + tweet.mediaUrls.map(m => {
      if (m.type === 'photo') return `![${m.alt || 'image'}](${m.url})`;
      return `[Video](${m.url})`;
    }).join('\n') + '\n';
  }

  // Quoted tweet
  let quotedMd = '';
  if (tweet.quotedTweet) {
    const qt = tweet.quotedTweet;
    quotedMd = `\n> [!quote] @${qt.handle}\n> ${(qt.text || '').split('\n').join('\n> ')}\n> [Source](${qt.url})\n`;
  }

  return `---
id: "${tweet.id}"
source: ${tweet.source || 'twitter'}
author: "${tweet.author}"
handle: "${tweet.handle}"
date: ${formatDateISO(tweet.createdAt)}
saved: ${formatDateISO(tweet.savedAt)}
url: "${tweet.url}"
category: "${tweet.category || 'Other'}"
topics:
${topics || '  - uncategorized'}
tags:
${tags || '  - untagged'}
summary: "${(tweet.summary || '').replace(/"/g, "'")}"
---

> ${tweet.text.split('\n').join('\n> ')}

— @${tweet.handle}, ${formatDateHuman(tweet.createdAt)}
${mediaMd}${quotedMd}
${topicLinks || '[[wiki/uncategorized]]'}
`;
}

// ---- Topic registry + compilation queue ----

async function updateTopicRegistry(tweet) {
  const result = await chrome.storage.local.get('topicRegistry');
  const registry = result.topicRegistry || {};

  for (const topic of tweet.topics) {
    if (!registry[topic]) {
      registry[topic] = {
        name: topic.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        slug: topic,
        bookmarkCount: 0,
        lastUpdated: null,
        lastCompiled: null,
      };
    }
    registry[topic].bookmarkCount++;
    registry[topic].lastUpdated = new Date().toISOString();
  }

  await chrome.storage.local.set({ topicRegistry: registry });
}

let compilationTimer = null;
const pendingTopics = new Set();

function queueCompilation(topics) {
  topics.forEach(t => pendingTopics.add(t));
  if (compilationTimer) clearTimeout(compilationTimer);
  compilationTimer = setTimeout(() => {
    const topicsToCompile = [...pendingTopics];
    pendingTopics.clear();
    compilationTimer = null;
    console.log('[Stash] Compilation triggered for:', topicsToCompile);
    compileTopics(topicsToCompile);
  }, 30000); // 30s debounce
}

// ---- Compilation engine (Phase 3) ----

async function compileTopics(topicSlugs) {
  const settings = await getSettings();
  const isLocal = settings.aiProvider === 'local';
  if (!isLocal && !settings.apiKey) { console.warn('[Stash] No API key — skipping compilation'); return; }
  if (!isLocal && !await checkSpendingLimit()) { console.warn('[Stash] Spending limit reached — skipping compilation'); return; }

  const bookmarks = await getBookmarks();
  const allBookmarks = Object.values(bookmarks);
  const compilationLog = (await chrome.storage.local.get('compilationLog')).compilationLog || {};

  for (const topic of topicSlugs) {
    try {
      await compileTopic(topic, allBookmarks, compilationLog, settings);
    } catch (e) {
      console.error(`[Stash] Compilation failed for ${topic}:`, e);
    }
  }

  // Build topic graph (shared bookmarks between topics)
  const topicGraph = {};
  for (const b of allBookmarks) {
    const topics = b.topics || [];
    for (let i = 0; i < topics.length; i++) {
      if (!topicGraph[topics[i]]) topicGraph[topics[i]] = {};
      for (let j = 0; j < topics.length; j++) {
        if (i !== j) topicGraph[topics[i]][topics[j]] = (topicGraph[topics[i]][topics[j]] || 0) + 1;
      }
    }
  }
  await chrome.storage.local.set({ topicGraph });

  // Update index with concept graph
  await generateIndex(allBookmarks, topicGraph);
}

async function compileTopic(topicSlug, allBookmarks, compilationLog, settings) {
  // Find all bookmarks for this topic
  const topicBookmarks = allBookmarks.filter(b => (b.topics || []).includes(topicSlug));
  if (topicBookmarks.length === 0) return;

  // Check what's already compiled
  const log = compilationLog[topicSlug] || { bookmarkIds: [], lastCompiled: null };
  const newBookmarks = topicBookmarks.filter(b => !log.bookmarkIds.includes(b.id));

  if (newBookmarks.length === 0) {
    console.log(`[Stash] ${topicSlug}: no new bookmarks, skipping`);
    return;
  }

  console.log(`[Stash] Compiling ${topicSlug}: ${newBookmarks.length} new sources (${topicBookmarks.length} total)`);

  // Try to read existing article
  let existingArticle = '';
  try {
    await ensureOffscreen();
    const readResult = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'READ_FILE',
      folder: 'wiki',
      filename: topicSlug,
    });
    if (readResult?.success) existingArticle = readResult.content;
  } catch {}

  // Build compilation prompt
  const topicName = topicSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const sourcesText = newBookmarks.map(b =>
    `- @${b.handle} (${formatDateISO(b.savedAt)}): "${(b.text || b.summary || '').substring(0, 400)}"\n  URL: ${b.url}\n  Tags: ${(b.tags || []).join(', ')}`
  ).join('\n\n');

  // Find related topics for cross-linking
  const graphResult = await chrome.storage.local.get('topicGraph');
  const graph = graphResult.topicGraph || {};
  const relatedTopics = Object.entries(graph[topicSlug] || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);

  const prompt = `You are a knowledge base compiler. You maintain wiki articles synthesized from social media bookmarks.

TOPIC: ${topicName}
RELATED TOPICS (cross-link to these where relevant): ${relatedTopics.map(t => `[[wiki/${t}]]`).join(', ') || 'none yet'}

${existingArticle ? `EXISTING ARTICLE (update incrementally, don't rewrite):\n${existingArticle}\n` : 'This is a NEW article — create it from scratch.'}

NEW SOURCES TO INCORPORATE:
${sourcesText}

INSTRUCTIONS:
1. SYNTHESIZE — turn raw tweets into coherent knowledge, don't just list them.
2. Attribute claims with source links: "According to @author..."
3. ${existingArticle ? 'UPDATE the existing article — add new info in appropriate sections, update the date.' : 'Create the article with the structure below.'}
4. Use this structure:
   - YAML frontmatter: topic, updated, source_count, related_topics
   - ## Overview (2-3 paragraph synthesis)
   - ## Key Insights (bullet points, each attributed to a source)
   - ## Open Questions (what's debated or unknown)
   - ## Sources (list with one-line descriptions)
   - ## Related (wikilinks to other potential wiki topics)
5. Use Obsidian wikilinks: [[wiki/other-topic]] for cross-references.
6. Write in the same language as the majority of the sources.
7. Return ONLY the complete markdown. No commentary outside the article.`;

  const articleContent = await callAI(prompt, settings, settings.digestModel);

  if (!articleContent || articleContent.length < 50) {
    console.warn(`[Stash] Compilation returned empty for ${topicSlug}`);
    return;
  }

  // Save wiki article
  await saveMarkdownFile('wiki', topicSlug, articleContent);

  // Update compilation log
  compilationLog[topicSlug] = {
    lastCompiled: new Date().toISOString(),
    bookmarkIds: topicBookmarks.map(b => b.id),
  };
  await chrome.storage.local.set({ compilationLog });

  // Update topic registry
  const regResult = await chrome.storage.local.get('topicRegistry');
  const registry = regResult.topicRegistry || {};
  if (registry[topicSlug]) {
    registry[topicSlug].lastCompiled = new Date().toISOString();
    await chrome.storage.local.set({ topicRegistry: registry });
  }

  // Mark bookmarks as compiled
  const bkResult = await chrome.storage.local.get('bookmarks');
  const bks = bkResult.bookmarks || {};
  for (const b of topicBookmarks) {
    if (bks[b.id]) {
      bks[b.id].compiledAt = new Date().toISOString();
      if (!bks[b.id].compiledInto) bks[b.id].compiledInto = [];
      if (!bks[b.id].compiledInto.includes(topicSlug)) {
        bks[b.id].compiledInto.push(topicSlug);
      }
    }
  }
  await chrome.storage.local.set({ bookmarks: bks });

  console.log(`[Stash] Compiled wiki/${topicSlug}.md (${topicBookmarks.length} sources)`);
}

async function generateIndex(allBookmarks, topicGraph) {
  const regResult = await chrome.storage.local.get('topicRegistry');
  const registry = regResult.topicRegistry || {};
  const topics = Object.values(registry).sort((a, b) => b.bookmarkCount - a.bookmarkCount);

  if (topics.length === 0) return;

  let md = `---\ntype: index\nupdated: ${new Date().toISOString().split('T')[0]}\n---\n\n`;
  md += `# Stash Knowledge Base\n\n`;
  md += `> Auto-compiled from ${allBookmarks.length} bookmarks across ${topics.length} topics\n\n`;
  md += `## Topics\n\n`;
  md += `| Topic | Sources | Last Compiled |\n|-------|---------|---------------|\n`;

  for (const t of topics) {
    const compiled = t.lastCompiled ? formatDateISO(t.lastCompiled) : 'pending';
    md += `| [[wiki/${t.slug}\\|${t.name}]] | ${t.bookmarkCount} | ${compiled} |\n`;
  }

  // Concept graph
  if (topicGraph && Object.keys(topicGraph).length > 0) {
    md += `\n## Concept Map\n\n`;
    for (const [topic, related] of Object.entries(topicGraph)) {
      const links = Object.entries(related).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([t, count]) => `[[wiki/${t}]] (${count})`).join(', ');
      if (links) md += `- **[[wiki/${topic}]]** → ${links}\n`;
    }
  }

  md += `\n## Recent Captures\n\n`;
  const recent = [...allBookmarks].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)).slice(0, 10);
  for (const b of recent) {
    md += `- [[raw/${formatDateISO(b.savedAt)}/${b.id}\\|@${b.handle}]] ${b.summary || truncate(b.text, 60)}\n`;
  }

  await saveMarkdownFile('', '_index', md);
}

// ---- Q&A System ----

async function askQuestion(question) {
  const settings = await getSettings();
  if (settings.aiProvider !== 'local' && !settings.apiKey) return { answer: 'No API key configured.', sources: [] };
  if (!await checkSpendingLimit()) return { answer: 'Spending limit reached.', sources: [] };

  const bookmarks = Object.values(await getBookmarks());
  const regResult = await chrome.storage.local.get('topicRegistry');
  const registry = regResult.topicRegistry || {};

  // Find relevant topics by keyword matching
  const qWords = question.toLowerCase().split(/\s+/);
  const scored = Object.entries(registry).map(([slug, topic]) => {
    const words = slug.split('-').concat((topic.name || '').toLowerCase().split(/\s+/));
    const score = qWords.filter(w => words.some(tw => tw.includes(w) || w.includes(tw))).length;
    return { slug, topic, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);

  // If no topic match, use all bookmarks as context
  const relevantTopics = scored.length > 0 ? scored.map(s => s.slug) : [];

  // Build context from bookmarks
  const contextBookmarks = relevantTopics.length > 0
    ? bookmarks.filter(b => (b.topics || []).some(t => relevantTopics.includes(t)))
    : bookmarks.slice(0, 20);

  const context = contextBookmarks.map(b =>
    `[@${b.handle}] ${b.summary || truncate(b.text, 200)} (${(b.tags || []).join(', ')})`
  ).join('\n');

  // Read wiki articles — try panel first (has permission), fallback to offscreen
  let wikiContext = '';
  let wikiCount = 0;
  for (const slug of relevantTopics.slice(0, 3)) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'READ_WIKI', folder: 'wiki', filename: slug });
      if (r?.success && r.content) {
        wikiContext += `\n\n--- Wiki: ${slug} ---\n${r.content.substring(0, 2000)}`;
        wikiCount++;
      }
    } catch {
      // Try offscreen fallback
      try {
        await ensureOffscreen();
        const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'READ_FILE', folder: 'wiki', filename: slug });
        if (r?.success && r.content) { wikiContext += `\n\n--- Wiki: ${slug} ---\n${r.content.substring(0, 2000)}`; wikiCount++; }
      } catch {}
    }
  }

  const prompt = `You are a knowledge base assistant. Answer the question using ONLY the data provided below. Cite sources with @handle when referencing specific bookmarks. If the data is insufficient, say what's missing.

WIKI ARTICLES:${wikiContext || '\n(No compiled articles yet)'}

RAW BOOKMARKS (${contextBookmarks.length} sources):
${context}

QUESTION: ${question}

Answer concisely in the same language as the question. Use markdown formatting.`;

  const answer = await callAI(prompt, settings, settings.digestModel);

  // Save Q&A to vault
  const date = new Date().toISOString().split('T')[0];
  const slug = question.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '-').substring(0, 40);
  const qaMd = `---\ntype: qa\nquestion: "${question.replace(/"/g, "'")}"\ndate: ${date}\nsources: [${relevantTopics.map(t => `"${t}"`).join(', ')}]\n---\n\n# ${question}\n\n${answer}\n\n---\n_Sources: ${relevantTopics.map(t => `[[wiki/${t}]]`).join(', ') || 'general bookmarks'}_`;
  await saveMarkdownFile(`wiki/qa`, `${date}-${slug}`, qaMd);

  return { answer, sources: relevantTopics, wikiCount, bookmarkCount: contextBookmarks.length, filename: `wiki/qa/${date}-${slug}.md` };
}

// ---- Linting / Health Checks ----

async function runLint() {
  const bookmarks = Object.values(await getBookmarks());
  const regResult = await chrome.storage.local.get('topicRegistry');
  const registry = regResult.topicRegistry || {};
  const logResult = await chrome.storage.local.get('compilationLog');
  const compilationLog = logResult.compilationLog || {};

  const issues = [];

  // 1. Gap detection: topics with bookmarks but no compiled article
  for (const [slug, topic] of Object.entries(registry)) {
    if (topic.bookmarkCount >= 2 && !topic.lastCompiled) {
      issues.push({ type: 'gap', severity: 'warning', topic: slug,
        message: `${topic.bookmarkCount} bookmarks about "${topic.name}" but no wiki article` });
    }
  }

  // 2. Stale articles: new bookmarks since last compile
  for (const [slug, topic] of Object.entries(registry)) {
    if (topic.lastCompiled && topic.lastUpdated > topic.lastCompiled) {
      const log = compilationLog[slug];
      const totalBm = bookmarks.filter(b => (b.topics || []).includes(slug)).length;
      const compiled = log?.bookmarkIds?.length || 0;
      const newCount = totalBm - compiled;
      if (newCount > 0) {
        issues.push({ type: 'stale', severity: 'info', topic: slug,
          message: `"${topic.name}" has ${newCount} new source${newCount > 1 ? 's' : ''} since last compile` });
      }
    }
  }

  // 3. Orphan bookmarks: no topics assigned
  const orphans = bookmarks.filter(b => !b.topics || b.topics.length === 0);
  if (orphans.length > 0) {
    issues.push({ type: 'orphan', severity: 'info',
      message: `${orphans.length} bookmark${orphans.length > 1 ? 's' : ''} without topic assignment` });
  }

  // 4. Missing connections: topics that share bookmarks but aren't linked
  const topicPairs = {};
  for (const b of bookmarks) {
    const topics = b.topics || [];
    for (let i = 0; i < topics.length; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        const key = [topics[i], topics[j]].sort().join('|');
        topicPairs[key] = (topicPairs[key] || 0) + 1;
      }
    }
  }
  for (const [pair, count] of Object.entries(topicPairs)) {
    if (count >= 2) {
      const [a, b] = pair.split('|');
      issues.push({ type: 'connection', severity: 'info',
        message: `"${a}" and "${b}" share ${count} sources — consider cross-linking` });
    }
  }

  return { issues, total: issues.length };
}

// ---- File saving ----

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.() || false;
  if (!existing) {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Write files to Obsidian vault via FileSystemDirectoryHandle',
      });
    } catch (e) {
      // Document might already exist
      if (!e.message?.includes('already exists')) {
        console.error('[Stash] Offscreen creation failed:', e);
      }
    }
  }
}

// File write queue — panel drains this when it's open
const writeQueue = [];

async function saveMarkdownFile(folder, filename, content) {
  // Queue the write — panel will process it
  writeQueue.push({ folder, filename, content });
  // Try to send to panel immediately
  try {
    await chrome.runtime.sendMessage({ type: 'WRITE_FILES', files: writeQueue.splice(0) });
    return true;
  } catch {
    // Panel not open — files stay in queue, will be drained when panel opens
    console.log('[Stash] Write queued (panel not open):', folder ? `${folder}/${filename}.md` : `${filename}.md`);
    return true; // Don't report failure — it's queued
  }
}

// Panel requests pending writes on load
function getPendingWrites() {
  return writeQueue.splice(0);
}

// ---- Obsidian URI (manual only, from popup) ----

function buildObsidianUri(vaultName, folderName, filename, content) {
  const filePath = folderName ? `${folderName}/${filename}` : filename;
  const params = new URLSearchParams({
    vault: vaultName,
    file: filePath,
    content: content,
  });
  return `obsidian://new?${params.toString()}`;
}

// ---- Side panel: open on icon click ----

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onInstalled.addListener((details) => {
  // Enable side panel on all pages
  chrome.sidePanel.setOptions({ enabled: true });
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

// ---- Main message handler ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Skip messages meant for offscreen document
  if (message.target === 'offscreen') return false;

  if (message.type === 'BOOKMARK_CREATED') {
    handleBookmark(message.tweet).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'GET_BOOKMARKS') {
    getBookmarks().then(bookmarks => {
      sendResponse({ bookmarks });
    });
    return true;
  }

  if (message.type === 'DELETE_BOOKMARK') {
    deleteBookmark(message.id).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'RESYNC_TO_OBSIDIAN') {
    resyncBookmark(message.id).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'OPEN_IN_OBSIDIAN') {
    openInObsidian(message.id).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'GENERATE_DIGEST') {
    generateDigest(message.period || 'day').then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'COMPILE_TOPIC') {
    compileTopics([message.topic]).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'COMPILE_ALL') {
    (async () => {
      const reg = await chrome.storage.local.get('topicRegistry');
      const topics = Object.keys(reg.topicRegistry || {});
      if (topics.length === 0) { sendResponse({ success: false, error: 'No topics' }); return; }
      await compileTopics(topics);
      sendResponse({ success: true, count: topics.length });
    })();
    return true;
  }

  if (message.type === 'GET_TOPICS') {
    chrome.storage.local.get('topicRegistry').then(r => {
      sendResponse({ topics: r.topicRegistry || {} });
    });
    return true;
  }

  if (message.type === 'GET_USAGE') {
    getUsage().then(usage => sendResponse({ usage }));
    return true;
  }

  if (message.type === 'ASK_QUESTION') {
    askQuestion(message.question).then(r => sendResponse(r));
    return true;
  }

  if (message.type === 'RUN_LINT') {
    runLint().then(r => sendResponse(r));
    return true;
  }

  if (message.type === 'GET_PENDING_WRITES') {
    sendResponse({ files: getPendingWrites() });
    return true;
  }

  if (message.type === 'MARK_VIEWED') {
    (async () => {
      const result = await chrome.storage.local.get('bookmarks');
      const bookmarks = result.bookmarks || {};
      if (bookmarks[message.id]) {
        bookmarks[message.id].lastViewedAt = new Date().toISOString();
        bookmarks[message.id].viewCount = (bookmarks[message.id].viewCount || 0) + 1;
        await chrome.storage.local.set({ bookmarks });
      }
      sendResponse({ success: true });
    })();
    return true;
  }
});

async function handleBookmark(rawTweet) {
  try {
    const settings = await getSettings();
    const tweet = normalizeTweet(rawTweet);
    tweet.savedAt = new Date().toISOString();

    // Preserve source platform
    tweet.source = rawTweet.source || 'twitter';
    tweet.category = 'Uncategorized';
    tweet.summary = '';

    // Save immediately so it appears in the panel right away
    await saveBookmark(tweet);
    console.log('[Stash] Bookmark saved:', tweet.id);

    // AI analysis (async — updates the bookmark after)
    const withinBudget = await checkSpendingLimit();
    const isLocal = settings.aiProvider === 'local';
    const hasKey = isLocal || settings.apiKey;
    if (settings.enableAiTagging && hasKey && tweet.text && (isLocal || withinBudget)) {
      console.log('[Stash] Calling AI...');
      try {
        const analysis = await analyzePost(tweet.text, settings);
        if (analysis) {
          tweet.tags = analysis.tags;
          tweet.topics = analysis.topics || [];
          tweet.category = analysis.category;
          tweet.summary = analysis.summary;
          // Re-save with AI data
          await saveBookmark(tweet);
          console.log('[Stash] AI updated:', analysis.category, analysis.topics);
        }
      } catch (e) {
        console.warn('[Stash] AI failed:', e.message);
      }
    }

    // Write raw .md file to vault: raw/{date}/{tweetId}.md
    if (settings.autoSaveFile) {
      const markdown = tweetToRawMarkdown(tweet);
      const dateFolder = formatDateISO(tweet.savedAt);
      const saved = await saveMarkdownFile(`raw/${dateFolder}`, tweet.id, markdown);
      if (!saved) {
        console.warn('[Stash] Raw file not saved — vault permission may be expired');
      }
    }

    // Always update topic registry and queue compilation (independent of file write)
    if (tweet.topics && tweet.topics.length > 0) {
      await updateTopicRegistry(tweet);
      queueCompilation(tweet.topics);
    }

    // Update badge briefly
    await chrome.action.setBadgeText({ text: '\u2713' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 2000);

    console.log('[X-Bookmarks] Saved bookmark:', tweet.id);
    return { success: true, tweet };
  } catch (e) {
    console.error('[X-Bookmarks] Failed to save bookmark:', e);
    return { success: false, error: e.message };
  }
}

async function deleteBookmark(id) {
  const result = await chrome.storage.local.get('bookmarks');
  const bookmarks = result.bookmarks || {};
  delete bookmarks[id];
  await chrome.storage.local.set({ bookmarks });
}

async function resyncBookmark(id) {
  const settings = await getSettings();
  const result = await chrome.storage.local.get('bookmarks');
  const bookmarks = result.bookmarks || {};
  const tweet = bookmarks[id];

  if (!tweet) {
    return { success: false, error: 'Bookmark not found' };
  }

  const markdown = tweetToMarkdown(tweet);
  const filename = generateFilename(tweet);
  const saved = await saveMarkdownFile(tweet.category || 'Uncategorized', filename, markdown);
  return { success: saved, error: saved ? null : 'No vault folder configured' };
}

async function openInObsidian(id) {
  const settings = await getSettings();
  const result = await chrome.storage.local.get('bookmarks');
  const bookmarks = result.bookmarks || {};
  const tweet = bookmarks[id];

  if (!tweet) {
    return { success: false, error: 'Bookmark not found' };
  }

  // Re-save raw file to vault
  const markdown = tweetToRawMarkdown(tweet);
  const dateFolder = formatDateISO(tweet.savedAt);
  await saveMarkdownFile(`raw/${dateFolder}`, tweet.id, markdown);

  // Open via obsidian:// URI
  if (settings.vaultName) {
    const uri = buildObsidianUri(settings.vaultName, `raw/${dateFolder}`, tweet.id, markdown);
    await chrome.tabs.create({ url: uri, active: false });
  } else {
    // No vault name — just open the tweet URL
    await chrome.tabs.create({ url: tweet.url });
  }
  return { success: true };
}

// ---- Daily Digest ----

async function generateDigest(period) {
  try {
    const settings = await getSettings();
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const bookmarks = await getBookmarks();
    const all = Object.values(bookmarks);

    // Calculate date range
    let startDate, periodLabel, filename, folder;
    if (period === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() - d.getDay()); // Start of week (Sunday)
      startDate = d.toISOString().split('T')[0];
      periodLabel = `Semana del ${formatDateSpanish(startDate)}`;
      filename = `${getWeekId(today)}`;
      folder = 'Weekly';
    } else if (period === 'month') {
      startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
      periodLabel = `${months[now.getMonth()]} ${now.getFullYear()}`;
      filename = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      folder = 'Monthly';
    } else {
      startDate = today;
      periodLabel = formatDateSpanish(today);
      filename = today;
      folder = 'Daily';
    }

    const dayBookmarks = all.filter(b => {
      const saved = (b.savedAt || '').split('T')[0];
      return saved >= startDate && saved <= today;
    });

    if (dayBookmarks.length === 0) {
      return { success: false, error: `No hay bookmarks para ${periodLabel}` };
    }

    // Group by category
    const byCategory = {};
    for (const b of dayBookmarks) {
      const cat = b.category || 'Otros';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(b);
    }

    const twitterCount = dayBookmarks.filter(b => b.source !== 'linkedin').length;
    const linkedinCount = dayBookmarks.filter(b => b.source === 'linkedin').length;
    const weekId = getWeekId(today);

    // Build detailed context for AI
    const bookmarkDetails = dayBookmarks.map((b, i) => {
      const src = b.source === 'linkedin' ? 'LinkedIn' : 'X/Twitter';
      const tags = (b.tags || []).join(', ');
      return `${i + 1}. [${src}] @${b.handle} (${b.category || 'Sin categoria'})
   "${b.text?.substring(0, 300) || b.summary || ''}"
   Tags: ${tags || 'ninguno'}`;
    }).join('\n\n');

    // Generate AI analysis with the smart model
    let aiContent = '';
    if (settings.apiKey) {
      const prompt = `Eres un asistente de knowledge management para un desarrollador de software que trabaja en proyectos de AI y tecnologia.

Analiza estos ${dayBookmarks.length} bookmarks guardados (${periodLabel}) y genera un resumen estructurado EN ESPAÑOL con formato Markdown.

El briefing debe tener EXACTAMENTE estas secciones:

## Resumen
Un parrafo corto (3-4 oraciones) que capture la esencia del dia: que temas dominaron, que es lo mas importante y por que.

## Tendencias Clave
Lista de 3-5 tendencias o temas principales que se repiten. Para cada una:
- **Nombre de la tendencia** — explicacion en 1-2 oraciones, mencionando cuales bookmarks la sustentan.

## Relevante para Mis Proyectos
Lista de insights directamente accionables para un desarrollador. Para cada uno:
- **Que**: descripcion concreta
- **Por que importa**: impacto potencial
- **Accion sugerida**: siguiente paso concreto

## Para Profundizar
Los 3 bookmarks mas importantes que merecen lectura completa, con una oracion explicando por que cada uno es valioso.

## Conexiones
Relaciones no obvias entre bookmarks de distintas categorias o fuentes (X vs LinkedIn).

IMPORTANTE:
- Se directo y concreto, no generico
- Cada punto debe ser accionable o informativo
- No repitas el contenido textual de los bookmarks, sintetiza
- Escribe en espanol

Bookmarks del dia:
${bookmarkDetails}`;

      aiContent = await callAI(prompt, settings, settings.digestModel);
      console.log('[Stash] Digest AI done, length:', aiContent.length);
    }

    // Build final markdown document
    let md = `---
type: daily-digest
date: ${today}
week: "${weekId}"
total: ${dayBookmarks.length}
twitter: ${twitterCount}
linkedin: ${linkedinCount}
tags:
  - daily-digest
  - ${today}
categories: [${Object.keys(byCategory).map(c => `"${c}"`).join(', ')}]
---

# ${periodLabel}

> **${dayBookmarks.length}** bookmarks guardados — ${twitterCount} de X/Twitter, ${linkedinCount} de LinkedIn

`;

    // AI analysis
    if (aiContent) {
      md += aiContent + '\n\n';
    }

    // Reference: all bookmarks grouped by category
    md += `---\n\n## Fuentes del Dia\n\n`;

    for (const [category, items] of Object.entries(byCategory).sort()) {
      md += `### ${category}\n\n`;
      md += `| Fuente | Autor | Nota | Tags |\n`;
      md += `|--------|-------|------|------|\n`;
      for (const b of items) {
        const src = b.source === 'linkedin' ? 'LinkedIn' : 'X';
        const filename = generateFilename(b);
        const summary = b.summary || truncate(b.text, 60);
        const tags = (b.tags || []).map(t => `\`${t}\``).join(' ');
        md += `| ${src} | [[${category}/${filename}\\|@${b.handle}]] | ${summary} | ${tags} |\n`;
      }
      md += '\n';
    }

    // Navigation
    md += `---\n\n`;
    md += `> [!nav] Navegacion\n`;
    md += `> [[Weekly/${weekId}]] · `;
    // Previous day link
    const prevDate = new Date(today);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevStr = prevDate.toISOString().split('T')[0];
    md += `[[Daily/${prevStr}|← Dia anterior]]\n`;

    // Save to vault
    const saved = await saveMarkdownFile(folder, filename, md);

    return { success: true, saved, count: dayBookmarks.length, filename: `${folder}/${filename}.md` };
  } catch (e) {
    console.error('[Stash] Digest generation failed:', e);
    return { success: false, error: e.message };
  }
}

function formatDateSpanish(dateStr) {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const d = new Date(dateStr + 'T12:00:00');
  return `${days[d.getDay()]} ${d.getDate()} de ${months[d.getMonth()]}, ${d.getFullYear()}`;
}

async function callAI(prompt, settings, model) {
  try {
    if (settings.aiProvider === 'claude') {
      return await callClaude(prompt, settings.apiKey, model);
    } else if (settings.aiProvider === 'openai') {
      return await callOpenAI(prompt, settings.apiKey, model);
    } else if (settings.aiProvider === 'openrouter') {
      return await callOpenRouter(prompt, settings.apiKey, model);
    } else if (settings.aiProvider === 'local') {
      return await callLocal(prompt, settings.localServerUrl, model);
    }
    return '';
  } catch {
    return '';
  }
}

console.log('[Stash] Service worker loaded');
