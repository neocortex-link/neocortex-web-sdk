import type { Conversation } from "../../client/Conversation";
import { GroupDirector } from "../../client/GroupDirector";
import { SmartAgent } from "../../client/SmartAgent";
import type { ChatHistoryEntry } from "../../core/types";
import { hueFor, NeocortexElement } from "../base";
import type { NeocortexMicButton } from "./mic";
import type { NeocortexChatPanel } from "./primitives";

const SPEAKER_ON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>`;
const SPEAKER_OFF = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>`;
const RESET = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;

/** Inner parts re-exported, so `neocortex-chat::part(bubble)` reaches the bubbles from the page. */
export const PANEL_PARTS = "list, empty, thinking, dots, message, player, character, notice, name, bubble";
export const INPUT_PARTS = "form, input: input-field, send";
export const MIC_PARTS = "button: mic-button";

const CHAT_CSS = /* css */ `
:host { display: flex; flex-direction: column; height: 32rem; max-height: 100%; min-width: 0;
  background: var(--_bg); border: 1px solid var(--_border); border-radius: var(--_radius); overflow: hidden; }
header { display: flex; align-items: center; gap: 0.5em; padding: 0.6em 0.8em; border-bottom: 1px solid var(--_border); }
header h2 { flex: 1; margin: 0; font-size: 1em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header button { padding: 0.35em; min-height: 2rem; min-width: 2rem; display: grid; place-items: center; background: transparent; border-color: transparent; }
header button[aria-pressed="true"] { color: var(--_accent); }
neocortex-chat-panel { flex: 1; min-height: 0; }
footer { display: flex; align-items: center; gap: 0.5em; padding: 0.6em 0.8em; border-top: 1px solid var(--_border); }
footer neocortex-text-input { flex: 1; min-width: 0; }
:host([no-header]) header { display: none; }
`;

/**
 * Shared behaviour of `<neocortex-chat>` and `<neocortex-group-chat>`: wiring a
 * conversation to a panel, a text box and a mic button, loading history, and
 * re-dispatching what happens as DOM events (`nx-line`, `nx-action`, `nx-error`,
 * `nx-response`).
 */
abstract class ConversationElement<A extends Conversation> extends NeocortexElement {
  static observedAttributes = ["endpoint", "voice", "push-to-talk", "placeholder", "heading", "language", "theme"];

  protected _agent: A | null = null;
  private offs: Array<() => void> = [];
  protected built = false;

  /** The conversation behind the element: register actions or listen to events on it. */
  get agent(): A {
    if (!this._agent) this.attachAgent();
    return this._agent!;
  }

  protected abstract createAgent(): A | null;
  protected abstract emptyText(): string;
  protected extraControls(): string {
    return "";
  }
  protected onBuilt(): void {}

  connectedCallback() {
    if (!this.built) this.build();
    if (!this._agent) this.attachAgent();
  }

  disconnectedCallback() {
    this._agent?.abort();
    this.mic.stop();
  }

  attributeChangedCallback(name: string, previous: string | null, value: string | null) {
    if (!this.built || previous === value) return;
    if (name === "voice") {
      if (this._agent) this._agent.voice = this.flag("voice");
      this.updateVoiceButton();
    } else if (name === "push-to-talk") {
      this.mic.toggleAttribute("push-to-talk", this.flag("push-to-talk"));
    } else if (name === "theme") {
      this.syncTheme();
    } else if (name === "placeholder") {
      this.input.setAttribute("placeholder", value ?? "");
    } else if (name === "heading") {
      this.$("h2").textContent = value ?? "";
    } else if (name === "language" && this._agent) {
      this._agent.language = value ?? undefined;
    } else if (name === "endpoint") {
      this.resetAgent();
    }
  }

  protected override clientChanged() {
    if (this.built) this.resetAgent();
  }

  /** Starts a new conversation. */
  reset(): void {
    this._agent?.abort();
    this._agent?.clearSession();
    this.panel.clear();
  }

  protected get panel(): NeocortexChatPanel {
    return this.$<NeocortexChatPanel>("neocortex-chat-panel");
  }

  protected get input(): HTMLElement {
    return this.$("neocortex-text-input");
  }

  protected get mic(): NeocortexMicButton {
    return this.$<NeocortexMicButton>("neocortex-mic-button");
  }

