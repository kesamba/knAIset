export type Bloc = "right" | "center" | "center-right" | "left" | "arab" | "haredi";

export interface MKProfile {
  id: string;
  name: string;
  nameEn: string;
  party: string;
  partyEn: string;
  seats: number;
  bloc: Bloc;
  color: string;
  emoji: string;
}

export interface Relationship {
  a: string;
  b: string;
  tension: number;
  summary: string;
  a_on_b: string;
  b_on_a: string;
}

export type Tone =
  | "calm"
  | "passionate"
  | "angry"
  | "sarcastic"
  | "conciliatory"
  | "humorous"
  | "solemn";

export type Stance = "for" | "against" | "mixed" | "undecided";

export interface Source {
  title: string;
  url: string;
}

export interface Speech {
  id: string;
  index: number;
  mkId: string;
  text: string;
  addressedTo: string[];
  tone: Tone;
  stance: Stance;
  innerThought: string;
  readyToVote: boolean;
  proposedResolution: string;
  sources: Source[];
  at: string;
  /** Who handed over the stick and why */
  stickReason: string;
}

export interface Reaction {
  mkId: string;
  speechId: string;
  thought: string;
  emoji: string;
  wantsFloor: boolean;
  urgency: number;
  heckle: string;
}

export type VoteChoice = "for" | "against" | "abstain";

export interface Ballot {
  mkId: string;
  vote: VoteChoice;
  explanation: string;
}

export interface VoteResult {
  resolution: string;
  ballots: Ballot[];
  byHeads: Record<VoteChoice, number>;
  bySeats: Record<VoteChoice, number>;
  passed: boolean;
  summary: string;
}

export interface Dossier {
  mkId: string;
  notes: string;
  sources: Source[];
  fromCache: boolean;
}

export type Phase = "research" | "debate" | "voting" | "done" | "error";

export interface SessionSnapshot {
  id: string;
  topic: string;
  createdAt: string;
  phase: Phase;
  mock: boolean;
  members: MKProfile[];
  dossiers: Record<string, Dossier>;
  speeches: Speech[];
  reactions: Reaction[];
  stickHolder: string | null;
  vote: VoteResult | null;
  events: GameEvent[];
}

export type GameEvent = { t: string; type: string; [k: string]: unknown };
