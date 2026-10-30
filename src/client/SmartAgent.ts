import type { ChatResponse, GroupMessage } from "../core/types";
import { Conversation, type ConversationOptions } from "./Conversation";

export type SmartAgentOptions = ConversationOptions & {
  characterId: string;
};

/**
 * One Neocortex character in conversation with the player. The web counterpart
 * of Unity's `NeocortexSmartAgent`.
 *
 * ```ts
 * const agent = new SmartAgent({ endpoint: "/api/neocortex", characterId: "..." });
 * agent.on("lineStarted", ({ line }) => show(line.text));
 * agent.registerAction("OPEN_DOOR", () => door.open());
 * await agent.textToAudio("Can you let me in?");
 * ```
 */
export class SmartAgent extends Conversation {
  readonly characterId: string;

  constructor(options: SmartAgentOptions) {
    super([options.characterId], options);
    this.characterId = options.characterId;
  }

  /** Sends a typed message and shows the reply as text. */
  async textToText(message: string): Promise<GroupMessage | null> {
    return first(await this.turn({ message, voice: false }));
  }

  /** Sends a typed message and speaks the reply. */
  async textToAudio(message: string): Promise<GroupMessage | null> {
    return first(await this.turn({ message, voice: true }));
  }

  /** Transcribes a recording, sends it, and shows the reply as text. */
  async audioToText(audio: Blob): Promise<GroupMessage | null> {
    const text = await this.transcribe(audio);
    return text ? this.textToText(text) : null;
  }

  /** Transcribes a recording, sends it, and speaks the reply. */
  async audioToAudio(audio: Blob): Promise<GroupMessage | null> {
    const text = await this.transcribe(audio);
    return text ? this.textToAudio(text) : null;
  }

  /** Sends a message using the agent's `voice` setting. */
  async send(message: string): Promise<GroupMessage | null> {
    return first(await this.turn({ message }));
  }

  /** Lets the character speak without the player saying anything, e.g. a greeting. */
  async prompt(): Promise<GroupMessage | null> {
    return first(await this.turn({}));
  }
}

function first(response: ChatResponse | null): GroupMessage | null {
  return response?.messages[0] ?? null;
}
