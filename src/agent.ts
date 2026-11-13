import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Ballot, Dossier, MKProfile, Reaction, Source, Speech, Stance, Tone } from "./types.js";
import {
  agentCall,
  config,
  searchQueriesOf,
  sourcesOf,
  structuredCall,
  textOf,
  webFetchTool,
  webSearchTool,
} from "./llm.js";
import { mkSystemPrompt, reactionPrompt, researchPrompt, speakPrompt, votePrompt, TODAY } from "./prompts.js";
import { dynamicsBriefFor, loadPersona, loadResearchGuide, relationshipBriefFor } from "./roster.js";
import * as mock from "./mock.js";
import { cliCall } from "./cli.js";

const CACHE_DIR = path.join(process.cwd(), "data", "research-cache");

const TONES = ["calm", "passionate", "angry", "sarcastic", "conciliatory", "humorous", "solemn"] as const;
const STANCES = ["for", "against", "mixed", "undecided"] as const;

/** The client-side tool an MK calls to deliver its speech (the "microphone"). */
function speakTool(memberIds: string[]): Anthropic.Beta.Messages.BetaTool {
  return {
    name: "speak",
    description:
      "נשא את הנאום שלך במליאה. קוראים לכלי פעם אחת, בסוף התור, אחרי שסיימת לחשוב ולחפש.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["speech", "addressed_to", "tone", "stance", "inner_thought", "ready_to_vote", "proposed_resolution", "doc_contribution"],
      properties: {
        speech: { type: "string", description: "הנאום עצמו, בעברית ובגוף ראשון, 50–170 מילים." },
        addressed_to: {
          type: "array",
          items: { type: "string", enum: memberIds },
          description: "מזהי חברי הכנסת שאתה פונה אליהם או תוקף אותם ישירות (יכול להיות ריק).",
        },
        tone: { type: "string", enum: [...TONES] },
        stance: { type: "string", enum: [...STANCES], description: "העמדה שלך כרגע ביחס להצעה שעל הפרק." },
        inner_thought: {
          type: "string",
          description: "מה אתה חושב באמת ולא אומר בקול. אסטרטגיה, כעס, חישוב קואליציוני. משפט או שניים.",
        },
        ready_to_vote: { type: "boolean", description: "האם לדעתך הדיון מוצה ואפשר להצביע." },
        proposed_resolution: {
          type: "string",
          description: "אם אתה רוצה להציע נוסח החלטה להצבעה, כתוב אותו כאן ('הכנסת מחליטה…'). אחרת, מחרוזת ריקה.",
        },
        doc_contribution: {
          type: "string",
          description: "רק כשיש מטלת יו\"ר: מה בדיוק אתה רוצה שייכנס למסמך (סעיף, צעד, מספר או הסתייגות). אחרת, מחרוזת ריקה.",
        },
      },
    },
  };
}

interface SpeakInput {
  speech: string;
  addressed_to: string[];
  tone: Tone;
  stance: Stance;
  inner_thought: string;
  ready_to_vote: boolean;
  proposed_resolution: string;
  doc_contribution?: string;
}

const CLI_RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dossier", "sources", "queries"],
  properties: {
    dossier: { type: "string" },
    sources: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "url"], properties: { title: { type: "string" }, url: { type: "string" } } },
    },
    queries: { type: "array", items: { type: "string" } },
  },
};

const ReactionSchema = z.object({
  thought: z.string(),
  emoji: z.string(),
  wants_floor: z.boolean(),
  urgency: z.number().int(),
  heckle: z.string(),
});

const BallotSchema = z.object({
  vote: z.enum(["for", "against", "abstain"]),
  explanation: z.string(),
});

export interface SpeakContext {
  topic: string;
  transcript: string;
  stickReason: string;
  turnsLeft: number;
  previousSpeeches: Speech[];
  names: Record<string, string>;
  /** The chair's demand, if this session must produce a document. */
  task: string;
  /** Fast mode turns off web search while speaking (research is already done). */
  allowSearch: boolean;
}

