# @neocortex-link/web

The Neocortex Web SDK. It lets you put Neocortex characters on any website or browser game, without exposing your API key.

It has three parts:

- **A secure server proxy** (`/server`). It holds your API key and checks every request before it costs you anything.
- **A browser client** (`/client`). It provides smart characters, group chats, quizzes, microphone input and streamed speech.
- **A Web Components UI kit** (`/ui`). These are drop-in elements: `<neocortex-chat>`, `<neocortex-quiz>`, a mic button and more. They work in plain HTML, React, Vue, Svelte, Three.js and PlayCanvas pages.

```
Browser                         Your server                      Neocortex
<neocortex-chat> ──fetch──▶  createNeocortexHandler()  ──x-api-key──▶  api.neocortex.link/v3
                 ◀─────────  (auth, allowlist, limits)  ◀────────────
```

## Why a proxy?

A Neocortex API key is a secret team key. Anything in browser JavaScript is public: if a key were there, anyone could read it and spend your credits. So the browser talks to **your** server, and your server talks to Neocortex.

The proxy adds these protections:

- **Your auth decides who can talk.** Your `authorize()` function identifies each visitor, and their id becomes the Neocortex `playerId`. Per-player credit caps then apply and can't be spoofed.
- **Characters are allowlisted.** A visitor can't use a character from your team that you didn't expose.
- **Requests are rebuilt from known fields only.** Size, length and count limits are enforced before anything is sent upstream.
- **Conversations are bound to the user.** Session ids reach the browser as signed tokens, so nobody can read or continue someone else's conversation by guessing an id.
- **Speech is limited to real replies.** Text-to-speech only voices lines a character actually said to that user, in that same character's voice, so your characters' voices can't be used to say arbitrary text.
- **Game context is server-side by default.** Scene `metadata` and `events` sent from the browser are dropped unless you opt in. Build trusted context on the server with `buildContext`.
- **Per-user rate limits, plus one turn in flight per conversation.**
- **Requests from other origins are refused,** including sibling subdomains, unless you allowlist the origin.
- **Upstream errors don't leak.** Server errors are masked. A rejected, deactivated or suspended API key becomes a generic 502 for the visitor, and the real reason goes to your `onError`.

The signing is stateless HMAC, so the proxy works on serverless hosts without a shared store.

## Install

```bash
npm install @neocortex-link/web
```

You need Node 20+ on the server. In the browser you need any modern engine with Web Audio and `fetch` streams.

## 1. Add the proxy to your server

### Next.js (App Router)

```ts
// app/api/neocortex/[...path]/route.ts
import { createNeocortexHandler } from "@neocortex-link/web/server";
import { auth } from "@/auth";

const handler = createNeocortexHandler({
  apiKey: process.env.NEOCORTEX_API_KEY!,
  characters: ["your-character-id"],
  authorize: async () => {
    const session = await auth();
    return session?.user ? { id: session.user.id } : null;
  },
});

export { handler as GET, handler as POST, handler as OPTIONS };
```

### Express

```ts
import express from "express";
import { createNeocortexHandler, toNodeHandler } from "@neocortex-link/web/server";

const app = express();
const handler = createNeocortexHandler({
  apiKey: process.env.NEOCORTEX_API_KEY!,
  characters: ["your-character-id"],
  authorize: (request) => {
    const user = getUserFromCookie(request.headers.get("cookie"));
    return user ? { id: user.id } : null;
  },
});

app.use("/api/neocortex", toNodeHandler(handler));
```

### Cloudflare Workers, Hono, Bun, Deno

The handler is a standard `(Request) => Promise<Response>`, so you can mount it directly. On Workers the key arrives with each request's `env`, so create the handler on first use:

```ts
import { createNeocortexHandler } from "@neocortex-link/web/server";

let handler: ((request: Request) => Promise<Response>) | undefined;

export default {
  fetch(request: Request, env: { NEOCORTEX_API_KEY: string }) {
    handler ??= createNeocortexHandler({
      apiKey: env.NEOCORTEX_API_KEY,
      basePath: "",
      characters: ["your-character-id"],
      authorize,
    });
    return handler(request);
  },
};
```

