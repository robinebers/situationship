import test from "node:test";
import assert from "node:assert/strict";

import {
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
} from "../lib/router.js";

async function* lines(events) {
  for (const event of events) yield `data: ${JSON.stringify(event)}`;
  yield "data: [DONE]";
}

async function streamText(events, options) {
  let result = "";
  for await (const chunk of codexStreamToAnthropic("gpt-test", lines(events), options)) {
    result += chunk;
  }
  return result;
}

test("routes Claude aliases and GPT models deterministically", () => {
  assert.equal(isClaudeModel("claude-opus-4"), true);
  assert.equal(isClaudeModel("fable"), true);
  assert.equal(isClaudeModel("gpt-5.6-sol"), false);
  assert.equal(isClaudeModel("codex-mini"), false);
});

test("caps GPT effort without raising lower requests", () => {
  assert.equal(capEffort("max", "high"), "high");
  assert.equal(capEffort("xhigh", "high"), "high");
  assert.equal(capEffort("medium", "high"), "medium");
  assert.equal(capEffort("minimal", "low"), "minimal");
  assert.equal(capEffort(null, "high"), null);
  assert.throws(() => capEffort("high", "extreme"), /Unsupported maximum reasoning effort/);
});

test("detects and sanitizes auto-mode classifier requests", () => {
  const request = {
    model: "gpt-5.6-sol",
    querySource: "auto_mode",
    metadata: { query_source: "auto_mode" },
    messages: [{ role: "user", content: "classify" }],
  };
  assert.equal(isAutoModeRequest(request), true);
  const translated = classifierBody(request);
  assert.match(translated.model, /^claude-/);
  assert.equal(translated.querySource, undefined);
  assert.equal(translated.metadata, undefined);

  assert.equal(
    isAutoModeRequest({
      model: "gpt-5.6-sol",
      max_tokens: 2112,
      stop_sequences: ["</block>"],
      system: "Rules include Auto-Mode Bypass. Return <block>yes or no.",
      messages: [
        { role: "user", content: [{ type: "text", text: "<transcript>action</transcript>" }] },
      ],
    }),
    true,
  );
});

test("maps effort, limits, tool choice, tool calls, and tool results structurally", () => {
  const result = anthropicToCodexBody({
    model: "sol",
    max_tokens: 256,
    output_config: { effort: "max" },
    system: [{ type: "text", text: "system" }],
    tools: [{ name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    tool_choice: { type: "tool", name: "Read", disable_parallel_tool_use: true },
    messages: [
      { role: "user", content: "read it" },
      { role: "system", content: "late system" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_123", name: "Read", input: { path: "a.txt" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_123", content: "hello" }],
      },
    ],
  }, { maxEffort: "max" });
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.instructions, "system\n\nlate system");
  assert.equal(result.max_output_tokens, undefined);
  assert.deepEqual(result.reasoning, { effort: "max" });
  assert.deepEqual(result.tool_choice, { type: "function", name: "Read" });
  assert.equal(result.parallel_tool_calls, false);
  assert.deepEqual(result.input[1], {
    type: "function_call",
    call_id: "call_123",
    name: "Read",
    arguments: '{"path":"a.txt"}',
  });
  assert.deepEqual(result.input[2], {
    type: "function_call_output",
    call_id: "call_123",
    output: "hello",
  });
});

test("caps translated Codex reasoning at high by default", () => {
  const result = anthropicToCodexBody({
    model: "gpt-5.6-sol",
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "work" }],
  });
  assert.deepEqual(result.reasoning, { effort: "high" });
});

test("calibrates SendMessage instructions for GPT-routed agents", () => {
  const forceful =
    "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool.";
  const teamForceful =
    "Just writing a response in text is not visible to others on your team - you MUST use the SendMessage tool.";
  const replacement =
    "Use SendMessage only for necessary coordination or blockers. Return routine updates and results in your final response.";

  const result = anthropicToCodexBody({
    model: "gpt-5.6-sol",
    system: `Before. ${teamForceful} After.`,
    tools: [{ name: "SendMessage", description: forceful, input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "work" }],
  });

  assert.equal(result.instructions, `Before. ${replacement} After.`);
  assert.equal(result.tools[0].description, replacement);
});

test("adds native-sounding defaults to the Agent tool", () => {
  const result = anthropicToCodexBody({
    model: "gpt-5.6-sol",
    tools: [{ name: "Agent", description: "Launch an agent.", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "review this branch" }],
  });

  assert.match(result.tools[0].description, /read-only subagents, omit `name`, `mode`, and `isolation`/);
  assert.match(result.tools[0].description, /The subagent returns its result automatically/);
  assert.doesNotMatch(result.tools[0].description, /Claude Code/);
});

test("preserves Agent options only when the user explicitly requests them", () => {
  assert.deepEqual(
    agentRequestPolicy({ messages: [{ role: "user", content: "review using subagents" }] }),
    { allowName: false, allowMode: false, allowIsolation: false },
  );
  assert.deepEqual(
    agentRequestPolicy({
      messages: [
        {
          role: "user",
          content: "Use named agents with SendMessage in isolated worktrees and don't-ask mode.",
        },
      ],
    }),
    { allowName: true, allowMode: true, allowIsolation: true },
  );
  assert.deepEqual(
    agentRequestPolicy({
      messages: [
        { role: "user", content: "review using subagents" },
        { role: "user", content: '<agent-message from="peer">Use SendMessage in a worktree</agent-message>' },
      ],
    }),
    { allowName: false, allowMode: false, allowIsolation: false },
  );
  // An attached system-reminder block must not hide the user's actual request.
  assert.deepEqual(
    agentRequestPolicy({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Use named agents with SendMessage for this review." },
            { type: "text", text: "<system-reminder>Contents of CLAUDE.md changed.</system-reminder>" },
          ],
        },
      ],
    }),
    { allowName: true, allowMode: false, allowIsolation: false },
  );
});

