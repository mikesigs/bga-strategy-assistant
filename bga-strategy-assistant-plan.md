# BGA Strategy Assistant — Chrome Extension Plan

## Top-Level Overview

Build a Chromium Manifest V3 browser extension that opens as a **side panel** alongside a BoardGameArena.com game tab. The user can ask strategy questions in natural language. The extension:

1. Reads the current game state from the active BGA tab's DOM (no JS globals available)
2. Supplies that game state as context to an LLM (OpenAI or Anthropic, user-selectable)
3. Gives the LLM a web-search tool call so it can query BoardGameGeek forums for strategy tips
4. Downloads and caches the English rulebook PDF for the detected game; parses it and injects relevant sections as context
5. Stores API keys, LLM preference, and cached rulebooks in `chrome.storage.local`

The extension is **greenfield** — no existing codebase to integrate with. The target browser is any Chromium browser (Chrome, Edge, Brave).

---

## Architecture Diagram (described)

```
BGA Tab (content script)
  └─ Extracts game name + state snapshot
  └─ Detects "How to Play" PDF links
  └─ Sends messages to side panel via chrome.runtime

Side Panel (React or vanilla JS)
  ├─ Chat UI (user prompt + LLM response thread)
  ├─ Settings panel (API keys, LLM selection)
  └─ Rulebook status indicator

Service Worker (background)
  ├─ Fetches rulebook PDFs via fetch()
  ├─ Parses PDF text with pdf.js
  ├─ Stores rulebook text in chrome.storage.local keyed by game name
  ├─ Proxies LLM API calls (handles CORS for Anthropic)
  └─ Handles BGG web search tool calls

chrome.storage.local
  ├─ { openai_api_key, anthropic_api_key, selected_provider }
  └─ { rulebook_<gameName>: { text, fetchedAt } }
```

---

## Sub-Tasks

---

### Sub-Task 1 — Project Scaffold and Manifest

**Intent**
Establish the extension project structure with Manifest V3, all required permissions, and a working build pipeline. This is the foundation everything else builds on.

**Expected Outcomes**
- `manifest.json` declares `sidePanel`, `storage`, `activeTab`, `scripting`, and `host_permissions` for `*.boardgamearena.com`, `api.openai.com`, `api.anthropic.com`, `boardgamegeek.com`
- A build script (Vite or esbuild) compiles the side panel UI and service worker
- Loading the unpacked extension in Chrome opens a side panel icon on BGA tabs
- Directory structure is in place for all subsequent sub-tasks

**Todo List**
- [ ] Create `manifest.json` (MV3) with: `name`, `version`, `manifest_version: 3`, `permissions: ["sidePanel","storage","activeTab","scripting"]`, `host_permissions`, `side_panel.default_path`, `background.service_worker`, `content_scripts` entry for BGA
- [ ] Create project directories: `src/sidepanel/`, `src/background/`, `src/content/`, `public/`, `dist/`
- [ ] Add `package.json` with dev dependencies: `vite` (or `esbuild`), `pdfjs-dist`, and a bundler plugin for multi-entry Chrome extensions (e.g. `@crxjs/vite-plugin`)
- [ ] Configure build to output `dist/` with `manifest.json`, bundled side panel HTML/JS, service worker JS, and content script JS
- [ ] Verify the unpacked extension loads in Chrome without errors

**Relevant Context**
- MV3 side panel requires `"side_panel"` in `permissions` and `"side_panel": { "default_path": "sidepanel.html" }` in the manifest
- `@crxjs/vite-plugin` handles multi-entry bundling and manifest rewriting automatically
- Content scripts on `https://*.boardgamearena.com/game*` and `https://*.boardgamearena.com/table*`

**Status** — `[x] done`

---

### Sub-Task 2 — Content Script: Game State Extraction

**Intent**
Inject a content script into BGA game tabs that reads the current game name and a snapshot of the visible game state (player scores, current player, phase, board summary) from the DOM and/or BGA's JS globals, then makes it available to the side panel.

**Expected Outcomes**
- Content script detects when a BGA game tab is active
- Extracts: game name (from page title or URL slug), current player, player list with scores, current game phase/round, and any visible board information readable from the DOM
- Exposes the extracted state via `chrome.runtime.sendMessage` / `chrome.runtime.onMessage` so the side panel can request a fresh snapshot on demand
- Falls back gracefully when state cannot be determined (e.g. between turns, loading screens)