The built-in rate limiter counts per Worker instance. For a global limit, pass a `RateLimiter` backed by KV or Durable Objects.

### Anonymous visitors

For an anonymous site you still need a stable id per visitor, because rate limits and credit caps hang off it. Use a signed, httpOnly cookie that your server sets. Don't use a value the browser picks itself.

[`examples/quickstart`](examples/quickstart) is a complete small site that does exactly this: one HTML page and a `node:http` server, with no framework or bundler.

## 2. Use it in the browser

### Drop-in UI

With a bundler (Vite, Next.js, webpack...):

```js
import "@neocortex-link/web/ui/auto";
```

In plain HTML, load it from a CDN instead:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@neocortex-link/web@0.2.0/dist/ui/auto.js"></script>
```

Then place the element anywhere on the page:

```html
<neocortex-chat endpoint="/api/neocortex" character-id="your-character-id" voice></neocortex-chat>
```

To serve the files yourself instead of from a CDN, map the import with an import map, as [`examples/quickstart`](examples/quickstart) does.

| Element | What it is |
|---|---|
| `<neocortex-chat character-id>` | A complete one-to-one chat: history, typing, mic input, spoken replies |
| `<neocortex-group-chat character-ids="a,b">` | Several characters in one conversation, each in their own colour |
| `<neocortex-quiz character-id question-set-id>` | A quiz host with questions, options, hints, progress and a leaderboard |
| `<neocortex-chat-panel>`, `<neocortex-message>` | The message list and bubbles on their own |
| `<neocortex-text-input>` | A text box that fires `nx-send` |
| `<neocortex-mic-button push-to-talk>` | A microphone with a level ring and silence countdown. Fires `nx-recorded` |
| `<neocortex-mic-select for="mic-id">` | A microphone picker |
| `<neocortex-thinking active>` | Typing dots |
| `<neocortex-usage-badge>` | Shows whether characters are available or out of credits |

**Attributes on the chat elements:**
- `endpoint`
- `voice`
- `push-to-talk`
- `heading`
- `placeholder`
- `language`
- `history="false"`
- `mic="false"`
- `theme="light|dark"`

**Events.** They bubble out of shadow DOM:
- `nx-line`
- `nx-action`
- `nx-emotion`
- `nx-response`
- `nx-reply-finished`
- `nx-error`

Calling `preventDefault()` on `nx-error` suppresses the built-in notice.

**Act on what characters do:**

```js
const chat = document.querySelector("neocortex-chat");
chat.agent.registerAction("OPEN_DOOR", () => door.open());
```

**Theming.** Every colour is a CSS custom property, and internals are exposed as `::part()`:

```css
neocortex-chat {
  --nx-accent: #7c3aed;
  --nx-character-bubble: #1e1b4b;
  --nx-radius: 20px;
  --nx-font: "Inter", sans-serif;
  height: 600px;
}
neocortex-chat::part(header) { display: none; }
```

The other tokens are:
- `--nx-accent-text`
- `--nx-bg`
- `--nx-surface`
- `--nx-text`
- `--nx-muted`
- `--nx-border`
- `--nx-player-bubble`
- `--nx-player-text`
- `--nx-character-text`
- `--nx-danger`

Elements follow `prefers-color-scheme` unless given `theme`, and they respect `dir="rtl"`.

**Auth headers.** If your proxy needs a token rather than a cookie, set one client for all elements:

```js
import { NeocortexClient, setDefaultClient } from "@neocortex-link/web/ui";
setDefaultClient(new NeocortexClient({ baseUrl: "/api/neocortex", headers: () => ({ authorization: `Bearer ${getToken()}` }) }));
```

### Programmatic

These names mirror the Unity SDK (`NeocortexSmartAgent`, `NeocortexGroupDirector`, `NeocortexQuizAgent`).

```ts
import { SmartAgent, AudioReceiver } from "@neocortex-link/web/client";

const agent = new SmartAgent({ endpoint: "/api/neocortex", characterId: "your-character-id" });

agent.on("lineStarted", ({ line }) => subtitle.show(line.text, line.emotion));
agent.on("emotionChanged", ({ emotion }) => avatar.setExpression(emotion));
agent.on("composing", (thinking) => spinner.toggle(thinking));
agent.registerAction("FOLLOW_PLAYER", () => npc.follow(player));

