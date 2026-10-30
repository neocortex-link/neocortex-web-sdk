# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-30

First stable release, now licensed under Apache-2.0. Everything listed under 0.1.0-rc.0 below is included, with these changes from a pre-release audit.

### Changed
- **Licence:** the package is licensed under Apache-2.0, with `LICENSE` and `NOTICE` files.
- **Speech tokens are bound to the character.** The proxy only voices a line in the voice of the character that said it.
- **Quiz session tokens carry their host character** and use the `ncq_` prefix. Tokens from the release candidate are no longer valid.
- **Sibling subdomains are refused.** The proxy now refuses `same-site` requests as well as `cross-site` ones, unless the origin is in `cors.origins`.
- **Key problems are masked.** A deactivated API key or a suspended workspace now becomes a generic 502 for the visitor, like a rejected key. The reason goes to `onError`.
- **`isNeocortexError()` is exported.** It recognises errors from any copy of the package.
- **`typesVersions` is added** for TypeScript projects that still use `moduleResolution: "node"`.

### Fixed
- **Request bodies:** `toNodeHandler` streams the request body into the handler instead of buffering it first, so oversized uploads are refused without filling memory.
- **`filterText`** now also applies to `spokenMessage` and to chat history.
- **Duplicate classes:** the ESM entry points share one copy of `NeocortexClient` and `NeocortexError`. Before, errors from a client imported from the package root lost their status and code inside `SmartAgent` and `QuizAgent`.
- **Microphone:** `AudioReceiver` no longer opens two microphones on a double click, and no longer leaves one open when stopped during the permission prompt. It also no longer records after a push-to-talk release that came before the microphone opened.
- **Trusted context:** context from `buildContext` is kept when browser-sent context (with `allowClientContext`) fills the limits.
- **`endpoint` attribute:** changing it on an element now switches the element to the new endpoint.
- **Memory:** abort listeners no longer pile up on long-running conversations.
- **README:** the Cloudflare Workers and plain-HTML examples now work as written.

### Removed
- The internal, unused server-sent-events reader.

## [0.1.0-rc.0] - 2026-10-30

First release candidate, published on the `rc` tag for early testing.

### Added

**Server proxy (`@neocortex-link/web/server`)**
- `createNeocortexHandler`, a Fetch-standard proxy that holds the API key.
- Routes: chat, history, speech, streamed speech, transcription, quiz, quiz session and usage. Characters, question sets and account are opt-in.
- Guards:
  - your own `authorize`
  - character and question-set allowlists
  - `playerId` bound to the signed-in user
  - HMAC-signed session tokens, so users can't read each other's conversations
  - speech tokens, so text-to-speech only voices real replies
  - body, length and count limits
  - per-user rate limits
  - one turn in flight per conversation
  - cross-site request refusal and CORS allowlist
  - masked upstream errors
- `toNodeHandler` for Express, Connect and `node:http`, with streaming responses.
- `MemoryRateLimiter` and a pluggable `RateLimiter` interface.

**Browser client (`@neocortex-link/web/client`)**
- Unity-style objects:
  - `SmartAgent`
  - `GroupDirector`
  - `QuizAgent`
  - `AudioReceiver` (AudioWorklet microphone with speech detection and push-to-talk)
  - `StreamingAudioPlayer` (Web Audio playback of streamed speech)
  - `UsageGate`
  - `EventLogger`
  - `Interactables`
  - session stores
- Line-by-line replies with prefetched speech, action handlers, queued input, and history.

**Core (`@neocortex-link/web`)**
- `NeocortexClient` covering every v3 endpoint.
- Typed models.
- `NeocortexError`.
- WAV streaming decoder.
- Emotion helpers.
- Quiz retry behaviour matching the Unity SDK.

**UI kit (`@neocortex-link/web/ui`)**
- Web Components:
  - `<neocortex-chat>`
  - `<neocortex-group-chat>`
  - `<neocortex-quiz>`
  - `<neocortex-chat-panel>`
  - `<neocortex-message>`
  - `<neocortex-text-input>`
  - `<neocortex-mic-button>`
  - `<neocortex-mic-select>`
  - `<neocortex-thinking>`
  - `<neocortex-usage-badge>`
- Theming through `--nc-*` custom properties and `::part()`, with light and dark modes and right-to-left support.

**Playground**
- A local playground with a mock API, a raw API console, and automated security checks.
