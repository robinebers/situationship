/**
 * Optional launch-time relabeling of Claude Code's model picker.
 *
 * Claude Code is a single, code-signed, Bun-compiled binary. The model
 * descriptions shown in the picker are stored as plain text inside it. This
 * module makes a throwaway copy of that binary, rewrites those description
 * strings so they reflect the GPT models they are actually remapped to, and
 * (on macOS) re-signs the copy so the OS will run it.
 *
 * Nothing here touches the user's real Claude Code install. The patched copy
 * lives in a temp directory and is deleted when the session ends.
 *
 * Hard rule: replacements must be the same length or shorter than the original
 * bytes. The strings live at fixed offsets inside the binary; growing one would
 * shift everything after it and corrupt the file. Shorter replacements are
 * padded with trailing spaces to keep every byte offset identical.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Display-only description strings, verified present in Claude Code 2.1.207.
// Opus→Sol, Sonnet→Terra, Haiku→Luna. Fable's description is left untouched
// because Fable really does run natively on Anthropic.
export const DEFAULT_LABEL_REPLACEMENTS = [
  // Replacements must be ≤ original byte length (trailing spaces pad the rest).
  { search: "Best for everyday, complex tasks", replace: "(GPT 5.6 Sol via Codex)" },
  { search: "Efficient for routine tasks", replace: "(GPT 5.6 Terra via Codex)" },
  { search: "Fastest for quick answers", replace: "(GPT 5.6 Luna via Codex)" },
];

const SPACE = 0x20;

/**
 * Overwrite every occurrence of `search` with `replace`, in place, keeping the
 * byte length identical by padding the replacement with trailing spaces.
 * Returns the number of occurrences rewritten.
 */
function replaceInPlace(buffer, search, replace) {
  const searchBuf = Buffer.from(search, "utf8");
  const replaceBuf = Buffer.from(replace, "utf8");
  if (replaceBuf.length > searchBuf.length) {
    throw new Error(
      `Replacement "${replace}" (${replaceBuf.length} bytes) is longer than "${search}" (${searchBuf.length} bytes).`,
    );
  }
  const padded = Buffer.alloc(searchBuf.length, SPACE);
  replaceBuf.copy(padded);

  let count = 0;
  let from = 0;
  for (;;) {
    const index = buffer.indexOf(searchBuf, from);
    if (index === -1) break;
    padded.copy(buffer, index);
    count += 1;
    from = index + padded.length;
  }
  return count;
}

function copyBinary(source, dest) {
  // COPYFILE_FICLONE makes this a near-instant copy-on-write clone on APFS and
  // falls back to a normal copy elsewhere.
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_FICLONE);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    // Non-POSIX platforms (Windows) manage the executable bit differently.
  }
}

function resign(dest) {
  // Modifying the bytes invalidates Anthropic's signature. macOS refuses to run
  // a signed binary whose signature no longer matches, so replace it with an
  // ad-hoc signature. Windows and Linux do not enforce this at runtime.
  if (process.platform !== "darwin") return;
  execFileSync("codesign", ["--force", "--sign", "-", dest], { stdio: "ignore" });
}

/**
 * Build a relabeled copy of the Claude Code binary.
 *
 * @param {string} claudePath Path to the claude executable (may be a symlink).
 * @param {object} [options]
 * @param {Array<{search:string,replace:string}>} [options.replacements]
 * @param {{ write: Function }} [options.logger]
 * @returns {{ path: string, cleanup: () => void, replaced: number }}
 */
export function createPatchedClaude(claudePath, options = {}) {
  const replacements = options.replacements || DEFAULT_LABEL_REPLACEMENTS;
  const logger = options.logger;

  const real = fs.realpathSync(claudePath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexcode-labels-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const dest = path.join(tmpDir, `claude-relabeled${suffix}`);

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort; the OS clears the temp directory eventually.
    }
  };

  try {
    copyBinary(real, dest);

    const buffer = fs.readFileSync(dest);
    let replaced = 0;
    for (const { search, replace } of replacements) {
      replaced += replaceInPlace(buffer, search, replace);
    }
    fs.writeFileSync(dest, buffer);

    resign(dest);

    logger?.write?.("label_patch", {
      source: real,
      replaced,
      requested: replacements.length,
    });

    return { path: dest, cleanup, replaced };
  } catch (error) {
    cleanup();
    throw error;
  }
}
