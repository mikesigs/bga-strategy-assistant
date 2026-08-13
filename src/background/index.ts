/**
 * Service Worker (background) — main entry point
 *
 * Sub-Task 4: Rulebook fetch, parse, and cache via pdfjs-dist (legacy build).
 * Sub-Task 6: LLM orchestration (buildSystemPrompt, callOpenAI, callAnthropic,
 *             executeBGGSearch, agentic loop, ASK_LLM handler).
 *
 * pdfjs-dist import notes:
 *   - Using the legacy CJS build (`pdfjs-dist/legacy/build/pdf`) which runs
 *     synchronously in a service worker without a separate worker thread.
 *   - GlobalWorkerOptions.workerSrc is set to '' to disable the worker thread.
 *   - @ts-expect-error is used because the legacy build path has no separate
 *     .d.ts; the main pdfjs-dist types still cover the API surface.
 */

// @ts-expect-error — legacy CJS build; types come from the main pdfjs-dist package
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";

// Disable the separate worker thread — required in a service worker context.
(pdfjsLib as typeof pdfjsLib).GlobalWorkerOptions.workerSrc = "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RulebookEntry {
  text: string;
  fetchedAt: string;
}

interface NoRulebookEntry {
  noRulebook: true;
}

type StorageEntry = RulebookEntry | NoRulebookEntry;

// Inbound message shapes
interface MsgRulebookUrlFound {
  type: "RULEBOOK_URL_FOUND";
  gameName: string;
  pdfUrl: string;
}

interface MsgRulebookNotFound {
  type: "RULEBOOK_NOT_FOUND";
  gameName: string;
}

interface MsgGetRulebook {
  type: "GET_RULEBOOK";
  gameName: string;
}

interface MsgUploadRulebook {
  type: "UPLOAD_RULEBOOK";
  gameName: string;
  buffer: ArrayBuffer;
}

// Minimal typed subset of the structured state produced by main-world.ts.
// We keep it loosely typed here so the background script doesn't need to
// duplicate all the detailed card interfaces.
interface StructuredPlayerState {
  id: string;
  name?: string;
  money?: string | number;
  reputation?: string | number;
  appeal?: string | number;
  conservation?: string | number;
  xtoken?: string | number;
  income?: string | number;
  score?: string | number;
  hand?: Array<{
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
    status?: {
      playable: boolean;
      conditions?: unknown;
      cost?: boolean | unknown;
      enclosure?: boolean | unknown;
      reason?: string;
    };
  }>;
  actionCards?: Array<{
    name?: string;
    actionType?: string;
    strength?: string | number;
    level?: string | number;
    status?: string;
    descI?: string;
    descII?: string;
  }>;
  icons?: Record<string, unknown>;
  sizes?: Record<string, unknown>;
  scoringHand?: Array<{ name?: string; desc?: string; scoreMap?: unknown }>;
  mapId?: string | number;
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

interface StructuredGameStatePayload {
  currentPlayerId: string;
  player: StructuredPlayerState;
  gamestate: {
    name?: string;
    active_player?: string | number;
    possibleactions?: string[];
    description?: string;
  };
  opponents: StructuredOpponent[];
}

interface GameState {
  gameName?: string;
  pageTitle?: string;
  playerBoardsText?: string;
  gameLogText?: string;
  activePlayer?: string;
  bgaPlayerId?: string | null;
  bgaUsername?: string | null;
  structuredState?: StructuredGameStatePayload | null;
}

interface MsgAskLlm {
  type: "ASK_LLM";
  question: string;
  gameName: string;
  gameState?: GameState;
}

interface MsgUserInfo {
  type: "USER_INFO";
  id: string;
  name: string;
}

type InboundMessage =
  | MsgRulebookUrlFound
  | MsgRulebookNotFound
  | MsgGetRulebook
  | MsgUploadRulebook
  | MsgAskLlm
  | MsgUserInfo;

// Outbound response shapes
interface RulebookDataResponse {
  type: "RULEBOOK_DATA";
  text: string | null;
  needsUpload?: boolean;
}

interface LlmResponse {
  type: "LLM_RESPONSE";
  text: string;
}

interface LlmError {
  type: "LLM_ERROR";
  error: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_BYTES = 500 * 1024; // 500 KB

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function storageKey(gameName: string): string {
  return `rulebook_${gameName}`;
}

async function getRulebookFromCache(
  gameName: string
): Promise<StorageEntry | null> {
  const key = storageKey(gameName);
  const result = await chrome.storage.local.get(key);
  return (result[key] as StorageEntry) ?? null;
}

async function cacheRulebook(gameName: string, text: string): Promise<void> {
  const key = storageKey(gameName);
  const entry: RulebookEntry = { text, fetchedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [key]: entry });
  console.log(`[BGA Assistant SW] Cached rulebook for "${gameName}" (${text.length} chars).`);
}

async function cacheNoRulebook(gameName: string): Promise<void> {
  const key = storageKey(gameName);
  const entry: NoRulebookEntry = { noRulebook: true };
  await chrome.storage.local.set({ [key]: entry });
  console.log(`[BGA Assistant SW] Stored noRulebook flag for "${gameName}".`);
}

// ---------------------------------------------------------------------------
// PDF parsing
// ---------------------------------------------------------------------------

async function parseRulebookBuffer(buffer: ArrayBuffer): Promise<string> {
  const loadingTask = (pdfjsLib as typeof pdfjsLib).getDocument({ data: buffer });
  const pdf: PDFDocumentProxy = await loadingTask.promise;
  const pageTexts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: { str?: string }) => item.str ?? "")
      .join(" ");
    pageTexts.push(pageText);
  }

  let text = pageTexts.join("\n");

  // Truncate to 500 KB if needed
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_TEXT_BYTES) {
    console.warn(
      `[BGA Assistant SW] Rulebook text exceeds 500 KB (${byteLength} bytes); truncating.`
    );
    // Slice characters until encoded bytes fit — approximate by char count ratio
    const ratio = MAX_TEXT_BYTES / byteLength;
    text = text.slice(0, Math.floor(text.length * ratio));
  }

  return text;
}

