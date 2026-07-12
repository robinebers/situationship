import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSessionLogger, pruneLogDirectory, sanitizeError } from "../lib/session-log.js";

test("writes private metadata-only session logs", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexcode-logs-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  const logger = await createSessionLogger({ logDir, rotationSize: "1K", maxTotalBytes: 4096 });
  logger.write("request", { route: "codex", model: "gpt-test", requestedEffort: "max" });
  logger.write("error", { error: "Bearer secret-token\nfailed" });
  await logger.close();

  const entries = fs
    .readFileSync(logger.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry.event), ["log_start", "request", "error", "log_end"]);
  assert.equal(entries[2].error, "Bearer [redacted] failed");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(logger.path).mode & 0o777, 0o600);
  }
});

test("rotates a long session and enforces its total budget", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexcode-rotate-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const logger = await createSessionLogger({ logDir, rotationSize: "1K", maxTotalBytes: 2048 });
  for (let index = 0; index < 100; index += 1) {
    logger.write("request", { index, model: "gpt-test", padding: "x".repeat(100) });
  }
  await logger.close();

  const total = fs
    .readdirSync(logDir)
    .reduce((sum, name) => sum + fs.statSync(path.join(logDir, name)).size, 0);
  assert.equal(total <= 2048, true);
});

test("prunes oldest inactive logs to the directory budget", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexcode-prune-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const oldPath = path.join(logDir, "old.jsonl");
  const newPath = path.join(logDir, "new.jsonl");
  fs.writeFileSync(oldPath, "a".repeat(10));
  fs.writeFileSync(newPath, "b".repeat(10));
  fs.utimesSync(oldPath, new Date(0), new Date(0));

  await pruneLogDirectory(logDir, 10);

  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(newPath), true);
});

test("sanitizes and bounds logged errors", () => {
  const jwt = "eyJabc.def.ghi";
  const result = sanitizeError(`${jwt}\n${"x".repeat(600)}`);
  assert.match(result, /^\[redacted-jwt\] /);
  assert.equal(result.length, 500);
});
