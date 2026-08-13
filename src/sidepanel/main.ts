// Injected at build time by vite.config.ts define
declare const __BUILD_TIME__: string;

/**
 * Side Panel — main entry point (Sub-Task 5)
 *
 * Handles:
 *  - Settings panel (load/save API keys + provider via chrome.storage.local)
 *  - Rulebook status bar (query service worker; show upload fallback)
 *  - Chat thread (user/assistant bubbles, Thinking indicator)
 *  - Message routing via chrome.runtime.sendMessage / chrome.tabs.sendMessage
 */

// ── Types ──────────────────────────────────────────────────────────────────

interface StorageSettings {
  openai_key?: string;
  anthropic_key?: string;
  selected_provider?: "openai" | "anthropic";
}

interface StoragePlayerInfo {
  bga_player_id?: string;
  bga_username?: string;
}

interface GameState {
  gameName?: string;
  pageTitle?: string;
  playerBoardsText?: string;
  gameLogText?: string;
  activePlayer?: string;
  bgaPlayerId?: string | null;
  bgaUsername?: string | null;
}

interface GameStateResponse {
  type: "GAME_STATE";
  data: GameState;
}

interface RulebookResponse {
  text?: string | null;
  needsUpload?: boolean;
}

interface LlmReply {
  type: "LLM_RESPONSE" | "LLM_ERROR";
  text?: string;
  error?: string;
}

// ── Module-level state ─────────────────────────────────────────────────────

let currentGameName: string | null = null;
let currentGameState: GameState | null = null;

// ── DOM refs ───────────────────────────────────────────────────────────────

const settingsPanel     = document.getElementById("settings-panel")!;
const settingsToggle    = document.getElementById("settings-toggle")!;
const settingsClose     = document.getElementById("settings-close")!;
const settingsSave      = document.getElementById("settings-save")!;
const settingsStatus    = document.getElementById("settings-status")!;
const detectedPlayerEl  = document.getElementById("detected-player")!;
const openaiKeyInput    = document.getElementById("openai-key") as HTMLInputElement;
const anthropicKeyInput = document.getElementById("anthropic-key") as HTMLInputElement;
const providerOpenai    = document.getElementById("provider-openai") as HTMLInputElement;
const providerAnthropic = document.getElementById("provider-anthropic") as HTMLInputElement;

const chatThread      = document.getElementById("chat-thread")!;
const messageInput    = document.getElementById("message-input") as HTMLTextAreaElement;
const sendBtn         = document.getElementById("send-btn") as HTMLButtonElement;

const rulebookStatus  = document.getElementById("rulebook-status")!;
const uploadLabel     = document.getElementById("upload-label") as HTMLLabelElement;
const uploadInput     = document.getElementById("upload-input") as HTMLInputElement;

const statusGame      = document.getElementById("status-game")!;
const statusPlayer    = document.getElementById("status-player")!;
const statusBuild     = document.getElementById("status-build")!;

// ── Status bar helpers ─────────────────────────────────────────────────────

function updateStatusBar(gameName: string | null, playerName: string | null): void {
  statusGame.textContent   = gameName   ? `Game: ${gameName}`     : "Game: —";
  statusPlayer.textContent = playerName ? `Player: ${playerName}` : "Player: —";
}

// Set build timestamp immediately — shows user the extension is the latest build
(function setBuildTime() {
  try {
    const dt = new Date(__BUILD_TIME__);
    // Format as e.g. "built 14:32:05" in local time
    const timeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dateStr = dt.toLocaleDateString([], { month: "short", day: "numeric" });
    statusBuild.textContent = `built ${dateStr} ${timeStr}`;
    statusBuild.title = __BUILD_TIME__;
  } catch {
    statusBuild.textContent = "built ?";
  }
})();

// ── Settings ───────────────────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get([
    "openai_key",
    "anthropic_key",
    "selected_provider",
  ]) as StorageSettings;

  if (stored.openai_key)    openaiKeyInput.value = stored.openai_key;
  if (stored.anthropic_key) anthropicKeyInput.value = stored.anthropic_key;

  const provider = stored.selected_provider ?? "openai";
  if (provider === "anthropic") {
    providerAnthropic.checked = true;
  } else {
    providerOpenai.checked = true;
  }

  // Show auto-detected player info (populated by USER_INFO message from content script)
  const playerInfo = await chrome.storage.local.get(["bga_player_id", "bga_username"]) as StoragePlayerInfo;
  if (playerInfo.bga_username && playerInfo.bga_player_id) {
    detectedPlayerEl.textContent = `${playerInfo.bga_username} (ID: ${playerInfo.bga_player_id})`;
    detectedPlayerEl.classList.remove("undetected");
  } else {
    detectedPlayerEl.textContent = "No BGA player detected — open a BGA game tab";
    detectedPlayerEl.classList.add("undetected");
  }
}

async function saveSettings(): Promise<void> {
  const provider = providerAnthropic.checked ? "anthropic" : "openai";
  await chrome.storage.local.set({
    openai_key: openaiKeyInput.value.trim(),
    anthropic_key: anthropicKeyInput.value.trim(),
    selected_provider: provider,
  } satisfies StorageSettings);

  settingsStatus.textContent = "Saved ✓";
  setTimeout(() => { settingsStatus.textContent = ""; }, 2000);
}

