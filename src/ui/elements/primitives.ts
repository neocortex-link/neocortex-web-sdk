import { NeocortexElement } from "../base";

/** Three bouncing dots while a character is thinking. Toggle with the `active` attribute. */
export class NeocortexThinking extends NeocortexElement {
  static observedAttributes = ["active", "label"];

  connectedCallback() {
    this.render(
      /* css */ `
      :host { display: inline-flex; }
      :host(:not([active])) { display: none; }
      .dots { display: inline-flex; gap: 4px; padding: 0.7em 0.9em; border-radius: var(--_radius);
        background: var(--_character-bubble); }
      .dots span { width: 6px; height: 6px; border-radius: 50%; background: var(--_character-text); opacity: 0.4;
        animation: nc-bounce 1.2s infinite ease-in-out; }
      .dots span:nth-child(2) { animation-delay: 0.15s; }
      .dots span:nth-child(3) { animation-delay: 0.3s; }
      @keyframes nc-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.4; } 40% { transform: translateY(-4px); opacity: 1; } }
      `,
      `<div class="dots" part="dots" role="status"><span></span><span></span><span></span><span class="sr-only"></span></div>`,
    );
    this.update();
  }

  attributeChangedCallback() {
    if (this.root.firstChild) this.update();
  }

  set active(value: boolean) {
    this.toggleAttribute("active", value);
  }

  get active(): boolean {
    return this.hasAttribute("active");
  }

  private update() {
    this.$(".sr-only").textContent = this.active ? (this.getAttribute("label") ?? "Thinking…") : "";
  }
}

export type MessageSender = "player" | "character" | "notice";

/** One chat bubble. Text is always set as text, never parsed as HTML. */
export class NeocortexMessage extends NeocortexElement {
  static observedAttributes = ["sender", "name", "text", "emotion", "hue"];

  connectedCallback() {
    this.render(
      /* css */ `
      :host { display: flex; flex-direction: column; align-items: flex-start; max-width: 100%; }
      :host([sender="player"]) { align-items: flex-end; }
      :host([sender="notice"]) { align-items: center; }
      .name { font-size: 0.75em; color: var(--_muted); margin: 0 0.6em 0.2em; }
      :host([hue]) .name { color: hsl(var(--nc-hue) 60% 45%); }
      :host([sender="player"]) .name, :host(:not([name])) .name { display: none; }
      .bubble { max-width: min(80%, 34rem); padding: 0.6em 0.9em; border-radius: var(--_radius);
        line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere;
        background: var(--_character-bubble); color: var(--_character-text);
        border-end-start-radius: calc(var(--_radius) * 0.3); }
      :host([hue]) .bubble { box-shadow: inset 3px 0 0 hsl(var(--nc-hue) 70% 55%); }
      :host([sender="player"]) .bubble { background: var(--_player-bubble); color: var(--_player-text);
        border-end-start-radius: var(--_radius); border-end-end-radius: calc(var(--_radius) * 0.3); }
      :host([sender="notice"]) .bubble { background: transparent; color: var(--_danger); font-size: 0.85em;
        border: 1px dashed currentColor; }
      `,
      `<span class="name" part="name"></span><div class="bubble" part="bubble"></div>`,
    );
    this.update();
  }

  attributeChangedCallback() {
    if (this.root.firstChild) this.update();
  }

  private update() {
    this.$(".name").textContent = this.getAttribute("name") ?? "";
    const bubble = this.$(".bubble");
    bubble.textContent = this.getAttribute("text") ?? this.textContent ?? "";
    const emotion = this.getAttribute("emotion");
    if (emotion && emotion !== "neutral") bubble.title = emotion;
    else bubble.removeAttribute("title");
    const hue = this.getAttribute("hue");
    if (hue) this.style.setProperty("--nc-hue", hue);
  }
}

export type PanelMessage = {
  sender: MessageSender;
  text: string;
  name?: string;
  emotion?: string;
  /** Colours the bubble per speaker in a group. */
  hue?: number;
};

/** A scrolling list of messages with a thinking indicator. */
export class NeocortexChatPanel extends NeocortexElement {
  static observedAttributes = ["empty-text"];

