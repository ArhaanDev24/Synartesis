import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createProvider, PRESETS, type ProviderConfig, type Provider } from "../providers/index.js";
import type { ModelChoice, Reasoning, Settings } from "../shared/ipc.js";

type ModelSettings = Omit<Settings, "account" | "canSignIn">;

/**
 * Which models are set up, and where their keys are.
 *
 * The keys are the reason this is its own file rather than a few fields on the
 * window. A key is the user's, it is worth money, and it must not end up in
 * the journal, a log, a crash report, or this file in a form anybody can read.
 * So it goes to the operating system's own keychain and comes back only at the
 * moment a request is built.
 */

/**
 * Somewhere to put a secret. Electron's `safeStorage` on a real machine, and
 * something simpler in a test -- which is the point of the seam: the tests
 * must not need a keychain, and the app must not settle for less than one.
 */
export interface SecretStore {
  /** False on a Linux box with no keyring, where the window has to say so. */
  available(): boolean;
  seal(plain: string): string;
  open(sealed: string): string;
}

interface StoredModel {
  readonly id: string;
  readonly name: string;
  readonly config: ProviderConfig;
  readonly needsKey: boolean;
  readonly note: string;
  /** Encrypted by the OS. Unreadable without this machine and this user. */
  readonly sealedKey?: string;
}

interface Stored {
  readonly models: readonly StoredModel[];
  readonly chosen?: string;
  readonly reasoning: Reasoning;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function seed(): Stored {
  return {
    models: PRESETS.map((preset) => ({
      id: slug(preset.name),
      name: preset.name,
      config: preset.config,
      needsKey: preset.needsKey,
      note: preset.note,
    })),
    // Ollama: the only one that works the moment the app opens, with no
    // account and no key. A first run that demands a credit card before it
    // will do anything is a first run nobody finishes.
    chosen: "ollama",
    reasoning: "balanced",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A model configuration, read field by field rather than trusted wholesale.
 *
 * This file is plain JSON in the user's own directory, so it will be hand
 * edited, and what comes back has to be checked like anything else off a disk.
 * A shape that does not survive this is dropped rather than passed on to be
 * discovered later as an undefined base URL in the middle of a request.
 */
function asConfig(value: Record<string, unknown>): ProviderConfig | undefined {
  const kind = value["kind"];
  const model = value["model"];
  const baseURL = value["baseURL"];
  const maxTokens = value["maxTokens"];
  const size = typeof maxTokens === "number" ? { maxTokens } : {};

  if (kind === "anthropic" || kind === "gemini") {
    return {
      kind,
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof baseURL === "string" ? { baseURL } : {}),
      ...size,
    };
  }
  if (kind === "openai-compatible" && typeof model === "string" && typeof baseURL === "string") {
    const label = value["label"];
    const reasoningEffort = value["reasoningEffort"];
    return {
      kind,
      model,
      baseURL,
      ...(typeof label === "string" ? { label } : {}),
      ...(typeof reasoningEffort === "boolean" ? { reasoningEffort } : {}),
      ...size,
    };
  }
  return undefined;
}

/**
 * What was on disk, if any of it can still be believed.
 *
 * A settings file that has been hand-edited into nonsense should cost the user
 * their preferences, not the ability to open the app. Anything unreadable is
 * replaced with the defaults.
 */
function read(path: string): Stored {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return seed();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["models"])) {
    return seed();
  }
  const models: StoredModel[] = [];
  for (const one of parsed["models"]) {
    if (!isRecord(one)) continue;
    const { id, name, config, needsKey, note, sealedKey } = one;
    if (typeof id !== "string" || typeof name !== "string" || !isRecord(config)) continue;
    const settled = asConfig(config);
    if (settled === undefined) continue;
    models.push({
      id,
      name,
      config: settled,
      needsKey: needsKey === true,
      note: typeof note === "string" ? note : "",
      ...(typeof sealedKey === "string" ? { sealedKey } : {}),
    });
  }
  if (models.length === 0) {
    return seed();
  }
  const reasoning = parsed["reasoning"];
  return {
    models,
    ...(typeof parsed["chosen"] === "string" ? { chosen: parsed["chosen"] } : {}),
    reasoning:
      reasoning === "brief" || reasoning === "balanced" || reasoning === "thorough"
        ? reasoning
        : "balanced",
  };
}

