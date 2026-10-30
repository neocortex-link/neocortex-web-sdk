import { QuizAgent } from "../../client/QuizAgent";
import type { QuizLeaderboardEntry, QuizQuestion } from "../../core/types";
import { NeocortexElement } from "../base";
import type { NeocortexMicButton } from "./mic";
import type { NeocortexChatPanel } from "./primitives";

const QUIZ_CSS = /* css */ `
:host { display: flex; flex-direction: column; height: 36rem; max-height: 100%; min-width: 0;
  background: var(--_bg); border: 1px solid var(--_border); border-radius: var(--_radius); overflow: hidden; }
header { display: flex; align-items: center; gap: 0.75em; padding: 0.6em 0.8em; border-bottom: 1px solid var(--_border); }
header h2 { margin: 0; font-size: 1em; font-weight: 600; flex: 1; }
.progress { flex: 0 0 8rem; height: 6px; border-radius: 3px; background: var(--_surface); overflow: hidden; }
.progress span { display: block; height: 100%; width: 0; background: var(--_accent); transition: width 300ms ease; }
.count { font-size: 0.8em; color: var(--_muted); font-variant-numeric: tabular-nums; }
neocortex-chat-panel { flex: 1; min-height: 6rem; }
.question { margin: 0 0.8em; padding: 0.8em; border-radius: var(--_radius); background: var(--_surface); }
.question[hidden] { display: none; }
.question p { margin: 0 0 0.6em; font-weight: 600; line-height: 1.4; }
.options { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.5em; }
.options button { text-align: start; background: var(--_bg); }
.confirm { display: flex; gap: 0.5em; padding: 0.6em 0.8em 0; }
.confirm[hidden] { display: none; }
footer { display: flex; align-items: center; gap: 0.5em; padding: 0.6em 0.8em; flex-wrap: wrap; }
footer neocortex-text-input { flex: 1 1 12rem; min-width: 0; }
.start { margin: auto; }
.board { margin: 0 0.8em 0.6em; padding: 0; list-style: none; font-size: 0.9em; }
.board[hidden] { display: none; }
.board li { display: flex; gap: 0.6em; padding: 0.3em 0.2em; border-bottom: 1px solid var(--_border); }
.board li span:nth-child(2) { flex: 1; }
.board li span:last-child { font-variant-numeric: tabular-nums; font-weight: 600; }
:host(:not([state="playing"])) footer, :host(:not([state="playing"])) .question { display: none; }
:host([state="playing"]) .start { display: none; }
`;

/**
 * A complete quiz: the host reads questions aloud, the player answers by
 * clicking, typing or speaking, and a leaderboard keeps score (Team plan).
 *
 * ```html
 * <neocortex-quiz endpoint="/api/neocortex" character-id="..." question-set-id="..." voice></neocortex-quiz>
 * ```
 */
export class NeocortexQuiz extends NeocortexElement {
  static observedAttributes = ["character-id", "question-set-id", "voice", "heading", "question-count"];

  private _agent: QuizAgent | null = null;
  private offs: Array<() => void> = [];

  get agent(): QuizAgent {
    if (!this._agent) this.attachAgent();
    return this._agent!;
  }

  connectedCallback() {
    if (this.root.firstChild) return;
    this.render(
      QUIZ_CSS,
      `<header part="header">
        <h2 part="heading"></h2>
        <span class="count" part="count" aria-live="polite"></span>
        <div class="progress" part="progress" role="progressbar" aria-label="Quiz progress" aria-valuemin="0"><span></span></div>
      </header>
      <neocortex-chat-panel part="panel"></neocortex-chat-panel>
      <ol class="board" part="leaderboard" hidden aria-label="Leaderboard"></ol>
      <section class="question" part="question" hidden aria-live="polite">
        <p></p>
        <div class="options" part="options"></div>
      </section>
      <div class="confirm" part="confirm" hidden>
        <button type="button" class="primary" data-say="yes">Yes</button>
        <button type="button" data-say="no">No</button>
      </div>
      <button class="start primary" part="start" type="button">Start quiz</button>
      <footer part="footer">
        <neocortex-text-input part="input" placeholder="Your answer…"></neocortex-text-input>
        <neocortex-mic-button part="mic"></neocortex-mic-button>
        <button type="button" class="hint" part="hint">Hint</button>
        <button type="button" class="pass" part="pass">Pass</button>
      </footer>`,
    );
    this.$("h2").textContent = this.getAttribute("heading") ?? "Quiz";
    this.setAttribute("state", "idle");

    this.$(".start").addEventListener("click", () => {
      this.agent.primeAudio();
      this.$<NeocortexChatPanel>("neocortex-chat-panel").clear();
      this.setAttribute("state", "playing");
      void this.agent.begin();
    });
    this.$("neocortex-text-input").addEventListener("nc-send", (event) => {
      const { text } = (event as CustomEvent<{ text: string }>).detail;
      this.answer(text, true);
    });
    this.$("neocortex-mic-button").addEventListener("nc-recorded", async (event) => {
      const { audio } = (event as CustomEvent<{ audio: Blob }>).detail;
      const characterId = this.getAttribute("character-id") ?? "";
      try {
        const { response } = await this.agent.client.transcribe({ characterId, audio });
        if (response.trim()) this.answer(response.trim(), false);
      } catch (error) {
        this.notice((error as Error).message);
      }
    });
    this.$(".hint").addEventListener("click", () => this.answer("Can I have a hint?", true));
    this.$(".pass").addEventListener("click", () => {
      this.panel.addMessage({ sender: "player", text: "Pass" });
      void this.agent.pass();
    });
    this.$(".confirm").addEventListener("click", (event) => {
      const say = (event.target as HTMLElement).closest("button")?.dataset.say;
      if (say) this.answer(say === "yes" ? "Yes" : "No", true);
    });
    this.attachAgent();
  }

