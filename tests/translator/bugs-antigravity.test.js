// Real Antigravity-MITM requests (Gemini-internal: { request: { contents, ... } }) → OpenAI.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { ANTIGRAVITY_DEFAULT_SYSTEM } from "../../open-sse/config/appConstants.js";

const AG2O = (req) =>
  translateRequest(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, "m", { request: req }, true, null, null);

describe("Antigravity → OpenAI", () => {
  // antigravity-to-openai.js — content with BOTH functionResponse and functionCall/text
  // previously returned toolResults early → dropped tool calls / text (fixed in #2225)
  it("functionResponse + functionCall in same content keeps both", () => {
    const out = AG2O({
      contents: [{
        role: "model",
        parts: [
          { functionResponse: { id: "c1", name: "prev", response: { result: "done" } } },
          { functionCall: { id: "c2", name: "next", args: {} } },
        ],
      }],
    });
    const json = JSON.stringify(out);
    expect(json, "functionCall lost when sharing content with functionResponse").toContain("\"next\"");
  });

  // antigravity-to-openai.js:167 — functionCall without id gets a random Date.now() id
  // KNOWN BUG: unstable id breaks matching with its functionResponse
  it("functionCall without id keeps a stable matchable id", () => {
    const out = AG2O({
      contents: [
        { role: "model", parts: [{ functionCall: { name: "search", args: { q: "x" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "search", response: { result: "r" } } }] },
      ],
    });
    const asst = out.messages.find((m) => m.tool_calls);
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool?.tool_call_id, "id mismatch between call and response").toBe(asst?.tool_calls?.[0]?.id);
  });

  // antigravity-to-openai.js:144-147 — signature-only part handling (regression guard)
  it("signature-only part does not produce empty text", () => {
    const out = AG2O({
      contents: [{ role: "model", parts: [{ thoughtSignature: "sig", text: "" }] }],
    });
    const asst = out.messages.find((m) => m.role === "assistant");
    const content = asst?.content;
    const hasEmpty = Array.isArray(content)
      ? content.some((c) => c.type === "text" && c.text === "")
      : content === "";
    expect(hasEmpty, "empty text part emitted").toBe(false);
  });
});

describe("Antigravity → Claude", () => {
  it("tool call input_json_delta includes Anthropic index", () => {
    const state = initState(FORMATS.CLAUDE);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, {
      response: {
        responseId: "resp-1",
        modelVersion: "gemini-pro-agent",
        candidates: [{
          content: {
            role: "model",
            parts: [{ functionCall: { name: "bash", args: { command: "git status" } } }],
          },
          finishReason: "STOP",
          index: 0,
        }],
      },
    }, state);

    const jsonDelta = events.find(
      (event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta"
    );
    expect(jsonDelta).toMatchObject({ index: expect.any(Number) });
    expect(JSON.parse(jsonDelta.delta.partial_json)).toEqual({ command: "git status" });
  });
});