export class Library {
  #state: Stored;

  private constructor(
    private readonly path: string,
    private readonly secrets: SecretStore,
    state: Stored,
  ) {
    this.#state = state;
  }

  static open(path: string, secrets: SecretStore): Library {
    return new Library(path, secrets, read(path));
  }

  #save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Written beside and moved into place: a crash halfway through a write
    // would otherwise leave a truncated file, and the next start would find
    // nonsense and silently reset everything the user had set up.
    const beside = `${this.path}.writing`;
    writeFileSync(beside, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    renameSync(beside, this.path);
  }

  /**
   * Everything about models, and nothing about who is using them. Signing in
   * is the desk's business; this file only knows where the keys are.
   */
  view(): ModelSettings {
    return {
      models: this.#state.models.map(
        (model): ModelChoice => ({
          id: model.id,
          name: model.name,
          config: model.config,
          needsKey: model.needsKey,
          note: model.note,
          hasKey: model.sealedKey !== undefined,
          // Asked of the adapter rather than guessed, so the window's answer
          // and the request's behaviour cannot drift apart.
          thinks: this.#thinks(model),
        }),
      ),
      ...(this.#state.chosen === undefined ? {} : { chosen: this.#state.chosen }),
      reasoning: this.#state.reasoning,
      canKeepSecrets: this.secrets.available(),
    };
  }

  #thinks(model: StoredModel): boolean {
    try {
      return createProvider(model.config, "probe").supportsReasoning;
    } catch {
      return false;
    }
  }

  #find(id: string): StoredModel | undefined {
    return this.#state.models.find((model) => model.id === id);
  }

  choose(id: string): void {
    if (this.#find(id) === undefined) {
      throw new Error(`No model called ${id}.`);
    }
    this.#state = { ...this.#state, chosen: id };
    this.#save();
  }

  setReasoning(reasoning: Reasoning): void {
    this.#state = { ...this.#state, reasoning };
    this.#save();
  }

  saveKey(id: string, key: string): void {
    if (!this.secrets.available()) {
      throw new Error(
        "This machine has no keychain Electron can use, so a key cannot be stored safely. " +
          "Use a local model instead -- it needs no key at all.",
      );
    }
    const sealed = this.secrets.seal(key);
    this.#state = {
      ...this.#state,
      models: this.#state.models.map((model) => (model.id === id ? { ...model, sealedKey: sealed } : model)),
    };
    this.#save();
  }

  forgetKey(id: string): void {
    this.#state = {
      ...this.#state,
      models: this.#state.models.map((model) => {
        if (model.id !== id) return model;
        // Rebuilt without the key rather than with the key set to nothing: an
        // empty string is a value, and it would be sealed, stored, and sent.
        return {
          id: model.id,
          name: model.name,
          config: model.config,
          needsKey: model.needsKey,
          note: model.note,
        };
      }),
    };
    this.#save();
  }

  /** The chosen model, ready to use, or a sentence saying what is missing. */
  provider(): Provider {
    const id = this.#state.chosen;
    const model = id === undefined ? undefined : this.#find(id);
    if (model === undefined) {
      throw new Error("No model is chosen yet. Pick one from the list.");
    }
    if (model.needsKey && model.sealedKey === undefined) {
      throw new Error(`${model.name} needs an API key. Add one in Models.`);
    }
    const key = model.sealedKey === undefined ? undefined : this.secrets.open(model.sealedKey);
    return createProvider(model.config, key);
  }

  reasoning(): Reasoning {
    return this.#state.reasoning;
  }
}
