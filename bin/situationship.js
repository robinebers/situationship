#!/usr/bin/env node
/**
 * npx situationship  — free port → Situationship router → claude → teardown
 *
 *   npx situationship
 *   npx situationship -c
 *   npx situationship --router-only
 */
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { startRouter } from "../lib/router.js";
import { createSessionLogger } from "../lib/session-log.js";
import { routingPrompt } from "../lib/system-prompt.js";

const MAX_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function launcherOptions(argv) {
  let routerOnly = false;
  let maxEffort = "high";
  const userArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--router-only") {
      routerOnly = true;
      continue;
    }
    if (arg === "--max-effort" || arg.startsWith("--max-effort=")) {
      const value = arg === "--max-effort" ? argv[++index] : arg.slice("--max-effort=".length);
      if (!value || !MAX_EFFORT_LEVELS.has(value)) {
        throw new Error("--max-effort must be one of: low, medium, high, xhigh, max");
      }
      maxEffort = value;
      continue;
    }
    userArgs.push(arg);
  }

  return { routerOnly, userArgs, maxEffort };
}

/** Defaults unless the user already passed the flag. */
function withDefaults(argv) {
  const out = [...argv];
  const has = (flag) =>
    out.some((a) => a === flag || a.startsWith(`${flag}=`));

  // Default model: Fable 5 (native Anthropic passthrough)
  if (!has("--model") && !process.env.ANTHROPIC_MODEL) {
    out.unshift(
      "--model",
      process.env.SITUATIONSHIP_MODEL || "fable",
    );
  }

  // Default permission mode: auto
  if (!has("--permission-mode")) {
    out.unshift(
      "--permission-mode",
      process.env.SITUATIONSHIP_PERMISSION_MODE || "auto",
    );
  }

  return out;
}

function findClaude() {
  try {
    if (process.platform === "win32") {
      const matches = execFileSync("where", ["claude"], { encoding: "utf8" })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      // Prefer a real executable: Node refuses to spawn .cmd shims directly.
      return matches.find((match) => /\.exe$/i.test(match)) || matches[0] || null;
    }
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function quoteForCmd(value) {
  if (value === "") return '""';
  return /[\s"^&|<>()%!]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function spawnClaude(claudePath, claudeArgs, env) {
  // Node throws EINVAL when spawning .cmd/.bat directly (CVE-2024-27980), so
  // npm-installed shims must go through cmd.exe with quoted arguments.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(claudePath)) {
    return spawn(quoteForCmd(claudePath), claudeArgs.map(quoteForCmd), {
      stdio: "inherit",
      env,
      shell: true,
    });
  }
  return spawn(claudePath, claudeArgs, { stdio: "inherit", env });
}

async function main() {
  const { routerOnly, userArgs, maxEffort } = launcherOptions(process.argv.slice(2));
  const host = process.env.DUAL_HOST || "127.0.0.1";
  const pinPort = process.env.DUAL_PORT ? Number(process.env.DUAL_PORT) : 0;
  const sessionLogger = await createSessionLogger();

  let router;
  try {
    router = await startRouter({
      host,
      port: pinPort,
      quiet: true,
      maxEffort,
      logger: sessionLogger,
    });
  } catch (error) {
    sessionLogger.write("startup_error", { error: error?.message || error });
    await sessionLogger.close();
    throw error;
  }
  const { host: h, port, close } = router;
  const base = `http://${h.includes(":") ? `[${h}]` : h}:${port}`;

  let exiting = false;
  let child = null;
  let promptPath = null;
  const shutdown = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill(code === 130 ? "SIGINT" : "SIGTERM");
    }
    if (promptPath) {
      try {
        fs.unlinkSync(promptPath);
      } catch {
        /* ignore */
      }
    }
    try {
      await close();
    } catch {
      /* ignore */
    }
    sessionLogger.write("session_exit", { code });
    await sessionLogger.close();
    process.exit(code);
  };

  process.on("SIGINT", () => {
    void shutdown(130);
  });
  process.on("SIGTERM", () => {
    void shutdown(143);
  });

  if (routerOnly) {
    console.error(`router ${base}  (--router-only; Ctrl-C to stop)`);
    console.error(`log ${sessionLogger.path}`);
    await new Promise(() => {});
    return;
  }

  const claudePath = findClaude();
  if (!claudePath) {
    console.error("claude not on PATH — install Claude Code first");
    await shutdown(1);
    return;
  }

  const childEnv = { ...process.env };
  childEnv.ANTHROPIC_BASE_URL = base;
  childEnv._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = "1";
  // Required for --permission-mode auto with a custom base URL / non-native path
  childEnv.CLAUDE_CODE_ENABLE_AUTO_MODE = childEnv.CLAUDE_CODE_ENABLE_AUTO_MODE || "1";
  childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL =
    childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL || "gpt-5.6-sol";
  childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL =
    childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || "gpt-5.6-terra";
  childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL =
    childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL || "gpt-5.6-luna";
  childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION =
    childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION || "gpt-5.6-sol";
  childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME =
    childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME || "GPT 5.6 Sol (ChatGPT)";
  childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION =
    childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ||
    "Via ChatGPT Codex (Situationship)";

  // Avoid stale gateway discovery without deleting the user's shared cache.
  delete childEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;

  const claudeArgs = withDefaults(userArgs);

  // Tell the model it sits behind the router. The file lives next to the
  // session log so it is ephemeral, and a user-supplied append flag wins.
  const userAppends = userArgs.some((a) => a.startsWith("--append-system-prompt"));
  if (!userAppends) {
    try {
      const candidate = sessionLogger.path.replace(/\.jsonl$/, ".prompt.md");
      fs.writeFileSync(candidate, routingPrompt(childEnv), { mode: 0o600 });
      promptPath = candidate;
      claudeArgs.unshift("--append-system-prompt-file", promptPath);
    } catch (error) {
      sessionLogger.write("prompt_file_error", { error: error?.message || error });
    }
  }

  console.error(`router ${base}`);
  console.error(`log ${sessionLogger.path}`);
  console.error(
    `default: model=fable  permission=auto  max-effort=${maxEffort}  ·  opus→sol sonnet→terra haiku→luna  ·  fable native`,
  );
  console.error("---");

  child = spawnClaude(claudePath, claudeArgs, childEnv);

  child.on("error", (e) => {
    console.error(`failed to spawn claude: ${e.message}`);
    void shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (signal === "SIGINT") void shutdown(130);
    else if (signal === "SIGTERM") void shutdown(143);
    else if (signal) void shutdown(128);
    else void shutdown(code ?? 0);
  });
}

main().catch((e) => {
  const debug = ["1", "true", "yes"].includes(String(process.env.DUAL_DEBUG || "").toLowerCase());
  console.error(debug && e?.stack ? e.stack : `situationship: ${e?.message || e}`);
  process.exit(1);
});
