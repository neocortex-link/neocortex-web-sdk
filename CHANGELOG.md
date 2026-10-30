# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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
