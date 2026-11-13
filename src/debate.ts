import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import Anthropic from "@anthropic-ai/sdk";
import { MKAgent } from "./agent.js";
import { draftDocument, draftResolution, summarize } from "./chair.js";
import { config, pool } from "./llm.js";
import { formatTranscript } from "./prompts.js";
import { appendDynamics, loadRoster } from "./roster.js";
import type {
  Ballot,
  GameEvent,
  KnessetDocument,
  MKProfile,
  Phase,
  Reaction,
  SessionSnapshot,
  Speech,
  VoteChoice,
  VoteResult,
} from "./types.js";

const SESSIONS_DIR = path.join(process.cwd(), "data", "sessions");
const DOCS_DIR = path.join(process.cwd(), "data", "documents");
const MAX_HECKLES_PER_SPEECH = 2;

export interface DebateOptions {
  topic: string;
  maxTurns?: number;
  /** Subset of MK ids to seat (default: all party heads). */
  memberIds?: string[];
  /** Chair's demand: the session ends with a Markdown document that answers it. */
  task?: string;
  /** Fast mode: no web search while speaking; the UI skips straight to the result. */
  fast?: boolean;
}

export class Debate extends EventEmitter {
  readonly id: string;
  readonly topic: string;
  readonly createdAt = new Date().toISOString();
  readonly members: MKProfile[];
  readonly maxTurns: number;
  readonly task: string;
  readonly fast: boolean;
  private agents: Map<string, MKAgent>;

  phase: Phase = "research";
  speeches: Speech[] = [];
  reactions: Reaction[] = [];
  chairNotes: { afterIndex: number; text: string }[] = [];
  events: GameEvent[] = [];
  stickHolder: string | null = null;
  vote: VoteResult | null = null;
  document: KnessetDocument | null = null;

  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private pendingStick: string | null = null;
  private voteRequest: { resolution?: string; reason: string } | null = null;
  private cycleSpoken = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(opts: DebateOptions) {
    super();
    this.id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
    this.topic = opts.topic.trim();
    this.task = opts.task?.trim() ?? "";
    this.fast = !!opts.fast;
    const roster = loadRoster();
    this.members = roster.members.filter((m) => !opts.memberIds?.length || opts.memberIds.includes(m.id));
    this.maxTurns = opts.maxTurns ?? Math.max(12, this.members.length * 2);
    const note = `${roster.knesset}: ${roster.note}`;
    this.agents = new Map(this.members.map((m) => [m.id, new MKAgent(m, this.members, note)]));
    for (const a of this.agents.values()) a.setMembers(this.members.map((m) => m.id));
  }

  // ---------- events & persistence ----------