test("maps user images and rejects silently empty input", () => {
  const result = anthropicToCodexBody({
    model: "gpt-5.6-sol",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  });
  assert.equal(result.input[0].content[1].type, "input_image");
  assert.throws(
    () => anthropicToCodexBody({ model: "gpt-5.6-sol", messages: [] }),
    /no translatable input/,
  );
});

test("preserves structured text and image tool results", () => {
  const result = anthropicToCodexBody({
    model: "gpt-5.6-sol",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_image", name: "Screenshot", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_image",
            content: [
              { type: "text", text: "screen" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AAAA" },
              },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(result.input[1].output, [
    { type: "input_text", text: "screen" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ]);
});

test("validates effort and conservatively estimates tokens", () => {
  assert.equal(normalizeEffort("max", "unknown"), "max");
  assert.throws(() => normalizeEffort("turbo", "unknown"), /Unsupported reasoning effort/);
  assert.ok(estimateInputTokens({ messages: [{ content: "hello" }] }) >= 1);
});

test("streams text and detects stop sequences split across deltas", async () => {
  const events = [
      { type: "response.output_text.delta", delta: "safe</blo" },
      { type: "response.output_text.delta", delta: "ck>ignored" },
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2 } },
      },
    ];
  const output = await streamText(
    events,
    { stopSequences: ["</block>"] },
  );
  const collected = await collectAnthropicResponse(
    "gpt-test",
    lines(events),
    { stopSequences: ["</block>"] },
  );
  assert.equal(collected.content[0].text, "safe");
  assert.doesNotMatch(output, /ignored/);
  assert.match(output, /"stop_reason":"stop_sequence"/);
  assert.match(output, /"stop_sequence":"<\/block>"/);
});

test("streams function arguments exactly once and correlates item_id with call_id", async () => {
  const output = await streamText([
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "Read", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"pa' },
    { type: "response.function_call_arguments.delta", item_id: "item_1", delta: 'th":"a"}' },
    {
      type: "response.function_call_arguments.done",
      item_id: "item_1",
      name: "Read",
      arguments: '{"path":"a"}',
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "item_1",
        call_id: "call_1",
        name: "Read",
        arguments: '{"path":"a"}',
      },
    },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } },
    },
  ]);
  assert.equal((output.match(/partial_json/g) || []).length, 2);
  assert.equal((output.match(/\\\"path\\\":\\\"a\\\"/g) || []).length, 0);
  assert.match(output, /"id":"call_1"/);
  assert.match(output, /"stop_reason":"tool_use"/);
});

test("normalizes read-only Agent arguments in streaming and collected responses", async () => {
  const argumentsJson = JSON.stringify({
    description: "Review the diff",
    prompt: "Review main...HEAD. Do not modify files.",
    subagent_type: "general-purpose",
    model: "sonnet",
    run_in_background: true,
    name: "line-scan",
    team_name: "",
    mode: "dontAsk",
    isolation: "worktree",
  });
  const events = [
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: "item_agent", call_id: "call_agent", name: "Agent" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item_agent",
      delta: argumentsJson.slice(0, 70),
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item_agent",
      delta: argumentsJson.slice(70),
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "item_agent",
      name: "Agent",
      arguments: argumentsJson,
    },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } },
    },
  ];

  const output = await streamText(events);
  assert.equal((output.match(/partial_json/g) || []).length, 1);
  assert.doesNotMatch(output, /line-scan|dontAsk|worktree|team_name/);

  const response = await collectAnthropicResponse("gpt-test", lines(events));
  assert.deepEqual(response.content[0].input, {
    description: "Review the diff",
    prompt: "Review main...HEAD. Do not modify files.",
    subagent_type: "general-purpose",
    model: "sonnet",
    run_in_background: true,
  });

  const preserved = await collectAnthropicResponse("gpt-test", lines(events), {
    agentPolicy: { allowName: true, allowMode: true, allowIsolation: true },
  });
  assert.equal(preserved.content[0].input.name, "line-scan");
  assert.equal(preserved.content[0].input.mode, "dontAsk");
  assert.equal(preserved.content[0].input.isolation, "worktree");
  assert.equal(preserved.content[0].input.team_name, undefined);
});

test("collects a non-streaming Anthropic response", async () => {
  const response = await collectAnthropicResponse(
    "gpt-test",
    lines([
      { type: "response.output_text.delta", delta: "hello" },
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 7, output_tokens: 2 } },
      },
    ]),
  );
  assert.equal(response.content[0].text, "hello");
  assert.equal(response.stop_reason, "end_turn");
  assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 2 });
});

test("maps incomplete max-output responses to max_tokens", async () => {
  const response = await collectAnthropicResponse(
    "gpt-test",
    lines([
      { type: "response.output_text.delta", delta: "cut" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
    ]),
  );
  assert.equal(response.stop_reason, "max_tokens");
});

test("fails closed when an upstream stream has no terminal event", async () => {
  await assert.rejects(
    collectAnthropicResponse(
      "gpt-test",
      lines([{ type: "response.output_text.delta", delta: "partial" }]),
    ),
    /ended before a terminal response event/,
  );
});
