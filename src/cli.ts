/**
 * BACKEND=cli: run every agent call through the Claude Code CLI (`claude -p`)
 * instead of the API. It uses whatever login the CLI already has (a Claude
 * subscription or a cloud session), so no API key is needed. Each call is a
 * separate headless process with its own system prompt: one agent, one context.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Run in an empty folder so the CLI doesn't pick up this repo's files or CLAUDE.md.
const WORK_DIR = path.join(process.cwd(), "data", "cli-work");

export class CliError extends Error {}

export async function cliCall<T>(opts: {
  model: string;
  system: string;
  user: string;
  /** JSON Schema the final answer must match (validated by the CLI). */
  schema: object;
  /** Allow WebSearch / WebFetch for this call. */
  web: boolean;
  effort: string;
  timeoutMs?: number;
}): Promise<T> {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tools = opts.web ? "WebSearch,WebFetch" : "";
  const args = [
    "-p",
    "--output-format", "json",
    "--model", opts.model,
    "--effort", opts.effort,
    "--system-prompt", opts.system,
    "--tools", tools,
    ...(opts.web ? ["--allowedTools", tools] : []),
    "--json-schema", JSON.stringify(opts.schema),
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { cwd: WORK_DIR, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CliError("claude -p timed out"));
    }, opts.timeoutMs ?? 8 * 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new CliError(`could not start claude CLI: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) reject(new CliError(`claude exited ${code}: ${stderr.slice(0, 400)}`));
      else resolve(stdout);
    });
    child.stdin.end(opts.user);
  });
  let res: { is_error?: boolean; subtype?: string; result?: string; structured_output?: T };
  try {
    res = JSON.parse(out);
  } catch {
    throw new CliError(`unexpected CLI output: ${out.slice(0, 300)}`);
  }
  if (res.is_error || res.structured_output == null) {
    throw new CliError(`CLI call failed (${res.subtype ?? "error"}): ${String(res.result ?? "").slice(0, 300)}`);
  }
  return res.structured_output;
}

/** Is the `claude` CLI installed and callable? */
export async function cliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(process.env.CLAUDE_BIN ?? "claude", ["--version"]);
    c.on("error", () => resolve(false));
    c.on("close", (code) => resolve(code === 0));
  });
}