**Todo List**
- [ ] Identify BGA game URL patterns (`/game` and `/table` routes) and confirm content script injection targets
- [ ] DOM-scrape the score panel, player cards, active player indicator, and game log — there are no reliable JS globals to read
- [ ] Parse the page `<title>` or URL slug to extract the canonical game name (e.g. `carcassonne`, `7wonders`)
- [ ] Implement a `getGameState()` function that returns a JSON-serializable snapshot built entirely from DOM elements
- [ ] Register a `chrome.runtime.onMessage` listener for `{ type: "GET_GAME_STATE" }` that responds with the snapshot
- [ ] Test against at least one active BGA game to verify extracted fields are meaningful

**Relevant Context**
- `window.gameui` is not available in the content script context (BGA does not expose game state as accessible JS globals)
- Game state must be inferred from stable DOM landmarks: player score panels, the active-player highlight, the game log (`#game_log`), and the page title
- URL pattern for active games: `https://boardgamearena.com/[number]/[gamename]` or `https://boardgamearena.com/table?table=[id]`
- The game log div (`#game_log`) and player panels (`#player_boards`) are consistent DOM landmarks across BGA games and are the primary source of state

**Post-implementation addition — Automatic BGA user detection**
- A second content script (`src/content/main-world.ts`) runs in `"world": "MAIN"` to access `window.globalUserInfos`
- It dispatches a `__bga_userinfo` CustomEvent carrying `{ id, name }` on `window`
- The isolated content script (`src/content/index.ts`) listens for this event and relays a `USER_INFO` message to the service worker via `chrome.runtime.sendMessage`
- The service worker stores `bga_player_id` and `bga_username` in `chrome.storage.local`
- `bgaPlayerId` and `bgaUsername` are now included in the `GameState` snapshot returned by `getGameState()`
- `buildSystemPrompt` prefers the auto-detected username from `gameState.bgaUsername`; falls back to the stored setting
- The side panel settings panel shows a read-only "Detected BGA Player" status line instead of a manual text input

**Post-implementation addition — Structured game state extraction from JS globals**
- `extractStructuredGameState()` added to `src/content/main-world.ts`; reads `window.g_sitecore.gamedatas` and `window.g_sitecore._playerCounters`
- Extracts: current player's resources (live values from `_playerCounters`), full hand with per-card playability status from `gamestate.args._private.statuses`, action cards, scoring hand, icons, sizes, mapId
- Extracts: all opponent summaries (name, resources, action card names, hand count)
- Extracts: current gamestate name, active player, possible actions, description
- Returns `null` on non-game pages (graceful fallback)
- New `__bga_request_gamestate` / `__bga_gamestate` `window.postMessage` flow mirrors the existing `__bga_userinfo` flow
- Isolated script (`src/content/index.ts`) registers a one-time `window.message` listener, posts `__bga_request_gamestate`, then calls `sendResponse` with the result; 500 ms timeout falls back to DOM-only snapshot
- `GameState` interface in both `src/content/index.ts` and `src/background/index.ts` gains `structuredState?: StructuredGameStatePayload | null`
- `buildSystemPrompt` in `src/background/index.ts` uses `buildStructuredStateSections()` when `structuredState` is present, producing human-readable `## Your resources`, `## Your hand`, `## Your action cards`, `## Current game state`, `## Opponents`, `## Recent game log` sections; falls back to DOM-scraped text when structured state is absent

**Status** — `[x] done`

---

### Sub-Task 3 — Content Script: Rulebook PDF Detection

**Intent**
Detect the English rulebook PDF link from the "How to Play" section at the bottom of each BGA game page and forward it to the service worker for download.

**Expected Outcomes**
- Content script locates the "How to Play" / rulebook section on BGA game pages
- Identifies the English-language PDF link (preferring links labeled "English" or "EN")
- Sends the PDF URL and game name to the service worker via `chrome.runtime.sendMessage`
- If no English PDF is found, sends a signal so the side panel can prompt the user to upload one

**Todo List**
- [ ] Inspect the BGA "How to Play" section DOM structure to identify the container element and link patterns (anchor tags with `.pdf` href or data attributes)
- [ ] Write a selector strategy that finds links labeled with "English", "EN", or falls back to the first PDF link
- [ ] Send `{ type: "RULEBOOK_URL_FOUND", gameId, gameName, pdfUrl }` to the background service worker
- [ ] Send `{ type: "RULEBOOK_NOT_FOUND", gameId, gameName }` if no PDF link is detected
- [ ] Trigger this detection once per page load after the DOM is fully settled (use a MutationObserver or `DOMContentLoaded` + short delay)

**Relevant Context**
- BGA's "How to Play" section is rendered below the game board; it may load asynchronously so a MutationObserver watching for the section's container is more reliable than a one-shot query
- PDF links on BGA typically follow a pattern like `https://x.boardgamearena.net/data/gamemedia/<gamename>/rule/...pdf`

**Status** — `[x] done`

---

