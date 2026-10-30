import { AudioReceiver, type ReceiverState } from "../../client/audio/AudioReceiver";
import { NeocortexElement } from "../base";

const MIC_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/></svg>`;

/**
 * A microphone button with a live level ring. Click to listen (recording stops
 * after a pause), or hold it with `push-to-talk`. Fires `nc-recorded` with
 * `{ audio }`, a WAV Blob ready for `agent.audioToAudio()`.
 */
export class NeocortexMicButton extends NeocortexElement {
  static observedAttributes = ["push-to-talk", "disabled", "threshold", "max-wait"];

  private _receiver: AudioReceiver | null = null;
  private unsubscribe: Array<() => void> = [];
  private frame = 0;

  /** The recorder behind the button. Share one with a `<neocortex-mic-select>`. */
  get receiver(): AudioReceiver {
    if (!this._receiver) this.receiver = new AudioReceiver();
    return this._receiver!;
  }

  set receiver(receiver: AudioReceiver) {
    this.unsubscribe.forEach((off) => off());
    this._receiver = receiver;
    this.applySettings();
    this.unsubscribe = [
      receiver.on("state", (state) => this.updateState(state)),
      receiver.on("recorded", (audio) => this.fire("nc-recorded", { audio })),
      receiver.on("permissionDenied", (error) => this.fire("nc-error", { error, reason: "permission" })),
      receiver.on("error", (error) => this.fire("nc-error", { error })),
    ];
  }

  connectedCallback() {
    if (this.root.firstChild) return;
    this.render(
      /* css */ `
      :host { display: inline-block; --_level: 0; --_silence: 0; }
      button { position: relative; width: 2.6rem; height: 2.6rem; min-height: 0; padding: 0; border-radius: 50%;
        display: grid; place-items: center; touch-action: none; user-select: none; -webkit-user-select: none; }
      button::before { content: ""; position: absolute; inset: -4px; border-radius: 50%;
        border: 3px solid var(--_accent); opacity: 0; transform: scale(calc(1 + var(--_level) * 0.35));
        transition: transform 60ms linear, opacity 120ms; pointer-events: none; }
      button::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; pointer-events: none;
        background: conic-gradient(var(--_muted) calc(var(--_silence) * 360deg), transparent 0);
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
        mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0); }
      :host([state="listening"]) button::before { opacity: 0.35; }
      :host([state="recording"]) button { background: var(--_accent); color: var(--_accent-text); border-color: transparent; }
      :host([state="recording"]) button::before { opacity: 0.8; }
      `,
      `<button part="button" type="button">${MIC_ICON}<span class="sr-only"></span></button>`,
    );

    const button = this.$<HTMLButtonElement>("button");
    button.addEventListener("click", () => {
      if (this.pushToTalk) return;
      this.toggle();
    });
    button.addEventListener("pointerdown", (event) => {
      if (!this.pushToTalk || this.disabled) return;
      button.setPointerCapture(event.pointerId);
      void this.receiver.press().catch(() => {});
    });
    const release = () => this.pushToTalk && this.receiver.release();
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("keydown", (event) => {
      if (!this.pushToTalk || event.repeat || (event.key !== " " && event.key !== "Enter")) return;
      event.preventDefault();
      void this.receiver.press().catch(() => {});
    });
    button.addEventListener("keyup", (event) => {
      if (this.pushToTalk && (event.key === " " || event.key === "Enter")) release();
    });

    if (!AudioReceiver.isSupported()) {
      button.disabled = true;
      button.title = "This browser cannot record audio.";
    }
    this.updateState("idle");
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.frame);
    this._receiver?.stop();
  }

  attributeChangedCallback(name: string) {
    if (!this.root.firstChild) return;
    if (name === "disabled") this.$<HTMLButtonElement>("button").disabled = this.disabled;
    this.applySettings();
    this.updateState(this._receiver?.state ?? "idle");
  }

  get pushToTalk(): boolean {
    return this.hasAttribute("push-to-talk");
  }

  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }

  /** Starts listening, or stops if already listening. */
  async toggle(): Promise<void> {
    if (this.disabled) return;
    if (this.receiver.isListening) this.receiver.stop();
    else await this.receiver.start().catch(() => {});
  }

  stop(): void {
    this._receiver?.stop();
  }

  private applySettings() {
    const receiver = this._receiver;
    if (!receiver) return;
    receiver.pushToTalk = this.pushToTalk;
    const threshold = Number(this.getAttribute("threshold"));
    if (threshold > 0) receiver.amplitudeThreshold = threshold;
    const maxWait = Number(this.getAttribute("max-wait"));
    if (maxWait > 0) receiver.maxWaitTime = maxWait;
  }

  private updateState(state: ReceiverState) {
    this.setAttribute("state", state);
    const label =
      state === "recording"
        ? "Recording. Pause to send."
        : state === "listening"
          ? "Listening. Start speaking, or press to stop."
          : this.pushToTalk
            ? "Hold to talk"
            : "Talk";
    if (!this.root.firstChild) return;
    this.$(".sr-only").textContent = label;
    this.$("button").title = label;
    if (this.pushToTalk) this.$("button").setAttribute("aria-pressed", String(state === "recording"));

    cancelAnimationFrame(this.frame);
    if (state === "idle") {
      this.style.setProperty("--_level", "0");
      this.style.setProperty("--_silence", "0");
      return;
    }
    const tick = () => {
      this.style.setProperty("--_level", String(this._receiver?.amplitude ?? 0));
      this.style.setProperty("--_silence", String(this._receiver?.silenceProgress ?? 0));
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }
}

/**
 * Lists microphones and switches the one a mic button records from. Point it at
 * the button with `for="<id>"`, or set its `receiver` property.
 */
export class NeocortexMicSelect extends NeocortexElement {
  private _receiver: AudioReceiver | null = null;

  get receiver(): AudioReceiver | null {
    if (this._receiver) return this._receiver;
    const id = this.getAttribute("for");
    const target = id ? (this.getRootNode() as Document | ShadowRoot).getElementById?.(id) : null;
    return target instanceof NeocortexMicButton ? target.receiver : null;
  }

  set receiver(receiver: AudioReceiver | null) {
    this._receiver = receiver;
  }

  connectedCallback() {
    if (this.root.firstChild) return;
    this.render(
      /* css */ `
      :host { display: inline-block; }
      select { font: inherit; color: inherit; background: var(--_bg); border: 1px solid var(--_border);
        border-radius: calc(var(--_radius) * 0.7); padding: 0.45em 0.6em; max-width: 100%; }
      `,
      `<select part="select" aria-label="Microphone"></select>`,
    );
    const select = this.$<HTMLSelectElement>("select");
    select.addEventListener("change", () => void this.receiver?.selectDevice(select.value));
    select.addEventListener("focus", () => void this.refresh());
    navigator.mediaDevices?.addEventListener?.("devicechange", () => void this.refresh());
    void this.refresh();
  }

  /** Re-reads the device list. Names appear once microphone permission is granted. */
  async refresh(): Promise<void> {
    const select = this.$<HTMLSelectElement>("select");
    const devices = await AudioReceiver.devices().catch(() => []);
    const current = select.value || readStoredDevice();
    select.replaceChildren();
    const fallback = new Option("Default microphone", "");
    select.append(fallback);
    devices
      .filter((device) => device.deviceId && device.deviceId !== "default")
      .forEach((device, index) => select.append(new Option(device.label || `Microphone ${index + 1}`, device.deviceId)));
    select.value = [...select.options].some((o) => o.value === current) ? current : "";
  }
}

function readStoredDevice(): string {
  try {
    return localStorage.getItem("neocortex-mic-device") ?? "";
  } catch {
    return "";
  }
}
