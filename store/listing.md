# Chrome Web Store Listing — Stash

## Short Description (132 chars max)
Capture X bookmarks, AI-tag them, build a knowledge base in Obsidian

## Detailed Description

Stash captures your X/Twitter bookmarks and turns them into a structured knowledge base in Obsidian.

When you bookmark a tweet, Stash grabs it, runs it through an AI for categorization, and writes a Markdown note to your Obsidian vault. Over time, related bookmarks get compiled into wiki-style articles by topic. You can ask questions against your bookmarks and get sourced answers.

**What it does:**
- Detects when you bookmark a tweet on X
- AI assigns category, tags, topics, and a one-line summary
- Saves a raw note to your vault (raw/{date}/{id}.md)
- Compiles related bookmarks into wiki articles (wiki/{topic}.md)
- Q&A: ask questions, get answers sourced from your bookmarks
- Generates daily/weekly/monthly digests
- Runs health checks on your knowledge base

**What you need:**
- Obsidian installed (obsidian.md) with Obsidian CLI
- An API key from Claude, OpenAI, or OpenRouter
- A folder in your vault selected via the extension

**How files are organized:**

```
your-vault/
├── raw/2026-04-06/{tweetId}.md
├── wiki/ai-agents.md
├── wiki/qa/2026-04-06-question.md
├── digests/daily/2026-04-06.md
└── _index.md
```

**Supported providers:**
- Claude (Anthropic) — Haiku for tagging, Sonnet/Opus for compilation
- OpenAI — GPT-4o Mini for tagging, GPT-4o for compilation
- OpenRouter — any model

**Cost control:** set a monthly spending limit. AI stops when you hit it.

**Privacy:** everything is local. No servers, no accounts, no tracking. Your API key goes directly to your chosen provider. Source code: github.com/garagon/stash-extension

---

## Category
Productivity

## Language
English

## Permission Justifications

### Host permission: x.com, twitter.com
Needed to detect bookmark actions and capture tweet content.

### Host permission: api.anthropic.com, api.openai.com, openrouter.ai
Needed to send tweet text to the user's AI provider for categorization and compilation. Only active when the user sets up their own API key.

### Permission: storage, unlimitedStorage
Stores bookmarks, topic registry, and settings locally.

### Permission: sidePanel
Shows the Stash panel in Chrome's side panel.

### Permission: offscreen
Reads files from the vault for wiki compilation and Q&A.

### Permission: tabs
Opens tweet URLs when clicking "Open on X".

### Permission: notifications
Brief confirmation when a bookmark is captured.