  private emitEvent(type: string, data: Record<string, unknown> = {}) {
    const ev: GameEvent = { t: new Date().toISOString(), type, ...data };
    this.events.push(ev);
    this.emit("event", ev);
    this.scheduleSave();
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      topic: this.topic,
      createdAt: this.createdAt,
      phase: this.phase,
      mock: config.mock,
      task: this.task,
      fast: this.fast,
      document: this.document,
      members: this.members,
      dossiers: Object.fromEntries(
        [...this.agents.values()].filter((a) => a.dossier).map((a) => [a.profile.id, a.dossier!]),
      ),
      speeches: this.speeches,
      reactions: this.reactions,
      stickHolder: this.stickHolder,
      vote: this.vote,
      events: this.events,
    };
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  save() {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SESSIONS_DIR, `${this.id}.json`), JSON.stringify(this.snapshot(), null, 2));
  }

  // ---------- user controls ----------

  pause() {
    this.paused = true;
    this.emitEvent("paused");
  }

  resume() {
    this.paused = false;
    this.resumeWaiters.splice(0).forEach((r) => r());
    this.emitEvent("resumed");
  }

  giveStick(mkId: string) {
    if (!this.agents.has(mkId)) return;
    this.pendingStick = mkId;
    this.emitEvent("stick_requested", { mkId });
  }

  chairNote(text: string) {
    const note = { afterIndex: this.speeches.length - 1, text: text.trim() };
    this.chairNotes.push(note);
    this.emitEvent("chair_note", note);
  }

  callVote(resolution?: string) {
    this.voteRequest = { resolution: resolution?.trim() || undefined, reason: "היו\"ר (המשתמש) קרא להצבעה" };
    this.emitEvent("vote_requested", { by: "chair" });
    if (this.paused) this.resume();
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((r) => this.resumeWaiters.push(r));
  }

  // ---------- main loop ----------

  async run() {
    this.emitEvent("session_started", {
      topic: this.topic,
      task: this.task,
      fast: this.fast,
      maxTurns: this.maxTurns,
      members: this.members.map((m) => m.id),
      mock: config.mock,
    });
    try {
      await this.researchPhase();
      await this.debatePhase();
      await this.votePhase();
      this.setPhase("done");
    } catch (err) {
      const msg =
        err instanceof Anthropic.AuthenticationError
          ? "אין מפתח API תקין. הגדירו ANTHROPIC_API_KEY או הריצו במצב דמו (MOCK=1)."
          : err instanceof Error
            ? err.message
            : String(err);
      this.setPhase("error");
      this.emitEvent("fatal", { message: msg });
    } finally {
      this.stickHolder = null;
      this.save();
    }
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.emitEvent("phase", { phase: p });
  }

  private async researchPhase() {
    this.setPhase("research");
    await pool([...this.agents.values()], config.concurrency, async (agent) => {
      const mkId = agent.profile.id;
      this.emitEvent("research_started", { mkId });
      try {
        const d = await agent.research(this.topic, this.task, (queries) => this.emitEvent("research_progress", { mkId, queries }));
        this.emitEvent("research_done", { mkId, dossier: d });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw err;
        agent.dossier = { mkId, notes: "(המחקר נכשל. אסתמך על הידע הבסיסי.)", sources: [], fromCache: false };
        this.emitEvent("agent_error", { mkId, stage: "research", message: String((err as Error).message ?? err) });
      }
    });
  }

  private transcript() {
    return formatTranscript(this.speeches, this.reactions, this.members, this.chairNotes);
  }

  private async debatePhase() {
    this.setPhase("debate");
    const names = Object.fromEntries(this.members.map((m) => [m.id, m.name]));
    while (!this.voteRequest && this.speeches.length < this.maxTurns) {
      await this.waitIfPaused();
      if (this.voteRequest) break;
      const { mkId, reason } = this.chooseNext();
      const agent = this.agents.get(mkId)!;
      this.stickHolder = mkId;
      this.emitEvent("stick_passed", { mkId, reason });

      let speech: Speech;
      try {
        const out = await agent.speak({
          topic: this.topic,
          transcript: this.transcript(),
          stickReason: reason,
          turnsLeft: this.maxTurns - this.speeches.length,
          previousSpeeches: this.speeches,
          names,
          task: this.task,
          allowSearch: !this.fast,
        });
        if (out.queries.length) this.emitEvent("speaker_searched", { mkId, queries: out.queries });
        const { queries: _q, ...rest } = out;
        speech = {
          ...rest,
          id: `s${this.speeches.length + 1}`,
          index: this.speeches.length,
          at: new Date().toISOString(),
          stickReason: reason,
        };
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw err;
        this.emitEvent("agent_error", { mkId, stage: "speak", message: String((err as Error).message ?? err) });
        this.cycleSpoken.add(mkId);
        continue;
      }
      this.speeches.push(speech);
      this.cycleSpoken.add(mkId);
      this.emitEvent("speech", { speech });

      await this.listenPhase(speech);
      this.checkAutoVote();
    }
    if (!this.voteRequest) this.voteRequest = { reason: "נגמר הזמן שהוקצב לדיון" };
    this.stickHolder = null;
  }

  /** Everyone who isn't holding the stick hears the speech and reacts privately. */
  private async listenPhase(speech: Speech) {
    if (!config.reactions) return;
    const speaker = this.members.find((m) => m.id === speech.mkId)!;
    const recent = formatTranscript(this.speeches.slice(-4, -1), this.reactions, this.members, []);
    const listeners = [...this.agents.values()].filter((a) => a.profile.id !== speech.mkId);
    const results = await pool(listeners, 6, async (a) => {
      try {
        return await a.react(this.topic, recent, speaker, speech);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw err;
        return null;
      }
    });
    const reactions = results.filter((r): r is Reaction => !!r);
    // Only the loudest few heckles make it into the protocol, as in a real plenum.
    const loud = reactions
      .filter((r) => r.heckle)
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, MAX_HECKLES_PER_SPEECH);
    for (const r of reactions) if (!loud.includes(r)) r.heckle = "";
    for (const r of reactions) {
      this.reactions.push(r);
      this.emitEvent("reaction", { reaction: r });
    }
  }

  private chooseNext(): { mkId: string; reason: string } {
    if (this.pendingStick) {
      const id = this.pendingStick;
      this.pendingStick = null;
      return { mkId: id, reason: "היו\"ר העביר אליך את המקל" };
    }
    if (this.cycleSpoken.size >= this.members.length) this.cycleSpoken.clear();
    const last = this.speeches.at(-1);
    if (!last) {
      const first = [...this.members].sort((a, b) => b.seats - a.seats)[0];
      return { mkId: first.id, reason: "אתה פותח את הדיון, כי סיעתך הגדולה ביותר" };
    }
    const recentSpeakers = this.speeches.slice(-3).map((s) => s.mkId);
    const lastReactions = this.reactions.filter((r) => r.speechId === last.id);
    let best = { mkId: "", score: -Infinity, reason: "" };
    for (const m of this.members) {
      if (m.id === last.mkId) continue;
      const r = lastReactions.find((x) => x.mkId === m.id);
      // Fairness first (who hasn't spoken this round), then raised hands and direct replies,
      // with a penalty so two rivals can't ping-pong the stick forever.
      const fresh = this.cycleSpoken.has(m.id) ? 0 : 6;
      const hand = r?.wantsFloor ? r.urgency * 0.8 : 0;
      const addressed = last.addressedTo.includes(m.id) ? 3 : 0;
      const recentPenalty = recentSpeakers.filter((x) => x === m.id).length * 5;
      const score = fresh + hand + addressed - recentPenalty + Math.random() * 2;
      if (score > best.score) {
        const lastName = this.members.find((x) => x.id === last.mkId)!.name;
        const reason =
          addressed && hand
            ? `${lastName} פנה אליך ישירות, והרמת יד (דחיפות ${r!.urgency})`
            : addressed
              ? `${lastName} פנה אליך ישירות`
              : hand >= 6
                ? `הרמת יד בדחיפות ${r!.urgency}`
                : "תורך בסבב";
        best = { mkId: m.id, score, reason };
      }
    }
    return { mkId: best.mkId, reason: best.reason };
  }

  private checkAutoVote() {
    const n = this.members.length;
    if (this.speeches.length < n) return;
    const window = this.speeches.slice(-n);
    const ready = window.filter((s) => s.readyToVote).length;
    if (ready / window.length >= 0.6) {
      this.voteRequest = { reason: `${ready} מתוך ${window.length} הדוברים האחרונים ביקשו לעבור להצבעה` };
      this.emitEvent("vote_requested", { by: "members", ready, of: window.length });
    }
  }

  /** Chair's-task mode: the drafting committee writes the requested document from the debate. */
  private async draftPhase(transcript: string): Promise<{ title: string; body: string } | null> {
    this.setPhase("drafting");
    this.emitEvent("document_drafting", { task: this.task });
    const contributions = this.speeches
      .filter((s) => s.docContribution)
      .map((s) => `- ${this.members.find((m) => m.id === s.mkId)!.name} (${this.members.find((m) => m.id === s.mkId)!.party}): ${s.docContribution}`)
      .join("\n");
    try {
      const d = await draftDocument({
        topic: this.topic,
        task: this.task,
        transcript,
        contributions,
        seats: this.members.map((m) => `${m.party} ${m.seats}`).join(", "),
      });
      const draft = { title: d.title.trim(), body: d.markdown.trim() };
      this.emitEvent("document_drafted", draft);
      return draft;
    } catch (err) {
      this.emitEvent("agent_error", { mkId: "chair", stage: "document", message: String((err as Error).message ?? err) });
      return null;
    }
  }

  private async votePhase() {
    const transcript = this.transcript();
    const draft = this.task ? await this.draftPhase(transcript) : null;
    this.setPhase("voting");
    const proposals = this.speeches.map((s) => s.proposedResolution).filter(Boolean);
    let resolution = this.voteRequest?.resolution;
    if (!resolution && draft) resolution = `הכנסת מאמצת את המסמך "${draft.title}" כמענה למטלת היו"ר.`;
    if (!resolution) {
      try {
        resolution = await draftResolution(this.topic, transcript, proposals);
      } catch (err) {
        // Don't lose the whole session over the motion text: fall back to a member's proposal or a generic one.
        this.emitEvent("agent_error", { mkId: "chair", stage: "resolution", message: String((err as Error).message ?? err) });
        resolution = proposals.at(-1) ?? `הכנסת מחליטה לאמץ את ההצעה שעל סדר היום בנושא "${this.topic}".`;
      }
    }
    this.emitEvent("vote_called", { resolution, reason: this.voteRequest?.reason ?? "" });

    const ballots: Ballot[] = [];
    await pool([...this.agents.values()], config.concurrency, async (agent) => {
      let b: Ballot;
      try {
        b = await agent.vote(this.topic, transcript, resolution, draft?.body);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw err;
        b = { mkId: agent.profile.id, vote: "abstain", explanation: "(לא הצביע: תקלה טכנית)" };
      }
      ballots.push(b);
      this.emitEvent("vote_cast", { ballot: b });
    });

    const order = this.members.map((m) => m.id);
    ballots.sort((a, b) => order.indexOf(a.mkId) - order.indexOf(b.mkId));
    const zero = (): Record<VoteChoice, number> => ({ for: 0, against: 0, abstain: 0 });
    const byHeads = zero();
    const bySeats = zero();
    for (const b of ballots) {
      byHeads[b.vote]++;
      bySeats[b.vote] += this.members.find((m) => m.id === b.mkId)!.seats;
    }
    const passed = bySeats.for > bySeats.against;
    const voteText = ballots
      .map((b) => `${this.members.find((m) => m.id === b.mkId)!.name}: ${b.vote}. ${b.explanation}`)
      .join("\n");
    this.vote = { resolution, ballots, byHeads, bySeats, passed, summary: "" };
    this.emitEvent("vote_result", { vote: this.vote });

    try {
      const roster = this.members.map((m) => `${m.id}=${m.name}`).join(", ");
      const s = await summarize(this.topic, transcript, `${voteText}\nבעד ${bySeats.for}, נגד ${bySeats.against}, נמנעים ${bySeats.abstain} (במנדטים)`, roster);
      this.vote.summary = s.summary;
      const ids = new Set(this.members.map((m) => m.id));
      appendDynamics(
        s.highlights
          .map((h) => ({ at: this.createdAt, topic: this.topic, between: h.between.filter((x) => ids.has(x)), event: h.event }))
          .filter((h) => h.between.length >= 1),
      );
      this.emitEvent("summary", { summary: s.summary, highlights: s.highlights });
    } catch (err) {
      this.emitEvent("agent_error", { mkId: "chair", stage: "summary", message: String((err as Error).message ?? err) });
    }

    if (draft) {
      this.document = { ...draft, markdown: this.documentMarkdown(draft) };
      fs.mkdirSync(DOCS_DIR, { recursive: true });
      fs.writeFileSync(path.join(DOCS_DIR, `${this.id}.md`), this.document.markdown);
      this.emitEvent("document_ready", { document: this.document });
    }
  }

  /** The downloadable file: the drafted body plus the plenum's record of how it got there. */
  private documentMarkdown(draft: { title: string; body: string }): string {
    const v = this.vote!;
    const mk = (id: string) => this.members.find((m) => m.id === id)!;
    const VOTE = { for: "בעד", against: "נגד", abstain: "נמנע" } as const;
    const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const contributions = this.speeches.filter((s) => s.docContribution);
    return [
      `# ${draft.title}`,
      "",
      `> מסמך שהופק בסימולציה של מליאת הכנסת (כנסת AI). הוא נכתב על ידי סוכני AI, ואין לייחס אותו לאנשים האמיתיים.`,
      "",
      `- **מטלת היו"ר:** ${this.task}`,
      `- **נושא הדיון:** ${this.topic}`,
      `- **תאריך:** ${this.createdAt.slice(0, 10)} · ${this.speeches.length} נאומים · ישיבה \`${this.id}\``,
      `- **סטטוס:** ${v.passed ? "✅ אומץ על ידי המליאה" : "❌ לא אומץ על ידי המליאה"} (בעד ${v.bySeats.for} · נגד ${v.bySeats.against} · נמנעים ${v.bySeats.abstain} מנדטים)`,
      "",
      "---",
      "",
      draft.body,
      "",
      "---",
      "",
      "## נספח א': ההצבעה במליאה",
      "",
      `**ההצעה:** ${v.resolution}`,
      "",
      "| ח\"כ | סיעה | מנדטים | הצבעה | הסבר |",
      "|---|---|---|---|---|",
      ...v.ballots.map((b) => `| ${mk(b.mkId).name} | ${mk(b.mkId).party} | ${mk(b.mkId).seats} | ${VOTE[b.vote]} | ${cell(b.explanation)} |`),
      "",
      `**לפי מנדטים:** בעד ${v.bySeats.for}, נגד ${v.bySeats.against}, נמנעים ${v.bySeats.abstain}. **לפי ראשי מפלגות:** ${v.byHeads.for}–${v.byHeads.against}–${v.byHeads.abstain}.`,
      ...(v.summary ? ["", "## נספח ב': איך התנהל הדיון", "", v.summary] : []),
      ...(contributions.length
        ? ["", "## נספח ג': ההצעות שחברי הכנסת ביקשו להכניס", "", ...contributions.map((s) => `- **${mk(s.mkId).name}** (נאום #${s.index + 1}): ${s.docContribution}`)]
        : []),
      "",
    ].join("\n");
  }
}

export function listSavedSessions(): {
  id: string;
  topic: string;
  createdAt: string;
  phase: Phase;
  passed?: boolean;
  fast?: boolean;
  hasDocument?: boolean;
}[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8")) as SessionSnapshot;
      return { id: s.id, topic: s.topic, createdAt: s.createdAt, phase: s.phase, passed: s.vote?.passed, fast: !!s.fast, hasDocument: !!s.document };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function loadSavedSession(id: string): SessionSnapshot | null {
  const file = path.join(SESSIONS_DIR, `${path.basename(id)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