async function fetchAndParseRulebook(pdfUrl: string): Promise<string> {
  console.log(`[BGA Assistant SW] Fetching rulebook PDF: ${pdfUrl}`);
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return parseRulebookBuffer(buffer);
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleRulebookUrlFound(msg: MsgRulebookUrlFound): Promise<void> {
  const { gameName, pdfUrl } = msg;
  const cached = await getRulebookFromCache(gameName);
  if (cached && "text" in cached) {
    console.log(`[BGA Assistant SW] Cache hit for "${gameName}" — skipping download.`);
    return;
  }
  try {
    const text = await fetchAndParseRulebook(pdfUrl);
    await cacheRulebook(gameName, text);
  } catch (err) {
    console.error(`[BGA Assistant SW] Failed to fetch/parse rulebook for "${gameName}":`, err);
  }
}

async function handleRulebookNotFound(msg: MsgRulebookNotFound): Promise<void> {
  const { gameName } = msg;
  // Only write the flag if there is no existing cached text (don't overwrite a
  // previously uploaded rulebook with a noRulebook flag).
  const cached = await getRulebookFromCache(gameName);
  if (!cached) {
    await cacheNoRulebook(gameName);
  }
}

async function handleGetRulebook(
  msg: MsgGetRulebook
): Promise<RulebookDataResponse> {
  const { gameName } = msg;
  const cached = await getRulebookFromCache(gameName);
  if (cached && "text" in cached) {
    return { type: "RULEBOOK_DATA", text: cached.text };
  }
  if (cached && "noRulebook" in cached) {
    return { type: "RULEBOOK_DATA", text: null, needsUpload: true };
  }
  // Nothing stored yet — treat as needsUpload until detection finishes.
  return { type: "RULEBOOK_DATA", text: null, needsUpload: true };
}

async function handleUploadRulebook(msg: MsgUploadRulebook): Promise<void> {
  const { gameName, buffer } = msg;
  try {
    const text = await parseRulebookBuffer(buffer);
    await cacheRulebook(gameName, text);
  } catch (err) {
    console.error(`[BGA Assistant SW] Failed to parse uploaded rulebook for "${gameName}":`, err);
  }
}

// ---------------------------------------------------------------------------
// LLM orchestration (Sub-Task 6)
// ---------------------------------------------------------------------------

/** ~32 000 chars ≈ 8 000 tokens at ~4 chars/token */
const RULEBOOK_CHAR_LIMIT = 32_000;

async function handleUserInfo(msg: MsgUserInfo): Promise<void> {
  await chrome.storage.local.set({
    bga_player_id: msg.id,
    bga_username: msg.name,
  });
  console.log("[BGA Assistant SW] User info stored:", msg.name, "(ID:", msg.id + ")");
}

// ── Structured state formatters ─────────────────────────────────────────────

/** Format a resource row: "Money: 20 | Reputation: 3 | ..." */
function formatResources(p: StructuredPlayerState): string {
  const parts: string[] = [];
  if (p.money    != null) parts.push(`Money: ${p.money}`);
  if (p.reputation != null) parts.push(`Reputation: ${p.reputation}`);
  if (p.appeal   != null) parts.push(`Appeal: ${p.appeal}`);
  if (p.conservation != null) parts.push(`Conservation: ${p.conservation}`);
  if (p.xtoken   != null) parts.push(`X-tokens: ${p.xtoken}`);
  if (p.income   != null) parts.push(`Income: ${p.income}`);
  if (p.score    != null) parts.push(`Score: ${p.score}`);
  return parts.join(" | ");
}

/** Render the player's hand as a numbered list with playability annotations. */
function formatHand(hand: StructuredPlayerState["hand"]): string {
  if (!hand || hand.length === 0) return "(no cards in hand)";
  return hand.map((card, i) => {
    const idx = i + 1;
    const type = card.type ? ` [${card.type}]` : "";
    const cost = card.cost != null ? ` — Cost: ${card.cost}` : "";
    const lvl  = card.lvl  != null ? ` | Level: ${card.lvl}` : "";
    const encSize = card.enclosureSize != null ? ` | Enclosure: size ${card.enclosureSize}` : "";
    const ability = card.ability ? ` | Ability: ${card.ability}` : "";

    // Continents: may be an object/array — render as joined string
    const continentStr = card.continents
      ? " | Continent: " + (
          Array.isArray(card.continents)
            ? (card.continents as string[]).join(", ")
            : typeof card.continents === "object"
            ? Object.values(card.continents as Record<string, unknown>).join(", ")
            : String(card.continents)
        )
      : "";

    // Prerequisites
    const prereqStr = card.prerequisites
      ? " | Prerequisites: " + (
          typeof card.prerequisites === "object"
            ? JSON.stringify(card.prerequisites)
            : String(card.prerequisites)
        )
      : "";

    const header = `${idx}. ${card.name ?? `Card #${card.id}`}${type}${cost}${lvl}${encSize}${prereqStr}${continentStr}${ability}`;

    if (!card.status) return header;
    const icon = card.status.playable ? "✅" : "❌";
    const reason = card.status.reason ?? (card.status.playable ? "Can be played" : "Cannot be played");
    return `${header}\n   ${icon} ${reason}`;
  }).join("\n");
}

/** Render the player's action cards as a bullet list. */
function formatActionCards(acs: StructuredPlayerState["actionCards"]): string {
  if (!acs || acs.length === 0) return "(no action cards)";
  return acs.map((ac) => {
    const label = [ac.actionType, `strength ${ac.strength}`, `level ${ac.level}`]
      .filter(Boolean)
      .join(", ");
    const desc = ac.descI ? ` ${ac.descI}` : "";
    const desc2 = ac.descII ? ` / ${ac.descII}` : "";
    return `- ${ac.name ?? "(unnamed)"} (${label}):${desc}${desc2}`;
  }).join("\n");
}

/** Render opponents as a compact bullet list. */
function formatOpponents(opponents: StructuredOpponent[], activePlayerId: string | number | undefined): string {
  if (opponents.length === 0) return "(no opponents)";
  return opponents.map((op) => {
    const resources = [
      op.money        != null ? `Money ${op.money}`        : null,
      op.appeal       != null ? `Appeal ${op.appeal}`      : null,
      op.reputation   != null ? `Reputation ${op.reputation}` : null,
      op.conservation != null ? `Conservation ${op.conservation}` : null,
      op.score        != null ? `Score ${op.score}`        : null,
      op.handCount    != null ? `Cards in hand: ${op.handCount}` : null,
    ].filter(Boolean).join(" | ");
    const activeMark = String(op.id) === String(activePlayerId) ? " ← active" : "";
    return `- ${op.name ?? op.id}: ${resources}${activeMark}`;
  }).join("\n");
}

/**
 * Build the structured sections of the system prompt when structured game
 * state is available from the MAIN world script.
 */
function buildStructuredStateSections(ss: StructuredGameStatePayload, gameLogText?: string): string {
  const p = ss.player;
  const gs = ss.gamestate;

  const activePlayerName = (() => {
    const id = String(gs.active_player ?? "");
    if (!id) return undefined;
    if (id === ss.currentPlayerId) return p.name ?? id;
    const opp = ss.opponents.find((o) => o.id === id);
    return opp?.name ?? id;
  })();

  const sections: string[] = [];

  // Resources
  sections.push("## Your resources", "", formatResources(p));

  // Hand
  const handCount = p.hand?.length ?? 0;
  sections.push("", `## Your hand (${handCount} card${handCount !== 1 ? "s" : ""})`, "", formatHand(p.hand));

  // Action cards
  sections.push("", "## Your action cards", "", formatActionCards(p.actionCards));

  // Current game state
  const gsLines: string[] = [
    `State: ${gs.name ?? "(unknown)"}${gs.description ? ` — ${gs.description}` : ""}`,
  ];
  if (activePlayerName) gsLines.push(`Active player: ${activePlayerName} (${gs.active_player})`);
  if (gs.possibleactions?.length) gsLines.push(`Possible actions: ${gs.possibleactions.join(", ")}`);
  sections.push("", "## Current game state", "", gsLines.join("\n"));

  // Opponents
  sections.push("", "## Opponents", "", formatOpponents(ss.opponents, gs.active_player));

  // Game log as fallback tail
  if (gameLogText) {
    sections.push("", "## Recent game log", "", gameLogText);
  }

  return sections.join("\n");
}

function buildSystemPrompt(
  gameName: string,
  gameState: GameState | null | undefined,
  rulebookText: string | null | undefined,
  bgaUsername?: string
): string {
  // Prefer the auto-detected username from game state; fall back to stored setting.
  const resolvedUsername = gameState?.bgaUsername || bgaUsername || null;

  const playerLine = resolvedUsername
    ? `The user's BGA username is "${resolvedUsername}". Always reason from ${resolvedUsername}'s perspective, even when it is not their turn.`
    : "The user's BGA username is unknown. Reason from the perspective of whichever player they indicate.";

  // Build the game-state section: prefer structured data when available.
  let stateSection: string;
  if (gameState?.structuredState) {
    stateSection = buildStructuredStateSections(
      gameState.structuredState,
      gameState.gameLogText
    );
  } else if (gameState) {
    // Fallback to DOM-scraped text
    stateSection = [
      `Game name: ${gameState.gameName ?? gameName}`,
      gameState.pageTitle    ? `Page title: ${gameState.pageTitle}` : null,
      gameState.activePlayer ? `Active player (current turn): ${gameState.activePlayer}` : null,
      gameState.playerBoardsText
        ? `Player boards:\n${gameState.playerBoardsText}`
        : null,
      gameState.gameLogText
        ? `Recent game log:\n${gameState.gameLogText}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  } else {
    stateSection = `Game name: ${gameName}\n(No game state available.)`;
  }

  const rulebookSection = rulebookText
    ? `## Rulebook excerpt (truncated to ~32 000 chars)\n\n${rulebookText.slice(0, RULEBOOK_CHAR_LIMIT)}`
    : "## Rulebook\n\n(No rulebook is loaded for this game.)";

  return [
    "You are a board game strategy assistant. Your job is to help the user make good decisions in their current board game.",
    "",
    "## Player identity",
    "",
    playerLine,
    "",
    stateSection,
    "",
    rulebookSection,
    "",
    "## Instructions",
    "",
    `Answer the user's question from ${resolvedUsername ? `${resolvedUsername}'s` : "the user's"} perspective using the game state and rulebook above as primary context.`,
    "Even if it is not the user's turn, provide advice for what they should plan or consider doing on their next turn.",
    "When strategy tips, forum discussions, or community advice would improve your answer, call the `search_bgg` tool with a concise query.",
    "Do not make up rules — if you are unsure, say so.",
  ].join("\n");
}

// ── Tool definitions ────────────────────────────────────────────────────────

const BGG_TOOL_OPENAI = {
  type: "function" as const,
  function: {
    name: "search_bgg",
    description:
      "Search BoardGameGeek forums and articles for strategy tips about a board game.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query — include the game name and a strategic topic, e.g. 'Carcassonne meeple placement strategy'.",
        },
      },
      required: ["query"],
    },
  },
};

