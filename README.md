# Stash

Capture X bookmarks, AI-tag them, build a knowledge base in Obsidian.

When you bookmark a post on X, Stash grabs it, runs it through an AI for categorization, and writes a Markdown note to your Obsidian vault. Related bookmarks get compiled into wiki articles by topic. You can ask questions against your bookmarks, generate periodic summaries, and run health checks on your knowledge base.

Follows [Karpathy's LLM Knowledge Base pattern](https://x.com/karpathy): raw data → compiled wiki → Q&A → knowledge compounds.

## How it works

**Capture** — Stash intercepts the bookmark action on X. No manual export, no copy-paste. The moment you hit the bookmark icon, the post is captured with full text, author, media, metrics, and quoted posts.

**AI Analysis** — Each bookmark is analyzed by your chosen AI. It gets a category (AI, Programming, Tech, Business, etc.), specific tags, topic slugs for wiki compilation, and a one-line summary. This happens in the background — the bookmark appears in your feed instantly, AI enrichment follows.

**Raw Notes** — Every bookmark is saved as a Markdown file in `raw/{date}/{id}.md` with full YAML frontmatter, wikilinks to related wiki articles, and embedded images. These are append-only — your raw data is never modified.

**Wiki Compilation** — 30 seconds after a bookmark is saved, Stash compiles related bookmarks into wiki-style articles under `wiki/`. If you bookmark 10 posts about AI agents over a week, they get synthesized into one `wiki/ai-agents.md` article with attributed insights, cross-references to other topics, and source links back to raw notes. Articles update incrementally — new bookmarks get folded in, not rewritten from scratch.

**Q&A** — The Ask tab lets you query your knowledge base. Stash reads relevant wiki articles and raw bookmarks, sends them as context to the AI, and returns an answer with source citations. Answers are saved back to `wiki/qa/` so your explorations compound over time.

**Summaries** — Generate daily, weekly, or monthly digests. The AI analyzes all bookmarks in the period, identifies trends, surfaces insights relevant to your projects, and highlights what deserves deeper reading. Summaries are saved to `digests/`.

**Health Checks** — Run a lint pass over your knowledge base. Stash detects uncompiled topics (bookmarks without a wiki article), stale articles (new sources since last compile), orphan bookmarks (no topic assigned), and missing cross-links between related topics. Zero AI cost — purely mechanical.

**Concept Map** — The `_index.md` file is auto-maintained with a topic table, a concept map showing relationships between topics (based on shared bookmarks), and a list of recent captures.

## Side Panel

Stash runs as a Chrome side panel with four tabs:

- **Feed** — chronological list of bookmarks with search, date grouping, and lazy loading
- **Ask** — chat interface to query your knowledge base
- **Discover** — weekly stats, topic breakdown, top authors
- **Settings** — vault folder, AI provider, model selection, usage tracking, spending limit, health checks, export, reset

## Vault structure

```
your-vault/
├── raw/
│   └── 2026-04-06/
│       └── {id}.md           # one file per bookmark
├── wiki/
│   ├── ai-agents.md          # compiled article
│   ├── prompt-engineering.md
│   └── qa/
│       └── 2026-04-06-q.md   # Q&A answers
├── digests/
│   ├── daily/
│   ├── weekly/
│   └── monthly/
└── _index.md                  # auto-maintained index + concept map
```

## Providers

| Provider | Tagging | Wiki / Q&A | Cost |
|----------|---------|------------|------|
| Claude | Haiku 4.5 | Sonnet 4.6 / Opus 4.6 | Paid |
| OpenAI | GPT-4o Mini | GPT-4o | Paid |
| OpenRouter | Any | Any | Paid |
| Local | llama-server / Ollama / LM Studio | Same | Free |

Two models are configured independently: a fast/cheap one for tagging (runs on every bookmark) and a smarter one for wiki compilation, Q&A, and digests.

Local mode connects to any OpenAI-compatible server on your machine:

```
llama-server -hf ggml-org/gemma-4-26B-A4B-it-GGUF:Q4_K_M
```

## Spending controls

Set a monthly dollar limit in Settings. Stash tracks estimated cost per API call by model. When the limit is reached, AI processing pauses — bookmarks still get captured but without categorization or compilation. Local AI is always free and exempt from limits.

Usage is broken down by cloud (with cost) and local (free) in Settings.

## Requirements

- [Obsidian](https://obsidian.md) + [Obsidian CLI](https://obsidian.md/cli)
- API key from [Claude](https://console.anthropic.com), [OpenAI](https://platform.openai.com), or [OpenRouter](https://openrouter.ai) — or a local server

## Install

**Chrome Web Store** — coming soon

**From source:**
1. Clone this repo
2. `chrome://extensions` → Developer Mode → Load unpacked
3. Click the Stash icon → Settings → select vault folder and configure AI

## Architecture

```
injected.js → content.js → background.js → panel/
(patches fetch)  (bridge)    (AI + compile)   (UI + file writer)
```

- `injected.js` runs in the page's MAIN world, patches `fetch` to detect `CreateBookmark` GraphQL calls
- `content.js` bridges messages from the page to the service worker, validates origin
- `background.js` handles AI tagging, wiki compilation, Q&A, digests, topic registry, health checks
- `panel/` renders the side panel UI and writes files to the vault via FileSystemDirectoryHandle

## Security

- API keys stored in `chrome.storage.local` (device-only, not synced)
- postMessage origin validated against allowed domains
- No remote code execution, no eval
- All data local, no telemetry

## Privacy

No servers, no accounts, no tracking. AI calls go directly from your browser to your chosen provider with your key. [Full privacy policy](store/privacy-policy.md).

## License

Apache 2.0
