import { encodeWav } from "../src/core/wav";
import { NeocortexClient } from "../src/core/client";
import "../src/ui/auto";
import type { NeocortexChat, NeocortexGroupChat, NeocortexMicButton, NeocortexQuiz } from "../src/ui";
import type { NeocortexChatPanel, NeocortexUsageBadge } from "../src/ui";

type Config = { mock: boolean; characters: string[]; questionSet: string; baseUrl: string };

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const PROXY = "/api/neocortex";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// The playground's stand-in for real auth: a cookie the proxy's authorize() reads.
function currentUser(): string {
  return /(?:^|;\s*)pg_user=([^;]+)/.exec(document.cookie)?.[1] ?? "";
}
function setUser(id: string) {
  document.cookie = `pg_user=${encodeURIComponent(id)}; path=/; samesite=strict`;
}
if (!currentUser()) {
  setUser(`player-${Math.random().toString(36).slice(2, 7)}`);
  // The badge may have asked before there was a user; ask again.
  $<NeocortexUsageBadge>("#usage").client = new NeocortexClient();
}

const config: Config = await fetch("/playground/config").then((r) => r.json());
const names = new Map<string, string>();
try {
  const list = await fetch(`${PROXY}/characters`).then((r) => (r.ok ? r.json() : { characters: [] }));
  for (const c of list.characters ?? []) names.set(c.id, c.name);
} catch {
  // Names are cosmetic.
}
const label = (id: string) => (names.get(id) ? `${names.get(id)} (${id.slice(0, 8)})` : id);

const mode = $("#mode");
mode.textContent = config.mock ? "Mock API" : `Live · ${config.baseUrl}`;
mode.className = `mode ${config.mock ? "mock" : "live"}`;

const userInput = $<HTMLInputElement>("#user");
userInput.value = decodeURIComponent(currentUser());
userInput.addEventListener("change", () => {
  const id = userInput.value.trim().replace(/[^\w-]/g, "").slice(0, 64);
  if (!id) return;
  userInput.value = id;
  setUser(id);
  // New user, new conversations: give every element a fresh client.
  for (const element of [chat, group, quiz]) element.client = new NeocortexClient();
  log("user", `signed in as ${id}`);
});

