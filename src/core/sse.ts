/**
 * Reads a `text/event-stream` body into `{ type, data }` events.
 *
 * Kept internal: `/v3/chat/stream` is not part of the public API yet, but the
 * dashboard already relies on it, so the parser is ready for when it is.
 */

export type ServerSentEvent = { type: string; data: unknown };

export async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      // Frames are separated by a blank line; a partial one waits for more bytes.
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): ServerSentEvent | null {
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;

  const raw = data.join("\n");
  try {
    return { type, data: JSON.parse(raw) };
  } catch {
    // A frame we cannot read is not worth failing the turn over.
    return { type, data: raw };
  }
}
