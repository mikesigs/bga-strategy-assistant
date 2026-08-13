# BGA Strategy Assistant — Architecture

## Overview

A Chromium Manifest V3 browser extension that sits alongside a BoardGameArena.com game tab as a Chrome Side Panel. The user asks natural-language strategy questions; the extension reads the live game state from the BGA page, injects it into an LLM prompt together with the game's rulebook text, and returns actionable advice.

## C4 — System Context

```
┌─────────────────────────────────────────────────────────────────┐
│  User                                                           │
│  Playing a board game on boardgamearena.com                     │
└───────────────────────────┬─────────────────────────────────────┘
                            │ asks strategy questions
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  BGA Strategy Assistant (Chrome Extension)                      │
│  Side panel alongside the BGA game tab                         │
└──────┬──────────────────────────────────────┬───────────────────┘
       │ reads game state                      │ calls LLM API
       ▼                                       ▼
┌──────────────────┐                 ┌─────────────────────┐
│ boardgamearena   │                 │ OpenAI / Anthropic  │
│ .com             │                 │ (user's own key)    │
└──────────────────┘                 └─────────────────────┘
                                              │ search_bgg tool
                                              ▼
                                     ┌─────────────────────┐
                                     │ boardgamegeek.com   │
                                     │ (strategy forums)   │
                                     └─────────────────────┘
```

## C4 — Container Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Chrome Extension                                                            │
│                                                                              │
│  ┌──────────────────────┐   GET_GAME_STATE    ┌─────────────────────────┐   │
│  │  Side Panel          │ ◄────────────────── │  Content Script         │   │
│  │  (src/sidepanel/)    │                     │  Isolated World         │   │
│  │                      │                     │  (src/content/index.ts) │   │
│  │  - Chat UI           │                     │                         │   │
│  │  - Settings panel    │                     │  - DOM scraping         │   │
│  │  - Status bar        │                     │  - Caches struct state  │   │
│  │  - Rulebook status   │                     │  - Rulebook detection   │   │
│  └──────────┬───────────┘                     └───────────▲─────────────┘   │
│             │                                    postMessage│                │
│             │ ASK_LLM                            __bga_*    │                │
│             │ GET_RULEBOOK                                  │                │
│             ▼                                     ┌─────────┴─────────────┐  │
│  ┌──────────────────────┐                        │  Content Script       │  │
│  │  Service Worker      │                        │  MAIN World           │  │
│  │  (src/background/)   │                        │  (src/content/        │  │
│  │                      │                        │   main-world.ts)      │  │
│  │  - LLM orchestration │                        │                       │  │
│  │  - Rulebook fetch    │                        │  - window.g_sitecore  │  │
│  │  - PDF parsing       │                        │  - globalUserInfos    │  │
│  │  - BGG search        │                        │  - extractStructured  │  │
│  └──────────┬───────────┘                        │    GameState()        │  │
│             │                                    └───────────────────────┘  │
│             │                                                                │
│  ┌──────────▼───────────┐                                                   │
│  │  chrome.storage      │                                                   │
│  │  .local              │                                                   │
│  │                      │                                                   │
│  │  - API keys          │                                                   │
│  │  - selected_provider │                                                   │
│  │  - bga_player_id     │                                                   │
│  │  - bga_username      │                                                   │
│  │  - rulebook_<game>   │                                                   │
│  └──────────────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## C4 — Component: Game State Flow

```
MAIN world script                Isolated content script         Service worker
(page JS scope)                  (extension scope)               (background)
──────────────────               ─────────────────────────       ─────────────────

On page load:
extractStructuredGameState()
  reads g_sitecore.gamedatas ──► postMessage(__bga_gamestate)
                                   cachedStructuredState = state
                                   recheckRulebookForGame(name)

On GET_GAME_STATE request:
                                 getGameState() [DOM]
                                 + cachedStructuredState
                                 ──────────────────────────────► buildSystemPrompt()
                                                                  runAgenticLoop()
                                                                  → OpenAI / Anthropic

On USER_INFO detection:
reads globalUserInfos ─────────► chrome.runtime.sendMessage ──► store bga_player_id
                                   (USER_INFO)                    bga_username
```

## Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| UI surface | Chrome Side Panel | Stays visible alongside the game; more space than a popup |
| Build tool | Vite + @crxjs/vite-plugin | MV3 multi-entry bundling with manifest rewriting |
| PDF parsing | pdfjs-dist legacy build | Runs in service worker without a separate worker thread |
| Anthropic CORS | Service worker + `anthropic-dangerous-direct-browser-access: true` header | Anthropic rejects browser-origin calls without this header |
| BGG strategy data | LLM-driven `search_bgg` tool call | Avoids fragile scraping; LLM decides what to search |
| LLM response | Single complete response, no streaming | Simpler implementation; streaming not required |
| Game state | MAIN world JS extraction | `g_sitecore.gamedatas` has full structured state; DOM scraping is unreliable |
| Rulebook storage | `chrome.storage.local` keyed by game name slug | Persists across sessions; no server needed |
| Game state cache | Module-level variable in isolated script | Avoids async `sendResponse` timeout in Chrome message passing |

## Message Passing Reference

| Message type | Direction | Payload |
|---|---|---|
| `GET_GAME_STATE` | Side panel → content script (via `chrome.tabs.sendMessage`) | — |
| `GAME_STATE` | Content script → side panel (response) | `{ type, data: GameState }` |
| `USER_INFO` | Content script → service worker | `{ type, id, name }` |
| `RULEBOOK_URL_FOUND` | Content script → service worker | `{ type, gameName, pdfUrl }` |
| `RULEBOOK_NOT_FOUND` | Content script → service worker | `{ type, gameName }` |
| `GET_RULEBOOK` | Side panel → service worker | `{ type, gameName }` |
| `RULEBOOK_DATA` | Service worker → side panel (response) | `{ type, text, needsUpload? }` |
| `UPLOAD_RULEBOOK` | Side panel → service worker | `{ type, gameName, buffer }` |
| `ASK_LLM` | Side panel → service worker | `{ type, question, gameName, gameState }` |
| `LLM_RESPONSE` | Service worker → side panel (response) | `{ type, text }` |
| `LLM_ERROR` | Service worker → side panel (response) | `{ type, error }` |
| `__bga_request_userinfo` | Isolated script → MAIN world (postMessage) | — |
| `__bga_userinfo` | MAIN world → isolated script (postMessage) | `{ type, detail: GlobalUserInfos }` |
| `__bga_request_gamestate` | Isolated script → MAIN world (postMessage) | — |
| `__bga_gamestate` | MAIN world → isolated script (postMessage) | `{ type, detail: StructuredGameState }` |

## chrome.storage.local Schema

```
{
  openai_key: string,
  anthropic_key: string,
  selected_provider: "openai" | "anthropic",
  bga_player_id: string,          // numeric player ID from globalUserInfos
  bga_username: string,           // display name from globalUserInfos
  rulebook_<gameName>: {
    text: string,                 // extracted PDF text, max 500KB
    fetchedAt: string             // ISO timestamp
  } | {
    noRulebook: true              // sentinel: detection ran, no PDF found
  }
}
```
