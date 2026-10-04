import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getModelUpstreamId, isValidModel } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { MODEL_PRICING, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("Antigravity Claude Opus 5.5 models", () => {
  describe("Provider registry & PROVIDER_MODELS", () => {
    it("registers official upstream model IDs in antigravity registry", () => {
      const modelIds = antigravityRegistry.models.map((m) => m.id);
      expect(modelIds).toContain("claude-opus-5-5-high");
      expect(modelIds).toContain("claude-opus-5-5-medium");
      expect(modelIds).toContain("claude-opus-5-5-low");
    });

    it("registers 'Claude Opus 5.5 (Thinking)' with ID 'claude-opus-5-5-high'", () => {
      const model = antigravityRegistry.models.find((m) => m.id === "claude-opus-5-5-high");
      expect(model).toBeDefined();
      expect(model.name).toBe("Claude Opus 5.5 (Thinking)");
    });

    it("exposes models in PROVIDER_MODELS under 'ag' alias", () => {
      const agModels = PROVIDER_MODELS.ag;
      expect(agModels).toBeDefined();
      const modelIds = agModels.map((m) => m.id);
      expect(modelIds).toContain("claude-opus-5-5-high");
      expect(modelIds).toContain("claude-opus-5-5-medium");
      expect(modelIds).toContain("claude-opus-5-5-low");
    });

    it("validates model IDs via isValidModel for both 'ag' and passthrough", () => {
      expect(isValidModel("ag", "claude-opus-5-5-high")).toBe(true);
      expect(isValidModel("ag", "claude-opus-5-5-medium")).toBe(true);
      expect(isValidModel("ag", "claude-opus-5-5-low")).toBe(true);
    });

    it("resolves upstream model IDs correctly", () => {
      expect(getModelUpstreamId("ag", "claude-opus-5-5-high")).toBe("claude-opus-5-5-high");
      expect(getModelUpstreamId("ag", "claude-opus-5-5-medium")).toBe("claude-opus-5-5-medium");
      expect(getModelUpstreamId("ag", "claude-opus-5-5-low")).toBe("claude-opus-5-5-low");
      expect(getModelUpstreamId("ag", "claude-opus-5-5")).toBe("claude-opus-5-5-high");
      expect(getModelUpstreamId("ag", "claude-opus-5.5-high")).toBe("claude-opus-5-5-high");
    });
  });

  describe("Capabilities & thinking levels", () => {
    it.each(["antigravity", "ag"])(
      "resolves Claude Opus 5.5 capabilities correctly for provider '%s'",
      (provider) => {
        const caps = getCapabilitiesForModel(provider, "claude-opus-5-5-high");
        expect(caps.vision).toBe(true);
        expect(caps.reasoning).toBe(true);
        expect(caps.search).toBe(true);
        expect(caps.thinkingFormat).toBe("gemini-budget");
        expect(caps.thinkingRange).toEqual({ min: 1024, max: 126976 });
        expect(caps.contextWindow).toBe(1000000);
        expect(caps.maxOutput).toBe(128000);
      }
    );

    it.each(["claude-opus-5-5-high", "claude-opus-5-5-medium", "claude-opus-5-5-low"])(
      "resolves capabilities for tiered model '%s'",
      (modelId) => {
        const caps = getCapabilitiesForModel("antigravity", modelId);
        expect(caps.vision).toBe(true);
        expect(caps.reasoning).toBe(true);
        expect(caps.thinkingFormat).toBe("gemini-budget");
        expect(caps.contextWindow).toBe(1000000);
        expect(caps.maxOutput).toBe(128000);
      }
    );

    it.each(["antigravity", "ag"])(
      "resolves thinking levels for '%s' to extended Claude levels including max",
      (provider) => {
        const levels = getThinkingLevels(provider, "claude-opus-5-5-high");
        expect(levels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
      }
    );
  });

  describe("CLI and MITM catalog synchronization", () => {
    it("includes claude-opus-5-5 models in the standalone CLI Antigravity catalog", () => {
      const source = readFileSync(join(here, "../../cli/src/cli/menus/providers.js"), "utf8");
      const agCatalog = source.match(/\n  ag: \[([\s\S]*?)\n  \],/)?.[1] || "";

      expect(agCatalog).toContain('"claude-opus-5-5-high"');
      expect(agCatalog).toContain('"claude-opus-5-5-medium"');
      expect(agCatalog).toContain('"claude-opus-5-5-low"');
    });

    it("includes claude-opus-5-5-high in MITM_TOOLS defaultModels", () => {
      const defaultModels = MITM_TOOLS.antigravity.defaultModels;
      const model = defaultModels.find((m) => m.id === "claude-opus-5-5-high");
      expect(model).toBeDefined();
      expect(model.name).toBe("Claude Opus 5.5 (Thinking)");
      expect(model.alias).toBe("claude-opus-5-5-high");
    });

    it("includes claude-opus-5-5 models in MITM_TOOLS modelAliases", () => {
      const aliases = MITM_TOOLS.antigravity.modelAliases;
      expect(aliases).toContain("claude-opus-5-5-high");
      expect(aliases).toContain("claude-opus-5-5-medium");
      expect(aliases).toContain("claude-opus-5-5-low");
    });

    it("includes claude-opus-5-5 models in usage importantModels", () => {
      const source = readFileSync(join(here, "../../open-sse/services/usage/google.js"), "utf8");
      expect(source).toContain("'claude-opus-5-5-high'");
      expect(source).toContain("'claude-opus-5-5-medium'");
      expect(source).toContain("'claude-opus-5-5-low'");
    });
  });

  describe("Pricing and Antigravity executor transformation", () => {
    it("defines pricing for Claude Opus 5.5 models", () => {
      expect(MODEL_PRICING["claude-opus-5-5-high"]).toEqual({
        input: 5.0,
        output: 25.0,
        cached: 0.5,
        reasoning: 37.5,
        cache_creation: 5.0,
      });
      const resolved = getPricingForModel("ag", "claude-opus-5-5-high");
      expect(resolved).toMatchObject({ input: 5.0, output: 25.0 });
    });

    it("transforms claude-opus-5-5-high requests with Claude 128000 token cap and thinkingConfig", () => {
      const executor = new AntigravityExecutor();
      const transformed = executor.transformRequest(
        "claude-opus-5-5-high",
        {
          request: {
            contents: [
              {
                role: "user",
                parts: [{ text: "Use tool_a" }],
              },
              {
                role: "model",
                parts: [{ functionCall: { id: "call_1", name: "tool_a", args: {} } }],
              },
              {
                role: "tool",
                parts: [{ functionResponse: { id: "call_1", name: "tool_a", response: { result: "ok" } } }],
              },
            ],
            generationConfig: {
              maxOutputTokens: 200000,
              thinkingConfig: { thinkingBudget: 130000 },
            },
          },
        },
        true,
        { projectId: "test-project", connectionId: "conn-1" }
      );

      // Claude max ceiling is 128000
      expect(transformed.request.generationConfig.maxOutputTokens).toBe(128000);
      // thinkingBudget must be strictly less than maxOutputTokens
      expect(transformed.request.generationConfig.thinkingConfig.thinkingBudget).toBeLessThan(128000);
      // Function response role is mapped to 'user' for Claude
      expect(transformed.request.contents[2].role).toBe("user");
      // Model is passed through
      expect(transformed.model).toBe("claude-opus-5-5-high");
      expect(transformed.project).toBe("test-project");
    });

    it("translates OpenAI request for claude-opus-5-5-high with default thinking enabled", () => {
      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.ANTIGRAVITY,
        "claude-opus-5-5-high",
        {
          messages: [{ role: "user", content: "Solve this" }],
        },
        true,
        { projectId: "project-1", connectionId: "conn-1" },
        "antigravity"
      );

      expect(translated.request.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 24576,
        includeThoughts: true,
      });
    });

    it("translates OpenAI request for claude-opus-5-5-medium with medium thinking level", () => {
      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.ANTIGRAVITY,
        "claude-opus-5-5-medium",
        {
          messages: [{ role: "user", content: "Solve this" }],
        },
        true,
        { projectId: "project-1", connectionId: "conn-1" },
        "antigravity"
      );

      expect(translated.request.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 8192,
        includeThoughts: true,
      });
    });

    it("translates OpenAI request for claude-opus-5-5-low with low thinking level", () => {
      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.ANTIGRAVITY,
        "claude-opus-5-5-low",
        {
          messages: [{ role: "user", content: "Solve this" }],
        },
        true,
        { projectId: "project-1", connectionId: "conn-1" },
        "antigravity"
      );

      expect(translated.request.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 1024,
        includeThoughts: true,
      });
    });

    it("respects explicit reasoning_effort override on claude-opus-5-5-high", () => {
      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.ANTIGRAVITY,
        "claude-opus-5-5-high",
        {
          messages: [{ role: "user", content: "Solve this" }],
          reasoning_effort: "low",
        },
        true,
        { projectId: "project-1", connectionId: "conn-1" },
        "antigravity"
      );

      expect(translated.request.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 1024,
        includeThoughts: true,
      });
    });

    it("respects explicit reasoning_effort none on claude-opus-5-5-high", () => {
      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.ANTIGRAVITY,
        "claude-opus-5-5-high",
        {
          messages: [{ role: "user", content: "Solve this" }],
          reasoning_effort: "none",
        },
        true,
        { projectId: "project-1", connectionId: "conn-1" },
        "antigravity"
      );

      expect(translated.request.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 0,
        includeThoughts: false,
      });
    });
  });
});
