import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function address(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("routes classifiers to Anthropic, GPT to Codex, and stays quiet", async (t) => {
  const received = { anthropic: [], codex: [] };
  const logged = [];
  const logger = { write: (event, fields) => logged.push({ event, ...fields }) };
  const anthropic = await listen(async (req, res) => {
    received.anthropic.push(await jsonBody(req));
    const data = JSON.stringify({
      id: "msg_classifier",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "<block>no</block>" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    res.end(data);
  });
  const codex = await listen(async (req, res) => {
    if (req.url.startsWith("/models")) {
      const data = JSON.stringify({
        models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: ["low", "high", "xhigh"] }],
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
      res.end(data);
      return;
    }
    received.codex.push(await jsonBody(req));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "working" })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  t.after(() => new Promise((resolve) => anthropic.close(resolve)));
  t.after(() => new Promise((resolve) => codex.close(resolve)));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexcode-test-"));
  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test-token", account_id: "acct" } }),
  );
  process.env.CODEX_HOME = home;
  process.env.ANTHROPIC_UPSTREAM = address(anthropic);
  process.env.CODEX_MODELS_URL = `${address(codex)}/models`;
  process.env.CODEX_RESPONSES_URL = `${address(codex)}/responses`;
  process.env.CODEXCODE_CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

  const { startRouter } = await import(`../lib/router.js?integration=${Date.now()}`);
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    stderr += String(chunk);
    return true;
  };
  const router = await startRouter({ host: "127.0.0.1", port: 0, quiet: true, logger });
  t.after(async () => {
    process.stderr.write = originalWrite;
    await router.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${router.port}`;

  const classifierResponse = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      querySource: "auto_mode",
      stream: false,
      max_tokens: 64,
      stop_sequences: ["</block>"],
      messages: [{ role: "user", content: "classify" }],
    }),
  });
  assert.equal(classifierResponse.status, 200);
  assert.equal((await classifierResponse.json()).content[0].text, "<block>no</block>");
  assert.equal(received.anthropic[0].model, "claude-haiku-4-5-20251001");
  assert.equal(received.anthropic[0].querySource, undefined);

  const nativeResponse = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-fable-5",
      stream: false,
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "native work" }],
    }),
  });
  assert.equal(nativeResponse.status, 200);
  await nativeResponse.json();
  assert.equal(received.anthropic[1].model, "claude-fable-5");
  assert.equal(received.anthropic[1].output_config.effort, "max");

  const codexResponse = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      stream: false,
      max_tokens: 100,
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "work" }],
    }),
  });
  assert.equal(codexResponse.status, 200);
  const result = await codexResponse.json();
  assert.equal(result.content[0].text, "working");
  assert.equal(received.codex[0].reasoning.effort, "high");
  assert.equal(received.codex[0].max_output_tokens, undefined);

  const claudeCount = await fetch(`${base}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-fable-5",
      messages: [{ role: "user", content: "count me" }],
    }),
  });
  assert.equal(claudeCount.status, 200);
  assert.equal(received.anthropic[2].model, "claude-fable-5");
  assert.equal(received.anthropic[2].messages[0].content, "count me");

  const gptCount = await fetch(`${base}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "count me" }],
    }),
  });
  assert.equal(gptCount.status, 200);
  const gptCountBody = await gptCount.json();
  assert.equal(gptCountBody.estimated, true);
  assert.equal(gptCountBody.input_tokens >= 1, true);
  assert.equal(received.anthropic.length, 3);

  const malformed = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(logged.some((entry) => entry.event === "router_start"), true);
  assert.equal(
    logged.some(
      (entry) =>
        entry.event === "response" &&
        entry.status === 200 &&
        entry.effectiveEffort === "high",
    ),
    true,
  );
  assert.equal(logged.some((entry) => entry.event === "handler_error" && entry.status === 400), true);
  assert.equal(stderr, "");
});

test("fails fast at startup when Codex auth is missing", async (t) => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexcode-noauth-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = emptyHome;
  t.after(() => {
    if (previousHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    fs.rmSync(emptyHome, { recursive: true, force: true });
  });

  const { startRouter } = await import(`../lib/router.js?noauth=${Date.now()}`);
  await assert.rejects(
    startRouter({ host: "127.0.0.1", port: 0, quiet: true }),
    /No Codex auth .*`codex login`/s,
  );
});
