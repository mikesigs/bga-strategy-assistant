/**
 * Content Script — injected into BGA game and table pages.
 *
 * Sub-Task 2: Extracts current game state from the DOM and responds to
 * GET_GAME_STATE messages from the side panel.
 *
 * Sub-Task 3: Detects the English rulebook PDF link from BGA's "How to Play"
 * section and forwards it to the service worker via chrome.runtime.sendMessage.
 */

console.log("[BGA Assistant] Content script injected on:", location.href);

/** Maximum characters to retain from the game log (keep the most recent tail). */
const GAME_LOG_MAX_CHARS = 3000;

/**
 * Collapse runs of whitespace (spaces, tabs, newlines) into a single space
 * and trim the result. Keeps extracted text compact for LLM context.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extract the canonical game name from the current URL or page title.
 *
 * BGA URL patterns:
 *   https://boardgamearena.com/<number>/<gamename>        (active game)
 *   https://boardgamearena.com/table?table=<id>           (table lobby)
 *
 * Falls back to the first word of the page <title> (BGA titles look like
 * "Carcassonne - Board Game Arena").
 */
function extractGameName(): string {
  // Pattern 1: /<digits>/<gamename>  e.g. /12345/arknova
  const slugMatch = location.pathname.match(/\/\d+\/([a-z0-9_]+)/i);
  if (slugMatch) return slugMatch[1].toLowerCase();

  // Pattern 2: known BGA DOM element
  const gameNameEl = document.querySelector<HTMLElement>(
    '[id^="game_name"], .game_name, #game-name, [class*="gameName"]'
  );
  if (gameNameEl?.textContent?.trim()) {
    return gameNameEl.textContent.trim().toLowerCase().replace(/\s+/g, "");
  }

  // Pattern 3: page title — BGA titles are "Status • GameName • Board Game Arena"
  // Split on bullet/dash separators and find the segment that looks like a game
  // name (short, no status verbs).
  const rawTitle = document.title ?? "";
  const segments = rawTitle.split(/\s*[•\-–|]\s*/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    // Skip segments that look like player status messages
    if (/\b(must|choose|play|select|pick|take|place|buy|build|draw)\b/i.test(seg)) continue;
    // Skip "Board Game Arena"
    if (/board game arena/i.test(seg)) continue;
    // Accept short segments — likely the game name
    if (seg.length > 0 && seg.length < 40) {
      return seg.toLowerCase().replace(/\s+/g, "");
    }
  }

  return "";
}

/**
 * Extract the raw text content of a DOM element, or return "" if not found.
 * Uses collapseWhitespace to normalise the result.
 */
function extractText(selector: string): string {
  const el = document.querySelector(selector);
  if (!el) return "";
  return collapseWhitespace(el.textContent ?? "");
}

/**
 * Detect the active (current-turn) player name from the DOM.
 *
 * BGA marks the active player with several possible CSS classes depending on
 * the game skin, checked in priority order:
 *   1. .active-player inside a player panel
 *   2. .current_player inside a player panel
 *   3. Any element with class "active" that also contains a .player-name child
 *   4. Supplementary: #generalactions text (often reads "It is X's turn")
 */
function extractActivePlayer(): string {
  // Strategy 1 & 2: highlighted player panels
  for (const cls of [".active-player", ".current_player"]) {
    const el = document.querySelector(`${cls} .player-name, ${cls}`);
    if (el) {
      const text = collapseWhitespace(el.textContent ?? "");
      if (text) return text;
    }
  }

  // Strategy 3: generic .active container with a .player-name descendant
  const activeName = document.querySelector(".active .player-name");
  if (activeName) {
    const text = collapseWhitespace(activeName.textContent ?? "");
    if (text) return text;
  }

  // Strategy 4: #generalactions often contains "It is <Name>'s turn"
  const generalActions = document.querySelector("#generalactions");
  if (generalActions) {
    const text = collapseWhitespace(generalActions.textContent ?? "");
    if (text) return text;
  }

  return "";
}

interface GameState {
  gameName: string;
  pageTitle: string;
  playerBoardsText: string;
  gameLogText: string;
  activePlayer: string;
  bgaPlayerId: string | null;
  bgaUsername: string | null;
  structuredState?: object | null;
}

/**
 * Build a JSON-serialisable snapshot of the current game state from the DOM.
 * All fields fall back to empty strings when the element is not present
 * (e.g. on a non-game page or a loading screen).
 */
