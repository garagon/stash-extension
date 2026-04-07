// Converts a normalized tweet object to Obsidian-flavored Markdown

export function tweetToMarkdown(tweet, template = 'default') {
  const frontmatter = buildFrontmatter(tweet);
  const body = buildBody(tweet);
  return `${frontmatter}\n${body}\n`;
}

function buildFrontmatter(tweet) {
  const tags = tweet.tags.length > 0
    ? `\ntags:\n${tweet.tags.map(t => `  - ${t}`).join('\n')}`
    : '\ntags: []';

  const lines = [
    '---',
    `source: twitter`,
    `tweet_id: "${tweet.id}"`,
    `author: "${tweet.author}"`,
    `handle: "@${tweet.handle}"`,
    `date: ${formatDateISO(tweet.createdAt)}`,
    `saved: ${formatDateISO(tweet.savedAt)}`,
    `url: ${tweet.url}`,
    tags,
    `likes: ${tweet.metrics.likes}`,
    `retweets: ${tweet.metrics.retweets}`,
    `replies: ${tweet.metrics.replies}`,
    tweet.metrics.views ? `views: ${tweet.metrics.views}` : null,
    '---',
  ];

  return lines.filter(Boolean).join('\n');
}

function buildBody(tweet) {
  const parts = [];

  // Title
  parts.push(`# @${tweet.handle}: ${truncate(tweet.text, 80)}\n`);

  // User note
  if (tweet.userNote) {
    parts.push(`> [!note] My Note`);
    parts.push(`> ${tweet.userNote}\n`);
  }

  // Tweet content
  parts.push(`## Tweet\n`);
  parts.push(`> ${tweet.text.split('\n').join('\n> ')}\n`);
  parts.push(`\u2014 **${tweet.author}** ([@${tweet.handle}](https://x.com/${tweet.handle})) \u2022 [${formatDateHuman(tweet.createdAt)}](${tweet.url})\n`);

  // Media
  if (tweet.mediaUrls.length > 0) {
    parts.push(`## Media\n`);
    for (const media of tweet.mediaUrls) {
      if (media.type === 'photo') {
        const alt = media.alt || `Image from @${tweet.handle}`;
        parts.push(`![${alt}](${media.url})\n`);
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        parts.push(`[Video](${media.url})\n`);
      }
    }
  }

  // Quoted tweet
  if (tweet.quotedTweet) {
    const qt = tweet.quotedTweet;
    parts.push(`## Quoted Tweet\n`);
    parts.push(`> ${qt.text.split('\n').join('\n> ')}`);
    parts.push(`> \u2014 **${qt.author}** ([@${qt.handle}](https://x.com/${qt.handle})) \u2022 [Link](${qt.url})\n`);
  }

  // Metrics
  parts.push(`## Metrics\n`);
  parts.push(`| Likes | Retweets | Replies | Views |`);
  parts.push(`|-------|----------|---------|-------|`);
  parts.push(`| ${tweet.metrics.likes} | ${tweet.metrics.retweets} | ${tweet.metrics.replies} | ${tweet.metrics.views || 'N/A'} |\n`);

  // Source link
  parts.push(`---`);
  parts.push(`*Saved by [Stash](${tweet.url})*`);

  return parts.join('\n');
}

function formatDateISO(dateStr) {
  try {
    return new Date(dateStr).toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

function formatDateHuman(dateStr) {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Unknown date';
  }
}

function truncate(text, maxLen) {
  if (!text) return '';
  const cleaned = text.replace(/\n/g, ' ');
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen) + '...';
}
