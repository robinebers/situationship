/**
 * Dual Anthropic Messages gateway for Claude Code.
 *
 * Claude models are proxied to Anthropic. GPT/Codex models are translated to
 * the ChatGPT Codex Responses endpoint using the Codex CLI OAuth credentials.
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";

const ANTHROPIC_UPSTREAM = process.env.ANTHROPIC_UPSTREAM || "https://api.anthropic.com";
const CODEX_RESPONSES =
  process.env.CODEX_RESPONSES_URL || "https://chatgpt.com/backend-api/codex/responses";
const CODEX_MODELS =
  process.env.CODEX_MODELS_URL || "https://chatgpt.com/backend-api/codex/models";
const CODEX_CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION || "1.0.0";
const CODEX_CLIENT_ID =
  process.env.CODEX_CLIENT_ID ||
  process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ||
  "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL =
  process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || "https://auth.openai.com/oauth/token";
const TOKEN_SKEW_S = Number(process.env.CODEX_TOKEN_REFRESH_SKEW_S || 300);
const MAX_BODY_BYTES = Number(process.env.DUAL_MAX_BODY_BYTES || 32 * 1024 * 1024);
const UPSTREAM_TIMEOUT_MS = Number(process.env.DUAL_UPSTREAM_TIMEOUT_MS || 180_000);
const DEBUG = ["1", "true", "yes"].includes(String(process.env.DUAL_DEBUG || "").toLowerCase());
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const MAX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_RE = /(^claude|claude-|anthropic\.|opus|sonnet|haiku|fable|mythos)/i;
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
  "accept-encoding",
]);
const LABELS = {
  "gpt-5.6-sol": "GPT 5.6 Sol (ChatGPT)",
  "gpt-5.6-terra": "GPT 5.6 Terra (ChatGPT)",
  "gpt-5.6-luna": "GPT 5.6 Luna (ChatGPT)",
  "gpt-5.5": "GPT 5.5 (ChatGPT)",
  "gpt-5.4": "GPT 5.4 (ChatGPT)",
  "gpt-5.4-mini": "GPT 5.4 Mini (ChatGPT)",
};

let authLock = Promise.resolve();
let quiet = false;
let modelMetadata = new Map();

function writeLog(logger, event, fields = {}) {
  try {
    logger?.write(event, fields);
  } catch {
    // Diagnostics must never affect routing.
  }
}

function requestContext(logger, body, route) {
  const context = {
    logger,
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    finished: false,
  };
  writeLog(logger, "request", {
    requestId: context.id,
    route,
    model: String(body.model || ""),
    requestedEffort: body.output_config?.effort ?? null,
    stream: body.stream === true,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
  });
  return context;
}

function finishRequest(context, event, fields = {}) {
  if (!context || context.finished) return;
  context.finished = true;
  writeLog(context.logger, event, {
    requestId: context.id,
    durationMs: Date.now() - context.startedAt,
    ...fields,
  });
}

function log(message, { debug = false } = {}) {
  if ((quiet || debug) && !DEBUG) return;
  process.stderr.write(`[dual] ${message}\n`);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function withAuthLock(fn) {
  const next = authLock.then(fn, fn);
  authLock = next.catch(() => {});
  return next;
}

// ── Codex auth ──────────────────────────────────────────────────────────────

function codexHome() {
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME);
  return path.join(os.homedir(), ".codex");
}

function codexAuthPath() {
  if (process.env.CODEX_AUTH_PATH) return path.resolve(process.env.CODEX_AUTH_PATH);
  if (process.env.CODEX_AUTH && process.env.CODEX_AUTH.includes(path.sep)) {
    return path.resolve(process.env.CODEX_AUTH);
  }
  return path.join(codexHome(), "auth.json");
}

function loadCodexAuth() {
  const authFile = codexAuthPath();
  if (!fs.existsSync(authFile)) {
    throw new Error(`No Codex auth at ${authFile}. Run \`codex login\` (or set CODEX_HOME).`);
  }
  const parsed = JSON.parse(fs.readFileSync(authFile, "utf8").replace(/^\uFEFF/, ""));
  if (!parsed?.tokens?.access_token) throw new Error(`Codex auth at ${authFile} has no access token.`);
  return parsed;
}

function saveCodexAuth(data) {
  const authFile = codexAuthPath();
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = path.join(
    path.dirname(authFile),
    `.${path.basename(authFile)}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, authFile);
    try {
      fs.chmodSync(authFile, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
}

function jwtExp(token) {
  if (!token || token.split(".").length < 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload.exp == null ? null : Number(payload.exp);
  } catch {
    return null;
  }
}

function needsRefresh(auth) {
  const tokens = auth.tokens || {};
  if (!tokens.refresh_token) return false;
  const exp = jwtExp(tokens.access_token);
  return exp != null && Date.now() / 1000 >= exp - TOKEN_SKEW_S;
}

async function refreshCodexToken(auth, { force = false, previousAccessToken } = {}) {
  return withAuthLock(async () => {
    let fresh;
    try {
      fresh = loadCodexAuth();
    } catch {
      fresh = auth;
    }

    // Another process/request may already have replaced the rejected token.
    if (force && previousAccessToken && fresh.tokens?.access_token !== previousAccessToken) {
      return fresh;
    }
    if (!force && !needsRefresh(fresh)) return fresh;

    const tokens = { ...(fresh.tokens || {}) };
    if (!tokens.refresh_token) return fresh;

    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: CODEX_CLIENT_ID,
      });
      const response = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) {
        log(`codex refresh failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
        return fresh;
      }
      const data = await response.json();
      const out = { ...fresh, tokens: { ...tokens } };
      for (const key of ["access_token", "refresh_token", "id_token"]) {
        if (data[key]) out.tokens[key] = data[key];
      }
      out.last_refresh = new Date().toISOString();
      saveCodexAuth(out);
      log("codex token refreshed", { debug: true });
      return out;
    } catch (error) {
      log(`codex refresh error: ${error.message}`);
      return fresh;
    }
  });
}

function codexHeaders(auth) {
  const tokens = auth.tokens || {};
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs",
  };
  if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
  return headers;
}

async function listCodexModels(auth) {
  try {
    const url = new URL(CODEX_MODELS);
    url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
    const headers = { ...codexHeaders(auth) };
    delete headers["Content-Type"];
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const models = (await response.json()).models || [];
    const valid = models.filter((model) => model && typeof model.slug === "string");
    modelMetadata = new Map(valid.map((model) => [model.slug, model]));
    return valid;
  } catch {
    return [];
  }
}

// ── Routing and request classification ─────────────────────────────────────

function normalizeModel(model) {
  const value = String(model || "gpt-5.4").trim();
  const aliases = {
    sol: "gpt-5.6-sol",
    terra: "gpt-5.6-terra",
    luna: "gpt-5.6-luna",
    "gpt5.6-sol": "gpt-5.6-sol",
    "gpt5.6-terra": "gpt-5.6-terra",
    "gpt5.6-luna": "gpt-5.6-luna",
  };
  return aliases[value.toLowerCase()] || value;
}

function isClaudeModel(model) {
  if (model == null || model === "") return true;
  if (typeof model !== "string") return true;
  const value = model.trim().toLowerCase();
  if (/^(gpt|o1|o3|o4)/.test(value) || value.startsWith("codex") || value.includes("gpt-oss")) {
    return false;
  }
  return CLAUDE_RE.test(value) || ["default", "best"].includes(value);
}

function querySource(body) {
  return (
    body?.querySource ||
    body?.query_source ||
    body?.metadata?.querySource ||
    body?.metadata?.query_source ||
    ""
  );
}

function isAutoModeRequest(body) {
  const source = String(querySource(body)).toLowerCase();
  if (source === "auto_mode" || source === "auto-mode" || source === "automode") return true;

  // Claude Code 2.1.207's MPg classifier builder keeps querySource internal.
  // Both classifier stages still have this complete wire-level protocol shape.
  const system = blocksText(body?.system);
  const userText = (body?.messages || [])
    .filter((message) => message?.role === "user")
    .map((message) => blocksText(message.content))
    .join("\n");
  const noTools = body?.tools == null || (Array.isArray(body.tools) && body.tools.length === 0);
  return (
    noTools &&
    system.includes("Auto-Mode Bypass") &&
    (system.includes("<block>") || userText.includes("<block>")) &&
    userText.includes("<transcript>") &&
    userText.includes("</transcript>")
  );
}

function classifierModel() {
  return process.env.CODEXCODE_CLASSIFIER_MODEL || "claude-haiku-4-5-20251001";
}

function classifierBody(body) {
  const out = { ...body, model: classifierModel() };
  delete out.querySource;
  delete out.query_source;
  if (out.metadata && typeof out.metadata === "object") {
    out.metadata = { ...out.metadata };
    delete out.metadata.querySource;
    delete out.metadata.query_source;
    if (!Object.keys(out.metadata).length) delete out.metadata;
  }
  return out;
}

function blocksText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n");
}

const AGENT_MESSAGE_POLICY =
  "Use SendMessage only for necessary coordination or blockers. Return routine updates and results in your final response.";
const AGENT_TOOL_POLICY =
  "For review, research, and other read-only subagents, omit `name`, `mode`, and `isolation`. The subagent returns its result automatically when finished. Set these optional fields only when the user explicitly requests an addressable name, a specific permission mode, or worktree isolation.";

function normalizeAgentMessagePrompt(value) {
  let text = String(value || "");
  for (const sentence of [
    "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool.",
    "Just writing a response in text is not visible to others on your team - you MUST use the SendMessage tool.",
  ]) {
    text = text.split(sentence).join(AGENT_MESSAGE_POLICY);
  }
  return text;
}

function textBlocks(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""));
}

function agentRequestPolicy(body) {
  // Filter injected markers per text block, not per message: Claude Code often
  // appends system-reminder blocks to real user turns, and those must not hide
  // what the user actually asked for.
  const userText = (body.messages || [])
    .filter((message) => message?.role === "user")
    .flatMap((message) => textBlocks(message.content))
    .filter(
      (text) =>
        text &&
        !text.includes("<agent-message") &&
        !text.includes("<task-notification") &&
        !text.includes("<system-reminder"),
    )
    .join("\n");
  return {
    allowName:
      /\bSendMessage\b|\bnamed\s+(?:sub)?agents?\b|\bname\s+(?:each|the|these|those|agents?)\b/i.test(
        userText,
      ),
    allowMode:
      /\bpermission[- ]mode\b|\bdontAsk\b|\bdon['’]?t[- ]ask\s+mode\b|\bacceptEdits\b|\bbypassPermissions\b/i.test(
        userText,
      ),
    allowIsolation: /\bworktrees?\b|\bisolat(?:e|ed|ion)\b/i.test(userText),
  };
}

function isReadOnlyAgentInput(input) {
  const text = `${input?.description || ""}\n${input?.prompt || ""}`;
  return (
    /\bread[- ]only\b|\bdo not modify\b|\bdon['’]?t modify\b/i.test(text) ||
    /^\s*(?:review|audit|inspect|check|find|assess|trace|scan|verify|research|locate)\b/i.test(text)
  );
}

function normalizeAgentArguments(toolName, rawArguments, policy = {}) {
  if (toolName !== "Agent") return rawArguments || "{}";
  let input;
  try {
    input = JSON.parse(rawArguments || "{}");
  } catch {
    return rawArguments || "{}";
  }
  if (!input || typeof input !== "object" || Array.isArray(input) || !isReadOnlyAgentInput(input)) {
    return JSON.stringify(input);
  }
  if (!policy.allowName) delete input.name;
  if (!policy.allowMode) delete input.mode;
  if (!policy.allowIsolation) delete input.isolation;
  if (input.team_name === "") delete input.team_name;
  return JSON.stringify(input);
}

function requestFingerprint(body) {
  const system = blocksText(body.system);
  const lastUser = [...(body.messages || [])]
    .reverse()
    .find((message) => message?.role === "user");
  const userText = blocksText(lastUser?.content);
  return {
    max_tokens: body.max_tokens ?? null,
    stop_sequences: body.stop_sequences ?? null,
    thinking: body.thinking?.type ?? body.thinking ?? null,
    effort: body.output_config?.effort ?? null,
    tools: Array.isArray(body.tools) ? body.tools.length : null,
    roles: Array.isArray(body.messages) ? body.messages.map((message) => message?.role) : null,
    system_sha256: system
      ? crypto.createHash("sha256").update(system).digest("hex").slice(0, 12)
      : null,
    auto_protocol: {
      transcript: userText.includes("<transcript>") && userText.includes("</transcript>"),
      block: system.includes("<block>") || userText.includes("<block>"),
      auto_mode_bypass: system.includes("Auto-Mode Bypass"),
    },
  };
}

// ── Anthropic → Responses translation ──────────────────────────────────────

function toolResultOutput(block) {
  const content = block.content;
  if (typeof content === "string" || content == null) {
    const text = String(content || "");
    return block.is_error ? `[tool_error]\n${text}` : text;
  }
  if (!Array.isArray(content)) {
    const text = JSON.stringify(content);
    return block.is_error ? `[tool_error]\n${text}` : text;
  }
  const items = [];
  if (block.is_error) items.push({ type: "input_text", text: "[tool_error]" });
  for (const item of content) {
    if (typeof item === "string") {
      items.push({ type: "input_text", text: item });
    } else if (item?.type === "text") {
      items.push({ type: "input_text", text: String(item.text || "") });
    } else if (item?.type === "image") {
      const source = item.source || {};
      if (source.type === "url" && source.url) {
        items.push({ type: "input_image", image_url: source.url });
      } else if (source.type === "base64" && source.data) {
        items.push({
          type: "input_image",
          image_url: `data:${source.media_type || "image/png"};base64,${source.data}`,
        });
      }
    }
  }
  return items.length ? items : "";
}

function inputContentBlock(block) {
  if (typeof block === "string") return { type: "input_text", text: block };
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") return { type: "input_text", text: String(block.text || "") };
  if (block.type === "image") {
    const source = block.source || {};
    if (source.type === "url" && source.url) {
      return { type: "input_image", image_url: source.url };
    }
    if (source.type === "base64" && source.data) {
      return {
        type: "input_image",
        image_url: `data:${source.media_type || "image/png"};base64,${source.data}`,
      };
    }
  }
  if (block.type === "document") {
    const source = block.source || {};
    if (source.type === "base64" && source.data) {
      return {
        type: "input_file",
        filename: block.title || "document",
        file_data: `data:${source.media_type || "application/pdf"};base64,${source.data}`,
      };
    }
    if (source.type === "url" && source.url) {
      return { type: "input_file", file_url: source.url };
    }
  }
  return null;
}

function supportedEfforts(model) {
  const metadata = modelMetadata.get(model) || {};
  const raw =
    metadata.supported_reasoning_levels ||
    metadata.supported_reasoning_efforts ||
    metadata.reasoning_levels ||
    [];
  return raw
    .map((entry) => String(entry?.effort ?? entry?.value ?? entry).toLowerCase())
    .filter(Boolean);
}

function capEffort(effort, maxEffort) {
  if (effort == null || effort === "") return null;
  const requested = String(effort).toLowerCase();
  const cap = String(maxEffort || "").toLowerCase();
  if (!EFFORT_LEVELS.includes(requested)) {
    throw httpError(400, `Unsupported reasoning effort: ${JSON.stringify(effort)}`);
  }
  if (!MAX_EFFORT_LEVELS.includes(cap)) {
    throw httpError(400, `Unsupported maximum reasoning effort: ${JSON.stringify(maxEffort)}`);
  }
  return EFFORT_LEVELS.indexOf(requested) > EFFORT_LEVELS.indexOf(cap) ? cap : requested;
}

function normalizeEffort(effort, model) {
  if (effort == null || effort === "") return null;
  const requested = String(effort).toLowerCase();
  if (!EFFORT_LEVELS.includes(requested)) {
    throw httpError(400, `Unsupported reasoning effort: ${JSON.stringify(effort)}`);
  }
  const supported = supportedEfforts(model);
  // Codex 0.144.1 serializes max/ultra on the wire. When discovery is
  // unavailable, preserve the caller's exact effort and let the backend be the
  // authority instead of silently lowering it.
  if (!supported.length) return requested;
  if (supported.includes(requested)) return requested;
  const requestedIndex = EFFORT_LEVELS.indexOf(requested);
  const ranked = supported
    .filter((value) => EFFORT_LEVELS.includes(value))
    .sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b));
  if (!ranked.length) return requested === "max" || requested === "ultra" ? "xhigh" : requested;
  let closest = ranked[0];
  for (const value of ranked) {
    if (EFFORT_LEVELS.indexOf(value) <= requestedIndex) closest = value;
  }
  return closest;
}

function translateToolChoice(choice) {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) return { type: "function", name: choice.name };
  throw httpError(400, `Unsupported tool_choice: ${JSON.stringify(choice)}`);
}

function appendMessage(input, role, content) {
  const filtered = content.filter(Boolean);
  if (!filtered.length) return;
  const previous = input[input.length - 1];
  if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...filtered);
  else input.push({ role, content: filtered });
}

function anthropicToCodexBody(body, { maxEffort = "high" } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object.");
  }
  if (body.model != null && typeof body.model !== "string") {
    throw httpError(400, "model must be a string.");
  }
  if (!Array.isArray(body.messages)) throw httpError(400, "messages must be an array.");

  const model = normalizeModel(body.model);
  const instructions = [];
  if (typeof body.system === "string" && body.system.trim()) {
    instructions.push(normalizeAgentMessagePrompt(body.system));
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (typeof block === "string") instructions.push(normalizeAgentMessagePrompt(block));
      else if (block?.type === "text") instructions.push(normalizeAgentMessagePrompt(block.text));
    }
  }

  const input = [];
  for (const [messageIndex, message] of body.messages.entries()) {
    if (!message || !["user", "assistant", "system", "developer"].includes(message.role)) {
      throw httpError(
        400,
        `Message ${messageIndex} has unsupported role ${JSON.stringify(message?.role)}.`,
      );
    }
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(blocks)) throw httpError(400, "Message content must be a string or array.");

    // Claude Code can inject additional system/developer messages after the
    // initial user turn. Responses accepts these most reliably as instructions.
    if (message.role === "system" || message.role === "developer") {
      for (const block of blocks) {
        if (block?.type === "text") instructions.push(normalizeAgentMessagePrompt(block.text));
      }
      continue;
    }

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") {
        if (!block.tool_use_id) throw httpError(400, "tool_result is missing tool_use_id.");
        input.push({
          type: "function_call_output",
          call_id: String(block.tool_use_id),
          output: toolResultOutput(block),
        });
        continue;
      }
      if (block.type === "tool_use") {
        if (!block.id || !block.name) throw httpError(400, "tool_use is missing id or name.");
        input.push({
          type: "function_call",
          call_id: String(block.id),
          name: String(block.name),
          arguments: JSON.stringify(block.input ?? {}),
        });
        continue;
      }
      if (block.type === "thinking") {
        appendMessage(input, "assistant", [
          { type: "output_text", text: `[reasoning summary]\n${String(block.thinking || "")}` },
        ]);
        continue;
      }
      if (block.type === "redacted_thinking") continue;

      const translated = inputContentBlock(block);
      if (!translated) {
        throw httpError(400, `Unsupported ${message.role} content block: ${JSON.stringify(block.type)}`);
      }
      if (message.role === "assistant") {
        if (translated.type !== "input_text") {
          throw httpError(400, `Unsupported assistant content block: ${JSON.stringify(block.type)}`);
        }
        appendMessage(input, "assistant", [{ type: "output_text", text: translated.text }]);
      } else {
        appendMessage(input, "user", [translated]);
      }
    }
  }
  if (!input.length) throw httpError(400, "Request contains no translatable input.");

  const tools = [];
  for (const tool of body.tools || []) {
    if (!tool || typeof tool !== "object" || !tool.name) {
      throw httpError(400, "Every tool must have a name.");
    }
    const name = String(tool.name);
    const description = normalizeAgentMessagePrompt(tool.description);
    tools.push({
      type: "function",
      name,
      description:
        name === "Agent" ? [description, AGENT_TOOL_POLICY].filter(Boolean).join("\n\n") : description,
      parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
    });
  }

  // The ChatGPT Codex endpoint is streamed internally. proxyCodex aggregates it
  // back into a normal Messages response when the caller requested stream:false.
  const out = { model, input, stream: true, store: false };
  if (instructions.length) out.instructions = instructions.filter(Boolean).join("\n\n");
  // The public Responses API accepts max_output_tokens, but the ChatGPT Codex
  // backend used here currently rejects it. Auto-mode classifier requests are
  // routed to Anthropic unchanged, so their small max_tokens limit is preserved.
  if (tools.length) {
    out.tools = tools;
    out.tool_choice = translateToolChoice(body.tool_choice);
  }

  const effort = normalizeEffort(capEffort(body.output_config?.effort, maxEffort), model);
  if (effort) {
    out.reasoning = { effort };
    if (modelMetadata.get(model)?.use_responses_lite === true) {
      out.reasoning.context = "all_turns";
    }
    out.include = ["reasoning.encrypted_content"];
  }
  out.parallel_tool_calls = body.tool_choice?.disable_parallel_tool_use !== true;

  const format = body.output_config?.format;
  if (format?.type === "json_schema" && format.schema) {
    out.text = {
      format: {
        type: "json_schema",
        name: format.name || "structured_output",
        schema: format.schema,
        strict: format.strict !== false,
      },
    };
  }
  return out;
}

// ── Responses SSE → Anthropic Messages ─────────────────────────────────────

function anthEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createStopFilter(stopSequences, emit) {
  const stops = (stopSequences || []).filter((value) => typeof value === "string" && value.length);
  const retain = Math.max(0, ...stops.map((value) => value.length - 1));
  let pending = "";
  let stopped = null;
  return {
    push(delta) {
      if (stopped || !delta) return;
      pending += delta;
      let matchIndex = -1;
      let match = null;
      for (const stop of stops) {
        const index = pending.indexOf(stop);
        if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
          matchIndex = index;
          match = stop;
        }
      }
      if (match) {
        if (matchIndex) emit(pending.slice(0, matchIndex));
        pending = "";
        stopped = match;
        return;
      }
      if (!stops.length) {
        emit(pending);
        pending = "";
      } else if (pending.length > retain) {
        emit(pending.slice(0, pending.length - retain));
        pending = pending.slice(-retain);
      }
    },
    flush() {
      if (!stopped && pending) emit(pending);
      pending = "";
      return stopped;
    },
    get stopped() {
      return stopped;
    },
  };
}

async function* codexEventObjects(
  model,
  lineIter,
  { stopSequences = [], agentPolicy = {} } = {},
) {
  const msgId = `msg_${crypto.randomBytes(12).toString("hex")}`;
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  };

  let textIndex = null;
  let nextIndex = 0;
  let stopReason = "end_turn";
  let stopSequence = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let terminal = false;
  let failed = null;
  const toolsByItem = new Map();
  const toolsByCall = new Map();
  const queued = [];

  const queueText = (text) => {
    if (!text) return;
    if (textIndex == null) {
      textIndex = nextIndex++;
      queued.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        },
      });
    }
    queued.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text } },
    });
  };
  const stopFilter = createStopFilter(stopSequences, queueText);
  const closeText = () => {
    if (textIndex == null) return;
    queued.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: textIndex },
    });
    textIndex = null;
  };
  const flushQueued = function* () {
    while (queued.length) yield queued.shift();
  };
  const openTool = (item = {}, fallback = {}) => {
    const itemId = item.id || fallback.item_id || fallback.itemId;
    const callId = item.call_id || fallback.call_id || itemId || `call_${crypto.randomBytes(8).toString("hex")}`;
    let state = toolsByItem.get(itemId) || toolsByCall.get(callId);
    if (state) return state;
    closeText();
    state = {
      itemId,
      callId,
      name: item.name || fallback.name || "tool",
      index: nextIndex++,
      emittedArguments: false,
      argumentBuffer: "",
      bufferArguments: (item.name || fallback.name) === "Agent",
      closed: false,
    };
    if (itemId) toolsByItem.set(itemId, state);
    toolsByCall.set(callId, state);
    queued.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: state.index,
        content_block: { type: "tool_use", id: callId, name: state.name, input: {} },
      },
    });
    stopReason = "tool_use";
    return state;
  };
  const toolDelta = (state, partialJson) => {
    if (!state || state.closed || !partialJson) return;
    if (state.bufferArguments) {
      state.argumentBuffer += partialJson;
      return;
    }
    emitToolDelta(state, partialJson);
  };
  const emitToolDelta = (state, partialJson) => {
    state.emittedArguments = true;
    queued.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: state.index,
        delta: { type: "input_json_delta", partial_json: partialJson },
      },
    });
  };
  const closeTool = (state, finalArguments) => {
    if (!state || state.closed) return;
    if (!state.emittedArguments) {
      const rawArguments =
        finalArguments && finalArguments !== "{}" ? finalArguments : state.argumentBuffer || "{}";
      emitToolDelta(state, normalizeAgentArguments(state.name, rawArguments, agentPolicy));
    }
    state.closed = true;
    queued.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: state.index },
    });
  };

  for await (const raw of lineIter) {
    if (!raw || raw.startsWith(":") || raw.startsWith("event:")) continue;
    if (!raw.startsWith("data:")) continue;
    const encoded = raw.slice(5).trim();
    if (!encoded || encoded === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(encoded);
    } catch {
      failed = { type: "api_error", message: "Codex upstream emitted malformed SSE JSON." };
      break;
    }

    const type = event.type || "";
    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      stopFilter.push(String(event.delta || ""));
      if (type === "response.refusal.delta") stopReason = "refusal";
    } else if (type === "response.output_item.added") {
      if (event.item?.type === "function_call") openTool(event.item, event);
    } else if (type === "response.function_call_arguments.delta") {
      const state = toolsByItem.get(event.item_id) || toolsByCall.get(event.call_id);
      if (state) toolDelta(state, String(event.delta || ""));
    } else if (type === "response.function_call_arguments.done") {
      const state =
        toolsByItem.get(event.item_id) ||
        toolsByCall.get(event.call_id) ||
        openTool({ id: event.item_id, call_id: event.call_id, name: event.name }, event);
      closeTool(state, String(event.arguments || "{}"));
    } else if (type === "response.output_item.done" && event.item?.type === "function_call") {
      const state =
        toolsByItem.get(event.item.id) ||
        toolsByCall.get(event.item.call_id) ||
        openTool(event.item, event);
      closeTool(state, String(event.item.arguments || "{}"));
    } else if (type === "response.completed" || type === "response.incomplete") {
      terminal = true;
      const response = event.response || {};
      const usage = response.usage || {};
      inputTokens = Number(usage.input_tokens || 0);
      outputTokens = Number(usage.output_tokens || 0);
      const reason = response.incomplete_details?.reason;
      if (type === "response.incomplete" || response.status === "incomplete") {
        stopReason = reason === "max_output_tokens" ? "max_tokens" : "end_turn";
      }
    } else if (type === "error" || type === "response.failed") {
      terminal = true;
      failed = event.error || event.response?.error || { message: "Codex response failed." };
      break;
    }
    for (const item of flushQueued()) yield item;
  }

  stopSequence = stopFilter.flush();
  if (stopSequence) {
    stopReason = "stop_sequence";
    terminal = true;
  }
  for (const item of flushQueued()) yield item;
  closeText();
  for (const state of new Set(toolsByCall.values())) closeTool(state, "{}");
  for (const item of flushQueued()) yield item;

  if (failed || !terminal) {
    yield {
      event: "error",
      data: {
        type: "error",
        error: {
          type: failed?.type || "api_error",
          message: String(failed?.message || "Codex stream ended before a terminal response event.").slice(0, 500),
        },
      },
    };
    return;
  }

  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: stopSequence },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}

async function* codexStreamToAnthropic(model, lineIter, options = {}) {
  for await (const item of codexEventObjects(model, lineIter, options)) {
    yield anthEvent(item.event, item.data);
  }
}

async function collectAnthropicResponse(model, lineIter, options = {}) {
  let message = null;
  const blocks = new Map();
  let stopReason = null;
  let stopSequence = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  for await (const item of codexEventObjects(model, lineIter, options)) {
    const data = item.data;
    if (item.event === "error") throw httpError(502, data.error?.message || "Codex stream failed.");
    if (item.event === "message_start") message = data.message;
    else if (item.event === "content_block_start") {
      blocks.set(data.index, { ...data.content_block, _json: "" });
    } else if (item.event === "content_block_delta") {
      const block = blocks.get(data.index);
      if (data.delta.type === "text_delta") block.text += data.delta.text;
      else if (data.delta.type === "input_json_delta") block._json += data.delta.partial_json;
    } else if (item.event === "content_block_stop") {
      const block = blocks.get(data.index);
      if (block?.type === "tool_use") {
        try {
          block.input = JSON.parse(block._json || "{}");
        } catch {
          throw httpError(502, `Codex emitted invalid tool JSON for ${block.name}.`);
        }
      }
      if (block) delete block._json;
    } else if (item.event === "message_delta") {
      stopReason = data.delta.stop_reason;
      stopSequence = data.delta.stop_sequence;
      usage = data.usage || usage;
    }
  }
  if (!message || !stopReason) throw httpError(502, "Codex response was incomplete.");
  return {
    ...message,
    content: [...blocks.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]),
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage,
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(httpError(400, "Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, object) {
  const data = JSON.stringify(object);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendAnthropicError(res, code, message) {
  sendJson(res, code, {
    type: "error",
    error: { type: code >= 500 ? "api_error" : "invalid_request_error", message },
  });
}

function copyReqHeaders(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP.has(key.toLowerCase()) || value == null) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function nodeRequest(urlString, { method = "GET", headers = {}, body, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "http:" ? http : https;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (upstream) => {
        if (stream) return resolve(upstream);
        const chunks = [];
        upstream.on("data", (chunk) => chunks.push(chunk));
        upstream.on("end", () =>
          resolve({
            statusCode: upstream.statusCode,
            headers: upstream.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      request.destroy(new Error(`Upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms.`));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function* readLines(stream) {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
    }
  }
  if (buffer) yield buffer.replace(/\r$/, "");
}

function estimateInputTokens(body) {
  // Conservative UTF-8 estimate. This intentionally overestimates typical
  // English/code instead of claiming tokenizer parity with either provider.
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 3));
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleModels(res) {
  let auth;
  try {
    auth = await refreshCodexToken(loadCodexAuth());
  } catch (error) {
    sendAnthropicError(res, 503, error.message);
    return;
  }
  const models = await listCodexModels(auth);
  sendJson(res, 200, {
    object: "list",
    data: models.map((model) => ({
      ...model,
      id: model.slug,
      object: "model",
      display_name: LABELS[model.slug] || model.display_name || model.slug,
      owned_by: "codex-chatgpt",
    })),
  });
}

async function proxyAnthropic(req, res, body, context) {
  const headers = copyReqHeaders(req);
  headers["accept-encoding"] = "identity";
  headers["content-type"] = "application/json";
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "anthropic-version")) {
    headers["anthropic-version"] = "2023-06-01";
  }
  const incoming = new URL(req.url || "/v1/messages", "http://router");
  const upstream = new URL(incoming.pathname, `${ANTHROPIC_UPSTREAM.replace(/\/$/, "")}/`);
  upstream.search = incoming.search;
  const payload = JSON.stringify(body);
  headers["content-length"] = Buffer.byteLength(payload);

  try {
    const response = await nodeRequest(upstream, {
      method: "POST",
      headers,
      body: payload,
      stream: true,
    });
    const responseHeaders = {
      "Content-Type": response.headers["content-type"] || "application/json",
      "Cache-Control": "no-cache",
      Connection: "close",
    };
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(res);
    response.on("end", () => {
      finishRequest(context, "response", { status: response.statusCode || 502 });
    });
    response.on("error", (error) => {
      log(`anthropic stream error: ${error.message}`);
      finishRequest(context, "error", {
        status: response.statusCode || 502,
        error: error.message,
      });
      if (!res.writableEnded) res.end();
    });
  } catch (error) {
    log(`anthropic proxy error: ${error.message}`);
    finishRequest(context, "error", { status: 502, error: error.message });
    if (!res.headersSent) sendAnthropicError(res, 502, error.message);
  }
}

async function proxyCodex(req, res, body, options, context) {
  let auth;
  try {
    auth = await refreshCodexToken(loadCodexAuth());
  } catch (error) {
    finishRequest(context, "error", { status: 503, error: error.message });
    sendAnthropicError(res, 503, error.message);
    return;
  }

  let codexBody;
  try {
    codexBody = anthropicToCodexBody(body, options);
  } catch (error) {
    finishRequest(context, "error", { status: error.statusCode || 400, error: error.message });
    sendAnthropicError(res, error.statusCode || 400, error.message);
    return;
  }
  const payload = JSON.stringify(codexBody);
  const requestUpstream = (currentAuth) =>
    nodeRequest(CODEX_RESPONSES, {
      method: "POST",
      headers: {
        ...codexHeaders(currentAuth),
        "Content-Length": Buffer.byteLength(payload),
      },
      body: payload,
      stream: true,
    });

  try {
    let upstream = await requestUpstream(auth);
    if (upstream.statusCode >= 400) {
      const chunks = [];
      for await (const chunk of upstream) chunks.push(chunk);
      let errorBody = Buffer.concat(chunks);
      log(`codex upstream ${upstream.statusCode}: ${errorBody.toString("utf8").slice(0, 300)}`);
      if (upstream.statusCode === 401) {
        const rejectedToken = auth.tokens?.access_token;
        auth = await refreshCodexToken(auth, { force: true, previousAccessToken: rejectedToken });
        upstream = await requestUpstream(auth);
        if (upstream.statusCode >= 400) {
          const retryChunks = [];
          for await (const chunk of upstream) retryChunks.push(chunk);
          errorBody = Buffer.concat(retryChunks);
        } else {
          errorBody = null;
        }
      }
      if (errorBody) {
        finishRequest(context, "response", {
          status: upstream.statusCode,
          effectiveEffort: codexBody.reasoning?.effort ?? null,
        });
        res.writeHead(upstream.statusCode, {
          "Content-Type": upstream.headers?.["content-type"] || "application/json",
          "Content-Length": errorBody.length,
        });
        res.end(errorBody);
        return;
      }
    }

    const options = {
      stopSequences: body.stop_sequences || [],
      agentPolicy: agentRequestPolicy(body),
    };
    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      for await (const chunk of codexStreamToAnthropic(codexBody.model, readLines(upstream), options)) {
        if (!res.writableEnded) res.write(chunk);
      }
      if (!res.writableEnded) res.end();
    } else {
      const response = await collectAnthropicResponse(codexBody.model, readLines(upstream), options);
      sendJson(res, 200, response);
    }
    finishRequest(context, "response", {
      status: upstream.statusCode || 200,
      effectiveEffort: codexBody.reasoning?.effort ?? null,
    });
  } catch (error) {
    log(`codex proxy error: ${error.message}`);
    finishRequest(context, "error", {
      status: error.statusCode || 502,
      effectiveEffort: codexBody?.reasoning?.effort ?? null,
      error: error.message,
    });
    if (!res.headersSent) sendAnthropicError(res, error.statusCode || 502, error.message);
    else if (!res.writableEnded) res.end();
  }
}

async function handleMessages(req, res, options) {
  const body = await readBody(req);
  log(`fingerprint ${JSON.stringify(requestFingerprint(body))}`, { debug: true });
  if (isAutoModeRequest(body)) {
    const context = requestContext(options.logger, body, "classifier");
    log(`classifier → ANTHROPIC model=${JSON.stringify(classifierModel())}`, { debug: true });
    await proxyAnthropic(req, res, classifierBody(body), context);
  } else if (isClaudeModel(body.model)) {
    const context = requestContext(options.logger, body, "anthropic");
    log(`request → ANTHROPIC model=${JSON.stringify(body.model || "")}`, { debug: true });
    await proxyAnthropic(req, res, body, context);
  } else {
    const context = requestContext(options.logger, body, "codex");
    log(`request → CODEX/GPT model=${JSON.stringify(body.model || "")}`, { debug: true });
    await proxyCodex(req, res, body, options, context);
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

export async function startRouter(opts = {}) {
  const host = opts.host || process.env.DUAL_HOST || "127.0.0.1";
  const port = opts.port != null ? Number(opts.port) : Number(process.env.DUAL_PORT || 0);
  const maxEffort = String(opts.maxEffort ?? "high").toLowerCase();
  const logger = opts.logger;
  if (!MAX_EFFORT_LEVELS.includes(maxEffort)) {
    throw new Error(`maxEffort must be one of: ${MAX_EFFORT_LEVELS.join(", ")}`);
  }
  quiet = opts.quiet ?? ["1", "true", "yes"].includes(String(process.env.DUAL_QUIET || "").toLowerCase());

  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback) throw new Error("DUAL_HOST must resolve to a loopback address.");

  // Fail fast: without Codex credentials the router cannot serve its purpose.
  // refreshCodexToken and listCodexModels degrade gracefully on network errors,
  // so only a missing/unusable auth file can throw here.
  const auth = await refreshCodexToken(loadCodexAuth());
  const models = await listCodexModels(auth);
  log(`codex auth ok — models: ${models.map((model) => model.slug).join(", ") || "(none listed)"}`);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host === "::1" ? "[::1]" : host}`);
      const pathname = url.pathname;
      if (req.method === "GET" && ["/", "/health", "/healthz"].includes(pathname)) {
        sendJson(res, 200, { ok: true, service: "cc-dual-router" });
        return;
      }
      if (req.method === "GET" && pathname === "/v1/models") {
        await handleModels(res);
        return;
      }
      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        const body = await readBody(req);
        // Claude models get exact Anthropic counts; the ChatGPT Codex backend
        // has no counting endpoint, so GPT models get a conservative estimate.
        if (typeof body.model === "string" && body.model && isClaudeModel(body.model)) {
          await proxyAnthropic(req, res, body, null);
        } else {
          sendJson(res, 200, { input_tokens: estimateInputTokens(body), estimated: true });
        }
        return;
      }
      if (req.method === "POST" && pathname === "/v1/messages") {
        await handleMessages(req, res, { maxEffort, logger });
        return;
      }
      sendJson(res, 404, { error: `no handler for ${pathname}` });
    } catch (error) {
      log(`handler error: ${error.message}`);
      writeLog(logger, "handler_error", {
        method: req.method || "",
        path: new URL(req.url || "/", "http://router").pathname,
        status: error.statusCode || 500,
        error: error.message,
      });
      if (!res.headersSent) sendAnthropicError(res, error.statusCode || 500, error.message);
    }
  });
  server.requestTimeout = UPSTREAM_TIMEOUT_MS + 5_000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  log(`listening on http://${host}:${boundPort}`);
  writeLog(logger, "router_start", { host, port: boundPort, maxEffort });

  return {
    server,
    host,
    port: boundPort,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export {
  agentRequestPolicy,
  anthropicToCodexBody,
  capEffort,
  classifierBody,
  collectAnthropicResponse,
  codexStreamToAnthropic,
  estimateInputTokens,
  isAutoModeRequest,
  isClaudeModel,
  normalizeEffort,
};
