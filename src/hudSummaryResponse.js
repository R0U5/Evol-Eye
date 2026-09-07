export const HUD_SUMMARY_UNCONFIGURED_CODE = 'HUD_SUMMARY_NOT_CONFIGURED';

/**
 * Describe the optional HUD summary capability without turning a deliberately
 * keyless boot into an HTTP failure.
 *
 * The summary can be served by any of three providers; it counts as configured
 * when at least one of them can serve: a local Ollama pair
 * (OLLAMA_BASE_URL + OLLAMA_HUD_SUMMARY_MODEL), or an OpenAI key
 * (OPENAI_API_KEY — optionally pointed at an OpenAI-compatible base URL).
 * A bare OPENAI_BASE_URL without a key is not a provider.
 *
 * @param {{openAiKey?: unknown, ollamaBaseUrl?: unknown, ollamaModel?: unknown}} env
 * @returns {{ statusCode: 200, payload: { configured: false, code: string, error: null, summary: null } }|null}
 *   A graceful unconfigured response, or null when any provider is configured.
 */
export function keylessHudSummaryResponse(env = {}) {
  const openAiKey = String(env?.openAiKey ?? '').trim();
  const localConfigured = Boolean(
    String(env?.ollamaBaseUrl ?? '').trim()
    && String(env?.ollamaModel ?? '').trim()
  );
  if (openAiKey || localConfigured) return null;
  return {
    statusCode: 200,
    payload: {
      configured: false,
      code: HUD_SUMMARY_UNCONFIGURED_CODE,
      error: null,
      summary: null,
    },
  };
}

/** Return true only for the deliberate, successful no-key capability response. */
export function isHudSummaryUnconfigured(status, data) {
  const keys = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data)
    : [];
  return keys.length === 4
    && status === 200
    && data?.configured === false
    && data?.code === HUD_SUMMARY_UNCONFIGURED_CODE
    && data?.error === null
    && data?.summary === null;
}