const BGG_TOOL_ANTHROPIC = {
  name: "search_bgg",
  description:
    "Search BoardGameGeek forums and articles for strategy tips about a board game.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Search query — include the game name and a strategic topic, e.g. 'Carcassonne meeple placement strategy'.",
      },
    },
    required: ["query"],
  },
};

// ── BGG search ──────────────────────────────────────────────────────────────

async function executeBGGSearch(query: string): Promise<string> {
  const encoded = encodeURIComponent(query);
  const primaryUrl = `https://boardgamegeek.com/search?q=${encoded}&objecttype=boardgame`;
  const fallbackUrl = `https://boardgamegeek.com/forums/1/general?q=${encoded}`;

  let rawText = "";

  try {
    let response = await fetch(primaryUrl);
    if (!response.ok) {
      response = await fetch(fallbackUrl);
    }
    if (!response.ok) {
      return `BGG search failed: HTTP ${response.status}`;
    }
    rawText = await response.text();
  } catch (err) {
    // Likely a CORS block on the primary URL; try fallback
    try {
      const fallback = await fetch(fallbackUrl);
      rawText = await fallback.text();
    } catch (err2) {
      return `BGG search unavailable: ${String(err2)}`;
    }
  }

  // Strip HTML tags and collapse whitespace
  const stripped = rawText
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped.slice(0, 3000);
}

