# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Saladict (沙拉查词) is a cross-browser WebExtension (Chrome/Firefox/Edge/Safari) — a feature-rich inline dictionary/translator with PDF support. React + TypeScript + Redux, built with Webpack via `neutrino-webextension`.

## Environment & tooling

- **Node `<= 16.20.2` is required** (see `.nvmrc` / `engines`). Newer Node will break the Webpack 4 / Neutrino 9 toolchain. Use `nvm use`.
- **Yarn (classic v1) only** — `packageManager` pins `yarn@1.22.22`.
- After `yarn install`, `postinstall` runs `scripts/setup-env.js`. Before a build you must run `yarn pdf` once (downloads PDF.js into `deps/`).
- Dictionary API keys go in a `.env` file (copy `.env.example`); leaving them empty just disables those dictionaries. `.env` is git-ignored and injected wholesale into `process.env` at build time via `DefinePlugin` (see `scripts/create-neutrino-config.js`), so any `FOO` in `.env` is readable as `process.env.FOO` in bundle code (e.g. `DEEPL_AUTH_KEY` feeds the DeepL dict's default `authKey`).
- **Versioning (this fork):** starts at `8.0.0`; bump a **patch in `package.json` on every change** and rebuild. The build derives `manifest.json`'s version from it, so the version shown in `chrome://extensions` is the check for "am I running the latest local build?".
- **Loading the build:** load `build/chrome` (MV3) as an unpacked extension. After a rebuild, reload the extension **and hard-refresh the page** — reloading an MV3 extension does NOT re-inject content scripts into already-open tabs (a stale content script throws "Extension context invalidated").

## Common commands

```bash
yarn start                 # WDS dev server (MV2) in a fake WebExtension env; opens browser
yarn start --wextentry <id>  # dev a single entry (e.g. popup, options, notebook)
yarn devbuild              # unminified dev build to build/
yarn build                 # full prod build: MV2 + MV3 (build:mv2 then build:mv3 + firefox-fix)
yarn build:mv2 / build:mv3 # build a single manifest version
yarn build --debug         # no compression + sourcemaps
yarn build --analyze       # webpack-bundle-analyzer

yarn type-check            # tsc --noEmit
yarn lint                  # eslint src (TS Standard style + prettier)
yarn test                  # jest (20s timeout)
yarn test:watch
yarn test path/to/file.spec.ts   # single test file (any jest CLI flag works)

yarn storybook             # component playground (run `yarn fixtures` once first)
yarn fixtures              # download intercepted dictionary responses for storybook/tests
yarn commit                # commitizen — conventional commits enforced by husky commitlint
```

## Architecture

**Multi-entry extension.** Each entry point (background, content script, popup, options page, and standalone pages) is a separate Webpack "main" defined in `scripts/create-neutrino-config.js` → `createMains()` — **this is the source of truth for what pages exist and their manifest wiring**, not `src/manifest/*.manifest.json` (those are per-browser overrides merged in). Entries: `content`, `selection`, `popup`, `options`, `background`, `notebook`, `history`, `quick-search`, `word-editor`, `audio-control`, plus `offscreen` (MV3 only). Each entry has a `__fake__/env.ts` used to simulate the WebExtension environment under WDS.

**Dual MV2/MV3 build.** `webpack.config.js` builds both manifest versions in production (each to `build/.tmp-mv<n>`, then assembled). `webext-targets.js` maps browsers → manifest version. MV3 lacks a persistent background page, so background work that needs a DOM (audio, DOM parsing) is delegated to an **offscreen document** — see `src/background/offscreen-*.ts`, `src/offscreen/`, and `dom-task-bridge.ts`.

**Background (`src/background/`)** is the service/coordination layer: message server (`server.ts`), audio manager, context menus, badge, sync managers (`sync-manager/`), IndexedDB access (`database/`, via Dexie), PDF sniffing, and window/tab management. `index.ts` + `initialization.ts` boot it.

**Content (`src/content/`)** is the in-page UI. State is **Redux + redux-observable**: reducers/handlers in `redux/modules/action-handlers/`, side effects in `redux/epics/` (e.g. `newSelection.epic.ts`, `searchStart.epic.ts`). The action catalog is `redux/modules/action-catalog.ts`.

**Dictionaries (`src/components/dictionaries/<dictID>/`)** are the core plugin system — ~30 dictionaries, each self-contained:
- `config.ts` — default `DictItem` options; the dict must also be registered in `src/app-config/dicts.ts` (**alphabetical order required**) for typings.
- `engine.ts` — must export `getSrcPage(text, config)` (URL for the dict's title link) and `search(text, config, profile, payload)` (fetch/parse/return results). HTML extraction **must** use helpers in `src/components/dictionaries/helpers.ts` for sanitization.
- `View.tsx` — a dumb React `PureComponent` that renders the search result.
- `_locales.json` — dict name + option locales. `_style.scss` — ECSS-ish selector naming.
- See `CONTRIBUTING.md` "How to add a dictionary" for the full checklist. Extra engine functions are invoked from `View.tsx` over the `'DICT_ENGINE_METHOD'` message channel.

**Config model (`src/app-config/`)** is two-layer: a global `AppConfig` (`index.ts`) plus per-scenario **Profiles** (`profiles.ts`, which dicts are active + their order). `config-manager.ts` and `profile-manager.ts` (in `_helpers/`) persist and stream these from `browser.storage`.

## Cross-cutting conventions

- **Path alias:** `@/` → `src/` (tsconfig + webpack). Prefer `@/...` imports over deep relative paths.
- **Messaging:** always send via `message` from `@/_helpers/browser-api` — **never** the native `browser.runtime.sendMessage`. Message types live in `src/typings/message.ts`; grep a message type name project-wide for usage examples.
- **`src/_helpers/`** holds shared cross-entry utilities (browser-api wrapper, i18n, lang detection, dom/fetch helpers, the various `*-manager.ts`).
- **Styles:** SCSS with globals auto-injected via `sass-resources-loader` from `src/_sass_shared/` — those variables/mixins are available in every `.scss` without importing.
- **Code style:** TypeScript-flavored [Standard](https://standardjs.com) + prettier (enforced by eslint). Commits follow Conventional Commits; releases via `standard-version`.

## AI translate dictionary — `src/components/dictionaries/openai/`

A custom AI-translation dict (shown as 「AI 翻译」; the dictID stays `openai` so stored profiles and `dictAuth.openai` need no migration) that departs from the usual dict template in a few ways:

- **Multi-provider, routed by model name** (`providers/`). `presets.ts` holds the providers (OpenAI, OpenRouter, Anthropic, Gemini, DeepSeek, Ollama, custom) and `inferProvider`: a `vendor/model` id goes to OpenRouter, `claude-*` to Anthropic, `gemini-*` to Gemini, `deepseek-*` to DeepSeek, anything else to OpenAI. `provider` = `'auto'` uses that inference; any other value overrides it (Ollama/custom are only reachable that way). Each provider has its own key field (`apiKey` = OpenAI, `openrouterApiKey`, `anthropicApiKey`, …) so switching models never loses a key; `baseUrl` is only read for `custom`/`ollama`.
- **Two wire protocols, one transport.** `openai-chat.ts` (OpenAI Chat Completions, also used by every non-Anthropic preset) and `anthropic.ts` (Messages API, direct from the extension via `anthropic-dangerous-direct-browser-access`) each build the request, parse SSE events, and heal a 400. `transport.ts` does the fetch (`credentials: 'omit'`, so the user's login cookies for e.g. openrouter.ai never ride along), the bounded heal-and-retry loop, error-message extraction (incl. Gemini's array-wrapped errors) and the SSE reader for both stream and one-shot calls. `engine.ts` only builds the prompt (`buildChat` → `{ system[], user }`) and resolves config (`resolveLLMConfig`, `hasCredential`).
- **Custom `View.tsx`** (not the MachineTrans re-export): the model returns constrained HTML which is sanitized with **DOMPurify** (`dompurify`, the only sanitizer available — there is no Markdown lib) and rendered. Allowed tags/attrs are whitelisted in the View.
- **Custom account form** `src/options/components/Entries/OpenAIAuth.tsx` (spliced into `DictAuths.tsx` by special-casing `dictID === 'openai'`): model / provider / a live "实际调用" route line (also flags a key whose format can't belong to the routed provider, via `checkKeyFormat` in `presets.ts` — OpenRouter answers a foreign key with a misleading "Missing Authentication header") / one key per provider / baseUrl + customApiKey (custom/Ollama only) / systemPrompt / prompt / temperature / reasoningEffort / maxTokens + a "test service" button. DeepL uses the generic form; this dict needs the richer one.
- **All behaviour lives in the configurable `systemPrompt`/`prompt`** (nothing hardcoded in the engine). The built-in default `systemPrompt`/`prompt` ship **empty** (`DEFAULT_OPENAI_SYSTEM_PROMPT`/`DEFAULT_OPENAI_PROMPT` in `openai/auth.ts` are `''`); the canonical prompts live in the repo-root **`PROMPT.md`**, which the user pastes into 词典账号 → AI 翻译 (systemPrompt handles: English word → study card, Chinese word → English equivalents, sentence/paragraph → translate). The engine just sends the user's configured prompts, so every rule is visible/editable in the settings panel. The selection is never truncated; only the **context** is reduced to the sentence around a word (`extractSentence`) to fill `{{sentence}}`. Note: `fillTemplate` substitutes `{{text}}/{{from}}/{{to}}/{{sentence}}` ONLY in the user `prompt`, never in `systemPrompt`.
- **Sentence context** is captured at selection time (`getSentenceFromSelection` → `word.context`) and plumbed through `FETCH_DICT_RESULT` (`searchStart.epic.ts`, `typings/message.ts`) as `{{sentence}}`; the prompt template also supports `{{text}}`/`{{from}}`/`{{to}}` via `fillTemplate`.
- **Pronunciation line** (single English words only): an `IPA_DIRECTIVE` system message makes the model prefix its reply with `[[IPA:…]]`, which the View lifts into a word + IPA + speaker line (one speaker per heteronym reading). A speaker sends `PLAY_PRONUNCIATION { text, ipa }`; the background (`src/background/cloud-tts.ts`) normalizes the IPA onto Google's en-US phoneme set (`toGooglePhonemes` in `openai/pronunciation.ts`) and synthesizes it with Google Cloud TTS WaveNet via SSML `<phoneme>` — plain Google Translate TTS guesses unknown words (e.g. "Kadane" → /kʌˈdɑːne/). Without `GOOGLE_CLOUD_TTS_API_KEY` in `.env`, with IPA Google can't express, or on an API error, it falls back to Google Translate TTS.
- **Per-provider param quirks** (all in the adapters, classified up front so steady-state calls never retry):
  - OpenAI `gpt-5+` / `o`-series (`isNewOpenAIModel`, also `openai/`-prefixed): omit `temperature`; `max_completion_tokens` instead of `max_tokens` — only for the `openai`/`custom` providers, gateways and other vendors take `max_tokens`.
  - OpenRouter: `reasoning: { effort }` instead of `reasoning_effort`. DeepSeek: no effort param at all.
  - Anthropic: `max_tokens` is required (4096 when unset). Models before 4.7 (`isLegacyClaudeModel`) get `temperature` and no effort; newer ones get no sampling params (a 400 there) and `output_config.effort`, with `none`/`minimal` sent as `low` since current Claude models can't fully disable thinking.
  - Heal on a 400: OpenAI names the param in `error.param`; OpenRouter/Anthropic/Gemini only mention it in the message, so the adapters match on the message too, and an unattributed 400 drops the reasoning param as a last resort (max 3 retries).
  - A heal that worked is remembered by `heal-cache.ts` (storage.local key `dict_openai_heal`, keyed by provider + baseUrl + model + temperature/effort/maxTokens) and applied before the first attempt next time, so e.g. OpenRouter's "Reasoning is mandatory" costs one 400 per model, not one per lookup. The `dict_` prefix means `onInstalled` clears it on every update; a remembered patch that later gets an unhealable 400 is forgotten and the request is retried as built.

**Config-merge migrations (`src/app-config/merge-config.ts`, post-merge patch).** `mergeString` keeps stored values over new defaults, so changing a default never reaches existing users on its own — you must migrate:
- Model: upgrade values in `LEGACY_OPENAI_MODELS` → `DEFAULT_OPENAI_MODEL`.
- Single-provider → multi-provider: a stored `dictAuth.openai` without `provider` gets `migrateSingleProviderAuth` (`openai/auth.ts`) — its old `baseUrl` host picks the provider (`api.openai.com` stays `auto`, port 11434 → `ollama`, unknown host → `custom` keeping the URL) and `apiKey` moves to that provider's key field. Keep every `dictAuth.openai` field a flat string: the merge only copies `dictAuth.<dict>.<key>` strings, so a nested object would be reset on every load.
- Prompts: **not migrated.** The defaults ship empty and the user pastes their own from `PROMPT.md`, so there is nothing to restore and a manual edit is never clobbered. (Earlier revisions tried exact-string `LEGACY_OPENAI_*_PROMPTS` matching and a `promptVersion` stamp; both were removed in favour of empty defaults.)
- DeepL: `dictAuth.deepl.authKey` is filled from `DEFAULT_DEEPL_AUTH_KEY` (`.env`) when empty.

Also note: `profile-manager.ts` `inflate()` must run `mergeProfile` for v1/legacy branches too (not only v2), or newly-added dicts won't appear in the dict list for existing users.