  disconnectedCallback() {
    this._agent?.abort();
    this.$<NeocortexMicButton>("neocortex-mic-button").stop();
  }

  attributeChangedCallback(name: string, previous: string | null, value: string | null) {
    if (!this.root.firstChild || previous === value) return;
    if (name === "voice" && this._agent) this._agent.voice = this.flag("voice");
    else if (name === "heading") this.$("h2").textContent = value ?? "Quiz";
    else this.resetAgent();
  }

  protected override clientChanged() {
    if (this.root.firstChild) this.resetAgent();
  }

  private get panel(): NeocortexChatPanel {
    return this.$<NeocortexChatPanel>("neocortex-chat-panel");
  }

  private answer(text: string, typed: boolean) {
    this.panel.addMessage({ sender: "player", text });
    this.agent.primeAudio();
    void this.agent.say(text, { typed });
  }

  private notice(text: string) {
    this.panel.addMessage({ sender: "notice", text });
  }

  private resetAgent() {
    this.offs.forEach((off) => off());
    this.offs = [];
    this._agent?.abort();
    this._agent = null;
    this.setAttribute("state", "idle");
    this.attachAgent();
  }

  private attachAgent() {
    const characterId = this.getAttribute("character-id");
    const questionSetId = this.getAttribute("question-set-id");
    if (!characterId || !questionSetId) return;

    const agent = new QuizAgent({
      client: this.client,
      characterId,
      questionSetId,
      voice: this.flag("voice"),
      questionCount: Number(this.getAttribute("question-count")) || undefined,
    });
    this._agent = agent;

    this.offs = [
      agent.on("busy", (busy) => (this.panel.thinking = busy)),
      agent.on("hostLine", ({ line }) => {
        this.panel.thinking = false;
        this.panel.addMessage({ sender: "character", text: line.text, emotion: line.emotion });
        this.fire("nc-line", { line });
      }),
      agent.on("questionChanged", (question) => this.showQuestion(question)),
      agent.on("expectingChanged", (expecting) => {
        this.$(".confirm").hidden = expecting !== "confirmation";
      }),
      agent.on("turn", (turn) => {
        if (turn.progress) this.showProgress(turn.progress.asked, turn.progress.total);
        this.$<HTMLButtonElement>(".hint").disabled = !turn.question?.hasHint && !this.agent.question?.hasHint;
        this.fire("nc-turn", turn);
      }),
      agent.on("leaderboardChanged", (board) => this.showLeaderboard(board)),
      agent.on("finished", (turn) => {
        this.setAttribute("state", "finished");
        this.$(".start").textContent = "Play again";
        this.$(".confirm").hidden = true;
        this.fire("nc-finished", turn);
      }),
      agent.on("error", (error) => {
        if (this.fire("nc-error", { error })) this.notice(error.message);
        if (!agent.sessionId) this.setAttribute("state", "idle");
      }),
    ];
  }

  private showQuestion(question: QuizQuestion | null) {
    const section = this.$(".question");
    section.hidden = !question;
    if (!question) return;
    this.$(".question p").textContent = question.questionText;
    const options = this.$(".options");
    options.replaceChildren(
      ...(question.options ?? []).map((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = option.text;
        button.addEventListener("click", () => {
          this.panel.addMessage({ sender: "player", text: option.text });
          this.agent.primeAudio();
          void this.agent.choose(option.id);
        });
        return button;
      }),
    );
  }

  private showProgress(asked: number, total: number) {
    const bar = this.$(".progress");
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(asked));
    this.$<HTMLElement>(".progress span").style.width = `${total ? (asked / total) * 100 : 0}%`;
    this.$(".count").textContent = total ? `${asked} / ${total}` : "";
  }

  private showLeaderboard(board: QuizLeaderboardEntry[]) {
    const list = this.$(".board");
    list.hidden = board.length < 2 && this.getAttribute("state") !== "finished";
    list.replaceChildren(
      ...board.map((entry) => {
        const item = document.createElement("li");
        for (const text of [`#${entry.rank}`, entry.displayName, String(entry.totalScore)]) {
          const span = document.createElement("span");
          span.textContent = text;
          item.append(span);
        }
        return item;
      }),
    );
  }
}
