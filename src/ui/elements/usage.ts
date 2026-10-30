import { UsageGate } from "../../client/UsageGate";
import type { UsageResponse } from "../../core/types";
import { NeocortexElement } from "../base";

/** A small status pill showing whether characters are available. Refreshes every `refresh` seconds (default 60). */
export class NeocortexUsageBadge extends NeocortexElement {
  static observedAttributes = ["endpoint", "character-id", "refresh"];

  private gate: UsageGate | null = null;
  private offs: Array<() => void> = [];

  connectedCallback() {
    if (!this.root.firstChild) {
      this.render(
        /* css */ `
        :host { display: inline-flex; }
        .pill { display: inline-flex; align-items: center; gap: 0.45em; padding: 0.25em 0.7em; border-radius: 999px;
          font-size: 0.8em; background: var(--_surface); border: 1px solid var(--_border); }
        .dot { width: 0.55em; height: 0.55em; border-radius: 50%; background: var(--_muted); }
        :host([status="ok"]) .dot { background: #16a34a; }
        :host([status="low"]) .dot { background: var(--_accent); }
        :host([status="empty"]) .dot { background: var(--_danger); }
        `,
        `<span class="pill" part="pill" role="status"><span class="dot" part="dot"></span><span class="label" part="label">Checking…</span></span>`,
      );
    }
    this.start();
  }

  disconnectedCallback() {
    this.stop();
  }

  attributeChangedCallback() {
    if (this.isConnected && this.root.firstChild) this.start();
  }

  protected override clientChanged() {
    if (this.isConnected) this.start();
  }

  private start() {
    this.stop();
    this.gate = new UsageGate({ client: this.client, characterId: this.getAttribute("character-id") ?? undefined });
    this.offs = [
      this.gate.on("updated", (usage) => this.show(usage)),
      this.gate.on("error", () => {
        if (this.gate?.usage) return;
        this.setAttribute("status", "unknown");
        this.$(".label").textContent = "Status unavailable";
      }),
    ];
    this.gate.startAutoRefresh(Number(this.getAttribute("refresh")) || 60);
  }

  private stop() {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.gate?.stopAutoRefresh();
    this.gate = null;
  }

  private show(usage: UsageResponse) {
    const status = usage.player?.overLimit || usage.character?.overLimit ? "empty" : usage.status;
    this.setAttribute("status", status);
    this.$(".label").textContent =
      status === "empty" ? "Characters resting" : status === "low" ? "Running low" : "Characters available";
    this.fire("nx-usage", usage);
  }
}