export class MKAgent {
  readonly profile: MKProfile;
  private system: string;
  private reactionSystem: string;
  dossier: Dossier | null = null;
  /** Private notes: what this MK thought while listening, and what it really meant when speaking. */
  privateLog: string[] = [];

  constructor(profile: MKProfile, members: MKProfile[], knessetNote: string) {
    this.profile = profile;
    const persona = loadPersona(profile.id);
    const relationships = relationshipBriefFor(profile.id, members);
    const dynamics = dynamicsBriefFor(profile.id, members);
    this.system = mkSystemPrompt({
      mk: profile,
      persona,
      relationships,
      dynamics,
      guide: loadResearchGuide(TODAY),
      knessetNote,
    });
    // Listening reactions don't need the research guide; keep that prompt lean.
    this.reactionSystem = mkSystemPrompt({ mk: profile, persona, relationships, dynamics, guide: "(לא רלוונטי בהקשבה)", knessetNote });
  }

  private cacheFile(topic: string, task: string) {
    const h = crypto.createHash("sha1").update(`${TODAY}|${topic}${task ? `|${task}` : ""}`).digest("hex").slice(0, 12);
    return path.join(CACHE_DIR, `${this.profile.id}-${h}.json`);
  }

  /** Research phase: the agent searches the web for itself and builds a dossier. */
  async research(topic: string, task: string, onProgress: (queries: string[]) => void): Promise<Dossier> {
    const file = this.cacheFile(topic, task);
    if (!config.mock && fs.existsSync(file)) {
      this.dossier = { ...JSON.parse(fs.readFileSync(file, "utf8")), fromCache: true };
      return this.dossier!;
    }
    if (config.mock) {
      this.dossier = await mock.research(this.profile, topic, onProgress);
      return this.dossier;
    }
    if (config.backend === "cli") {
      const r = await cliCall<{ dossier: string; sources: Source[]; queries: string[] }>({
        model: config.mkModel,
        system: this.system,
        user: `${researchPrompt(this.profile, topic, task)}\n\nהחזר JSON: dossier הוא תיק המודיעין, sources הם המקורות שבאמת קראת (title, url), ו-queries הן השאילתות שהרצת.`,
        schema: CLI_RESEARCH_SCHEMA,
        web: true,
        effort: config.researchEffort,
      });
      onProgress((r.queries ?? []).map((q) => `🔎 ${q}`));
      this.dossier = { mkId: this.profile.id, notes: r.dossier.trim(), sources: (r.sources ?? []).slice(0, 12), fromCache: false };
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.dossier, null, 2));
      return this.dossier;
    }
    const { blocks } = await agentCall({
      model: config.mkModel,
      system: this.system,
      user: researchPrompt(this.profile, topic, task),
      tools: [webSearchTool(6), webFetchTool(3)],
      effort: config.researchEffort,
    });
    onProgress(searchQueriesOf(blocks));
    const notes = textOf(blocks) || "(המחקר לא החזיר תוצאות. אסתמך על הידע הבסיסי שלי.)";
    this.dossier = { mkId: this.profile.id, notes, sources: sourcesOf(blocks).slice(0, 12), fromCache: false };
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.dossier, null, 2));
    return this.dossier;
  }

  /** Holding the stick: compose a speech that responds to the room. */
  async speak(ctx: SpeakContext): Promise<Omit<Speech, "id" | "index" | "at" | "stickReason"> & { queries: string[] }> {
    if (config.mock) return mock.speak(this.profile, ctx);
    const prompt = speakPrompt({
      topic: ctx.topic,
      dossier: this.dossier?.notes ?? "(אין)",
      privateLog: this.privateLog.slice(-10).join("\n"),
      transcript: ctx.transcript,
      stickReason: ctx.stickReason,
      turnsLeft: ctx.turnsLeft,
      task: ctx.task,
      allowSearch: ctx.allowSearch,
    });
    if (config.backend === "cli") {
      const tool = speakTool(this.otherIds);
      const schema = {
        ...tool.input_schema,
        required: [...(tool.input_schema.required ?? []), "sources", "queries"],
        properties: {
          ...(tool.input_schema.properties as Record<string, unknown>),
          sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "url"], properties: { title: { type: "string" }, url: { type: "string" } } } },
          queries: { type: "array", items: { type: "string" } },
        },
      };
      const out = await cliCall<SpeakInput & { sources: Source[]; queries: string[] }>({
        model: config.mkModel,
        system: this.system,
        user: `${prompt}\n\n(במקום לקרוא לכלי speak, החזר את אותם שדות כ-JSON. ב-sources שים מקורות שבדקת עכשיו, וב-queries את החיפושים שהרצת. אם לא חיפשת, השאר רשימות ריקות.)`,
        schema,
        web: ctx.allowSearch,
        effort: config.speechEffort,
      });
      return this.toSpeech(out, out.sources ?? [], (out.queries ?? []).map((q) => `🔎 ${q}`));
    }
    const { blocks } = await agentCall({
      model: config.mkModel,
      system: this.system,
      user: prompt,
      tools: ctx.allowSearch ? [webSearchTool(2), speakTool(this.otherIds)] : [speakTool(this.otherIds)],
      effort: config.speechEffort,
    });
    const call = blocks.find(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use" && b.name === "speak",
    );
    let out: SpeakInput;
    if (call) {
      out = call.input as SpeakInput;
    } else {
      // The model answered in plain text instead of calling the tool: use the text as the speech.
      out = {
        speech: textOf(blocks) || "(שותק ומביט באולם)",
        addressed_to: [],
        tone: "calm",
        stance: "undecided",
        inner_thought: "",
        ready_to_vote: false,
        proposed_resolution: "",
        doc_contribution: "",
      };
    }
    return this.toSpeech(out, sourcesOf(blocks), searchQueriesOf(blocks));
  }

  private toSpeech(out: SpeakInput, sources: Source[], queries: string[]) {
    if (out.inner_thought) this.privateLog.push(`(כשדיברתי) ${out.inner_thought}`);
    return {
      mkId: this.profile.id,
      text: out.speech.trim(),
      addressedTo: (out.addressed_to ?? []).filter((id) => id !== this.profile.id),
      tone: out.tone,
      stance: out.stance,
      innerThought: out.inner_thought,
      readyToVote: !!out.ready_to_vote,
      proposedResolution: out.proposed_resolution?.trim() ?? "",
      docContribution: out.doc_contribution?.trim() ?? "",
      sources: sources.slice(0, 6),
      queries,
    };
  }

  private otherIds: string[] = [];
  setMembers(ids: string[]) {
    this.otherIds = ids.filter((id) => id !== this.profile.id);
  }

  /** Not holding the stick: listen, think privately, maybe heckle. */
  async react(topic: string, recent: string, speaker: MKProfile, speech: Speech): Promise<Reaction> {
    const r = config.mock
      ? await mock.react(this.profile, speaker, speech)
      : await structuredCall({
          model: config.reactionModel,
          system: this.reactionSystem,
          user: reactionPrompt({
            topic,
            recent,
            speakerName: speaker.name,
            speechText: speech.text,
            privateLog: this.privateLog.slice(-6).join("\n"),
          }),
          schema: ReactionSchema,
          effort: "low",
          maxTokens: 4000,
        });
    const urgency = Math.max(0, Math.min(10, Math.round(r.urgency)));
    this.privateLog.push(`(על ${speaker.name}) ${r.thought}`);
    return {
      mkId: this.profile.id,
      speechId: speech.id,
      thought: r.thought,
      emoji: r.emoji,
      wantsFloor: r.wants_floor,
      urgency,
      heckle: r.heckle?.trim() ?? "",
    };
  }

  async vote(topic: string, transcript: string, resolution: string, document?: string): Promise<Ballot> {
    if (config.mock) return mock.vote(this.profile, resolution);
    const b = await structuredCall({
      model: config.mkModel,
      system: this.system,
      user: votePrompt({
        topic,
        transcript,
        resolution,
        dossier: this.dossier?.notes ?? "(אין)",
        privateLog: this.privateLog.slice(-12).join("\n"),
        document,
      }),
      schema: BallotSchema,
      effort: "low",
    });
    return { mkId: this.profile.id, vote: b.vote, explanation: b.explanation };
  }
}
