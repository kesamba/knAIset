import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { Source } from "./types.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const config = {
  /** Model for MK agents (research, speeches, votes) and the chair. */
  mkModel: process.env.MK_MODEL ?? "claude-opus-5-5",
  /** Cheaper model for the many "listening" reactions after every speech. */
  reactionModel: process.env.REACTION_MODEL ?? "claude-haiku-5-5",
  speechEffort: (process.env.SPEECH_EFFORT ?? "medium") as Effort,
  researchEffort: (process.env.RESEARCH_EFFORT ?? "medium") as Effort,
  mock: process.env.MOCK === "1",
  reactions: process.env.REACTIONS !== "off",
  /** How many MK calls may run against the API at the same time. */
  concurrency: Number(process.env.CONCURRENCY ?? 4),
};

let _client: Anthropic | null = null;
export function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

/** Models that accept the server-side refusal fallback parameter. */
function fallbackParams(model: string) {
  const supported = ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-2", "claude-fable-5-1", "claude-sonnet-5-5"];
  return supported.includes(model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
}

export class RefusalError extends Error {}

function assertNotRefused(msg: BetaMessage) {
  if (msg.stop_reason === "refusal") {
    throw new RefusalError(`המודל סירב לבקשה (${msg.stop_details?.category ?? "ללא קטגוריה"})`);
  }
}

export const webSearchTool = (maxUses: number): BetaToolUnion => ({
  type: "web_search_20260209",
  name: "web_search",
  max_uses: maxUses,
});

export const webFetchTool = (maxUses: number): BetaToolUnion => ({
  type: "web_fetch_20260209",
  name: "web_fetch",
  max_uses: maxUses,
});

export interface AgentCallResult {
  /** Every content block the model produced across continuations, in order. */
  blocks: BetaContentBlock[];
  final: BetaMessage;
}

/**
 * One agent turn with server tools (web search / fetch) and optional client tools.
 * Resumes `pause_turn` until the model ends its turn or calls a client tool.
 */
export async function agentCall(opts: {
  model: string;
  system: string;
  user: string;
  tools: BetaToolUnion[];
  effort: Effort;
  maxTokens?: number;
  stopOnTool?: string;
}): Promise<AgentCallResult> {
  const messages: BetaMessageParam[] = [{ role: "user", content: opts.user }];
  const blocks: BetaContentBlock[] = [];
  for (let i = 0; i < 6; i++) {
    const stream = client().beta.messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 32000,
      // Persona + guide are identical on every call for this MK, so cache them.
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages,
      tools: opts.tools,
      output_config: { effort: opts.effort },
      ...fallbackParams(opts.model),
    });
    const msg = await stream.finalMessage();
    assertNotRefused(msg);
    blocks.push(...msg.content);
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    return { blocks, final: msg };
  }
  throw new Error("agentCall: too many continuations");
}

/** A single structured-output call (no tools). */
export async function structuredCall<S extends z.ZodType>(opts: {
  model: string;
  system: string;
  user: string;
  schema: S;
  effort: Effort;
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const msg = await client().beta.messages.parse({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8000,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.user }],
    output_config: { effort: opts.effort, format: betaZodOutputFormat(opts.schema) },
    ...fallbackParams(opts.model),
  });
  assertNotRefused(msg as BetaMessage);
  if (msg.parsed_output == null) throw new Error("structuredCall: output did not parse");
  return msg.parsed_output as z.infer<S>;
}

export function textOf(blocks: BetaContentBlock[]): string {
  return blocks
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Collect the URLs the agent actually looked at (search results + fetched pages). */
export function sourcesOf(blocks: BetaContentBlock[]): Source[] {
  const out = new Map<string, Source>();
  for (const b of blocks) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        if (r.type === "web_search_result") out.set(r.url, { title: r.title, url: r.url });
      }
    } else if (b.type === "web_fetch_tool_result" && b.content.type === "web_fetch_result") {
      const url = b.content.url;
      out.set(url, { title: b.content.content?.title ?? url, url });
    }
  }
  return [...out.values()];
}

/** Count of searches/fetches the agent ran (for the UI). */
export function searchQueriesOf(blocks: BetaContentBlock[]): string[] {
  const q: string[] = [];
  for (const b of blocks) {
    if (b.type === "server_tool_use") {
      const input = b.input as { query?: string; url?: string };
      if (input.query) q.push(`🔎 ${input.query}`);
      else if (input.url) q.push(`📄 ${input.url}`);
    }
  }
  return q;
}

/** Tiny promise pool so 11 agents don't all hit the API at once. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
