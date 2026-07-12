# Protocol evidence

The private ChatGPT Codex endpoint and Claude Code's internal request formats are undocumented, so this gateway's behavior was derived by inspecting the actual clients rather than public API descriptions. This document records what was inspected and what was found.

Note: the router does not check or enforce any client versions at runtime. The versions below are simply the ones that were inspected and tested; other versions will likely work until either client changes its wire format.

## Versions inspected

- Claude Code `2.1.207`, installed binary SHA-256: `1397a062c6889675055e3314dd956376ac51262a7734ad9e819c26975d71547a`
- Codex CLI tag `rust-v0.144.1`, source commit `44918ea10c0f99151c6710411b4322c2f5c96bea`

## Claude Code 2.1.207

The native binary contains bundled, minified JavaScript. Inspection of its `MPg`, `jPu`, and `oOu` functions established:

- The auto classifier normally selects the current session model. A remote `tengu_auto_mode_config.modelByMainModel` or `model` can override it; special Fable/Mythos-family models resolve differently.
- `CLAUDE_CODE_AUTO_MODE_MODEL` is declared in the environment schema, but the classifier resolver `oOu` does not read it. The router therefore does not rely on that variable.
- Classifier stage 1 sends the rules as `system`, a `<transcript>…</transcript>` user payload, no tools, the XML `<block>` protocol, and `stop_sequences: ["</block>"]`.
- Classifier stage 2 uses the same rules/transcript protocol without the stop sequence.
- `querySource: "auto_mode"` exists in Claude's internal request options but is removed before the HTTP Messages body is serialized.
- Effort is serialized in `output_config.effort`.
- The launcher caps GPT/Codex effort at `high` by default. `--max-effort` can set the cap to `low`, `medium`, `high`, `xhigh`, or `max`; native Claude passthrough is not capped.

Live capture through this router confirmed stage-1 `max_tokens: 2112`, stage-2 `max_tokens: 10240`, the full protocol markers above, and in-band `system` messages inside `messages` on normal GPT turns.

Classifier detection requires the complete stable protocol fingerprint—rules, transcript wrapper, block protocol, and absence of tools. It does not route based on token count or stop sequence alone.

## Codex CLI 0.144.1

The canonical request struct is [`ResponsesApiRequest`](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-api/src/common.rs#L216-L239). It includes tools, tool choice, parallel-tool control, reasoning, store, stream, includes, service tier, cache key, text controls, and client metadata. It does not include `max_output_tokens`.

The CLI's request builder:

- maps effort into the `reasoning` object;
- uses `context: "all_turns"` for Responses Lite models;
- requests `reasoning.encrypted_content` when reasoning is enabled;
- preserves structured response items for tool calls and results.

See the [`build_reasoning` and request builder](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/core/src/client.rs#L802-L914).

The CLI effort enum serializes `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and future model-defined values. See [`ReasoningEffort`](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/protocol/src/openai_models.rs#L40-L68).

`function_call_output.output` is either a string or structured `input_text`/`input_image` content. Regular function calls are authoritative at `response.output_item.done`; argument-delta events may also be present and must not cause the final arguments to be emitted twice.

## Live backend checks

The private ChatGPT Codex endpoint was probed through the completed router:

- `max_output_tokens` was rejected with HTTP 400, matching its absence from Codex CLI's request struct.
- A non-streaming Messages call returned the requested exact text.
- Sol accepted `reasoning.effort: "max"` with Responses Lite `context: "all_turns"`.
- A forced tool call produced one opaque `call_id`; a structural `function_call_output` continuation returned the result without repeating the tool.
- A real Claude Code auto-mode Agent flow routed both classifier stages to native Anthropic, kept main/subagent traffic on Sol/Luna, and completed with `SUBAGENT`.