  connectedCallback() {
    if (this.root.firstChild) return;
    this.render(
      /* css */ `
      :host { display: block; overflow-y: auto; overscroll-behavior: contain; scroll-behavior: smooth; }
      .list { display: flex; flex-direction: column; gap: 0.6em; padding: 1em; min-height: 100%; }
      .empty { margin: auto; color: var(--_muted); font-size: 0.9em; text-align: center; }
      .list:has(neocortex-message) .empty { display: none; }
      `,
      `<div class="list" part="list" role="log" aria-live="polite" aria-relevant="additions">
        <p class="empty" part="empty"></p>
        <neocortex-thinking part="thinking"></neocortex-thinking>
      </div>`,
    );
    this.$(".empty").textContent = this.getAttribute("empty-text") ?? "";
  }

  attributeChangedCallback() {
    if (this.root.firstChild) this.$(".empty").textContent = this.getAttribute("empty-text") ?? "";
  }

  addMessage(message: PanelMessage, options: { prepend?: boolean } = {}): HTMLElement {
    this.connectedCallback();
    const element = document.createElement("neocortex-message");
    element.setAttribute("sender", message.sender);
    element.setAttribute("text", message.text);
    if (message.name) element.setAttribute("name", message.name);
    if (message.emotion) element.setAttribute("emotion", message.emotion);
    if (message.hue !== undefined) element.setAttribute("hue", String(message.hue));
    element.setAttribute("part", `message ${message.sender}`);

    const list = this.$(".list");
    if (options.prepend) list.insertBefore(element, this.$(".empty").nextSibling);
    else list.insertBefore(element, this.$("neocortex-thinking"));
    if (!options.prepend) this.scrollToEnd();
    return element;
  }

  /** Shows or hides the thinking dots at the end of the list. */
  set thinking(value: boolean) {
    this.connectedCallback();
    this.$<NeocortexThinking>("neocortex-thinking").active = value;
    if (value) this.scrollToEnd();
  }

  clear(): void {
    this.connectedCallback();
    this.root.querySelectorAll("neocortex-message").forEach((element) => element.remove());
  }

  scrollToEnd(): void {
    requestAnimationFrame(() => (this.scrollTop = this.scrollHeight));
  }
}

/** A text box with a send button. Fires `nc-send` with `{ text }`. */
export class NeocortexTextInput extends NeocortexElement {
  static observedAttributes = ["placeholder", "disabled", "maxlength"];

  connectedCallback() {
    if (this.root.firstChild) return;
    this.render(
      /* css */ `
      :host { display: block; }
      form { display: flex; gap: 0.5em; }
      input { flex: 1; min-width: 0; font: inherit; color: inherit; background: var(--_bg);
        border: 1px solid var(--_border); border-radius: calc(var(--_radius) * 0.7); padding: 0.55em 0.8em; }
      input::placeholder { color: var(--_muted); }
      `,
      `<form part="form">
        <input part="input" type="text" autocomplete="off" enterkeyhint="send" aria-label="Message" />
        <button part="send" class="primary" type="submit">Send</button>
      </form>`,
    );
    this.$("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = this.$<HTMLInputElement>("input");
      const text = input.value.trim();
      if (!text || this.hasAttribute("disabled")) return;
      if (this.fire("nc-send", { text })) input.value = "";
    });
    this.update();
  }

  attributeChangedCallback() {
    if (this.root.firstChild) this.update();
  }

  override focus(): void {
    this.$<HTMLInputElement>("input").focus();
  }

  get value(): string {
    return this.root.firstChild ? this.$<HTMLInputElement>("input").value : "";
  }

  set value(text: string) {
    this.connectedCallback();
    this.$<HTMLInputElement>("input").value = text;
  }

  private update() {
    const input = this.$<HTMLInputElement>("input");
    input.placeholder = this.getAttribute("placeholder") ?? "Say something…";
    input.maxLength = Number(this.getAttribute("maxlength") ?? 500);
    const disabled = this.hasAttribute("disabled");
    input.disabled = disabled;
    this.$<HTMLButtonElement>("button").disabled = disabled;
  }
}
