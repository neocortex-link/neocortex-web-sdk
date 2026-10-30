import { NeocortexChat, NeocortexGroupChat } from "./elements/chat";
import { NeocortexMicButton, NeocortexMicSelect } from "./elements/mic";
import { NeocortexChatPanel, NeocortexMessage, NeocortexTextInput, NeocortexThinking } from "./elements/primitives";
import { NeocortexQuiz } from "./elements/quiz";
import { NeocortexUsageBadge } from "./elements/usage";

export const ELEMENTS = {
  "neocortex-chat": NeocortexChat,
  "neocortex-group-chat": NeocortexGroupChat,
  "neocortex-quiz": NeocortexQuiz,
  "neocortex-chat-panel": NeocortexChatPanel,
  "neocortex-message": NeocortexMessage,
  "neocortex-text-input": NeocortexTextInput,
  "neocortex-thinking": NeocortexThinking,
  "neocortex-mic-button": NeocortexMicButton,
  "neocortex-mic-select": NeocortexMicSelect,
  "neocortex-usage-badge": NeocortexUsageBadge,
} as const;

/** Registers every `<neocortex-*>` element. Safe to call more than once, and a no-op outside a browser. */
export function defineNeocortexElements(): void {
  if (typeof customElements === "undefined") return;
  for (const [name, element] of Object.entries(ELEMENTS)) {
    if (!customElements.get(name)) customElements.define(name, element as unknown as CustomElementConstructor);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "neocortex-chat": NeocortexChat;
    "neocortex-group-chat": NeocortexGroupChat;
    "neocortex-quiz": NeocortexQuiz;
    "neocortex-chat-panel": NeocortexChatPanel;
    "neocortex-message": NeocortexMessage;
    "neocortex-text-input": NeocortexTextInput;
    "neocortex-thinking": NeocortexThinking;
    "neocortex-mic-button": NeocortexMicButton;
    "neocortex-mic-select": NeocortexMicSelect;
    "neocortex-usage-badge": NeocortexUsageBadge;
  }
}
