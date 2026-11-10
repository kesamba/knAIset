import express from "express";
import path from "node:path";
import { Debate, listSavedSessions, loadSavedSession } from "./debate.js";
import { config } from "./llm.js";
import { loadRoster } from "./roster.js";
import type { GameEvent } from "./types.js";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const live = new Map<string, Debate>();

app.get("/api/config", (_req, res) => {
  res.json({ mock: config.mock, backend: config.backend, mkModel: config.mkModel, reactionModel: config.reactionModel, reactions: config.reactions });
});

app.get("/api/roster", (_req, res) => {
  res.json(loadRoster());
});

app.get("/api/sessions", (_req, res) => {
  res.json(listSavedSessions());
});

app.post("/api/sessions", (req, res) => {
  const { topic, maxTurns, memberIds } = req.body ?? {};
  if (typeof topic !== "string" || topic.trim().length < 3) {
    res.status(400).json({ error: "צריך נושא לדיון" });
    return;
  }
  const debate = new Debate({
    topic,
    maxTurns: Number.isFinite(maxTurns) ? Math.max(3, Math.min(60, Number(maxTurns))) : undefined,
    memberIds: Array.isArray(memberIds) ? memberIds : undefined,
  });
  live.set(debate.id, debate);
  void debate.run();
  res.json({ id: debate.id });
});

app.get("/api/sessions/:id", (req, res) => {
  const d = live.get(req.params.id);
  const snap = d ? d.snapshot() : loadSavedSession(req.params.id);
  if (!snap) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(snap);
});

/** Server-sent events: the full snapshot first, then every new event live. */
app.get("/api/sessions/:id/stream", (req, res) => {
  const d = live.get(req.params.id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const snap = d ? d.snapshot() : loadSavedSession(req.params.id);
  if (!snap) {
    send("fatal", { message: "הדיון לא נמצא" });
    res.end();
    return;
  }
  send("snapshot", snap);
  if (!d) return void res.end();
  const onEvent = (ev: GameEvent) => send("game", ev);
  d.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    d.off("event", onEvent);
  });
});

app.post("/api/sessions/:id/control", (req, res) => {
  const d = live.get(req.params.id);
  if (!d) {
    res.status(404).json({ error: "הדיון לא פעיל" });
    return;
  }
  const { action, mkId, text, resolution } = req.body ?? {};
  switch (action) {
    case "pause":
      d.pause();
      break;
    case "resume":
      d.resume();
      break;
    case "stick":
      d.giveStick(String(mkId));
      break;
    case "chair":
      if (typeof text === "string" && text.trim()) d.chairNote(text);
      break;
    case "vote":
      d.callVote(typeof resolution === "string" ? resolution : undefined);
      break;
    default:
      res.status(400).json({ error: "unknown action" });
      return;
  }
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`🏛️  knAIset running on http://localhost:${port}  (backend: ${config.backend})`);
});
