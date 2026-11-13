import { z } from "zod";
import { config, structuredCall } from "./llm.js";
import { chairSystem, documentPrompt, resolutionPrompt, summaryPrompt } from "./prompts.js";
import * as mock from "./mock.js";

/** The neutral chair / Knesset secretariat: drafts the motion and writes the wrap-up. */
export async function draftResolution(topic: string, transcript: string, proposals: string[]): Promise<string> {
  if (config.mock) return mock.resolution(topic, proposals);
  const out = await structuredCall({
    model: config.mkModel,
    system: chairSystem(),
    user: resolutionPrompt(topic, transcript, proposals),
    schema: z.object({ resolution: z.string() }),
    effort: "low",
  });
  return out.resolution.trim();
}

const SummarySchema = z.object({
  summary: z.string(),
  highlights: z.array(z.object({ between: z.array(z.string()), event: z.string() })),
});

export async function summarize(
  topic: string,
  transcript: string,
  voteText: string,
  roster: string,
): Promise<z.infer<typeof SummarySchema>> {
  if (config.mock) return mock.summary();
  return structuredCall({
    model: config.mkModel,
    system: chairSystem(),
    user: summaryPrompt(topic, transcript, voteText, roster),
    schema: SummarySchema,
    effort: "low",
  });
}

const DocumentSchema = z.object({ title: z.string(), markdown: z.string() });

/** Chair's-task mode: the drafting committee turns the debate into the requested document. */
export async function draftDocument(p: {
  topic: string;
  task: string;
  transcript: string;
  contributions: string;
  seats: string;
}): Promise<z.infer<typeof DocumentSchema>> {
  if (config.mock) return mock.document(p.topic, p.task, p.contributions);
  return structuredCall({
    model: config.mkModel,
    system: chairSystem(),
    user: documentPrompt(p),
    schema: DocumentSchema,
    effort: "medium",
    maxTokens: 16000,
  });
}
