# Documentation Index

Reference material for developers and AI agents working on the BGA Strategy Assistant extension.

## Documents

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | C4 diagrams, component map, message passing reference, storage schema |
| [BGA-DOM-AND-GLOBALS.md](BGA-DOM-AND-GLOBALS.md) | BGA JS globals, execution contexts, confirmed data structures, DOM selectors, known pitfalls |
| [LLM-CONTEXT.md](LLM-CONTEXT.md) | System prompt structure, tool definitions, token budget, provider differences |
| [DEBUGGING.md](DEBUGGING.md) | Where logs appear, key log lines, diagnosing common failures, storage inspector commands |
| [EXTENSION-RELOAD.md](EXTENSION-RELOAD.md) | Reliable procedure for getting Chrome to run the latest build |

## For AI agents starting a new session

Read in this order:
1. **ARCHITECTURE.md** — understand the component map and message flow before touching any code
2. **BGA-DOM-AND-GLOBALS.md** — critical: documents what is actually accessible in each context and the exact shape of `g_sitecore.gamedatas`
3. **DEBUGGING.md** — know where logs appear and how to clear bad cached state

Key facts to keep in context:
- The MAIN world script (`src/content/main-world.ts`) is the only place BGA JS globals can be read
- Isolated content scripts communicate with MAIN world via `window.postMessage` (not CustomEvent)
- The side panel cannot use `currentWindow: true` to find the BGA tab — use `url` filter instead
- `sendResponse` in `onMessage` must be called synchronously; cache state proactively rather than doing async work inside the handler
- The status bar build timestamp is the reliable indicator that a rebuild was loaded
