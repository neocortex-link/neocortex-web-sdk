# Neocortex Web quickstart

This is the smallest real site built on `@neocortex-link/web`. It's one HTML page with a shopkeeper character, plus a small Node server that keeps your API key private.

It uses no framework and no bundler. The only dependency is the SDK, installed from npm.

```bash
cp .env.example .env    # add NEOCORTEX_API_KEY and NEOCORTEX_CHARACTER_ID
npm install
npm start               # http://localhost:3100
```

## What's in it

| File | Does |
|---|---|
| `server.js` | Mounts `createNeocortexHandler` at `/api/neocortex`. Gives each browser an anonymous id in a signed, httpOnly cookie, which `authorize` reads. Serves the SDK's browser build from `node_modules`. |
| `public/index.html` | Loads the UI kit through an import map. Places `<neocortex-chat>` and `<neocortex-usage-badge>` on the page, and shows the character's actions. |

The browser never sees the API key. Every request goes to `/api/neocortex`, where the proxy:
- checks the visitor's cookie,
- allows only your one character,
- adds server-side context,
- then calls Neocortex.

## Make it yours

- **Theme:** change the `--nc-*` variables on `neocortex-chat` in `index.html`.
- **React to actions:** listen for `nc-action`, or use `chat.agent.registerAction("OPEN_DOOR", ...)`.
- **Use your own login:** replace `visitorFrom` in `server.js` with your session check.
- **Use a bundler (Vite, Next.js...):** drop the import map and `import "@neocortex-link/web/ui/auto"` directly.