/** Player ID detected from window.globalUserInfos via the MAIN world script. */
let bgaPlayerId: string | null = null;
let bgaUsername: string | null = null;

function getGameState(): GameState {
  const gameName = extractGameName();
  const pageTitle = collapseWhitespace(document.title);
  const playerBoardsText = extractText("#player_boards");

  // Game log: keep only the most recent GAME_LOG_MAX_CHARS characters
  const rawLog = extractText("#game_log");
  const gameLogText = rawLog.length > GAME_LOG_MAX_CHARS
    ? rawLog.slice(-GAME_LOG_MAX_CHARS)
    : rawLog;

  const activePlayer = extractActivePlayer();

  return { gameName, pageTitle, playerBoardsText, gameLogText, activePlayer, bgaPlayerId, bgaUsername };
}

// ---------------------------------------------------------------------------
// User info detection (relayed from MAIN world script via CustomEvent)
// ---------------------------------------------------------------------------

/** True once we have sent a USER_INFO message for this page session. */
let userInfoMessageSent = false;

// Register the response listener FIRST, then send the request.
// Using postMessage instead of CustomEvent for cross-world reliability.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (event.data?.type !== "__bga_userinfo") return;
  if (userInfoMessageSent) return;

  const detail = event.data.detail as { id: number | string; name: string } | null;
  if (!detail) return; // null means not logged in

  bgaPlayerId = String(detail.id);
  bgaUsername = detail.name;
  userInfoMessageSent = true;

  chrome.runtime.sendMessage({
    type: "USER_INFO",
    id: bgaPlayerId,
    name: bgaUsername,
  });
  console.log("[BGA Assistant] User detected:", bgaUsername, "(ID:", bgaPlayerId + ")");
});

// Ask the MAIN world script to reply with globalUserInfos.
console.log("[BGA ISOLATED] posting __bga_request_userinfo");
window.postMessage({ type: "__bga_request_userinfo" }, "*");

// ---------------------------------------------------------------------------
// Sub-Task 3 — Rulebook PDF detection
// ---------------------------------------------------------------------------

/**
 * Scan the DOM for rulebook/rules PDF links in the #game-links section.
 *
 * Priority order:
 * 1. Anchors inside #game-links whose text contains "Rulebook" (case-insensitive)
 * 2. Anchors inside #game-links with a link_lang attribute containing "(en)"
 * 3. Any anchor in #game-links whose href ends in .pdf or matches BGA gamemedia/rule pattern
 * 4. Fallback: same scan across the full page body
 *
 * Returns an array of all viable URLs (caller picks the best one or uses all).
 */