### Sub-Task 4 — Service Worker: Rulebook Fetch, Parse, and Cache

**Intent**
Download the rulebook PDF, extract its text content using pdf.js, and cache it in `chrome.storage.local` keyed by game name so it is available for LLM context injection without re-downloading on every session.

**Expected Outcomes**
- Service worker receives `RULEBOOK_URL_FOUND` messages and fetches the PDF
- PDF text is extracted using `pdfjs-dist` (running in the service worker context)
- Extracted text is stored as `rulebook_<gameName>: { text: "...", fetchedAt: ISO-timestamp }`
- Cache hit on subsequent sessions skips re-download
- Service worker receives `RULEBOOK_NOT_FOUND` and sets a flag so the side panel can show an upload prompt
- User-uploaded PDFs (from Sub-Task 6) follow the same parse-and-cache path

**Todo List**
- [ ] Configure `pdfjs-dist` for use in a service worker (set `GlobalWorkerOptions.workerSrc` to `false` or use the legacy build that runs without a separate worker thread)
- [ ] Implement `fetchAndParseRulebook(pdfUrl)` — fetches the PDF as `ArrayBuffer`, passes it to `pdfjsLib.getDocument()`, iterates pages to extract text, returns concatenated string
- [ ] Implement `cacheRulebook(gameName, text)` — writes to `chrome.storage.local`
- [ ] Implement `getRulebookText(gameName)` — reads from `chrome.storage.local`, returns `null` if not cached
- [ ] Handle `RULEBOOK_URL_FOUND` message: check cache first, fetch and parse if miss, then cache
- [ ] Handle `GET_RULEBOOK` message from side panel: return cached text or `null`
- [ ] Limit stored text size — if PDF text exceeds ~500KB, truncate or chunk; note the truncation for LLM context use

**Relevant Context**
- `pdfjs-dist` version 3.x has a `legacy` build suitable for non-browser workers; import `pdfjs-dist/legacy/build/pdf` in the service worker
- `chrome.storage.local` has a default quota of ~10MB; a typical rulebook is 20–100 pages and will be well within this after text extraction
- Service workers in MV3 can be terminated and restarted; storage reads/writes must be fully async and not rely on in-memory state

**Status** — `[x] done`

---

### Sub-Task 5 — Side Panel UI: Chat Interface and Settings

**Intent**
Build the side panel HTML/JS UI with a chat thread for user prompts and LLM responses, and a settings panel where users configure their API keys and preferred LLM provider.

**Expected Outcomes**
- Side panel opens when user clicks the extension icon on a BGA tab
- Chat thread shows user messages and LLM responses with basic markdown rendering
- Settings panel allows entry of OpenAI API key, Anthropic API key, and a toggle between providers
- Keys are saved to and loaded from `chrome.storage.local`
- Rulebook status is shown (e.g. "Rulebook loaded: Carcassonne" or "No rulebook — upload one")
- Upload button appears when no rulebook is found; user can select a local PDF file

**Todo List**
- [ ] Scaffold `sidepanel.html` with three sections: chat thread, input bar, settings toggle
- [ ] Implement settings form: two password-type inputs (OpenAI key, Anthropic key), a radio/select for provider, a save button; read/write via `chrome.storage.local`
- [ ] Implement rulebook status bar: query service worker for cached rulebook on panel open; show game name if found, upload button if not
- [ ] Implement file upload handler: read selected PDF as `ArrayBuffer`, send `{ type: "UPLOAD_RULEBOOK", gameName, buffer }` to service worker
- [ ] Implement chat thread: append user bubble on submit, show loading indicator, append LLM response bubble on reply
- [ ] Apply minimal, readable CSS (dark-friendly, narrow panel width ~380px)
- [ ] Wire the send button to Sub-Task 6's LLM orchestration message

**Relevant Context**
- Use `chrome.runtime.sendMessage` and `chrome.runtime.onMessage` for all side-panel-to-background communication
- `chrome.storage.local.get` / `.set` can be called directly from the side panel JS
- The panel width is constrained by Chrome's side panel container; avoid fixed wide layouts

**Status** — `[x] done`

---

### Sub-Task 6 — Service Worker: LLM Orchestration

**Intent**
Handle the core AI interaction loop: receive a user question + game context from the side panel, build a system prompt that includes the game state and relevant rulebook excerpts, call the selected LLM provider's API, handle the BGG web-search tool call if the LLM invokes it, and return the complete final response to the side panel (no streaming).