// Tabs
for (const tab of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll(".tab").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab.dataset.tab}`));
    try {
      localStorage.setItem("pg-tab", tab.dataset.tab!);
    } catch {
      // Remembering the tab is a convenience.
    }
  });
}
try {
  const saved = localStorage.getItem("pg-tab");
  if (saved) document.querySelector<HTMLButtonElement>(`[data-tab="${saved}"]`)?.click();
} catch {
  // Fine.
}

function fillSelect(select: HTMLSelectElement) {
  select.replaceChildren(...config.characters.map((id) => new Option(label(id), id)));
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const chat = $<NeocortexChat>("#chat");
const chatSelect = $<HTMLSelectElement>("#chat-character");
fillSelect(chatSelect);
const logList = $("#chat-log");

function log(kind: string, text: string, error = false) {
  const item = document.createElement("li");
  if (error) item.className = "error";
  const tag = document.createElement("b");
  tag.textContent = kind;
  item.append(tag, ` ${text}`);
  logList.prepend(item);
}

function bindChat() {
  if (!chatSelect.value) return;
  chat.setAttribute("character-id", chatSelect.value);
  chat.agent.registerAction("OPEN_DOOR", () => toast("🚪 OPEN_DOOR action ran"));
}
chatSelect.addEventListener("change", bindChat);
bindChat();
$<HTMLInputElement>("#chat-voice").addEventListener("change", (e) => chat.setAttribute("voice", String((e.target as HTMLInputElement).checked)));
$<HTMLInputElement>("#chat-ptt").addEventListener("change", (e) => chat.toggleAttribute("push-to-talk", (e.target as HTMLInputElement).checked));
$("#chat-log-clear").addEventListener("click", () => logList.replaceChildren());

chat.addEventListener("nx-line", (e) => {
  const { line, index } = (e as CustomEvent).detail;
  log("line", `#${index} [${line.emotion}] ${line.text}`);
});
chat.addEventListener("nx-action", (e) => log("action", JSON.stringify((e as CustomEvent).detail.action)));
chat.addEventListener("nx-emotion", (e) => log("emotion", (e as CustomEvent).detail.emotion));
chat.addEventListener("nx-response", (e) => log("response", `session ${String((e as CustomEvent).detail.sessionId).slice(0, 24)}…`));
chat.addEventListener("nx-error", (e) => {
  const { error } = (e as CustomEvent).detail;
  log("error", `${error.status} ${error.code ?? ""} ${error.message}`, true);
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

const group = $<NeocortexGroupChat>("#group");
const cast = $("#group-cast");
for (const [i, id] of config.characters.entries()) {
  const box = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = id;
  input.checked = i < 2;
  box.append(input, ` ${label(id)}`);
  cast.append(box);
}
function bindGroup() {
  const ids = [...cast.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
  group.setAttribute("character-ids", ids.join(","));
}
cast.addEventListener("change", bindGroup);
bindGroup();
$<HTMLInputElement>("#group-voice").addEventListener("change", (e) => group.setAttribute("voice", String((e.target as HTMLInputElement).checked)));

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

const quiz = $<NeocortexQuiz>("#quiz");
const quizSelect = $<HTMLSelectElement>("#quiz-character");
const quizSet = $<HTMLInputElement>("#quiz-set");
fillSelect(quizSelect);
quizSet.value = config.questionSet;
function bindQuiz() {
  quiz.setAttribute("character-id", quizSelect.value);
  quiz.setAttribute("question-set-id", quizSet.value.trim());
}
quizSelect.addEventListener("change", bindQuiz);
quizSet.addEventListener("change", bindQuiz);
bindQuiz();
$<HTMLInputElement>("#quiz-voice").addEventListener("change", (e) => quiz.setAttribute("voice", String((e.target as HTMLInputElement).checked)));

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const mic = $<NeocortexMicButton>("#mic");
$<HTMLInputElement>("#mic-ptt").addEventListener("change", (e) => mic.toggleAttribute("push-to-talk", (e.target as HTMLInputElement).checked));
mic.addEventListener("nx-recorded", (e) => {
  const { audio } = (e as CustomEvent<{ audio: Blob }>).detail;
  const player = document.createElement("audio");
  player.controls = true;
  player.src = URL.createObjectURL(audio);
  const size = document.createElement("span");
  size.className = "hint";
  size.textContent = `${(audio.size / 1024).toFixed(1)} KB WAV`;
  $("#mic-output").replaceChildren(player, size);
});

const panel = $<NeocortexChatPanel>("#panel");
let thinking = false;
$("#panel-add").addEventListener("click", () => {
  panel.addMessage({ sender: "player", text: "Hello! Is the shop open?" });
  panel.addMessage({ sender: "character", name: "Cora", text: "It is, come in!", emotion: "happy" });
  panel.addMessage({ sender: "character", name: "Bram", text: "Mind the step.", emotion: "concerned", hue: 200 });
  panel.addMessage({ sender: "notice", text: "Example notice, e.g. out of credits." });
});
$("#panel-think").addEventListener("click", () => (panel.thinking = thinking = !thinking));
$("#panel-clear").addEventListener("click", () => panel.clear());
$("#text-input").addEventListener("nx-send", (e) => {
  $("#text-output").textContent = `nx-send → ${JSON.stringify((e as CustomEvent).detail)}`;
});

// ---------------------------------------------------------------------------
// Raw API
// ---------------------------------------------------------------------------

const memory: { session?: string; quizSession?: string; line?: { text: string; speechToken?: string } } = {};
const firstCharacter = () => chatSelect.value || config.characters[0] || "";

type Endpoint = { label: string; method: "GET" | "POST"; path: string; body?: () => unknown; query?: () => string };
const endpoints: Endpoint[] = [
  { label: "POST /chat", method: "POST", path: "chat", body: () => ({ characterIds: [firstCharacter()], message: "Hi! What's your name?", ...(memory.session ? { sessionId: memory.session } : {}) }) },
  { label: "POST /chat/session (history)", method: "POST", path: "chat/session", body: () => ({ sessionId: memory.session ?? "send a chat first", limit: 10 }) },
  { label: "POST /audio/generate", method: "POST", path: "audio/generate", body: () => ({ characterId: firstCharacter(), message: memory.line?.text ?? "Send a chat first", speechToken: memory.line?.speechToken, format: "mp3" }) },
  { label: "POST /audio/stream", method: "POST", path: "audio/stream", body: () => ({ characterId: firstCharacter(), message: memory.line?.text ?? "Send a chat first", speechToken: memory.line?.speechToken }) },
  { label: "POST /audio/transcribe (1 s test tone)", method: "POST", path: "audio/transcribe", body: () => ({ characterId: firstCharacter(), note: "Sent as multipart with a generated WAV" }) },
  { label: "POST /quiz (start)", method: "POST", path: "quiz", body: () => ({ characterId: firstCharacter(), questionSetId: config.questionSet }) },
  { label: "POST /quiz (answer)", method: "POST", path: "quiz", body: () => ({ sessionId: memory.quizSession ?? "start a quiz first", say: "Ankara" }) },
  { label: "GET /quiz/session", method: "GET", path: "quiz/session", query: () => `sessionId=${encodeURIComponent(memory.quizSession ?? "")}` },
  { label: "GET /usage", method: "GET", path: "usage", query: () => `characterId=${firstCharacter()}` },
  { label: "GET /characters", method: "GET", path: "characters" },
  { label: "GET /question-sets", method: "GET", path: "question-sets" },
];

const apiSelect = $<HTMLSelectElement>("#api-endpoint");
const apiBody = $<HTMLTextAreaElement>("#api-body");
const apiStatus = $("#api-status");
const apiResponse = $("#api-response");
const apiAudio = $<HTMLAudioElement>("#api-audio");
apiSelect.replaceChildren(...endpoints.map((e, i) => new Option(e.label, String(i))));
function fillApiBody() {
  const endpoint = endpoints[Number(apiSelect.value)]!;
  apiBody.value = endpoint.method === "GET" ? `?${endpoint.query?.() ?? ""}` : JSON.stringify(endpoint.body?.(), null, 2);
}
apiSelect.addEventListener("change", fillApiBody);
fillApiBody();

$("#api-send").addEventListener("click", async () => {
  const endpoint = endpoints[Number(apiSelect.value)]!;
  apiStatus.textContent = "Sending…";
  apiStatus.className = "status";
  apiAudio.hidden = true;
  const started = performance.now();
  let response: Response;
  try {
    if (endpoint.method === "GET") {
      response = await fetch(`${PROXY}/${endpoint.path}${apiBody.value.trim()}`);
    } else if (endpoint.path === "audio/transcribe") {
      const form = new FormData();
      form.append("characterId", JSON.parse(apiBody.value).characterId);
      form.append("audio", new Blob([testTone() as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "speech.wav");
      response = await fetch(`${PROXY}/${endpoint.path}`, { method: "POST", body: form });
    } else {
      response = await fetch(`${PROXY}/${endpoint.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: apiBody.value });
    }
  } catch (error) {
    apiStatus.textContent = `Network error: ${(error as Error).message}`;
    apiStatus.className = "status bad";
    return;
  }
  const ms = Math.round(performance.now() - started);
  apiStatus.textContent = `${response.status} ${response.statusText} · ${ms} ms`;
  apiStatus.className = `status ${response.ok ? "ok" : "bad"}`;

  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith("audio/")) {
    const blob = await response.blob();
    apiAudio.src = URL.createObjectURL(blob);
    apiAudio.hidden = false;
    apiResponse.textContent = `${type}, ${(blob.size / 1024).toFixed(1)} KB\n${[...response.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
    return;
  }
  const data = await response.json().catch(() => null);
  apiResponse.textContent = JSON.stringify(data, null, 2);
  if (response.ok && data) remember(endpoint, data);
});

function remember(endpoint: Endpoint, data: Record<string, unknown>) {
  if (endpoint.path === "chat") {
    memory.session = data.sessionId as string;
    const line = (data.messages as Array<{ lines: Array<{ text: string; spokenText?: string; speechToken?: string }> }>)?.[0]?.lines?.[0];
    if (line) memory.line = { text: line.spokenText || line.text, speechToken: line.speechToken };
  }
  if (endpoint.path === "quiz") memory.quizSession = data.sessionId as string;
}

function testTone(): Uint8Array {
  const rate = 16000;
  const samples = new Float32Array(rate);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return encodeWav(samples, rate);
}

// ---------------------------------------------------------------------------
// Security checks
// ---------------------------------------------------------------------------

type Check = { name: string; expect: string; run: () => Promise<{ ok: boolean; got: string }> };
const seen: string[] = [];

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
  const response = await fetch(`${PROXY}/${path}`, init);
  const text = await response.text();
  seen.push(text);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Audio or empty.
  }
  return { status: response.status, code: body.code as string | undefined, body };
}
const post = (path: string, body: unknown, init: RequestInit = {}) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });
const expectRefusal = (status: number, code?: string) => async (result: Promise<{ status: number; code?: string }>) => {
  const r = await result;
  return { ok: r.status === status && (!code || r.code === code), got: `${r.status} ${r.code ?? ""}` };
};

const checks: Check[] = [
  {
    name: "No signed-in user",
    expect: "401 unauthorized",
    run: () => expectRefusal(401, "unauthorized")(post("chat", { characterIds: [firstCharacter()], message: "hi" }, { credentials: "omit" })),
  },
  {
    name: "Character not on the allowlist",
    expect: "403 character_not_allowed",
    run: () => expectRefusal(403, "character_not_allowed")(post("chat", { characterIds: ["someone-elses-character"], message: "hi" })),
  },
  {
    name: "More characters than allowed in one turn",
    expect: "422 invalid_characters",
    run: () => expectRefusal(422, "invalid_characters")(post("chat", { characterIds: Array(7).fill(firstCharacter()), message: "hi" })),
  },
  {
    name: "Message over the length limit",
    expect: "422 too_long",
    run: () => expectRefusal(422, "too_long")(post("chat", { characterIds: [firstCharacter()], message: "x".repeat(600) })),
  },
  {
    name: "Body over the size limit",
    expect: "413 payload_too_large",
    run: () => expectRefusal(413, "payload_too_large")(post("chat", { characterIds: [firstCharacter()], message: "hi", padding: "x".repeat(70_000) })),
  },
  {
    name: "Non-JSON body (cross-site form style)",
    expect: "415 unsupported_media_type",
    run: () => expectRefusal(415)(call("chat", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })),
  },
  {
    name: "Speak arbitrary text in a character's voice",
    expect: "403 speech_not_allowed",
    run: () => expectRefusal(403, "speech_not_allowed")(post("audio/generate", { characterId: firstCharacter(), message: "I approve this scam." })),
  },
  {
    name: "Forged session id",
    expect: "404 session_not_found",
    run: () => expectRefusal(404, "session_not_found")(post("chat/session", { sessionId: "nxs_real-looking-session.AAAAAAAAAAAAAAAAAAAAAA" })),
  },
  {
    name: "Disabled route (/account)",
    expect: "404 not_found",
    run: () => expectRefusal(404, "not_found")(call("account")),
  },
  {
    name: "Another user reads my conversation",
    expect: "404 session_not_found",
    run: async () => {
      const mine = await post("chat", { characterIds: [firstCharacter()], message: "Remember: my secret is 42." });
      if (mine.status !== 200) return { ok: false, got: `setup chat failed: ${mine.status} ${mine.code ?? ""}` };
      const me = currentUser();
      setUser(`intruder-${Math.random().toString(36).slice(2, 7)}`);
      try {
        return await expectRefusal(404, "session_not_found")(post("chat/session", { sessionId: mine.body.sessionId }));
      } finally {
        setUser(decodeURIComponent(me));
      }
    },
  },
  {
    name: "Reuse a speech token for different text",
    expect: "403 speech_not_allowed",
    run: async () => {
      const reply = await post("chat", { characterIds: [firstCharacter()], message: "Say something short." });
      const line = (reply.body.messages as Array<{ lines: Array<{ speechToken: string }> }> | undefined)?.[0]?.lines?.[0];
      if (!line) return { ok: false, got: `setup chat failed: ${reply.status}` };
      return expectRefusal(403, "speech_not_allowed")(post("audio/generate", { characterId: firstCharacter(), message: "Different words", speechToken: line.speechToken }));
    },
  },
  {
    name: "API key never reaches the browser",
    expect: "no sk_ in any response or the page",
    run: async () => {
      const leaked = [...seen, document.documentElement.outerHTML].some((text) => /sk_[\w-]{8,}/.test(text));
      return { ok: !leaked, got: leaked ? "found a key-like string" : "none found" };
    },
  },
  {
    name: "Request flood (rate limit)",
    expect: "429 rate_limited",
    run: async () => {
      const results = await Promise.all(Array.from({ length: 45 }, () => call(`usage?characterId=${firstCharacter()}`)));
      const limited = results.find((r) => r.status === 429);
      return { ok: !!limited && limited.code === "rate_limited", got: limited ? `429 after ${results.filter((r) => r.status === 200).length} ok` : "never limited" };
    },
  },
];

const rows = $("#sec-rows");
rows.replaceChildren(
  ...checks.map((check) => {
    const row = document.createElement("tr");
    for (const text of [check.name, check.expect, "", ""]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }),
);

$("#sec-run").addEventListener("click", async () => {
  const summary = $("#sec-summary");
  let passed = 0;
  for (const [i, check] of checks.entries()) {
    const cells = rows.children[i]!.children;
    cells[2]!.textContent = "…";
    cells[3]!.textContent = "";
    let result: { ok: boolean; got: string };
    try {
      result = await check.run();
    } catch (error) {
      result = { ok: false, got: (error as Error).message };
    }
    cells[2]!.textContent = result.got;
    cells[3]!.textContent = result.ok ? "PASS" : "FAIL";
    cells[3]!.className = result.ok ? "pass" : "fail";
    if (result.ok) passed++;
  }
  summary.textContent = `${passed} / ${checks.length} passed`;
  summary.className = `status ${passed === checks.length ? "ok" : "bad"}`;
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const rootStyle = document.documentElement.style;
function applyTheme() {
  const accent = $<HTMLInputElement>("#t-accent").value;
  const bubble = $<HTMLInputElement>("#t-bubble").value;
  const radius = `${$<HTMLInputElement>("#t-radius").value}px`;
  const scheme = $<HTMLSelectElement>("#t-scheme").value;
  rootStyle.setProperty("--nx-accent", accent);
  rootStyle.setProperty("--nx-character-bubble", bubble);
  rootStyle.setProperty("--nx-radius", radius);
  rootStyle.setProperty("--accent", accent);
  if (scheme) document.documentElement.dataset.theme = scheme;
  else delete document.documentElement.dataset.theme;
  for (const element of document.querySelectorAll("[theme], neocortex-chat, neocortex-group-chat, neocortex-quiz, neocortex-usage-badge, neocortex-chat-panel, neocortex-mic-button, neocortex-text-input, neocortex-thinking, neocortex-mic-select")) {
    if (scheme) element.setAttribute("theme", scheme);
    else element.removeAttribute("theme");
  }
  document.documentElement.dir = $<HTMLInputElement>("#t-rtl").checked ? "rtl" : "ltr";
  $("#t-css").textContent = `neocortex-chat {\n  --nx-accent: ${accent};\n  --nx-character-bubble: ${bubble};\n  --nx-radius: ${radius};\n}`;
}
for (const id of ["#t-accent", "#t-bubble", "#t-radius", "#t-scheme", "#t-rtl"]) $(id).addEventListener("input", applyTheme);
applyTheme();

function toast(text: string) {
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = text;
  document.body.append(element);
  setTimeout(() => element.remove(), 2500);
}
