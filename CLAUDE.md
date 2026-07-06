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

## OpenAI (AI translation) dictionary — `src/components/dictionaries/openai/`

A custom AI-translation dict that departs from the usual dict template in a few ways:

- **Custom `View.tsx`** (not the MachineTrans re-export): the model returns constrained HTML which is sanitized with **DOMPurify** (`dompurify`, the only sanitizer available — there is no Markdown lib) and rendered. Allowed tags/attrs are whitelisted in the View.
- **Custom account form** `src/options/components/Entries/OpenAIAuth.tsx` (spliced into `DictAuths.tsx` by special-casing `dictID === 'openai'`): baseUrl / apiKey / model / systemPrompt / prompt / temperature / reasoningEffort / maxTokens + a "test service" button. DeepL uses the generic form; OpenAI needs the richer one.
- **All behaviour lives in the configurable `systemPrompt`/`prompt`** (nothing hardcoded in the engine). The default systemPrompt tells the model how to handle each case (English word → study card, Chinese word → English equivalents, sentence/paragraph → translate). The engine just sends the user's configured prompts, so the user can see/edit every rule in the settings panel. The selection is never truncated; only the **context** is reduced to the sentence around a word (`extractSentence`) to fill `{{sentence}}`. Note: `fillTemplate` substitutes `{{text}}/{{from}}/{{to}}/{{sentence}}` ONLY in the user `prompt`, never in `systemPrompt`.
- **Sentence context** is captured at selection time (`getSentenceFromSelection` → `word.context`) and plumbed through `FETCH_DICT_RESULT` (`searchStart.epic.ts`, `typings/message.ts`) as `{{sentence}}`; the prompt template also supports `{{text}}`/`{{from}}`/`{{to}}` via `fillTemplate`.
- **Newer-model quirks** (`gpt-5+`, `o`-series, via `isNewOpenAIModel`): use `max_completion_tokens` not `max_tokens`, and omit `temperature`. `postChatCompletions` self-heals on a 400 by swapping/dropping the rejected param (`max_tokens`↔`max_completion_tokens`, drop `temperature`, `reasoning_effort` `minimal`→`none`) and retrying.

**Config-merge migrations (`src/app-config/merge-config.ts`, post-merge patch).** `mergeString` keeps stored values over new defaults, so changing a default never reaches existing users on its own — you must migrate:
- Model: upgrade values in `LEGACY_OPENAI_MODELS` → `DEFAULT_OPENAI_MODEL`.
- Prompts: gated by `OPENAI_PROMPT_VERSION` (in `openai/auth.ts`). Bump it whenever you improve the default systemPrompt/prompt; the merge force-restores configs whose stored `promptVersion` is behind (once), then stamps them — later manual edits persist. This replaced the fragile exact-string `LEGACY_OPENAI_*_PROMPTS` matching.
- DeepL: `dictAuth.deepl.authKey` is filled from `DEFAULT_DEEPL_AUTH_KEY` (`.env`) when empty.

Also note: `profile-manager.ts` `inflate()` must run `mergeProfile` for v1/legacy branches too (not only v2), or newly-added dicts won't appear in the dict list for existing users.
