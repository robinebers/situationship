import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createStream } from "rotating-file-stream";

const DEFAULT_MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const ERROR_LIMIT = 500;

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function filePid(name) {
  const match = name.match(/^\d{8}T\d{6}Z-(\d+)-[a-f0-9]{8}(?:\.|$)/i);
  return match ? Number(match[1]) : null;
}

function isCurrentLog(name) {
  return /^\d{8}T\d{6}Z-\d+-[a-f0-9]{8}\.jsonl$/i.test(name);
}

async function pruneLogDirectory(logDir, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES) {
  let names;
  try {
    names = await fs.promises.readdir(logDir);
  } catch {
    return;
  }

  const files = [];
  for (const name of names) {
    const fullPath = path.join(logDir, name);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.isFile()) files.push({ name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A concurrent logger may have rotated or removed it.
    }
  }

  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= maxTotalBytes) return;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (total <= maxTotalBytes) break;
    const pid = filePid(file.name);
    if (isCurrentLog(file.name) && pid !== null && processIsAlive(pid)) continue;
    try {
      await fs.promises.unlink(file.fullPath);
      total -= file.size;
    } catch {
      // Best effort under concurrent sessions.
    }
  }
}

function sanitizeError(value) {
  return String(value || "")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, ERROR_LIMIT);
}

export async function createSessionLogger(options = {}) {
  const logDir = path.resolve(options.logDir || path.join(os.homedir(), ".codexcode", "logs"));
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  await fs.promises.mkdir(logDir, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.chmod(logDir, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  await pruneLogDirectory(logDir, maxTotalBytes);

  const sessionId = `${safeTimestamp()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const filename = `${sessionId}.jsonl`;
  const filePath = path.join(logDir, filename);
  const stream = createStream((time, index) => {
    if (!time) return filename;
    return `${sessionId}.${safeTimestamp(time)}.${index ?? 0}.jsonl`;
  }, {
    path: logDir,
    size: options.rotationSize || "1M",
    mode: 0o600,
  });
  stream.on("rotated", () => {
    void pruneLogDirectory(logDir, maxTotalBytes);
  });
  stream.on("warning", () => {});
  stream.on("error", () => {});

  let closed = false;
  const write = (event, fields = {}) => {
    if (closed) return;
    try {
      const entry = { time: new Date().toISOString(), event, ...fields };
      if (entry.error != null) entry.error = sanitizeError(entry.error);
      stream.write(`${JSON.stringify(entry)}\n`);
    } catch {
      // Diagnostics must never break routing.
    }
  };

  write("log_start", { pid: process.pid, version: 1 });

  return {
    path: filePath,
    write,
    close: () =>
      new Promise((resolve) => {
        if (closed) return resolve();
        write("log_end", { pid: process.pid });
        closed = true;
        stream.end(() => {
          void pruneLogDirectory(logDir, maxTotalBytes).finally(resolve);
        });
      }),
  };
}

export { DEFAULT_MAX_TOTAL_BYTES, pruneLogDirectory, sanitizeError };
