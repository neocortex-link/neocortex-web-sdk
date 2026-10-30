/**
 * Stateless proofs the proxy hands to the browser and checks when they come back.
 *
 * A session id is wrapped in a token bound to the user it was issued to, so one
 * user cannot read or continue another's conversation by guessing ids. Each line
 * a character says carries a speech token, so the text-to-speech route will only
 * voice what a character actually said, not whatever text a visitor sends.
 *
 * Both are HMACs rather than records in a store, which keeps the proxy working on
 * serverless hosts where memory does not survive between requests.
 */

const encoder = new TextEncoder();
const SESSION_PREFIX = "nxs_";
const QUIZ_PREFIX = "nxq_";

export class Signer {
  private key: Promise<CryptoKey>;

  constructor(secret: string) {
    this.key = deriveKey(secret);
  }

  async sign(purpose: string, ...parts: string[]): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", await this.key, encoder.encode([purpose, ...parts].join("\u0000")));
    // 128 bits is far beyond guessing range and keeps tokens short.
    return base64url(new Uint8Array(mac).subarray(0, 16));
  }

  async verify(signature: string, purpose: string, ...parts: string[]): Promise<boolean> {
    const expected = await this.sign(purpose, ...parts);
    return timingSafeEqual(expected, signature);
  }

  async wrapSession(sessionId: string, userId: string): Promise<string> {
    return `${SESSION_PREFIX}${sessionId}.${await this.sign("session", userId, sessionId)}`;
  }

  /** The real session id, or null when the token is malformed or belongs to someone else. */
  async unwrapSession(token: unknown, userId: string): Promise<string | null> {
    const parts = split(token, SESSION_PREFIX, 2);
    if (!parts) return null;
    const [sessionId, signature] = parts;
    return (await this.verify(signature!, "session", userId, sessionId!)) ? sessionId! : null;
  }

  /**
   * A quiz token also carries its host character. Later turns name only the
   * session, and the host's lines must still be signed for that character.
   */
  async wrapQuizSession(sessionId: string, userId: string, characterId: string): Promise<string> {
    return `${QUIZ_PREFIX}${sessionId}.${characterId}.${await this.sign("quiz", userId, sessionId, characterId)}`;
  }

  async unwrapQuizSession(token: unknown, userId: string): Promise<{ sessionId: string; characterId: string } | null> {
    const parts = split(token, QUIZ_PREFIX, 3);
    if (!parts) return null;
    const [sessionId, characterId, signature] = parts;
    return (await this.verify(signature!, "quiz", userId, sessionId!, characterId!))
      ? { sessionId: sessionId!, characterId: characterId! }
      : null;
  }

  /** Proof that `characterId` said `text` to this user. */
  speechToken(userId: string, characterId: string, text: string): Promise<string> {
    return this.sign("speech", userId, characterId, normalizeSpeech(text));
  }

  verifySpeech(token: unknown, userId: string, characterId: string, text: string): Promise<boolean> {
    if (typeof token !== "string" || token.length > 64) return Promise.resolve(false);
    return this.verify(token, "speech", userId, characterId, normalizeSpeech(text));
  }
}

/**
 * Splits `prefix` + `count` dot-separated parts. Only the session id can contain
 * a dot, so the other parts are taken from the end.
 */
function split(token: unknown, prefix: string, count: number): string[] | null {
  if (typeof token !== "string" || !token.startsWith(prefix) || token.length > 256) return null;
  const parts = token.slice(prefix.length).split(".");
  if (parts.length < count) return null;
  const tail = parts.splice(parts.length - (count - 1));
  const head = parts.join(".");
  if (!head || tail.some((part) => !part)) return null;
  return [head, ...tail];
}

function normalizeSpeech(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  // Derive rather than use the secret directly, so a key reused elsewhere never
  // signs anything in the same space.
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const derived = await crypto.subtle.sign("HMAC", root, encoder.encode("neocortex-web-proxy/v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
