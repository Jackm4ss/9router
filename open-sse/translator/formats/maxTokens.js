import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../config/runtimeConfig.js";

/**
 * Adjust max_tokens based on request context
 * @param {object} body - Request body
 * @param {number} [ceiling=DEFAULT_MAX_TOKENS] - Upper bound for max_tokens.
 *   Callers with model context (e.g. openai-to-claude) pass the model's real
 *   maxOutput so high-output models (Opus 4.8 = 128000) aren't pre-clamped to
 *   the conservative 64000 default before the model-aware step sees them.
 * @returns {number} Adjusted max_tokens
 */
export function adjustMaxTokens(body, ceiling = DEFAULT_MAX_TOKENS) {
  let maxTokens = body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS;

  // Auto-increase for tool calling to prevent truncated arguments (min never above max)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    if (maxTokens < DEFAULT_MIN_TOKENS) {
      maxTokens = DEFAULT_MIN_TOKENS;
    }
  }

  // Ensure max_tokens > thinking.budget_tokens (Claude API requirement).
  // Both max_tokens <= ceiling and max_tokens > budget_tokens must hold.
  // If budget_tokens alone meets or exceeds the ceiling, cap maxTokens at
  // ceiling and shrink budget_tokens so room remains for output tokens.
  if (body.thinking?.budget_tokens) {
    if (body.thinking.budget_tokens >= ceiling) {
      maxTokens = ceiling;
      body.thinking.budget_tokens = Math.max(1024, ceiling - 1024);
    } else {
      if (maxTokens <= body.thinking.budget_tokens) {
        maxTokens = body.thinking.budget_tokens + 1024;
      }
      if (maxTokens > ceiling) {
        maxTokens = ceiling;
      }
      if (body.thinking.budget_tokens >= maxTokens) {
        body.thinking.budget_tokens = Math.max(1024, maxTokens - 1024);
      }
    }
  } else {
    // Never exceed the ceiling
    if (maxTokens > ceiling) maxTokens = ceiling;
  }

  return maxTokens;
}

