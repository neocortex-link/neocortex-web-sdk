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
const SESSION_PREFIX = "ncs_";

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
    if (typeof token !== "string" || !token.startsWith(SESSION_PREFIX) || token.length > 256) return null;
    const body = token.slice(SESSION_PREFIX.length);
    const dot = body.lastIndexOf(".");
    if (dot <= 0) return null;
    const sessionId = body.slice(0, dot);
    const signature = body.slice(dot + 1);
    return (await this.verify(signature, "session", userId, sessionId)) ? sessionId : null;
  }

  speechToken(userId: string, text: string): Promise<string> {
    return this.sign("speech", userId, normalizeSpeech(text));
  }

  verifySpeech(token: unknown, userId: string, text: string): Promise<boolean> {
    if (typeof token !== "string" || token.length > 64) return Promise.resolve(false);
    return this.verify(token, "speech", userId, normalizeSpeech(text));
  }
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
