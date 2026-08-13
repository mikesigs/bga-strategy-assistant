# BGA Strategy Assistant

A Chromium Manifest V3 browser extension that opens as a **side panel** alongside a [BoardGameArena](https://boardgamearena.com) game tab. Ask strategy questions in natural language and receive AI-powered answers grounded in the game's rulebook and BoardGameGeek forum discussions.

---

## Features (planned)

- **Game state awareness** — reads the current game name, player scores, and active phase from the BGA DOM
- **Rulebook context** — automatically downloads and caches the English rulebook PDF for the detected game
- **LLM-powered answers** — uses OpenAI (`gpt-4o`) or Anthropic (`claude-3-5-sonnet`), user-selectable
- **BGG strategy search** — the LLM can invoke a `search_bgg` tool to pull in relevant forum discussions
- **Local API key storage** — keys are stored in `chrome.storage.local`, never leave your browser

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A Chromium browser (Chrome, Edge, or Brave)
- An OpenAI or Anthropic API key

### Install and build

```bash
npm install
npm run build
```

This produces a `dist/` folder ready to load as an unpacked extension.

### Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked** and select the `dist/` folder
4. Navigate to a BoardGameArena game — the extension icon will appear in the toolbar

### Configure API keys

1. Open the side panel by clicking the extension icon on a BGA tab
2. Click the **Settings** gear icon
3. Enter your OpenAI and/or Anthropic API key
4. Select your preferred provider and click **Save**

---

## Development

```bash
npm run dev   # Vite watch mode — rebuilds dist/ on every file change
```

Reload the extension in `chrome://extensions` after each rebuild, or install the [Extensions Reloader](https://chrome.google.com/webstore/detail/extensions-reloader/fimgfedafeadlieiabdeeaodndnlbhid) extension to speed up the cycle.

---

## Project structure

```
manifest.json          MV3 manifest
src/
  sidepanel/           Side panel UI (HTML + TypeScript)
  background/          Service worker (PDF fetch, LLM calls)
  content/             Content script (DOM scraping)
public/                Static assets (icons)
dist/                  Build output — load this as an unpacked extension
```

---

## Status

Implementation is in progress. See [`bga-strategy-assistant-plan.md`](./bga-strategy-assistant-plan.md) for the full sub-task breakdown.
