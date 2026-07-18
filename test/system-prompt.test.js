import test from "node:test";
import assert from "node:assert/strict";
import { routingPrompt } from "../lib/system-prompt.js";

test("routingPrompt reflects the resolved alias mapping", () => {
  const prompt = routingPrompt({
    ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.6-sol",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.6-terra",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-5.6-luna",
  });
  assert.match(prompt, /Chief-of-Thread Mode/);
  assert.match(prompt, /Situationship/);
  assert.match(prompt, /Claude Opus -> gpt-5\.6-sol/);
  assert.match(prompt, /Claude Sonnet -> gpt-5\.6-terra/);
  assert.match(prompt, /Claude Haiku -> gpt-5\.6-luna/);
});
