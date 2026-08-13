/**
 * MAIN world content script — runs in the page's JS scope so it can access
 * window globals that are not visible to isolated content scripts.
 *
 * Uses window.postMessage to communicate with the isolated content script
 * (CustomEvent can have cross-world reliability issues in some Chrome versions).
 *
 * IMPORTANT: This script must NOT use any chrome.* APIs.
 */

interface GlobalUserInfos {
  id: number | string;
  name: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// BGA game-state globals (typed minimally — only the fields we read)
// ---------------------------------------------------------------------------

interface BgaCardObject {
  id?: string | number;
  name?: string;
  type?: string;
  cost?: string | number;
  lvl?: string | number;
  enclosureSize?: string | number;
  enclosureRequirements?: unknown;
  specialEnclosure?: unknown;
  categories?: unknown;
  prerequisites?: unknown;
  continents?: unknown;
  ability?: string;
  [key: string]: unknown;
}

interface BgaActionCard {
  name?: string;
  actionType?: string;
  strength?: string | number;
  level?: string | number;
  status?: string;
  descI?: string;
  descII?: string;
  [key: string]: unknown;
}

interface BgaScoringCard {
  name?: string;
  desc?: string;
  scoreMap?: unknown;
  [key: string]: unknown;
}

interface BgaPlayer {
  name?: string;
  money?: string | number;
  reputation?: string | number;
  appeal?: string | number;
  conservation?: string | number;
  xtoken?: string | number;
  income?: string | number;
  score?: string | number;
  hand?: Record<string, BgaCardObject>;
  actionCards?: Record<string, BgaActionCard>;
  icons?: Record<string, unknown>;
  sizes?: Record<string, unknown>;
  scoringHand?: Record<string, BgaScoringCard>;
  mapId?: string | number;
  [key: string]: unknown;
}

interface BgaGamestate {
  name?: string;
  active_player?: string | number;
  possibleactions?: string[];
  description?: string;
  args?: {
    _private?: {
      statuses?: Record<string, {
        playable?: boolean;
        conditions?: unknown;
        cost?: boolean | unknown;
        enclosure?: boolean | unknown;
      }>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface BgaGamedatas {
  players?: Record<string, BgaPlayer>;
  gamestate?: BgaGamestate;
  [key: string]: unknown;
}

interface BgaSitecore {
  gamedatas?: BgaGamedatas;
  _playerCounters?: Record<string, Record<string, { currentValue?: number | string }>>;
  player_id?: string | number;
  [key: string]: unknown;
}

declare global {
  interface Window {
    globalUserInfos?: GlobalUserInfos;
    g_sitecore?: BgaSitecore;
  }
}

// ---------------------------------------------------------------------------
// Structured game state extraction
// ---------------------------------------------------------------------------

interface StructuredCardStatus {
  playable: boolean;
  conditions?: unknown;
  cost?: boolean | unknown;
  enclosure?: boolean | unknown;
  reason?: string;
}

interface StructuredCard {
  id?: string | number;
  name?: string;
  type?: string;
  cost?: string | number;
  lvl?: string | number;
  enclosureSize?: string | number;
  enclosureRequirements?: unknown;
  specialEnclosure?: unknown;
  categories?: unknown;
  prerequisites?: unknown;
  continents?: unknown;
  ability?: string;
  status?: StructuredCardStatus;
}

interface StructuredActionCard {
  name?: string;
  actionType?: string;
  strength?: string | number;
  level?: string | number;
  status?: string;
  descI?: string;
  descII?: string;
}

interface StructuredOpponent {
  id: string;
  name?: string;
  money?: string | number;
  reputation?: string | number;
  appeal?: string | number;
  conservation?: string | number;
  score?: string | number;
  xtoken?: string | number;
  actionCards?: Array<{ name?: string; actionType?: string; strength?: string | number; level?: string | number }>;
  icons?: Record<string, unknown>;
  handCount?: number;
}

interface StructuredGameState {
  currentPlayerId: string;
  gameName?: string;
  player: {
    id: string;
    name?: string;
    money: string | number;
    reputation: string | number;
    appeal: string | number;
    conservation: string | number;
    xtoken: string | number;
    income: string | number;
    score: string | number;
    hand: StructuredCard[];
    actionCards: StructuredActionCard[];
    icons?: Record<string, unknown>;
    sizes?: Record<string, unknown>;
    scoringHand?: Array<{ name?: string; desc?: string; scoreMap?: unknown }>;
    mapId?: string | number;
  };
  gamestate: {
    name?: string;
    active_player?: string | number;
    possibleactions?: string[];
    description?: string;
  };
  opponents: StructuredOpponent[];
}

/** Convert a BGA record/object into an array, filtering out nullish values. */
function recordToArray<T>(record: Record<string, T> | undefined | null): T[] {
  if (!record) return [];
  return Object.values(record).filter((v) => v != null);
}

/**
 * Read the most up-to-date resource value for a player from _playerCounters,
 * falling back to the gamedatas value if the counter isn't present.
 */
function liveCounter(
  sitecore: BgaSitecore,
  playerId: string,
  key: string,
  fallback: string | number | undefined
): string | number {
  const counter = sitecore._playerCounters?.[playerId]?.[key];
  if (counter?.currentValue != null) return counter.currentValue;
  return fallback ?? 0;
}

/**
 * Build a clean, JSON-serializable snapshot of the BGA game state from
 * window.g_sitecore.gamedatas and related globals.
 *
 * Returns null when g_sitecore.gamedatas is not available (non-game page).
 */
function extractStructuredGameState(): StructuredGameState | null {
  const sitecore = window.g_sitecore;
  if (!sitecore?.gamedatas) return null;

  const gd = sitecore.gamedatas;
  // player_id may live on sitecore or directly on window as current_player_id
  const currentPlayerId = String(
    (sitecore as Record<string, unknown>).current_player_id ??
    (window as unknown as Record<string, unknown>).current_player_id ??
    ""
  );
  if (!currentPlayerId || !gd.players?.[currentPlayerId]) return null;

  // Extract game name from URL slug — most reliable source
  const slugMatch = window.location.pathname.match(/\/\d+\/([a-z0-9_]+)/i);
  const gameName = slugMatch ? slugMatch[1].toLowerCase() : undefined;

  const rawPlayer = gd.players[currentPlayerId];

  // Build card status map from gamestate private args
  const statuses = gd.gamestate?.args?._private?.statuses ?? null;

  const hand: StructuredCard[] = recordToArray(rawPlayer.hand).map((card) => {
    const cardId = String(card.id ?? "");
    const rawStatus = statuses?.[cardId] ?? null;
    const statusEntry: StructuredCardStatus | undefined = rawStatus
      ? {
          playable: rawStatus.playable ?? false,
          conditions: rawStatus.conditions,
          cost: rawStatus.cost,
          enclosure: rawStatus.enclosure,
          reason: rawStatus.playable
            ? "Can be played"
            : "Cannot be played",
        }
      : statuses !== null
      ? { playable: false, reason: "playability unknown" }
      : { playable: false, reason: "playability unknown (not your turn)" };

    return {
      id: card.id,
      name: card.name,
      type: card.type,
      cost: card.cost,
      lvl: card.lvl,
      enclosureSize: card.enclosureSize,
      enclosureRequirements: card.enclosureRequirements,
      specialEnclosure: card.specialEnclosure,
      categories: card.categories,
      prerequisites: card.prerequisites,
      continents: card.continents,
      ability: card.ability,
      status: statusEntry,
    };
  });

  const actionCards: StructuredActionCard[] = recordToArray(rawPlayer.actionCards).map(
    (ac) => ({
      name: ac.name,
      actionType: ac.actionType,
      strength: ac.strength,
      level: ac.level,
      status: ac.status,
      descI: ac.descI,
      descII: ac.descII,
    })
  );

  const scoringHand = recordToArray(rawPlayer.scoringHand).map((sc) => ({
    name: sc.name,
    desc: sc.desc,
    scoreMap: sc.scoreMap,
  }));

  // Opponents: all players except the current one
  const opponents: StructuredOpponent[] = Object.entries(gd.players ?? {})
    .filter(([id]) => id !== currentPlayerId)
    .map(([id, p]) => ({
      id,
      name: p.name,
      money: liveCounter(sitecore, id, "money", p.money),
      reputation: liveCounter(sitecore, id, "reputation", p.reputation),
      appeal: liveCounter(sitecore, id, "appeal", p.appeal),
      conservation: liveCounter(sitecore, id, "conservation", p.conservation),
      score: liveCounter(sitecore, id, "score", p.score),
      xtoken: liveCounter(sitecore, id, "xtoken", p.xtoken),
      actionCards: recordToArray(p.actionCards).map((ac) => ({
        name: ac.name,
        actionType: ac.actionType,
        strength: ac.strength,
        level: ac.level,
      })),
      icons: p.icons as Record<string, unknown> | undefined,
      handCount: p.hand ? Object.keys(p.hand).length : undefined,
    }));

  return {
    currentPlayerId,
    gameName,
    player: {
      id: currentPlayerId,
      name: rawPlayer.name,
      money: liveCounter(sitecore, currentPlayerId, "money", rawPlayer.money),
      reputation: liveCounter(sitecore, currentPlayerId, "reputation", rawPlayer.reputation),
      appeal: liveCounter(sitecore, currentPlayerId, "appeal", rawPlayer.appeal),
      conservation: liveCounter(sitecore, currentPlayerId, "conservation", rawPlayer.conservation),
      xtoken: liveCounter(sitecore, currentPlayerId, "xtoken", rawPlayer.xtoken),
      income: liveCounter(sitecore, currentPlayerId, "income", rawPlayer.income),
      score: liveCounter(sitecore, currentPlayerId, "score", rawPlayer.score),
      hand,
      actionCards,
      icons: rawPlayer.icons as Record<string, unknown> | undefined,
      sizes: rawPlayer.sizes as Record<string, unknown> | undefined,
      scoringHand,
      mapId: rawPlayer.mapId,
    },
    gamestate: {
      name: gd.gamestate?.name,
      active_player: gd.gamestate?.active_player,
      possibleactions: gd.gamestate?.possibleactions,
      description: gd.gamestate?.description,
    },
    opponents,
  };
}

// ---------------------------------------------------------------------------
// User info — postMessage flow
// ---------------------------------------------------------------------------

console.log("[BGA MAIN] main-world.ts loaded");

function sendUserInfo(): void {
  const info = window.globalUserInfos ?? null;
  console.log("[BGA MAIN] postMessage __bga_userinfo:", info);
  window.postMessage({ type: "__bga_userinfo", detail: info }, "*");
}

// ---------------------------------------------------------------------------
// Game state — postMessage flow
// ---------------------------------------------------------------------------

// Push state proactively on script load so the isolated world has it cached
// before any GET_GAME_STATE request arrives.
(function pushInitialState() {
  if (window.g_sitecore?.gamedatas) {
    sendGameState();
  } else {
    // gamedatas not ready yet — wait for load event
    window.addEventListener("load", () => sendGameState(), { once: true });
  }
})();

function sendGameState(): void {
  const state = extractStructuredGameState();
  console.log("[BGA MAIN] postMessage __bga_gamestate, state:", state
    ? `player=${state.player.name}, game=${state.gameName}, hand=${state.player.hand.length} cards`
    : `null (g_sitecore=${!!window.g_sitecore}, gamedatas=${!!window.g_sitecore?.gamedatas}, currentPlayerId=${
        String((window.g_sitecore as Record<string,unknown>)?.current_player_id ?? (window as unknown as Record<string,unknown>).current_player_id ?? "?")
      }, playerExists=${
        !!window.g_sitecore?.gamedatas?.players?.[String((window.g_sitecore as Record<string,unknown>)?.current_player_id ?? (window as unknown as Record<string,unknown>).current_player_id ?? "")]
      })`
  );
  window.postMessage({ type: "__bga_gamestate", detail: state }, "*");
}

// ---------------------------------------------------------------------------
// Listen for requests from the isolated script
// ---------------------------------------------------------------------------

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "__bga_request_userinfo") {
    console.log("[BGA MAIN] received __bga_request_userinfo, globalUserInfos:", window.globalUserInfos);
    if (window.globalUserInfos) {
      sendUserInfo();
    } else {
      window.addEventListener("load", sendUserInfo, { once: true });
    }
    return;
  }

  if (event.data?.type === "__bga_request_gamestate") {
    console.log("[BGA MAIN] received __bga_request_gamestate");
    sendGameState();
    return;
  }
});
