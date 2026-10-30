// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { NeocortexClient } from "../src/core/client";
import { defineNeocortexElements, type NeocortexChat, type NeocortexChatPanel, setDefaultClient } from "../src/ui";
import { chatReply, fakeUpstream } from "./helpers";

beforeAll(() => defineNeocortexElements());

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("elements", () => {
  it("registers every element once, even when called twice", () => {
    defineNeocortexElements();
    for (const name of ["neocortex-chat", "neocortex-quiz", "neocortex-mic-button", "neocortex-usage-badge"]) {
      expect(customElements.get(name)).toBeTruthy();
    }
  });

  it("renders message text as text, never HTML", () => {
    const panel = document.createElement("neocortex-chat-panel") as NeocortexChatPanel;
    document.body.append(panel);
    const message = panel.addMessage({ sender: "character", text: '<img src=x onerror="alert(1)">', name: "<b>Eve</b>" });
    const bubble = message.shadowRoot!.querySelector(".bubble")!;
    expect(bubble.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(bubble.querySelector("img")).toBeNull();
    expect(message.shadowRoot!.querySelector(".name b")).toBeNull();
    panel.remove();
  });

  it("text input fires nc-send and clears", () => {
    const input = document.createElement("neocortex-text-input");
    document.body.append(input);
    const sent: string[] = [];
    input.addEventListener("nc-send", (e) => sent.push((e as CustomEvent).detail.text));
    const field = input.shadowRoot!.querySelector("input")!;
    field.value = "  hello  ";
    input.shadowRoot!.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(sent).toEqual(["hello"]);
    expect(field.value).toBe("");
    input.remove();
  });

  it("rebuilds its client when the endpoint attribute changes", () => {
    const badge = document.createElement("neocortex-chat-panel");
    badge.setAttribute("endpoint", "/one");
    const first = badge.client;
    expect(first.baseUrl).toBe("/one");
    expect(badge.client).toBe(first);
    badge.setAttribute("endpoint", "/two");
    expect(badge.client.baseUrl).toBe("/two");

    const explicit = new NeocortexClient({ baseUrl: "/explicit" });
    badge.client = explicit;
    badge.setAttribute("endpoint", "/three");
    expect(badge.client).toBe(explicit);
  });

  it("neocortex-chat runs a turn through its client and shows the reply", async () => {
    const upstream = fakeUpstream({ chat: () => chatReply("s1", [{ text: "Hello from Cora", emotion: "HAPPY" }]) });
    setDefaultClient(new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch }));
    localStorage.clear();

    const chat = document.createElement("neocortex-chat") as NeocortexChat;
    chat.setAttribute("character-id", "char-a");
    document.body.append(chat);
    const lines: string[] = [];
    chat.addEventListener("nc-line", (e) => lines.push((e as CustomEvent).detail.line.text));

    const input = chat.shadowRoot!.querySelector("neocortex-text-input")!;
    input.shadowRoot!.querySelector("input")!.value = "Hi Cora";
    input.shadowRoot!.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush(50);

    expect(lines).toEqual(["Hello from Cora"]);
    const panel = chat.shadowRoot!.querySelector("neocortex-chat-panel")!;
    const texts = [...panel.shadowRoot!.querySelectorAll("neocortex-message")].map((m) => m.getAttribute("text"));
    expect(texts).toEqual(["Hi Cora", "Hello from Cora"]);
    expect(chat.shadowRoot!.querySelector("h2")!.textContent).toBe("Cora");
    expect(upstream.last()!.body).toMatchObject({ characterIds: ["char-a"], message: "Hi Cora" });
    chat.remove();
    setDefaultClient(null);
  });
});
