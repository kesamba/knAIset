import fs from "node:fs";
import path from "node:path";
import type { MKProfile, Relationship } from "./types.js";

const ROOT = process.cwd();
const MKS_DIR = path.join(ROOT, "mks");
const DATA_DIR = path.join(ROOT, "data");
const DYNAMICS_FILE = path.join(DATA_DIR, "dynamics.json");

interface RosterFile {
  knesset: string;
  asOf: string;
  note: string;
  members: MKProfile[];
}

interface RelationshipsFile {
  pairs: Relationship[];
  blocDefaults: Record<string, string>;
}

/** A memorable moment between MKs, carried over from earlier debates. */
export interface DynamicsEvent {
  at: string;
  topic: string;
  between: string[];
  event: string;
}

export function loadRoster(): RosterFile {
  return JSON.parse(fs.readFileSync(path.join(MKS_DIR, "roster.json"), "utf8"));
}

export function loadPersona(id: string): string {
  return fs.readFileSync(path.join(MKS_DIR, `${id}.md`), "utf8");
}

export function loadResearchGuide(today: string): string {
  return fs
    .readFileSync(path.join(ROOT, "docs", "RESEARCH_GUIDE.md"), "utf8")
    .replaceAll("{{TODAY}}", today);
}

function loadRelationships(): RelationshipsFile {
  return JSON.parse(fs.readFileSync(path.join(MKS_DIR, "relationships.json"), "utf8"));
}

/** Relationship notes from `id`'s point of view, for every other member. */
export function relationshipBriefFor(id: string, members: MKProfile[]): string {
  const rel = loadRelationships();
  const byId = new Map(members.map((m) => [m.id, m]));
  const lines: string[] = [];
  for (const other of members) {
    if (other.id === id) continue;
    const pair = rel.pairs.find(
      (p) => (p.a === id && p.b === other.id) || (p.b === id && p.a === other.id),
    );
    const o = byId.get(other.id)!;
    if (pair) {
      const mine = pair.a === id ? pair.a_on_b : pair.b_on_a;
      const theirs = pair.a === id ? pair.b_on_a : pair.a_on_b;
      lines.push(
        `- **${o.name} (${o.party}, ${o.seats})**: מתח ${pair.tension}/10. ${pair.summary}\n  איך אתה מדבר עליו: ${mine}\n  איך הוא מדבר עליך: ${theirs}`,
      );
    } else {
      lines.push(`- **${o.name} (${o.party}, ${o.seats})**: אין הערות מיוחדות. התנהג לפי היחסים בין הגושים.`);
    }
  }
  return lines.join("\n");
}

export function loadDynamics(): DynamicsEvent[] {
  try {
    return JSON.parse(fs.readFileSync(DYNAMICS_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function appendDynamics(events: DynamicsEvent[]): void {
  if (!events.length) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const all = [...loadDynamics(), ...events].slice(-200);
  fs.writeFileSync(DYNAMICS_FILE, JSON.stringify(all, null, 2));
}

/** Memories from previous debates that involve `id` (most recent last). */
export function dynamicsBriefFor(id: string, members: MKProfile[]): string {
  const names = new Map(members.map((m) => [m.id, m.name]));
  const mine = loadDynamics()
    .filter((e) => e.between.includes(id))
    .slice(-12);
  if (!mine.length) return "(עדיין אין זיכרונות מדיונים קודמים בסימולציה)";
  return mine
    .map((e) => `- [${e.at.slice(0, 10)} · ${e.topic}] ${e.between.map((b) => names.get(b) ?? b).join(" ↔ ")}: ${e.event}`)
    .join("\n");
}
