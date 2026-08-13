# BGA DOM and JavaScript Globals

Critical reference for any agent working on this extension. Documents what is and is not accessible in each script execution context, and the exact structure of the globals that carry game state.

## Execution Contexts

BGA game pages involve three distinct JavaScript execution contexts:

| Context | What can run here | chrome.* API | window globals |
|---|---|---|---|
| **Page JS** (BGA's own scripts) | BGA framework, game modules | ✗ | ✓ full access |
| **MAIN world content script** (`"world": "MAIN"`) | `src/content/main-world.ts` | ✗ | ✓ full access |
| **Isolated world content script** (default) | `src/content/index.ts` | ✓ | ✗ isolated |
| **Service worker** | `src/background/index.ts` | ✓ | ✗ no DOM |
| **Side panel** | `src/sidepanel/main.ts` | ✓ | ✗ own window |

**The critical constraint**: isolated content scripts cannot read BGA's JS globals (`window.g_sitecore`, `window.globalUserInfos`, etc.). Only MAIN world scripts can. Communication between MAIN world and isolated world must use `window.postMessage`.

## Confirmed Window Globals

All confirmed present on BGA game pages (`document_idle`):

### `window.globalUserInfos`
The logged-in user's account info. Always present on BGA pages when logged in.
```js
{
  id: number | string,  // numeric player ID, e.g. 88257314
  name: string,         // display name, e.g. "Sigzy"
  // ... additional account fields
}
```

### `window.current_player_id`
String. The numeric ID of the currently logged-in player. Duplicate of `globalUserInfos.id` but available directly on window.
```js
"88257314"
```

### `window.g_sitecore`
The main BGA framework object. Extends `window.mainsite` (they are the same object).

Notable fields confirmed present:
```js
{
  current_player_id: string,     // "88257314"
  current_player_name: string,   // "Sigzy"
  current_table_id: string,      // active table ID
  gamedatas: BgaGamedatas,       // ← PRIMARY game state source (see below)
  _playerCounters: {             // ← live resource counters (more up-to-date than gamedatas)
    [playerId: string]: {
      [resourceKey: string]: {
        currentValue: number,
        targetValue: number,
        span: {},
        linked: null,
        speed: number
      }
    }
  },
  notifqueue: object,            // notification/action queue
  preferences: object,           // user preferences
}
```

### `window.g_sitecore.gamedatas`
The full structured game state. **This is the primary source for all game data.**

Top-level keys confirmed for Ark Nova:
```js
{
  players: Record<string, BgaPlayer>,   // keyed by numeric player ID string
  gamestate: BgaGamestate,             // current state machine state
  gamestates: object,                  // all state definitions (111 entries)
  cards: object,                       // card data
  buildings: object,                   // building data
  conservationBonuses: object,
  deckCount: number,
  discardCount: number,
  break: object,
  meeples: object,
  playerorder: array,
  // ... other game-specific fields
}
```

## BgaPlayer Object (per-player state)

Keyed in `gamedatas.players[playerId]`. Confirmed fields:
```js
{
  id: number,
  no: number,              // player order (0-based)
  name: string,            // display name
  color: string,           // hex color without #
  eliminated: 0 | 1,
  score: number,
  money: number,
  reputation: number,
  appeal: number,
  conservation: number,
  xtoken: number,
  income: number,
  mapId: string,           // e.g. "T1"

  hand: Record<string, BgaCardObject>,        // YOUR hand (opponents show [])
  handCount: number,                          // total cards in hand
  scoringHand: Record<string, BgaScoringCard>, // end-game scoring cards
  scoringHandCount: number,
  actionCards: Record<string, BgaActionCard>, // the 5 action cards

  icons: {                 // zoo icon counts — prerequisite checking
    Bird: number, Predator: number, Herbivore: number, Bear: number,
    Reptile: number, Pet: number, Primate: number,
    Africa: number, Europe: number, Asia: number, Americas: number, Australia: number,
    "Partner-Zoo": number, AnimalsII: number, CardsII: number,
    Science: number, Fac: number, Rock: number, Water: number, SeaAnimal: number
  },
  sizes: {                 // enclosures built
    small: number, medium: number, large: number
  },
  projectStrength: number,
  handStatus: [number, boolean],
  is_ai: "0" | "1",
  beginner: boolean,
  avatar: string,
  order: number,
  ack: string,
}
```

**Important**: `hand` is only populated for the current logged-in player. Opponent `hand` arrays are empty `[]`; use `handCount` for opponents.

## BgaCardObject (hand card)

```js
{
  id: string,              // e.g. "A460_DuskyleafMonkey", "S252_SpottedHyenaCompound"
  location: "hand",
  state: number,
  pId: number,
  type: "animal" | "sponsor" | "scoring",
  name: string,            // display name
  latin?: string,          // latin name + conservation status
  number: number,          // card number
  cost?: number,           // money cost (animals)
  lvl?: number,            // level (sponsors)
  appeal: number,
  conservation: number,
  reputation: number,
  enclosureSize?: number,
  enclosureRequirements: {} | Record<string, number>,  // e.g. { Rock: 1 }
  specialEnclosure: [] | { types: string[], cubes: number },
  categories: string[],    // e.g. ["Primate"], ["Bird"]
  prerequisites: [] | Record<string, number>,  // e.g. { Asia: 3 }
  continents: string[],    // e.g. ["Asia"], ["Africa"]
  ability: {} | Record<string, null | number>, // e.g. { Clever: null }, { Pouch: 1 }
  wave: boolean,
  noRegularEnclosure?: boolean,
}
```

## BgaActionCard

```js
{
  id: number,              // 1–5 for current player
  strength: number,        // current strength value
  pId: string,             // player ID
  type: string,            // e.g. "Build", "Cards", "Animals4", "Association4", "Sponsors"
  actionType: string,      // canonical type: "Build" | "Cards" | "Animals" | "Association" | "Sponsors"
  number: number,          // variant number (0 = base)
  name: string,
  level: 1 | 2,            // I or II
  status: number,
  descI: string[],         // level I description lines
  descII: string[],        // level II description lines
  tooltip: string[],
  extraDatas: null,
}
```

## BgaGamestate

```js
{
  id: number,              // state machine state ID
  name: string,            // e.g. "chooseActionCard"
  active_player: string,   // numeric player ID of whose turn it is
  type: "activeplayer" | "multipleactiveplayer" | "game",
  description: string,     // e.g. "${actplayer} must choose an action card"
  descriptionmyturn: string,
  possibleactions: string[], // e.g. ["actChooseActionCard", "actPassOptionalAction"]
  action: string,
  transitions: null | object,
  reflexion: {
    total: Record<string, string | number>,  // total time used per player
  },
  updateGameProgression: number,

  args: {
    // Present when active player is choosing action cards:
    cards: Record<string, Record<string, number>>,  // card slot → strength options
    strengths: Record<string, number>,              // card ID → current strength
    xtokens: number,
    canGainXToken: boolean,

    _private: {  // ← ONLY populated when it is YOUR turn
      statuses: Record<string, CardPlayabilityStatus>
    }
  }
}
```

## Card Playability Status (`gamestate.args._private.statuses`)

Only present when it is the current player's turn. Keyed by card ID.

```js
// Playable card:
"A450_CommonWombat": {
  id: "A450_CommonWombat",
  conditions: { ignored: 0, valid: true },
  cost: true,        // can afford
  baseCost: true,
  folder: 0,
  enclosures: [],
  canFlock: false,
  enclosure: false,  // no special enclosure needed
  playable: false    // NOTE: playable=false here means "not yet played", not "cannot play"
}

// Unplayable card (missing prerequisites):
"A406_SiberianTiger": {
  id: "A406_SiberianTiger",
  conditions: { Asia: false, ignored: 3, valid: false },  // Asia: false = prerequisite not met
  cost: false,       // also cannot afford
  baseCost: false,
  playable: false
}
```

**Warning**: `playable: false` does NOT mean the card cannot be played. It means it has not been played yet this action. The actual playability is determined by `conditions.valid === true` AND `cost === true` AND enclosure requirements met.

## Reliable DOM Selectors

| Purpose | Selector | Notes |
|---|---|---|
| Player boards container | `#player_boards` | Consistent across all BGA games |
| Game log | `#game_log` | Consistent across all BGA games |
| Current action buttons | `#generalactions` | Shows whose turn + available actions |
| Rulebook PDF links | `#game-links a[href$=".pdf"]` | Priority: text "Rulebook" > `link_lang="(en)"` > first PDF |
| Active player highlight | `.active-player`, `.current_player` | Game-skin dependent |

## URL Patterns

| URL pattern | Page type | Game name location |
|---|---|---|
| `/[digits]/[gamename]` | Active game | URL slug — most reliable |
| `/tableview?table=[id]` | Game lobby / waiting room | Not in URL; use page title |
| `/table?table=[id]` | Table setup | Not in URL |

**Game name extraction from title**: BGA titles during a game follow `"Status • GameName • Board Game Arena"`. Skip segments containing action verbs (must, choose, play, select) and skip "Board Game Arena". The remaining short segment is the game name.

## Known Pitfalls

1. **`window.gameui` does not exist** as an accessible global in content script context. This was the original assumption; it is wrong.

2. **`g_sitecore._playerCounters` is more current than `gamedatas.players`** for resource values. Use `_playerCounters[id][resource].currentValue` as the authoritative value during a player's turn.

3. **Opponent hand contents are hidden**. `gamedatas.players[opponentId].hand` is always `[]`. Use `handCount` for the count.

4. **`_private.statuses` is absent when it is not your turn.** Handle gracefully — show "playability unknown (not your turn)".

5. **The side panel runs in its own Chrome window context.** `chrome.tabs.query({ currentWindow: true })` or `lastFocusedWindow: true` will NOT find the BGA tab — they resolve to the side panel's own window. Use `chrome.tabs.query({ url: "https://*.boardgamearena.com/*" })` instead.

6. **`sendResponse` in `chrome.runtime.onMessage` must be called synchronously** (or return `true` and call it before the message port closes, typically within ~5 seconds). Do not use async request/reply patterns inside `onMessage` handlers. Cache state proactively instead.

7. **CustomEvents across MAIN/isolated world boundaries are unreliable** in some Chrome versions. Use `window.postMessage` / `window.addEventListener("message")` instead.
