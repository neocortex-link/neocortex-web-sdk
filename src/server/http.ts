/** Small Response and Request helpers for the proxy. */

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(error: ProxyError, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: error.message, code: error.code, ...extra }, error.status, error.headers);
}

/**
 * Reads the body without trusting Content-Length, stopping as soon as it passes
 * the limit so an oversized upload cannot fill memory.
 */
export async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge(limit);
    }
    parts.push(value);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

function tooLarge(limit: number): ProxyError {
  return new ProxyError(413, "payload_too_large", `The request body is larger than ${limit} bytes.`);
}

export async function readJson(request: Request, limit: number): Promise<Record<string, unknown>> {
  // A JSON content type forces a CORS preflight, so a cross-site form post
  // cannot reach this route with someone else's cookies.
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    throw new ProxyError(415, "unsupported_media_type", "Send the request body as application/json.");
  }
  const bytes = await readBody(request, limit);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProxyError(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProxyError(400, "invalid_json", "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