  protected resetAgent(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    this._agent?.abort();
    this._agent = null;
    this.panel.clear();
    if (this.isConnected) this.attachAgent();
  }

  private build() {
    this.built = true;
    this.render(
      CHAT_CSS,
      `<header part="header">
        <h2 part="heading"></h2>
        ${this.extraControls()}
        <button part="voice-toggle" class="voice" type="button"></button>
        <button part="reset" class="reset" type="button" title="New conversation" aria-label="New conversation">${RESET}</button>
      </header>
      <neocortex-chat-panel part="panel" exportparts="${PANEL_PARTS}"></neocortex-chat-panel>
      <footer part="footer">
        <neocortex-text-input part="input" exportparts="${INPUT_PARTS}"></neocortex-text-input>
        <neocortex-mic-button part="mic" exportparts="${MIC_PARTS}"></neocortex-mic-button>
      </footer>`,
    );
    this.$("h2").textContent = this.getAttribute("heading") ?? "";
    this.panel.setAttribute("empty-text", this.emptyText());
    if (this.hasAttribute("placeholder")) this.input.setAttribute("placeholder", this.getAttribute("placeholder")!);
    if (this.flag("push-to-talk")) this.mic.setAttribute("push-to-talk", "");
    if (this.getAttribute("mic") === "false") this.mic.hidden = true;
    this.syncTheme();

    this.$(".voice").addEventListener("click", () => {
      this.setAttribute("voice", String(!this.flag("voice")));
      if (this.flag("voice")) this.agent.primeAudio();
    });
    this.$(".reset").addEventListener("click", () => this.reset());

    this.input.addEventListener("nx-send", (event) => {
      const { text } = (event as CustomEvent<{ text: string }>).detail;
      this.agent.primeAudio();
      void this.sendText(text);
    });
    this.mic.addEventListener("nx-recorded", (event) => {
      const { audio } = (event as CustomEvent<{ audio: Blob }>).detail;
      this.agent.primeAudio();
      void this.sendAudio(audio);
    });
    this.mic.addEventListener("nx-error", (event) => {
      const detail = (event as CustomEvent<{ error: Error; reason?: string }>).detail;
      // The event is still on its way out to the page; wait for it so a page
      // listener can call preventDefault() and show its own message instead.
      setTimeout(() => {
        if (event.defaultPrevented) return;
        this.panel.addMessage({
          sender: "notice",
          text: detail.reason === "permission" ? "Microphone access was blocked." : detail.error.message,
        });
      });
    });
    this.updateVoiceButton();
    this.onBuilt();
  }

  protected abstract sendText(text: string): Promise<unknown>;
  protected abstract sendAudio(audio: Blob): Promise<unknown>;

  private attachAgent() {
    const agent = this.createAgent();
    if (!agent) return;
    this._agent = agent;
    agent.voice = this.flag("voice");
    agent.language = this.getAttribute("language") ?? undefined;

    this.offs = [
      agent.on("playerMessage", (text) => this.panel.addMessage({ sender: "player", text })),
      agent.on("composing", (value) => (this.panel.thinking = value)),
      agent.on("lineStarted", (detail) => {
        this.panel.addMessage({
          sender: "character",
          text: detail.line.text,
          name: this.showNames ? detail.name : undefined,
          emotion: detail.line.emotion,
          hue: this.showNames ? hueFor(detail.characterId) : undefined,
        });
        if (!this.getAttribute("heading") && !this.showNames) this.$("h2").textContent = detail.name;
        this.fire("nx-line", detail);
      }),
      agent.on("action", (detail) => this.fire("nx-action", detail)),
      agent.on("emotionChanged", (detail) => this.fire("nx-emotion", detail)),
      agent.on("response", (response) => this.fire("nx-response", response)),
      agent.on("replyFinished", (response) => this.fire("nx-reply-finished", response)),
      agent.on("error", (error) => {
        if (this.fire("nx-error", { error })) this.panel.addMessage({ sender: "notice", text: friendlyError(error) });
      }),
    ];

    if (this.flag("history", true)) void this.loadHistory(agent);
  }

  private async loadHistory(agent: A) {
    const page = await agent.history(30);
    if (!page || agent !== this._agent) return;
    const entries = [...page.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const entry of entries.reverse()) this.addHistoryEntry(entry);
  }