describe("Antigravity executor", () => {
  it("strips optional from nested tool schemas", () => {
    const out = new AntigravityExecutor().transformRequest("gemini-2.5-pro", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{
          functionDeclarations: [{
            name: "lookup",
            description: "Lookup a value",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query",
                  optional: true,
                },
              },
            },
          }],
        }],
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    const query = out.request.tools[0].functionDeclarations[0].parameters.properties.query;
    expect(query).toEqual({ type: "string", description: "Search query" });
  });

  it("does not inject the legacy Antigravity default system prompt for Gemini-backed models", () => {
    const out = openaiToAntigravityRequest("gemini-3.5-flash-low", {
      messages: [
        { role: "system", content: "USER_SYSTEM_PROMPT" },
        { role: "user", content: "hello" },
      ],
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    const system = JSON.stringify(out.request.systemInstruction);
    expect(system).toContain("USER_SYSTEM_PROMPT");
    expect(system).not.toContain(ANTIGRAVITY_DEFAULT_SYSTEM);
    expect(system).not.toContain("Please ignore the following [ignore]");
  });

  it("does not inject the legacy Antigravity default system prompt for Claude-backed models", () => {
    const out = openaiToAntigravityRequest("claude-opus-4-6-thinking", {
      messages: [
        { role: "system", content: "USER_SYSTEM_PROMPT" },
        { role: "user", content: "hello" },
      ],
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    const system = JSON.stringify(out.request.systemInstruction);
    expect(system).toContain("USER_SYSTEM_PROMPT");
    expect(system).not.toContain(ANTIGRAVITY_DEFAULT_SYSTEM);
    expect(system).not.toContain("Please ignore the following [ignore]");
  });

  it("translates claude-opus-4-6-thinking to Antigravity with thinkingConfig and preserves it through transformRequest", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "claude-opus-4-6-thinking",
      {
        messages: [{ role: "user", content: "Solve this puzzle" }],
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
      "antigravity"
    );

    expect(translated.request.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 24576,
      includeThoughts: true,
    });
    expect(translated.request.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(32768);

    const transformed = new AntigravityExecutor().transformRequest(
      "claude-opus-4-6-thinking",
      translated,
      true,
      { projectId: "project-1", connectionId: "conn-1" }
    );

    expect(transformed.request.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 24576,
      includeThoughts: true,
    });
    expect(transformed.thinking).toBeUndefined();
    expect(transformed.output_config).toBeUndefined();
  });
  it("translates claude-opus-4-6-thinking with reasoning_effort max ensuring maxOutputTokens > thinkingBudget", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "claude-opus-4-6-thinking",
      {
        messages: [{ role: "user", content: "Solve this puzzle" }],
        reasoning_effort: "max",
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
      "antigravity"
    );

    expect(translated.request.generationConfig.maxOutputTokens).toBe(128000);
    expect(translated.request.generationConfig.thinkingConfig.thinkingBudget).toBeLessThan(
      translated.request.generationConfig.maxOutputTokens
    );
    expect(translated.request.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 126976,
      includeThoughts: true,
    });

    const transformed = new AntigravityExecutor().transformRequest(
      "claude-opus-4-6-thinking",
      translated,
      true,
      { projectId: "project-1", connectionId: "conn-1" }
    );

    expect(transformed.request.generationConfig.maxOutputTokens).toBe(128000);
    expect(transformed.request.generationConfig.thinkingConfig.thinkingBudget).toBeLessThan(
      transformed.request.generationConfig.maxOutputTokens
    );
    expect(transformed.request.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 126976,
      includeThoughts: true,
    });
  });

  it("translates claude-opus-4.6 with reasoning_effort max ensuring maxOutputTokens > thinkingBudget", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "claude-opus-4.6",
      {
        messages: [{ role: "user", content: "Solve this puzzle" }],
        reasoning_effort: "max",
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
      "antigravity"
    );

    expect(translated.request.generationConfig.maxOutputTokens).toBe(128000);
    expect(translated.request.generationConfig.thinkingConfig.thinkingBudget).toBe(126976);
  });

  it("translates Antigravity thinking stream chunks for claude-opus-4-6-thinking to OpenAI reasoning_content", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(
      FORMATS.ANTIGRAVITY,
      FORMATS.OPENAI,
      {
        response: {
          responseId: "resp-thought",
          modelVersion: "claude-opus-4-6-thinking",
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "Thinking step 1...", thought: true }],
            },
          }],
        },
      },
      state
    );

    const delta = events?.find((e) => e.choices?.[0]?.delta?.reasoning_content);
    expect(delta?.choices?.[0]?.delta?.reasoning_content).toBe("Thinking step 1...");
  });

  it("translates Antigravity thinking stream chunks for claude-opus-4-6-thinking to Claude thinking_delta", () => {
    const state = initState(FORMATS.CLAUDE);
    const events = translateResponse(
      FORMATS.ANTIGRAVITY,
      FORMATS.CLAUDE,
      {
        response: {
          responseId: "resp-thought-claude",
          modelVersion: "claude-opus-4-6-thinking",
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "Thinking step 1...", thought: true }],
            },
          }],
        },
      },
      state
    );

    const thinkingDelta = events?.find(
      (e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta"
    );
    expect(thinkingDelta?.delta?.thinking).toBe("Thinking step 1...");
  });

  it("translates gemini-3.8-flash-high with max_tokens 65536 allowing native 65536 limit", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "gemini-3.8-flash-high",
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 65536,
      },
      true,
      null,
      "antigravity"
    );
    const finalReq = new AntigravityExecutor().transformRequest("gemini-3.8-flash-high", translated, true, { projectId: "p-1" });
    expect(finalReq.request.generationConfig.maxOutputTokens).toBe(65536);
  });
});
