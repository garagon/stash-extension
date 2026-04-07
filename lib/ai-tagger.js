// AI auto-tagging via Claude API (optional)
// Uses claude-haiku-4-5 for speed and low cost

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

export async function generateTags(tweetText, apiKey) {
  if (!apiKey || !tweetText) return [];

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `Generate 3-5 short, specific tags for this tweet. Tags should be lowercase, single words or hyphenated phrases useful for organizing a personal knowledge base. Return ONLY a JSON array of strings, nothing else.

Tweet: "${tweetText}"`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.debug('[X-Bookmarks] Claude API error:', response.status);
      return [];
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const tags = JSON.parse(match[0]);
      return tags
        .filter(t => typeof t === 'string')
        .map(t => t.toLowerCase().replace(/\s+/g, '-'))
        .slice(0, 5);
    }

    return [];
  } catch (e) {
    console.debug('[X-Bookmarks] AI tagging failed:', e);
    return [];
  }
}
