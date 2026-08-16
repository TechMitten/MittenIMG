# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MittenIMG is a VS Code extension (publisher `TechRayApps`, extension id `imagemitten`) that generates images from a sidebar webview. It optionally scans the open workspace for context, sends that context + the user's prompt to an LLM via the Pollinations API to produce an enhanced image-generation prompt, then requests an image from Pollinations and saves it to a `MittenIMG/` folder in the workspace.

## Commands

- `npm run compile` — webpack dev build to `dist/extension.js`
- `npm run watch` — webpack in watch mode (used by the "Run Extension" launch config's pre-launch task is `compile`, not `watch`)
- `npm run package` — production build (`webpack --mode production --devtool hidden-source-map`), run automatically by `vscode:prepublish`
- `npm run lint` — ESLint over `src/`
- `npm run compile-tests` / `npm run watch-tests` — compiles `src/` to `out/` via `tsc` (for the test runner; there are currently no test files in the repo)
- `npm test` — runs `pretest` (compile-tests + compile + lint) then `node ./out/test/runTest.js`. This will fail today since no `src/test/` exists yet — check before assuming a test suite is present.
- `npm run vsix` — bumps the version and packages a `.vsix` via `scripts/package-vsix.sh` (wraps `vsce package`). Pass `-- --no-bump` / `-- current` to package without bumping, or `-- minor`/`-- major`/`-- <version>` to control the bump. If the git tree has uncommitted changes, the script auto-adds `--no-git-tag-version` to avoid `npm version` errors.

To manually run/debug the extension in VS Code: use the "Run Extension" launch config in [.vscode/launch.json](.vscode/launch.json) (F5), which builds via the `npm: compile` task first and launches an Extension Development Host.

## Architecture

The entire extension logic lives in one file: [src/extension.ts](src/extension.ts). There is no other src module — do not go looking for a services/utils layer that doesn't exist.

- **`activate()`** registers a single webview view provider (`imagemitten-sidebar.view`, shown in the `imagemitten-sidebar` activity bar container) and a command (`imagemitten.start`) that focuses it.
- **`ImageMittenViewProvider`** (implements `vscode.WebviewViewProvider`) owns essentially all behavior:
  - Renders the webview HTML/CSS/JS inline via `_getMainHtml()` (a large template string — there is no separate frontend build step or framework; the webview script is hand-written vanilla JS embedded in the TS file).
  - Handles all `postMessage` commands from the webview in `resolveWebviewView`'s `onDidReceiveMessage` switch: `generate`, `showOutput`, `openSettings`, `toggleContext`, `saveConvertedImage`, `connectPollinations`, `disconnectPollinations`, `dismissOnboarding`.
  - `handleGenerate()` is the core flow: optionally gathers codebase context (`vscode.workspace.findFiles`, capped at ~100k chars) → sends prompt + context to the Pollinations chat completions endpoint for prompt enhancement → requests the image from the Pollinations image endpoint (uploading a base image first via `media.pollinations.ai/upload` if editing) → saves the PNG to `<workspace>/MittenIMG/` and returns it (base64) to the webview.
  - `handleConnectPollinations()` / `handleDisconnectPollinations()` implement a BYOP (Bring Your Own Pollinations) OAuth device-code flow against `enter.pollinations.ai`, polling for a token and storing it in `vscode.SecretStorage` (never in settings). `getActiveApiKey()` prefers this OAuth token over the manually-configured `mittenimg.pollinationsApiKey` setting.
  - `_refreshImageModels()` fetches the live model catalog from `gen.pollinations.ai/image/models` on activation and pushes updates to the webview; `FALLBACK_IMAGE_MODELS`/`FALLBACK_EDIT_IMAGE_MODELS` near the top of the file are the static fallback used if that request fails, and should be kept roughly in sync with the live catalog when models change.
- All network calls go through `axios` directly (no wrapper/client abstraction). All logging goes through the module-level `outputChannel` (`vscode.window.createOutputChannel('MittenIMG')`), shown to the user via the "📄 Logs" button.
- Webview state persistence (current screen, prompt, selected model, last result) is handled entirely client-side in the injected script via `vscode.getState()`/`setState()` — there is no extension-side state beyond `SecretStorage` (OAuth token) and `globalState` (onboarding-dismissed flag).

## Build/package layout

- `webpack.config.js` bundles `src/extension.ts` → `dist/extension.js` (commonjs, `vscode` external). It uses a custom loader ([webpack.strip-sourcemap-loader.js](webpack.strip-sourcemap-loader.js)) to strip `sourceMappingURL` comments from bundled `node_modules` code (notably from `axios`'s transitive `https-proxy-agent` dependency) — without it, VS Code's debugger tries to resolve source maps that were never emitted into `dist/`.
- `.vscodeignore` excludes source/dev files from the packaged `.vsix`; only `dist/`, `media/`, and packaging metadata ship.
- Configuration contract (`contributes.configuration` in [package.json](package.json)): `mittenimg.useCodebaseContext` (bool), `mittenimg.pollinationsApiKey` (string, fallback only), `mittenimg.contextIgnoreFolders` (string[], merged with the always-excluded `node_modules`/`.git`/`dist`/`out`).

## Notes specific to this codebase

- `POLLINATIONS_APP_CLIENT_ID` in [src/extension.ts](src/extension.ts) is a publishable (`pk_`) client ID — intentionally safe to ship in the bundle, not a secret.
- A `pollinationsapi.md` reference file is expected by convention (referenced in comments, excluded via `.gitignore`/`.vscodeignore`) but is not checked into the repo — it's a local-only API reference, not something to look for or recreate.