  private addHistoryEntry(entry: ChatHistoryEntry) {
    if (entry.sender === "EVENT" || !entry.content) return;
    const isPlayer = entry.sender === "USER";
    this.panel.addMessage(
      {
        sender: isPlayer ? "player" : "character",
        text: entry.content,
        name: !isPlayer && this.showNames ? entry.name : undefined,
        emotion: entry.emotion,
        hue: !isPlayer && this.showNames && entry.speakerCharacterId ? hueFor(entry.speakerCharacterId) : undefined,
      },
      { prepend: true },
    );
  }

  protected get showNames(): boolean {
    return false;
  }

  private updateVoiceButton() {
    const on = this.flag("voice");
    const button = this.$(".voice");
    button.innerHTML = on ? SPEAKER_ON : SPEAKER_OFF;
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Voice replies on" : "Voice replies off");
    button.title = on ? "Voice replies on" : "Voice replies off";
  }
}

/**
 * A complete chat with one character: history, typing, voice input, spoken
 * replies and a thinking indicator.
 *
 * ```html
 * <neocortex-chat endpoint="/api/neocortex" character-id="..." voice></neocortex-chat>
 * ```
 */
export class NeocortexChat extends ConversationElement<SmartAgent> {
  static override observedAttributes = [...ConversationElement.observedAttributes, "character-id"];

  override attributeChangedCallback(name: string, previous: string | null, value: string | null) {
    if (name === "character-id" && previous !== value) {
      if (this.built) this.resetAgent();
      return;
    }
    super.attributeChangedCallback(name, previous, value);
  }

  protected createAgent(): SmartAgent | null {
    const characterId = this.getAttribute("character-id");
    if (!characterId) return null;
    return new SmartAgent({ client: this.client, characterId });
  }

  protected emptyText() {
    return "Say hello to start the conversation.";
  }

  protected sendText(text: string) {
    return this.agent.send(text);
  }

  protected async sendAudio(audio: Blob) {
    const text = await this.agent.transcribe(audio);
    if (text) await this.agent.send(text);
  }
}

/**
 * Several characters in one conversation, each speaking in their own colour.
 *
 * ```html
 * <neocortex-group-chat endpoint="/api/neocortex" character-ids="id1,id2" voice></neocortex-group-chat>
 * ```
 */
export class NeocortexGroupChat extends ConversationElement<GroupDirector> {
  static override observedAttributes = [...ConversationElement.observedAttributes, "character-ids", "max-turns"];

  override attributeChangedCallback(name: string, previous: string | null, value: string | null) {
    if ((name === "character-ids" || name === "max-turns") && previous !== value) {
      if (name === "max-turns" && this._agent) this._agent.maxTurns = Number(value) || undefined;
      else if (this.built) this.resetAgent();
      return;
    }
    super.attributeChangedCallback(name, previous, value);
  }

  protected createAgent(): GroupDirector | null {
    const ids = (this.getAttribute("character-ids") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return null;
    return new GroupDirector({
      client: this.client,
      characterIds: ids,
      maxTurns: Number(this.getAttribute("max-turns")) || undefined,
    });
  }

  protected override get showNames() {
    return true;
  }

  protected emptyText() {
    return "Say something to the group, or let them talk.";
  }

  protected override extraControls() {
    return `<button part="continue" class="continue" type="button" title="Let them keep talking">Let them talk</button>`;
  }

  protected override onBuilt() {
    const button = this.$<HTMLButtonElement>(".continue");
    button.style.cssText = "width:auto;font-size:0.85em;border-color:var(--_border)";
    button.addEventListener("click", () => {
      this.agent.primeAudio();
      void this.agent.continue();
    });
  }

  protected sendText(text: string) {
    return this.agent.send(text);
  }

  protected sendAudio(audio: Blob) {
    return this.agent.sendAudio(audio);
  }
}

function friendlyError(error: { status: number; code?: string; message: string; isOutOfCredits?: boolean }): string {
  if (error.isOutOfCredits || error.code === "insufficient_credits") return "This character is resting right now. Try again later.";
  if (error.status === 429) return "Slow down a little and try again in a moment.";
  if (error.status === 401) return "Sign in to talk to characters.";
  if (error.status === 0 && error.code === "network_error") return "Could not connect. Check your internet connection.";
  return error.message;
}