// ── Provider API calls ──────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  tools: typeof BGG_TOOL_OPENAI[],
  extraMessages: OpenAIMessage[] = []
): Promise<unknown> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userMessage },
    ...extraMessages,
  ];

  const body = {
    model: "gpt-4o",
    messages,
    tools,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${errText}`);
  }

  return response.json();
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
        | { type: "tool_result"; tool_use_id: string; content: string }
      >;
}

async function callAnthropic(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  tools: typeof BGG_TOOL_ANTHROPIC[],
  extraMessages: AnthropicMessage[] = []
): Promise<unknown> {
  const messages: AnthropicMessage[] = [
    { role: "user", content: userMessage },
    ...extraMessages,
  ];

  const body = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 4096,
    system: systemPrompt,
    messages,
    tools,
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic error ${response.status}: ${errText}`);
  }

  return response.json();
}

// ── Agentic loop ────────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 3;

async function runAgenticLoop(
  provider: "openai" | "anthropic",
  apiKey: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  if (provider === "openai") {
    const extraMessages: OpenAIMessage[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const raw = await callOpenAI(
        apiKey,
        systemPrompt,
        userMessage,
        [BGG_TOOL_OPENAI],
        extraMessages
      ) as {
        choices: Array<{
          finish_reason: string;
          message: {
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: "function";
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };

      const choice = raw.choices[0];

      if (
        choice.finish_reason === "tool_calls" &&
        choice.message.tool_calls?.length
      ) {
        const toolCall = choice.message.tool_calls[0];
        const toolArgs = JSON.parse(toolCall.function.arguments) as { query: string };
        console.log(`[BGA Assistant SW] OpenAI tool call: search_bgg("${toolArgs.query}")`);

        const toolResult = await executeBGGSearch(toolArgs.query);

        // Append assistant tool-call message and tool-result message
        extraMessages.push({
          role: "assistant",
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        });
        extraMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: "search_bgg",
          content: toolResult,
        });
        // Continue loop for next LLM call
        continue;
      }

      // No tool call — return final text
      return choice.message.content ?? "";
    }

    // Exhausted rounds — do a final call without tools to force a text answer
    const final = await callOpenAI(
      apiKey,
      systemPrompt,
      userMessage,
      [],
      extraMessages
    ) as { choices: Array<{ message: { content: string | null } }> };
    return final.choices[0].message.content ?? "";

  } else {
    // Anthropic
    const extraMessages: AnthropicMessage[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const raw = await callAnthropic(
        apiKey,
        systemPrompt,
        userMessage,
        [BGG_TOOL_ANTHROPIC],
        extraMessages
      ) as {
        stop_reason: string;
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: { query: string } }
        >;
      };

      if (raw.stop_reason === "tool_use") {
        const toolUseBlock = raw.content.find(
          (b): b is { type: "tool_use"; id: string; name: string; input: { query: string } } =>
            b.type === "tool_use"
        );
        if (!toolUseBlock) break;

        console.log(`[BGA Assistant SW] Anthropic tool call: search_bgg("${toolUseBlock.input.query}")`);
        const toolResult = await executeBGGSearch(toolUseBlock.input.query);

        // Append assistant message (full content array) and tool result message
        extraMessages.push({ role: "assistant", content: raw.content });
        extraMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseBlock.id,
              content: toolResult,
            },
          ],
        });
        continue;
      }

      // No tool use — extract text block
      const textBlock = raw.content.find(
        (b): b is { type: "text"; text: string } => b.type === "text"
      );
      return textBlock?.text ?? "";
    }

    // Exhausted rounds — final call without tools
    const final = await callAnthropic(
      apiKey,
      systemPrompt,
      userMessage,
      [],
      extraMessages
    ) as {
      content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>;
    };
    const textBlock = final.content.find(
      (b): b is { type: "text"; text: string } => b.type === "text"
    );
    return textBlock?.text ?? "";
  }
}

