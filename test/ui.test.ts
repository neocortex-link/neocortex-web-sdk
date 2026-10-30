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

  it("text input fires nx-send and clears", () => {
    const input = document.createElement("neocortex-text-input");
    document.body.append(input);
    const sent: string[] = [];
    input.addEventListener("nx-send", (e) => sent.push((e as CustomEvent).detail.text));
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

  it("passes theme down to nested elements, including new bubbles", () => {
    const chat = document.createElement("neocortex-chat") as NeocortexChat;
    chat.setAttribute("theme", "light");
    document.body.append(chat);
    const panel = chat.shadowRoot!.querySelector("neocortex-chat-panel") as NeocortexChatPanel;
    expect(panel.getAttribute("theme")).toBe("light");
    expect(chat.shadowRoot!.querySelector("neocortex-text-input")!.getAttribute("theme")).toBe("light");
    expect(panel.addMessage({ sender: "character", text: "Hi" }).getAttribute("theme")).toBe("light");

    chat.setAttribute("theme", "dark");
    expect(panel.shadowRoot!.querySelector("neocortex-message")!.getAttribute("theme")).toBe("dark");
    chat.remove();
  });

  it("re-exports inner parts so the page can style bubbles", () => {
    const chat = document.createElement("neocortex-chat");
    document.body.append(chat);
    const panel = chat.shadowRoot!.querySelector("neocortex-chat-panel")!;
    expect(panel.getAttribute("exportparts")).toContain("bubble");
    const message = (panel as NeocortexChatPanel).addMessage({ sender: "player", text: "Hi" });
    expect(message.getAttribute("exportparts")).toBe("name, bubble");
    chat.remove();
  });

  it("treats push-to-talk=\"false\" as off", () => {
    const chat = document.createElement("neocortex-chat");
    chat.setAttribute("push-to-talk", "false");
    document.body.append(chat);
    expect(chat.shadowRoot!.querySelector("neocortex-mic-button")!.hasAttribute("push-to-talk")).toBe(false);
    chat.setAttribute("push-to-talk", "");
    expect(chat.shadowRoot!.querySelector("neocortex-mic-button")!.hasAttribute("push-to-talk")).toBe(true);
    chat.remove();
  });

  it("lets the page suppress the built-in microphone notice", async () => {
    const chat = document.createElement("neocortex-chat");
    document.body.append(chat);
    chat.addEventListener("nx-error", (event) => event.preventDefault());
    const mic = chat.shadowRoot!.querySelector("neocortex-mic-button")!;
    mic.dispatchEvent(new CustomEvent("nx-error", { detail: { error: new Error("no mic") }, bubbles: true, composed: true, cancelable: true }));
    await flush();
    const panel = chat.shadowRoot!.querySelector("neocortex-chat-panel")!;
    expect(panel.shadowRoot!.querySelectorAll("neocortex-message")).toHaveLength(0);
    chat.remove();
  });

  it("switches existing elements to a default client set later", () => {
    setDefaultClient(null);
    const panel = document.createElement("neocortex-chat-panel");
    const before = panel.client;
    const later = new NeocortexClient({ baseUrl: "/later" });
    setDefaultClient(later);
    expect(panel.client).not.toBe(before);
    expect(panel.client).toBe(later);
    setDefaultClient(null);
  });

  it("neocortex-chat runs a turn through its client and shows the reply", async () => {
    const upstream = fakeUpstream({ chat: () => chatReply("s1", [{ text: "Hello from Cora", emotion: "HAPPY" }]) });
    setDefaultClient(new NeocortexClient({ baseUrl: "https://api.test/v3", fetch: upstream.fetch }));
    localStorage.clear();

    const chat = document.createElement("neocortex-chat") as NeocortexChat;
    chat.setAttribute("character-id", "char-a");
    document.body.append(chat);
    const lines: string[] = [];
    chat.addEventListener("nx-line", (e) => lines.push((e as CustomEvent).detail.line.text));

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
