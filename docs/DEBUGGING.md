# Debugging Guide

## Where logs appear

Each component logs to a different DevTools console:

| Component | Where to find logs |
|---|---|
| Side panel (`src/sidepanel/`) | Right-click inside side panel → Inspect |
| Content scripts (`src/content/`) | BGA game tab → F12 → Console |
| Service worker (`src/background/`) | `chrome://extensions` → "service worker" link |
| MAIN world script (`main-world.ts`) | BGA game tab → F12 → Console (same as content scripts) |

## Confirming a rebuild was loaded

The status bar under the extension header shows `built MMM DD HH:MM:SS`. This timestamp is embedded at compile time. If it matches your last `npm run build` time, Chrome is running the latest version.

If it doesn't update after ↺ refresh:
1. Go to `chrome://extensions`
2. Disable the extension toggle → wait 2 seconds → re-enable
3. Hard-reload the BGA tab (Ctrl+Shift+R)

Service workers are especially sticky. If SW logs still show old behaviour, open SW DevTools and run `chrome.runtime.reload()` in the console.

## Key log lines to watch

### BGA game tab console

```
[BGA Assistant] Content script injected on: https://...
[BGA MAIN] main-world.ts loaded
[BGA ISOLATED] posting __bga_request_userinfo
[BGA MAIN] received __bga_request_userinfo, globalUserInfos: { id: ..., name: ... }
[BGA MAIN] postMessage __bga_userinfo: { id: ..., name: ... }
[BGA Assistant] User detected: Sigzy (ID: 88257314)
[BGA MAIN] postMessage __bga_gamestate, state: player=Sigzy, game=arknova, hand=6 cards
[BGA Assistant] Structured state cached from MAIN world, game: arknova
[BGA Assistant] Rulebook candidates found: [...]
[BGA Assistant] Rulebook PDF detected: https://... for game: arknova
```

### Service worker console

```
[BGA Assistant SW] Message received: USER_INFO
[BGA Assistant SW] User info stored: Sigzy (ID: 88257314)
[BGA Assistant SW] Message received: RULEBOOK_URL_FOUND
[BGA Assistant SW] Fetching rulebook PDF: https://...
[BGA Assistant SW] Message received: ASK_LLM
[BGA Assistant SW] ASK_LLM diagnostics: { gameName, hasGameState, hasStructuredState, ... }
[BGA Assistant SW] System prompt (first 1000 chars): ...
```

## Diagnosing "No game state in prompt"

If the system prompt shows only `Game name:` and `Page title:` with no resources or hand:

1. Check BGA tab console for `[BGA MAIN] postMessage __bga_gamestate, state:` — if it says `null`, read the debug info: `g_sitecore=true/false`, `gamedatas=true/false`, `currentPlayerId=...`, `playerExists=true/false`
2. If `gamedatas=false`: you're on a non-game page (tableview, lobby). Navigate to the active game board.
3. If `playerExists=false`: the `current_player_id` lookup failed. Check `window.current_player_id` vs `window.g_sitecore.current_player_id` in the browser console.
4. If `[BGA MAIN] postMessage __bga_gamestate` never appears: the MAIN world script isn't loading. Check `chrome://extensions` for manifest errors.

## Diagnosing "Rulebook not found"

1. Check BGA tab console — does `[BGA Assistant] Rulebook candidates found:` appear? If not, `#game-links` wasn't found or contained no PDF anchors.
2. In browser console on the BGA game page, run:
   ```js
   document.querySelector('#game-links')
   ```
   If null, the section hasn't loaded yet or uses a different container.
3. Manually inspect `#game-links` anchors:
   ```js
   Array.from(document.querySelectorAll('#game-links a')).map(a => ({ text: a.textContent.trim(), href: a.href, lang: a.getAttribute('link_lang') }))
   ```
4. If the cached rulebook was stored under a wrong game name, clear it:
   ```js
   // In SW DevTools console:
   chrome.storage.local.get(null, console.log)        // see all keys
   chrome.storage.local.remove('rulebook_wrongname')  // remove bad entry
   ```

## Diagnosing side panel not finding BGA tab

If `Game: —` shows in the status bar while a BGA game is open:

1. Open side panel DevTools, check `chrome.tabs.query({ url: "https://*.boardgamearena.com/*" })` returns the tab.
2. Verify the content script injected: BGA tab console should show `[BGA Assistant] Content script injected on:`.
3. Check that the URL matches the manifest `content_scripts.matches` pattern (`https://*.boardgamearena.com/*`).

## chrome.storage inspector

In the SW DevTools console:
```js
// See everything stored
chrome.storage.local.get(null, d => console.log(JSON.stringify(Object.keys(d))))

// See a specific rulebook
chrome.storage.local.get('rulebook_arknova', console.log)

// Clear a bad rulebook cache
chrome.storage.local.remove('rulebook_arknova')

// See player info
chrome.storage.local.get(['bga_player_id', 'bga_username'], console.log)
```