// ── ASK_LLM handler ─────────────────────────────────────────────────────────

async function handleAskLlm(msg: MsgAskLlm): Promise<LlmResponse | LlmError> {
  const { question, gameName, gameState } = msg;

  // Load settings and stored player info (fallback when gameState has no user info)
  const stored = await chrome.storage.local.get([
    "openai_key",
    "anthropic_key",
    "selected_provider",
    "bga_username",
  ]) as {
    openai_key?: string;
    anthropic_key?: string;
    selected_provider?: "openai" | "anthropic";
    bga_username?: string;
  };

  const provider = stored.selected_provider ?? "openai";
  const apiKey =
    provider === "anthropic" ? stored.anthropic_key : stored.openai_key;

  if (!apiKey) {
    return {
      type: "LLM_ERROR",
      error: `No API key configured for provider "${provider}". Open Settings and enter your key.`,
    };
  }

  // Get rulebook from cache
  const rulebookEntry = await getRulebookFromCache(gameName);
  const rulebookText =
    rulebookEntry && "text" in rulebookEntry ? rulebookEntry.text : null;

  // bgaUsername from storage is a fallback; gameState.bgaUsername is preferred (set by auto-detection)
  const systemPrompt = buildSystemPrompt(gameName, gameState, rulebookText, stored.bga_username);

  // Diagnostic logging — visible in the SW DevTools console
  console.log("[BGA Assistant SW] ASK_LLM diagnostics:", {
    gameName,
    hasGameState: !!gameState,
    hasStructuredState: !!(gameState as { structuredState?: unknown } | undefined)?.structuredState,
    structuredStateKeys: gameState
      ? Object.keys((gameState as { structuredState?: Record<string, unknown> })?.structuredState ?? {})
      : [],
    hasRulebook: !!rulebookText,
    rulebookChars: rulebookText?.length ?? 0,
    bgaUsername: gameState?.bgaUsername ?? stored.bga_username ?? "(none)",
  });
  console.log("[BGA Assistant SW] System prompt (first 1000 chars):\n", systemPrompt.slice(0, 1000));

  try {
    const text = await runAgenticLoop(provider, apiKey, systemPrompt, question);
    return { type: "LLM_RESPONSE", text };
  } catch (err) {
    console.error("[BGA Assistant SW] LLM error:", err);
    return { type: "LLM_ERROR", error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[BGA Assistant] Extension installed / updated.");
});

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    const msg = message as InboundMessage;
    console.log("[BGA Assistant SW] Message received:", msg?.type);

    switch (msg?.type) {
      case "RULEBOOK_URL_FOUND":
        handleRulebookUrlFound(msg).then(() => sendResponse({ ok: true }));
        return true; // async response

      case "RULEBOOK_NOT_FOUND":
        handleRulebookNotFound(msg).then(() => sendResponse({ ok: true }));
        return true;

      case "GET_RULEBOOK":
        handleGetRulebook(msg).then((response) => sendResponse(response));
        return true;

      case "UPLOAD_RULEBOOK":
        handleUploadRulebook(msg).then(() => sendResponse({ ok: true }));
        return true;

      case "ASK_LLM":
        handleAskLlm(msg).then((response) => sendResponse(response));
        return true;

      case "USER_INFO":
        handleUserInfo(msg).then(() => sendResponse({ ok: true }));
        return true;

      default:
        console.warn("[BGA Assistant SW] Unknown message type:", (msg as { type?: string })?.type);
        sendResponse({ ok: false, error: "Unknown message type" });
        return false;
    }
  }
);
