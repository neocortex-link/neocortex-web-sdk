import type { ChatResponse } from "../core/types";
import { Conversation, type ConversationOptions } from "./Conversation";

export type GroupDirectorOptions = ConversationOptions & {
  /** Two to six characters sharing one conversation (Pro or Team plan). */
  characterIds: string[];
  /** How many characters may speak in one turn. */
  maxTurns?: number;
};

/**
 * Several characters in one conversation, where the AI picks who answers. The web
 * counterpart of Unity's `NeocortexGroupDirector`.
 */
export class GroupDirector extends Conversation {
  maxTurns?: number;

  constructor(options: GroupDirectorOptions) {
    super([...options.characterIds], options);
    this.maxTurns = options.maxTurns;
  }

  get members(): readonly string[] {
    return this.characterIds;
  }

  /** Adds a character. The cast is part of the session, so this starts a new one. */
  addCharacter(characterId: string): void {
    if (this.characterIds.includes(characterId)) return;
    this.characterIds = [...this.characterIds, characterId];
    this.clearSession();
  }

  removeCharacter(characterId: string): void {
    if (!this.characterIds.includes(characterId) || this.characterIds.length === 1) return;
    this.characterIds = this.characterIds.filter((id) => id !== characterId);
    this.clearSession();
  }

  /** The player speaks to the group; the AI decides who answers. */
  send(message: string): Promise<ChatResponse | null> {
    return this.turn({ message, ...this.turnLimit() });
  }

  /** The player addresses one character directly. */
  sendTo(characterId: string, message: string): Promise<ChatResponse | null> {
    return this.turn({ message, speakerCharacterId: characterId, ...this.turnLimit() });
  }

  /** The characters carry on among themselves without the player. */
  continue(): Promise<ChatResponse | null> {
    return this.turn({ ...this.turnLimit() });
  }

  /** Transcribes a recording and sends it to the group. */
  async sendAudio(audio: Blob): Promise<ChatResponse | null> {
    const text = await this.transcribe(audio);
    return text ? this.send(text) : null;
  }

  private turnLimit() {
    return this.maxTurns ? { maxTurns: this.maxTurns } : {};
  }
}
