# Extension Reload Procedure

After every `npm run build`, follow this sequence to guarantee Chrome is running the latest code.

## Full reload (use when behaviour doesn't match expectations)

1. `npm run build` — confirm `✓ built in X.XXs` with no errors
2. Go to `chrome://extensions`
3. Click **↺ refresh** on the BGA Strategy Assistant card
4. Click the **"service worker"** link to open SW DevTools
5. In the SW DevTools console run: `chrome.runtime.reload()`  
   *(This forces the service worker to terminate and restart clean)*
6. Close the SW DevTools
7. Go to the BGA game tab → **Ctrl+Shift+R** (hard reload)
8. Open the side panel

**Verify**: the status bar should show a `built` timestamp matching your build time.

## Quick reload (minor UI changes only)

1. `npm run build`
2. `chrome://extensions` → ↺ refresh
3. Close and reopen the side panel

## Why the service worker is sticky

Chrome MV3 service workers are kept alive in memory between page loads and survive a simple ↺ extension refresh. The old bundle keeps running until the process is explicitly terminated. `chrome.runtime.reload()` is the reliable termination trigger.

## Content script reload

Content scripts only re-inject on a full page reload. After any change to `src/content/`, always hard-reload the BGA tab (Ctrl+Shift+R) — not just a soft refresh.

## Confirming correct version

Check the `built MMM DD HH:MM:SS` timestamp in the status bar under the extension header. This is embedded at compile time by Vite's `define` config. If it doesn't match your last build, Chrome is still running the old version.
