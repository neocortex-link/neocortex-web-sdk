/**
 * Runs the Fetch-style proxy handler inside Express, Connect or plain `node:http`.
 *
 * Types are declared structurally so the package does not depend on `@types/node`
 * or Express at runtime.
 */

type NodeRequest = {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Set when a body parser (e.g. `express.json()`) already consumed the stream. */
  body?: unknown;
  on(event: "close", listener: () => void): unknown;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
};

type NodeResponse = {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string | string[]): unknown;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string | Uint8Array): unknown;
  once?(event: "drain", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  writableFinished?: boolean;
};

type FetchHandler = (request: Request) => Promise<Response>;

/**
 * Wraps a handler from `createNeocortexHandler` as `(req, res) => void`.
 *
 * Mount it on the same path you gave as `basePath`, e.g.
 * `app.use("/api/neocortex", toNodeHandler(handler))`.
 */
export function toNodeHandler(handler: FetchHandler) {
  return async function neocortexNodeHandler(req: NodeRequest, res: NodeResponse, next?: (error?: unknown) => void) {
    const controller = new AbortController();
    // The request emits "close" as soon as its body has been read, so watch the
    // response instead: closing before it finished means the visitor left.
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    try {
      const request = await toRequest(req, controller.signal);
      const response = await handler(request);
      await writeResponse(res, response, controller.signal);
    } catch (error) {
      if (next) return next(error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Something went wrong.", code: "internal_error" }));
      } else {
        res.end();
      }
    }
  };
}

async function toRequest(req: NodeRequest, signal: AbortSignal): Promise<Request> {
  const header = (name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const protocol = header("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = header("x-forwarded-host")?.split(",")[0]?.trim() || header("host") || "localhost";
  // Express rewrites req.url under app.use(path); originalUrl keeps the full path.
  const url = new URL(req.originalUrl ?? req.url ?? "/", `${protocol}://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }

  const method = (req.method ?? "GET").toUpperCase();
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const isJson = /^application\/json\b/i.test(header("content-type") ?? "");
    if (req.body !== undefined && req.body !== null && (isJson || !isEmptyParsedBody(req.body))) {
      // A body parser already ran; re-serialize what it produced.
      body = typeof req.body === "string" || req.body instanceof Uint8Array ? (req.body as BodyInit) : JSON.stringify(req.body);
      headers.delete("content-length");
    } else {
      // Stream rather than buffer: the handler checks auth, the route and the size
      // limit first, and reads only as much as it accepts. Node drains whatever is
      // left once the response ends, without holding it in memory.
      const iterator = (req as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
      body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await iterator.next();
          if (done) controller.close();
          else controller.enqueue(typeof value === "string" ? new TextEncoder().encode(value) : value);
        },
        async cancel() {
          await iterator.return?.();
        },
      });
    }
  }

  // `duplex` is required by Node's fetch for a streamed body, and missing from the DOM types.
  return new Request(url, { method, headers, body, signal, duplex: "half" } as RequestInit);
}

function isEmptyParsedBody(body: unknown): boolean {
  // express.json() leaves {} when the request was not JSON at all.
  return typeof body === "object" && !(body instanceof Uint8Array) && Object.keys(body as object).length === 0;
}

async function writeResponse(res: NodeResponse, response: Response, signal: AbortSignal) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));

  if (!response.body) {
    res.end();
    return;
  }

  // Stream chunk by chunk so speech starts playing before synthesis finishes.
  const reader = response.body.getReader();
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value) && res.once) {
        await new Promise<void>((resolve) => res.once!("drain", resolve));
      }
    }
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => {});
    res.end();
  }
}