function findRulebookPdfUrls(): string[] {
  const searchRoots: Element[] = [];

  const gameLinks = document.querySelector("#game-links");
  if (gameLinks) searchRoots.push(gameLinks);

  // Also try legacy how-to-play container IDs as fallback roots
  for (const sel of ["#howtoplay", "#how_to_play", "#help_section", "#rules"]) {
    const el = document.querySelector(sel);
    if (el && !searchRoots.includes(el)) searchRoots.push(el);
  }

  // Final fallback: entire body
  if (searchRoots.length === 0) searchRoots.push(document.body);

  const seen = new Set<string>();
  const rulebook: string[] = [];
  const english: string[] = [];
  const other: string[] = [];

  for (const root of searchRoots) {
    const anchors = Array.from(root.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    for (const a of anchors) {
      const href = a.href;
      if (!href || seen.has(href)) continue;
      // Must look like a PDF or BGA rules file
      const looksLikePdf = href.endsWith(".pdf") || /\/gamemedia\/[^/]+\/rule\//i.test(href);
      if (!looksLikePdf) continue;
      seen.add(href);

      const text = (a.textContent ?? "").toLowerCase().trim();
      const lang = (a.getAttribute("link_lang") ?? "").toLowerCase();

      if (text.includes("rulebook")) {
        rulebook.push(href);
      } else if (lang.includes("(en)") || text.includes("english") || /\ben\b/.test(text)) {
        english.push(href);
      } else {
        other.push(href);
      }
    }
  }

  // Return in priority order: explicit Rulebook label > English label > others
  return [...rulebook, ...english, ...other];
}

/** Convenience wrapper — returns the single best rulebook URL or null. */
function findRulebookPdfUrl(): string | null {
  const urls = findRulebookPdfUrls();
  if (urls.length === 0) return null;
  console.log("[BGA Assistant] Rulebook candidates found:", urls);
  return urls[0];
}

/** True once we have sent a RULEBOOK_URL_FOUND or RULEBOOK_NOT_FOUND message
 *  for this page session, so we do not fire again on subsequent DOM mutations. */
let rulebookMessageSent = false;

/** The game name used when rulebookMessageSent was set — if game name changes
 *  (e.g. corrected by structured state), we re-run detection. */
let rulebookSentForGame = "";

/**
 * Attempt to detect the rulebook PDF and, if found (or timed out), send the
 * appropriate message to the service worker.
 *
 * @param isTimeout - When true, we send RULEBOOK_NOT_FOUND even if the PDF is
 *   still absent (the observation window has expired).
 */
function trySendRulebookMessage(gameNameOverride?: string, isTimeout = false): void {
  if (rulebookMessageSent) return;

  const pdfUrl = findRulebookPdfUrl();
  const gameName = gameNameOverride ?? extractGameName();

  if (!gameName) return; // don't send with empty game name

  if (pdfUrl) {
    rulebookMessageSent = true;
    rulebookSentForGame = gameName;
    chrome.runtime.sendMessage({
      type: "RULEBOOK_URL_FOUND",
      gameName,
      pdfUrl,
    });
    console.log("[BGA Assistant] Rulebook PDF detected:", pdfUrl, "for game:", gameName);
  } else if (isTimeout) {
    rulebookMessageSent = true;
    rulebookSentForGame = gameName;
    chrome.runtime.sendMessage({
      type: "RULEBOOK_NOT_FOUND",
      gameName,
    });
    console.log("[BGA Assistant] Rulebook PDF not found for:", gameName);
  }
}

/**
 * Called when the structured state arrives with an authoritative game name.
 * If rulebook detection already ran under a different (wrong) name, reset and retry.
 */
function recheckRulebookForGame(gameName: string): void {
  if (!gameName) return;
  if (rulebookMessageSent && rulebookSentForGame === gameName) return; // already correct
  // Reset and re-run with the correct name
  rulebookMessageSent = false;
  rulebookSentForGame = "";
  trySendRulebookMessage(gameName);
}

/**
 * Set up a MutationObserver that watches for the "How to Play" section being
 * added asynchronously after the main game board renders.  The observer is
 * disconnected as soon as the PDF is found, or after a 15-second timeout.
 */
function initRulebookDetection(): void {
  // Immediate scan — section may already be in the DOM.
  trySendRulebookMessage();
  if (rulebookMessageSent) return;

  const observer = new MutationObserver(() => {
    trySendRulebookMessage();
    if (rulebookMessageSent) observer.disconnect();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Hard timeout: give up after 15 seconds and report not found.
  setTimeout(() => {
    if (!rulebookMessageSent) {
      observer.disconnect();
      trySendRulebookMessage(undefined, /* isTimeout */ true);
    }
  }, 15_000);
}

// Kick off rulebook detection once the DOM is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initRulebookDetection);
} else {
  initRulebookDetection();
}

// ---------------------------------------------------------------------------
// Structured state cache — populated by MAIN world push on load
// ---------------------------------------------------------------------------

/** Cached structured game state, pushed from the MAIN world on page load. */
let cachedStructuredState: object | null = null;

// Listen for proactive pushes from the MAIN world (sent on page load and on request).
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (event.data?.type !== "__bga_gamestate") return;

  const state = (event.data.detail as { gameName?: string } | null) ?? null;
  cachedStructuredState = state;

  if (state) {
    const gameName = (state as { gameName?: string }).gameName;
    if (gameName) recheckRulebookForGame(gameName);
    console.log("[BGA Assistant] Structured state cached from MAIN world, game:", gameName);
  }
});

// Request structured state from MAIN world immediately on script load.
// MAIN world sends it back via postMessage — no waiting in message handler.
window.postMessage({ type: "__bga_request_gamestate" }, "*");

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    const msg = message as { type?: string };

    if (msg.type === "GET_GAME_STATE") {
      // Request a fresh state from MAIN world (async — updates cache for next call)
      window.postMessage({ type: "__bga_request_gamestate" }, "*");

      // Respond immediately with DOM snapshot + whatever is in cache right now
      const domSnapshot = getGameState();
      const structuredState = cachedStructuredState;
      const gameName = (structuredState as { gameName?: string } | null)?.gameName
        ?? domSnapshot.gameName;

      sendResponse({
        type: "GAME_STATE",
        data: { ...domSnapshot, gameName, structuredState },
      });

      return false; // synchronous response
    }

    return false;
  }
);