button.onclick = () => {
  agent.primeAudio(); // browsers only allow audio after a click
  agent.textToAudio("Where is the blacksmith?");
};

// Voice in, voice out
const mic = new AudioReceiver({ maxWaitTime: 1.2 });
mic.on("recorded", (wav) => agent.audioToAudio(wav));
await mic.start();
```

| Class | Main methods |
|---|---|
| `SmartAgent` | `textToText`, `textToAudio`, `audioToText`, `audioToAudio`, `send`, `prompt`, `history`, `registerAction`, `clearSession`, `abort` |
| `GroupDirector` | `send`, `sendTo`, `continue`, `sendAudio`, `addCharacter`, `removeCharacter` |
| `QuizAgent` | `begin`, `say`, `sayAs`, `choose`, `chooseAs`, `pass`, `resync`, `abort` |
| `AudioReceiver` | `start`, `stop`, `press`, `release`, `selectDevice`, `AudioReceiver.devices()` |
| `StreamingAudioPlayer` | `play`, `playBlob`, `stop`, `getLevel()` (for lip sync), `volume` |
| `UsageGate` | `refresh`, `canUse`, `startAutoRefresh` |
| `EventLogger`, `Interactables` | Game events and scene entities for each turn (see `allowClientContext`) |

**How replies play.**
- Multi-line replies play line by line. With `voice`, each line is streamed as speech, and the next line is fetched while the current one plays.
- If streaming isn't available, it falls back to whole clips.
- Input sent while a turn is running is queued.
- Sessions persist in `localStorage` using the same keys as the Unity SDK.

### Server-to-server

For backends that call Neocortex directly:

```ts
import { NeocortexClient } from "@neocortex-link/web/server";
const neocortex = new NeocortexClient({ apiKey: process.env.NEOCORTEX_API_KEY });
const { sessionId, messages } = await neocortex.chat({ characterIds: ["..."], message: "Hi", playerId: "user-1" });
```

### Prototyping without a server

```ts
new NeocortexClient({ apiKey: "sk_...", dangerouslyAllowBrowser: true });
```

This exists only for local experiments. Anyone who opens the page can take the key.

## Proxy options

| Option | Default | Notes |
|---|---|---|
| `apiKey` | required | Read from the environment |
| `authorize(request)` | required | Return `{ id }` or `null` (401) |
| `characters` | required | Array or `(user) => ids` |
| `questionSets` | any | Allowlist for quizzes |
| `basePath` | `/api/neocortex` | Where the handler is mounted; `""` for a whole host |
| `baseUrl` | `https://api.neocortex.link/v3` | Point at a local or staging API |
| `routes` | all on except `characters`, `questionSets`, `account` | `account` returns your team's email |
| `limits` | message 500 chars, speech 2000, JSON 64 KB, audio 10 MB, 6 characters a turn | |
| `rateLimit` | 30 requests a minute per user, in memory | Pass a `RateLimiter` backed by Redis or KV when you run more than one instance |
| `speechRepliesOnly` | `true` | `false` lets the browser voice any text |
| `allowClientContext` | `false` | Accept browser-sent `metadata` and `events` |
| `buildContext(user, turn)` | — | Add trusted scene context to every turn |
| `filterText(text, ctx)` | — | Rewrite or moderate replies |
| `cors.origins` | none | Only needed when the page is on another origin |
| `secret` | derived from `apiKey` | Signs session and speech tokens |
| `onError` | `console.error` | Never receives the key |

## Playground

```bash
npm run playground
```

This opens http://localhost:5173. Without a key it runs against a built-in mock API. Copy `.env.example` to `.env.local` and set `NEOCORTEX_API_KEY` and `NEOCORTEX_CHARACTERS` to use your real characters.

The playground has these tabs:
- **Chat**
- **Group**
- **Quiz**
- **Components**
- **Raw API**
- **Security:** runs the attacks the proxy must refuse.

It also has a live theme editor.

## Development

```bash
npm run check   # typecheck, lint, test, build
```

## License

[Apache-2.0](LICENSE). Using the Neocortex API itself is subject to the Neocortex terms of service.
