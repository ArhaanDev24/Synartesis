import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAICompatibleProvider } from "./openai.js";
import { patient } from "./patience.js";
import type { Provider } from "./types.js";

export type { Ask, Exchange, Provider, ProviderTool, Reasoning, ToolCall, Turn } from "./types.js";

/**
 * Which model, and where.
 *
 * This is the half of a model's setup that is safe to write down: an endpoint,
 * a name, a couple of switches. The key is not here and never is -- it belongs
 * to the operating system's keychain, is passed to `createProvider` at the
 * moment of use, and is not written to the journal, a log or a crash report.
 */
export type ProviderConfig =
  | {
      readonly kind: "anthropic";
      readonly model?: string;
      readonly maxTokens?: number;
      readonly baseURL?: string;
    }
  | {
      readonly kind: "gemini";
      readonly model?: string;
      readonly maxTokens?: number;
      readonly baseURL?: string;
    }
  | {
      readonly kind: "openai-compatible";
      readonly model: string;
      readonly baseURL: string;
      readonly maxTokens?: number;
      readonly reasoningEffort?: boolean;
      readonly label?: string;
    };

export function createProvider(config: ProviderConfig, apiKey?: string): Provider {
  switch (config.kind) {
    case "anthropic":
    case "gemini": {
      if (apiKey === undefined || apiKey === "") {
        // Better here than four layers down as a 401 the user has to decode.
        throw new Error(`${config.kind} needs an API key; none was given.`);
      }
      const shared = {
        apiKey,
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
        ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      };
      return patient(
        config.kind === "anthropic"
          ? createAnthropicProvider(shared)
          : createGeminiProvider(shared),
      );
    }
    case "openai-compatible":
      return patient(
        createOpenAICompatibleProvider({
          model: config.model,
          baseURL: config.baseURL,
          // A local server wants no authentication and is given none. Sending
          // an empty bearer token to `localhost` is not harmless: some
          // gateways read it as an attempt and refuse.
          ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
          ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
          ...(config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: config.reasoningEffort }),
          ...(config.label === undefined ? {} : { label: config.label }),
        }),
      );
  }
}

export interface Preset {
  readonly name: string;
  readonly config: ProviderConfig;
  /** Whether the user has to supply a key, so the pane can stop asking for one. */
  readonly needsKey: boolean;
  /** One line under the name, telling the truth about what this costs. */
  readonly note: string;
  /**
   * Where a key comes from, for the ones that need one. Shown as a link the
   * window can open, so nobody has to go and find out which of four consoles
   * this particular provider uses.
   */
  readonly keyUrl?: string;
}

/**
 * Somewhere to start, rather than a list of everything that works.
 *
 * Any endpoint speaking `/v1/chat/completions` can be typed in by hand; these
 * are the ones worth not having to look up. The model ids are defaults a
 * person is expected to change -- a local install has whatever it has pulled.
 *
 * **Send a request to the host before adding one here.** 0.8.7 shipped a
 * GitHub Models entry whose endpoint had been retired three weeks earlier:
 * the host still answered, with `200 OK` and `content-type: text/plain`, so
 * it looked alive from a distance and could never have worked. It was added
 * from blog posts and community threads, all of which predated the
 * retirement, and the vendor's own documentation said plainly that the
 * inference API was gone. A preset that does not work is worse than an
 * absent one: the person who picks it concludes this window is broken, not
 * that the service is.
 */
export const PRESETS: readonly Preset[] = [
  {
    name: "Claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    config: { kind: "anthropic", model: "claude-opus-5" },
    needsKey: true,
    note: "Anthropic. Charged per token. Thinking effort applies.",
  },
  {
    name: "Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    // Flash rather than Pro, because a key from AI Studio is a free key
    // until somebody turns on billing, and a free key's allowance for the Pro
    // models is zero -- not small, zero. A preset that greets a new user with
    // a quota refusal on their first message is a preset that is wrong.
    config: { kind: "gemini", model: "gemini-3.8-flash" },
    needsKey: true,
    note: "Google. Thinking level applies. The Pro models need billing on the key's project.",
  },
  {
    name: "Ollama",
    config: {
      kind: "openai-compatible",
      model: "qwen3:8b",
      baseURL: "http://localhost:11434/v1",
      label: "Ollama",
    },
    needsKey: false,
    note: "On this machine. Free, private, and nothing leaves the laptop. Pick a model that can call tools.",
  },
  {
    name: "LM Studio",
    config: {
      kind: "openai-compatible",
      model: "local-model",
      baseURL: "http://localhost:1234/v1",
      label: "LM Studio",
    },
    needsKey: false,
    note: "On this machine. Free and private. Tool support depends on the model loaded.",
  },
  {
    name: "vLLM",
    config: {
      kind: "openai-compatible",
      model: "local-model",
      baseURL: "http://localhost:8000/v1",
      label: "vLLM",
    },
    needsKey: false,
    note: "Your own server. Start it with a tool-call parser or tools will be ignored.",
  },
  {
    name: "Groq",
    keyUrl: "https://console.groq.com/keys",
    config: {
      kind: "openai-compatible",
      model: "llama-3.3-70b-versatile",
      baseURL: "https://api.groq.com/openai/v1",
      label: "Groq",
    },
    needsKey: true,
    // The free tier is the point of this entry: the local presets above are
    // free only if you have the machine for them, and this one is not.
    note: "Hosted, with a free tier and no card. Rate limited. Check the model still calls tools.",
  },
  {
    name: "OpenRouter",
    keyUrl: "https://openrouter.ai/keys",
    config: {
      kind: "openai-compatible",
      // One of the free ids that advertises tool support; the catalogue at
      // /api/v1/models says which, and it moves. A `:free` model without
      // tools cannot drive this window at all, so the suffix alone is not
      // enough to go on when changing this.
      model: "qwen/qwen3.8-27b:free",
      baseURL: "https://openrouter.ai/api/v1",
      label: "OpenRouter",
    },
    needsKey: true,
    note: "Many models behind one key, including free ones. Pick an id ending :free that supports tools.",
  },
  {
    name: "Mistral",
    keyUrl: "https://console.mistral.ai/api-keys",
    config: {
      kind: "openai-compatible",
      // Small for the same reason Gemini is Flash: the large models are
      // refused outright on the entry tier.
      model: "mistral-small-latest",
      baseURL: "https://api.mistral.ai/v1",
      label: "Mistral",
    },
    needsKey: true,
    note: "Hosted. No thinking control. The large models need a paid tier.",
  },
  {
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    config: {
      kind: "openai-compatible",
      model: "gpt-5",
      baseURL: "https://api.openai.com/v1",
      reasoningEffort: true,
      label: "OpenAI",
    },
    needsKey: true,
    note: "Hosted. Charged per token. Reasoning effort applies.",
  },
];