settingsToggle.addEventListener("click", () => settingsPanel.classList.add("open"));
settingsClose.addEventListener("click",  () => settingsPanel.classList.remove("open"));
settingsSave.addEventListener("click",   saveSettings);

// ── Active tab helpers ─────────────────────────────────────────────────────

async function getActiveBgaTab(): Promise<chrome.tabs.Tab | null> {
  // The side panel does not take focus from the browser window, so
  // lastFocusedWindow / currentWindow both resolve to the wrong context.
  // Query ALL tabs across all windows filtered to BGA URLs instead,
  // preferring the active tab in any window over a background tab.
  const bgaTabs = await chrome.tabs.query({ url: "https://*.boardgamearena.com/*" });
  return bgaTabs.find(t => t.active) ?? bgaTabs[0] ?? null;
}

async function fetchGameState(): Promise<GameState | null> {
  const tab = await getActiveBgaTab();
  if (tab?.id == null) return null;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_GAME_STATE" }) as GameStateResponse;
    return response?.data ?? null;
  } catch {
    return null;
  }
}

// ── Rulebook status bar ────────────────────────────────────────────────────

async function refreshRulebookStatus(): Promise<void> {
  if (!currentGameName) {
    rulebookStatus.textContent = "No BGA game detected";
    uploadLabel.style.display = "none";
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "GET_RULEBOOK",
    gameName: currentGameName,
  }) as RulebookResponse | null;

  if (response?.text) {
    rulebookStatus.textContent = `📖 Rulebook loaded: ${currentGameName}`;
    uploadLabel.style.display = "none";
  } else {
    rulebookStatus.textContent = `No rulebook for "${currentGameName}"`;
    uploadLabel.style.display = "";
  }
}

uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file || !currentGameName) return;

  rulebookStatus.textContent = "Uploading…";
  uploadLabel.style.display = "none";

  const buffer = await file.arrayBuffer();

  await chrome.runtime.sendMessage({
    type: "UPLOAD_RULEBOOK",
    gameName: currentGameName,
    buffer,
  });

  // Clear the input so the same file can be re-selected if needed
  uploadInput.value = "";
  await refreshRulebookStatus();
});

// ── Chat bubbles ───────────────────────────────────────────────────────────

function appendBubble(
  text: string,
  role: "user" | "assistant" | "error" | "thinking",
): HTMLElement {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text;
  chatThread.appendChild(div);
  chatThread.scrollTop = chatThread.scrollHeight;
  return div;
}

function removeElement(el: HTMLElement): void {
  el.remove();
}

// ── Send message ───────────────────────────────────────────────────────────

async function sendMessage(): Promise<void> {
  const question = messageInput.value.trim();
  if (!question) return;

  // Disable input while waiting
  sendBtn.disabled = true;
  messageInput.value = "";
  messageInput.style.height = "auto";

  appendBubble(question, "user");
  const thinkingBubble = appendBubble("Thinking…", "thinking");

  // Fetch fresh game state on every send so the LLM always has current info.
  const freshGameState = await fetchGameState();
  if (freshGameState?.gameName) {
    currentGameName = freshGameState.gameName;
    const pi = await chrome.storage.local.get(["bga_username"]) as StoragePlayerInfo;
    updateStatusBar(currentGameName, pi.bga_username ?? null);
  }

  const reply = await chrome.runtime.sendMessage({
    type: "ASK_LLM",
    question,
    gameName: currentGameName ?? "",
    gameState: freshGameState ?? currentGameState ?? undefined,
  }) as LlmReply | null;

  removeElement(thinkingBubble);

  if (!reply) {
    appendBubble("No response from service worker.", "error");
  } else if (reply.type === "LLM_RESPONSE" && reply.text) {
    appendBubble(reply.text, "assistant");
  } else if (reply.type === "LLM_ERROR" || reply.error) {
    appendBubble(`Error: ${reply.error ?? "Unknown error"}`, "error");
  } else {
    appendBubble("Unexpected response from service worker.", "error");
  }

  sendBtn.disabled = false;
  messageInput.focus();
}

sendBtn.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-grow textarea
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
});

// ── Storage change listener ────────────────────────────────────────────────

// Update detected player display immediately when USER_INFO is stored by
// the service worker — no need to reload the panel.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!("bga_username" in changes) && !("bga_player_id" in changes)) return;

  chrome.storage.local.get(["bga_player_id", "bga_username"]).then((stored) => {
    const info = stored as StoragePlayerInfo;
    if (info.bga_username && info.bga_player_id) {
      detectedPlayerEl.textContent = `${info.bga_username} (ID: ${info.bga_player_id})`;
      detectedPlayerEl.classList.remove("undetected");
      updateStatusBar(currentGameName, info.bga_username);
    }
  });
});

// ── Initialise ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  await loadSettings();

  // Resolve game name and state from the active BGA tab
  const gameState = await fetchGameState();
  currentGameState = gameState;
  currentGameName = gameState?.gameName ?? null;

  // Update status bar with initial values
  const playerInfo = await chrome.storage.local.get(["bga_username"]) as StoragePlayerInfo;
  updateStatusBar(currentGameName, playerInfo.bga_username ?? null);

  await refreshRulebookStatus();
}

init();