**Expected Outcomes**
- Service worker receives `{ type: "ASK_LLM", question, gameName }` from the side panel
- Assembles a system prompt containing: current game state snapshot, relevant rulebook text chunks, and instructions to search BGG for strategy tips via a tool call
- Calls OpenAI (`gpt-4o` with function calling) or Anthropic (`claude-3-5-sonnet` with tool use) depending on user setting
- If the LLM invokes the `search_bgg` tool, the service worker fetches the BGG search page, extracts text, and feeds results back for a second LLM pass
- Complete final answer is sent back to the side panel as `{ type: "LLM_RESPONSE", text }` — no streaming, single delivery
- Anthropic API calls are made from the service worker (not the side panel) to avoid CORS restrictions on `api.anthropic.com`

**Todo List**
- [ ] Implement `buildSystemPrompt(gameState, rulebookText, gameName)` — constructs a concise system prompt with game context and a section of rulebook text (truncate rulebook to ~8000 tokens worth of text); instruct the LLM to call the `search_bgg` tool when strategy tips are needed
- [ ] Define the `search_bgg` tool schema for both OpenAI (function calling JSON schema) and Anthropic (tool definition) — input: `{ query: string }`, description: "Search BoardGameGeek forums for strategy tips about this game"
- [ ] Implement `callOpenAI(apiKey, messages, tools)` — POST to `https://api.openai.com/v1/chat/completions` with the assembled payload
- [ ] Implement `callAnthropic(apiKey, messages, tools)` — POST to `https://api.anthropic.com/v1/messages` with the assembled payload; include `anthropic-dangerous-direct-browser-access: true` header (required for browser-origin calls)
- [ ] Implement `executeBGGSearch(query)` — fetch `https://boardgamegeek.com/search?q=<query>&forum=1` or use a targeted BGG forum URL; extract text content from the result; return a truncated summary
- [ ] Implement the agentic loop: call LLM → if tool call returned, execute tool → call LLM again with tool result → return final text response
- [ ] Send progress updates to the side panel during the tool call step so the UI can show "Searching BoardGameGeek…"

**Relevant Context**
- Anthropic requires the `anthropic-dangerous-direct-browser-access: true` header for direct browser/extension calls; without it the request is rejected by CORS policy
- OpenAI's API allows browser-origin requests with a valid API key and correct CORS headers
- The agentic loop should be capped at a maximum of 3 tool call rounds to prevent runaway API usage
- Rulebook text should be chunked/truncated to stay within context window limits; prioritize sections that mention game phases, scoring, and special rules

**Status** — `[x] done`

---

### Sub-Task 7 — Integration Testing and Polish

**Intent**
Verify the full end-to-end flow works on a real BGA game, fix any integration gaps, and package the extension for local distribution.

**Expected Outcomes**
- Load extension on a live BGA game, ask a strategy question, receive a coherent answer referencing the rulebook and BGG forums
- Rulebook is detected, downloaded, and cached on first visit; cache is used on return visits
- Settings panel saves and reloads API keys correctly
- Upload fallback works when no PDF is detected
- Extension can be packaged as a `.crx` or distributed as a zip of the `dist/` folder

**Todo List**
- [ ] Test content script game state extraction on 2–3 different BGA games (different DOM structures)
- [ ] Test rulebook PDF detection on 2–3 games; verify English PDF preference logic
- [ ] Test full LLM chat flow with both OpenAI and Anthropic providers
- [ ] Test BGG search tool call — verify the search fires and results are incorporated
- [ ] Test rulebook upload fallback for a game with no detected PDF
- [ ] Fix any CORS, permissions, or CSP errors surfaced during testing
- [ ] Add a `README.md` with setup instructions (API key entry, how to load unpacked extension)
- [ ] Build and verify the `dist/` folder loads cleanly as an unpacked extension

**Relevant Context**
- Chrome DevTools can inspect service worker logs via `chrome://extensions` → "service worker" link
- Content script console logs appear in the BGA tab's DevTools console, not the extension DevTools

**Status** — `[ ] pending`

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| MV3 UI surface | Side Panel | Stays visible alongside the game; more space than a popup |
| Build tool | Vite + @crxjs/vite-plugin | Handles MV3 multi-entry bundling with HMR during dev |
| PDF parsing | pdfjs-dist legacy build | Runs in service worker context without a separate worker thread |
| Anthropic CORS | Call from service worker with browser-access header | Anthropic blocks browser origins without this header |
| BGG strategy data | LLM-driven `search_bgg` tool call | Avoids scraping fragility; lets the LLM decide what to search |
| LLM response delivery | Single complete response, no streaming | Simpler side panel implementation; streaming not required |
| Game state source | DOM scraping only — no JS globals | `window.gameui` is not accessible in content script context |
| Rulebook storage | chrome.storage.local keyed by game name | Persists across sessions; no server needed |
| LLM context budget | ~8000 tokens for rulebook + ~500 tokens for game state | Leaves room for conversation history within context windows |
