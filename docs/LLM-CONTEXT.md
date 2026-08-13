# LLM Context Design

## System prompt structure

Built by `buildSystemPrompt()` in `src/background/index.ts`. When structured game state is available, the prompt contains:

```
You are a board game strategy assistant...

## Player identity
The user's BGA username is "Sigzy" (BGA player ID: 88257314).
Always reason from Sigzy's perspective, even when it is not their turn.

## Your resources
Money: 20 | Reputation: 3 | Appeal: 6 | Conservation: 0 | X-tokens: 1 | Income: 12 | Score: -8

## Your hand (6 cards)
1. Dusky-leaf Monkey [animal] — Cost: 12 | Enclosure: size 2 | Continent: Asia | Ability: Clever
   ✅ Conditions met, can afford
2. Siberian Tiger [animal] — Cost: 30 | Enclosure: size 5 | Prerequisites: {"Asia":3} | Continent: Asia
   ❌ Conditions NOT met ({"Asia":false,"ignored":3,"valid":false}) | Cannot afford
3. Secretary Bird [animal] — Cost: 14 | Enclosure: large-bird-aviary | Continent: Africa
   ✅ Conditions met, can afford
...

## Your action cards
- Build (Build, strength 2, level I): Build 1 building, max size 2. Pay 2 money/space. / ...
- Animals (Animals, strength 4, level I): Play animal cards. [Mark] / ...
...

## Your scoring cards
- Large Animal Zoo: Gain CONSERVATION for large animals in your zoo
- Designer Zoo: Gain CONSERVATION for different shaped buildings in your zoo

## Current game state
chooseActionCard — Chris Nissen must choose an action card
Active player: Chris Nissen (85789300)
Possible actions: actChooseActionCard, actPassOptionalAction

## Opponents
- PhtevenK: Money 17 | Appeal 10 | Reputation 2 | Conservation 0 | Score -4 | Cards in hand: 4
- musaam: Money 19 | Appeal 10 | Reputation 1 | Conservation 0 | Score -4 | Cards in hand: 3

## Recent game log
[raw DOM text from #game_log, last 3000 chars]

## Rulebook excerpt
[PDF text, truncated to 32000 chars]

## Instructions
Answer the user's question from Sigzy's perspective...
Even if it is not the user's turn, provide advice for next turn...
When strategy tips or forum discussion would help, call the search_bgg tool...
Do not make up rules — if unsure, say so.
```

## BGG search tool

Both OpenAI and Anthropic are given a `search_bgg` tool:
- **Input**: `{ query: string }` — a concise search query
- **Execution**: `fetch("https://boardgamegeek.com/search?q=<encoded>&objecttype=boardgame")` with HTML stripping, truncated to 3000 chars
- **Rounds**: max 3 tool-call rounds to prevent runaway usage
- The LLM decides when to call it — typically for strategy tips, card interactions, or rule clarifications not in the rulebook

## Token budget

| Section | Approximate size |
|---|---|
| System prompt preamble + identity | ~200 tokens |
| Structured game state (resources + hand + actions) | ~800–1500 tokens |
| Rulebook excerpt | up to ~8000 tokens (32000 chars) |
| Game log | up to ~750 tokens (3000 chars) |
| Instructions | ~100 tokens |
| **Total system prompt** | ~10000–11000 tokens |
| User question | ~50–200 tokens |
| BGG search result (if invoked) | ~750 tokens |

Both GPT-4o (128K context) and Claude 3.5 Sonnet (200K context) have ample room.

## Fallback behaviour

When `structuredState` is null (non-game page, or extraction failure), the prompt falls back to DOM-scraped text:
```
Game name: arknova
Page title: Chris Nissen must choose an action card • Ark Nova • Board Game Arena
Player boards:
[raw #player_boards textContent]
Recent game log:
[raw #game_log textContent]
```

This provides minimal context. The LLM will typically ask for more information or give generic advice. Structured state extraction should be fixed rather than relying on this fallback.

## Provider differences

| | OpenAI (gpt-4o) | Anthropic (claude-3-5-sonnet) |
|---|---|---|
| Tool format | `tools` array with `function` objects | `tools` array with `input_schema` |
| System prompt | `messages[0]` with `role: "system"` | Top-level `system` field |
| Tool call detection | `finish_reason === "tool_calls"` | `stop_reason === "tool_use"` |
| Tool result format | `role: "tool"` message | `role: "user"` with `tool_result` content block |
| CORS from browser | ✅ Allowed | ✅ Allowed with `anthropic-dangerous-direct-browser-access: true` header |
| Call site | Service worker (avoids any browser CORS issues) | Service worker (required for Anthropic) |
