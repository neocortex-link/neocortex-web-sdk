/**
 * Wire types for the Neocortex v3 API.
 *
 * These follow what the server actually sends rather than what older docs say, and
 * keep the server's own field names so a payload can be logged and compared
 * against the API reference without translation.
 */

import type { Emotion } from "./emotions";

// ---------------------------------------------------------------------------
// Scene context
// ---------------------------------------------------------------------------

export type Vector3 = { x: number; y: number; z: number };

export type InteractableProperty = { name: string; value: string };

/** Something in the scene a character can perceive and act on. */
export type Interactable = {
  id: string;
  type: "CHARACTER" | "OBJECT";
  name: string;
  /** Set for an entity that is itself a Neocortex character. */
  characterId?: string;
  /** True for the entity the player is currently focused on. */
  isSubject?: boolean;
  position?: Vector3;
  properties?: InteractableProperty[];
};

/** A game event the characters should know about, highest priority first. */
export type EventLog = {
  /** 0 = low, 1 = medium, 2 = high. */
  priority: 0 | 1 | 2;
  content: string;
  /** ISO timestamp. */
  date?: string;
};

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatLine = {
  text: string;
  /** The text to send to speech synthesis, when it differs from what is shown. */
  spokenText?: string;
  emotion: Emotion;
  /**
   * Added by the server proxy: proof that this line came from a character, which
   * the proxy asks for before it will synthesize the line as speech.
   */
  speechToken?: string;
};

export type ChatAction = {
  name: string;
  /** The id of an entity sent in `metadata`, or "" when the action has no target. */
  targetId: string;
};

export type GroupMessage = {
  characterId: string;
  name: string;
  lines: ChatLine[];
  actions?: ChatAction[];
  flowState?: string;
  spokenMessage?: string;
};

export type ChatRequest = {
  /** One character for a conversation, up to six for a group scene (Pro or Team plan). */
  characterIds: string[];
  /** Leave out for an ambient turn, where the characters talk among themselves. */
  message?: string;
  playerId?: string;
  sessionId?: string;
  /** Force which character answers. Must be one of `characterIds`. */
  speakerCharacterId?: string;
  /** A character the player is role-playing as. `null` clears it. */
  playAs?: string | null;
  /** How many characters may speak in one group turn (max 6). */
  maxTurns?: number;
  metadata?: Interactable[];
  events?: EventLog[];
};

export type ChatResponse = {
  sessionId: string;
  messages: GroupMessage[];
};

export type ChatHistoryRequest = {
  sessionId: string;
  /** 1 to 100, default 20. */
  limit?: number;
  /** The `nextCursor` from the previous page. */
  before?: string;
};

export type ChatHistoryEntry = {
  content: string;
  sender: "USER" | "ASSISTANT" | "EVENT";
  createdAt: string;
  speakerCharacterId?: string;
  name?: string;
  addressedTo?: string;
  emotion?: Emotion;
  actions?: string[];
};

export type ChatHistoryResponse = {
  sessionId: string;
  messages: ChatHistoryEntry[];
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export type AudioFormat = "mp3" | "wav";

export type GenerateAudioRequest = {
  characterId: string;
  /** Up to 2000 characters. */
  message: string;
  emotion?: Emotion;
  format?: AudioFormat;
  language?: string;
  /** The `speechToken` of the line being spoken. Required by the server proxy by default. */
  speechToken?: string;
};

export type TranscribeRequest = {
  characterId: string;
  /** Up to 10 MB. Recorded audio as wav, mp3, m4a, webm, ogg or flac. */
  audio: Blob;
  language?: string;
  /** Words the transcriber should expect, such as names from your game. */
  prompt?: string;
};

export type TranscribeResponse = {
  response: string;
  model?: string;
};

// ---------------------------------------------------------------------------
// Quiz (Team plan)
// ---------------------------------------------------------------------------

export type QuizParticipant = {
  id: string;
  displayName: string;
  type?: "human" | "ai";
};

export type QuizStartRequest = {
  characterId: string;
  questionSetId: string;
  playerId?: string;
  participants?: QuizParticipant[];
  questionCount?: number;
  selectionMode?: "sequential" | "random";
};

export type QuizContinueRequest = {
  sessionId: string;
  /** What the player said. Empty means "pass". */
  say?: string;
  optionId?: string;
  participantId?: string;
  /** True when `say` was typed rather than spoken. */
  typed?: boolean;
};

export type QuizTurnRequest = QuizStartRequest | QuizContinueRequest;

export type QuizLine = ChatLine & {
  role: "greeting" | "reaction" | "question" | "closing";
};

export type QuizOption = { id: string; text: string };

export type QuizQuestion = {
  questionId: string;
  keyword?: string;
  type: string;
  questionText: string;
  options?: QuizOption[];
  hasHint?: boolean;
};

export type QuizResult = {
  participantId?: string;
  verdict: string;
  score: number;
};

export type QuizLeaderboardEntry = {
  participantId: string;
  displayName: string;
  totalScore: number;
  rank: number;
};

export type QuizExpecting = "answer" | "confirmation" | "nothing";

export type QuizTurnResponse = {
  sessionId: string;
  lines: QuizLine[];
  expecting: QuizExpecting;
  attempt: number;
  attemptsLeft: number;
  hintGiven: boolean;
  done: boolean;
  actions?: ChatAction[];
  intent?: string;
  question?: QuizQuestion;
  upcoming?: { questionId: string; keyword?: string };
  progress?: { asked: number; total: number };
  result?: QuizResult[];
  leaderboard?: QuizLeaderboardEntry[];
  pending?: string[];
  answered?: string[];
};

export type QuizSessionResponse = {
  state: Record<string, unknown> & { phase?: string; expecting?: QuizExpecting };
  leaderboard: QuizLeaderboardEntry[];
  roundHistory?: unknown[];
  questionSet?: unknown;
  startedAt: string;
  finishedAt: string | null;
};

// ---------------------------------------------------------------------------
// Account and catalogue
// ---------------------------------------------------------------------------

export type Character = { id: string; name: string };

export type QuestionSet = { id: string; name: string; questionCount: number };

export type AccountResponse = {
  tier: string;
  email: string;
  creditsRemaining: number;
  nextRefresh: string | null;
};

export type UsageResponse = {
  status: "ok" | "low" | "empty";
  creditsRemaining: number;
  player?: { interactionsToday: number; creditsUsedAllTime: number; overLimit: boolean };
  character?: { creditsUsedAllTime: number; overLimit: boolean };
};

/** The body every failed request carries. */
export type ApiErrorBody = {
  error: string;
  code?: string;
  /** Quiz `quiz_finished` replays the closing turn here. */
  turn?: QuizTurnResponse;
};
