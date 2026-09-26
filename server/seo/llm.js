/**
 * Provider-agnostic LLM abstraction for AI SEO recommendations — server-side only, never imported by
 * anything under src/. A provider is a plain object: { name, model, available, generate(input) }. Swapping
 * providers (or adding a second one) means writing another factory with this same shape; nothing in
 * server/seo/recommendations.js is provider-specific. generate() must return already-parsed JSON, never
 * raw prose — see anthropicProvider, which forces this via tool-use rather than asking nicely and hoping.
 */
const ANTHROPIC_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

function anthropicProvider(apiKey) {
  return {
    name: 'anthropic',
    model: ANTHROPIC_MODEL,
    available: true,
    async generate({ system, prompt, schema, maxTokens = 1024 }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
          tools: [{ name: 'submit_recommendation', description: 'Submit the SEO recommendation.', input_schema: schema }],
          tool_choice: { type: 'tool', name: 'submit_recommendation' },
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
      if (!toolUse) throw new Error('The model did not return a structured recommendation.');
      return toolUse.input;
    },
  };
}

const unavailableProvider = {
  name: 'none',
  model: null,
  available: false,
  async generate() { throw new Error('No LLM provider is configured (set ANTHROPIC_API_KEY).'); },
};

/** Reads the env var at call time (so a .env file loaded by server/index.js is already visible), same rule
 *  as everywhere else in this codebase. Tests never set ANTHROPIC_API_KEY to a real key — they intercept the
 *  outgoing fetch() itself, which keeps this module identical in tests and production. */
export function getLlmProvider() {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? anthropicProvider(key) : unavailableProvider;
}
