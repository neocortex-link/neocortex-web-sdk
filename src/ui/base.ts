import { NeocortexClient } from "../core/client";

/**
 * Lets the elements be imported during server rendering (Next.js, Astro...)
 * without crashing: there is no HTMLElement to extend on the server, and the
 * elements are only defined once they reach a browser.
 */
const ElementBase = (typeof HTMLElement === "undefined" ? class {} : HTMLElement) as typeof HTMLElement;

let defaultClient: NeocortexClient | null = null;

/**
 * Sets the client every element uses unless it has its own `endpoint` attribute
 * or `client` property. Use it to add your app's auth headers once:
 *
 * ```ts
 * setDefaultClient(new NeocortexClient({ baseUrl: "/api/neocortex", headers: () => ({ authorization: `Bearer ${token}` }) }));
 * ```
 */
export function setDefaultClient(client: NeocortexClient | null): void {
  defaultClient = client;
}

/** Design tokens. Every value can be overridden from outside with the `--nc-*` custom property. */
export const BASE_CSS = /* css */ `
:host {
  --_accent: var(--nc-accent, #f59e0b);
  --_accent-text: var(--nc-accent-text, #1f1f1f);
  --_bg: var(--nc-bg, #ffffff);
  --_surface: var(--nc-surface, #f5f5f4);
  --_text: var(--nc-text, #1c1917);
  --_muted: var(--nc-muted, #78716c);
  --_border: var(--nc-border, #e7e5e4);
  --_player-bubble: var(--nc-player-bubble, var(--_accent));
  --_player-text: var(--nc-player-text, var(--_accent-text));
  --_character-bubble: var(--nc-character-bubble, #1f1f1f);
  --_character-text: var(--nc-character-text, #fafaf9);
  --_danger: var(--nc-danger, #dc2626);
  --_radius: var(--nc-radius, 14px);
  --_font: var(--nc-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --_focus: 0 0 0 3px color-mix(in srgb, var(--_accent) 45%, transparent);
  font-family: var(--_font);
  color: var(--_text);
  box-sizing: border-box;
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --_bg: var(--nc-bg, #121212);
    --_surface: var(--nc-surface, #1c1c1c);
    --_text: var(--nc-text, #f5f5f4);
    --_muted: var(--nc-muted, #a8a29e);
    --_border: var(--nc-border, #2e2e2e);
    --_character-bubble: var(--nc-character-bubble, #2a2a2a);
  }
}
:host([theme="dark"]) {
  --_bg: var(--nc-bg, #121212);
  --_surface: var(--nc-surface, #1c1c1c);
  --_text: var(--nc-text, #f5f5f4);
  --_muted: var(--nc-muted, #a8a29e);
  --_border: var(--nc-border, #2e2e2e);
  --_character-bubble: var(--nc-character-bubble, #2a2a2a);
}
:host([hidden]) { display: none !important; }
*, *::before, *::after { box-sizing: inherit; }
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border: 1px solid var(--_border);
  background: var(--_surface);
  border-radius: calc(var(--_radius) * 0.7);
  padding: 0.45em 0.9em;
  min-height: 2.25rem;
}
button:hover:not(:disabled) { border-color: var(--_accent); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: none; box-shadow: var(--_focus); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.primary { background: var(--_accent); color: var(--_accent-text); border-color: transparent; font-weight: 600; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`;

export abstract class NeocortexElement extends ElementBase {
  protected readonly root: ShadowRoot;
  private _client: NeocortexClient | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  /** A client to use instead of the `endpoint` attribute, e.g. one carrying auth headers. */
  get client(): NeocortexClient {
    if (this._client) return this._client;
    const endpoint = this.getAttribute("endpoint");
    if (endpoint) return (this._client = new NeocortexClient({ baseUrl: endpoint }));
    return (this._client = defaultClient ?? new NeocortexClient());
  }

  set client(client: NeocortexClient) {
    this._client = client;
    this.clientChanged();
  }

  /** Called when the client is replaced, so composite elements can rebuild their agent. */
  protected clientChanged(): void {}

  protected render(css: string, html: string): void {
    this.root.innerHTML = `<style>${BASE_CSS}${css}</style>${html}`;
  }

  protected $<T extends Element = HTMLElement>(selector: string): T {
    const found = this.root.querySelector<T>(selector);
    if (!found) throw new Error(`${this.localName}: missing ${selector}`);
    return found;
  }

  protected fire<T>(name: string, detail?: T): boolean {
    return this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: true }));
  }

  protected flag(name: string, fallback = false): boolean {
    const value = this.getAttribute(name);
    if (value === null) return fallback;
    return value !== "false";
  }
}

/** A stable hue per character, so each speaker in a group keeps their own colour. */
export function hueFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}
