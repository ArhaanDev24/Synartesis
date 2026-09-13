/**
 * What a provider's refusal actually means, in a sentence.
 *
 * Every one of them says no in its own dialect, wrapped in its own JSON, and
 * the window used to show the wrapper. The four that matter in practice are a
 * model that has been retired, a model the account is not entitled to, a
 * quota that is spent, and a key that is wrong -- and all four have the same
 * shape of answer: here is what is wrong, and here is the one thing to change.
 *
 * It never invents a cause. Anything it does not recognise is returned as it
 * arrived, because a message nobody anticipated is still better than a guess.
 */

/** The name a provider suggests when it retires one, if it names one. */
export function replacementFor(said: string): string | undefined {
  // Google: "... is no longer available. Please update your code to use
  // models/gemini-3.1-pro-preview for the latest features ..."
  const google = /use\s+models\/([A-Za-z0-9._-]+)/.exec(said);
  if (google?.[1] !== undefined) {
    return google[1];
  }
  // OpenAI and the compatible ones tend to quote it plainly. The word
  // boundaries matter: without them "usage" ends in `use` and "retry" in
  // `try`, and a rate limit would start recommending models.
  const quoted = /\b(?:use|try|switch to|replaced by)\s+[`'"]?([A-Za-z0-9][A-Za-z0-9._:-]{2,})[`'"]?/i.exec(said);
  return quoted?.[1];
}

/**
 * The model, out of the id the app gives a provider.
 *
 * Those ids are `kind:model` so that two configurations of one vendor are
 * distinguishable. A person reading a sentence about their model wants the
 * model, not the adapter that carried it.
 */
export function namely(id: string): string {
  const cut = id.indexOf(":");
  // A label a person typed is left alone, and so is a bare name. Only the
  // adapter prefixes this app puts on itself are taken off.
  return cut === -1 || !/^(?:anthropic|gemini|openai-compatible)$/.test(id.slice(0, cut))
    ? id
    : id.slice(cut + 1);
}

/**
 * How long the provider asked us to wait, in milliseconds.
 *
 * Both shapes Google sends -- the machine-readable `retryDelay` and the
 * sentence -- and the plain English OpenAI and Anthropic use.
 */
export function retryAfter(said: string): number | undefined {
  const structured = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(said);
  const prose = /(?:retry|try again|wait)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(s\b|sec|second)/i.exec(said);
  const found = structured?.[1] ?? prose?.[1];
  if (found === undefined) {
    return undefined;
  }
  const seconds = Number(found);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

/**
 * Whether waiting is pointless, because the allowance is zero rather than
 * spent.
 *
 * This is the distinction Google's own message obscures, and it is the whole
 * reason this class exists: a free key is told "limit: 0" and "please retry in
 * 23s" in the same breath. Retrying that succeeds on no schedule. The fix is
 * billing or a different model, and saying "wait 23 seconds" would send
 * somebody round a loop that never ends.
 */
export function hasNoAllowance(said: string): boolean {
  // Deliberately only the shapes that mean zero. "You exceeded your current
  // quota" is what Google says for a per-minute limit on a paid key too, and
  // reading that as "you have none" would tell somebody to set up billing they
  // are already paying for.
  return /\blimit:\s*0\b|"limit"\s*:\s*"?0"?[,}\s]|insufficient_quota|billing_not_active/i.test(said);
}

/** Whether the provider is refusing over volume rather than over the model. */
export function isRateLimit(said: string): boolean {
  return /RESOURCE_EXHAUSTED|rate[_ ]limit|\b429\b|too many requests|quota/i.test(said);
}

export interface Refusal {
  /** One sentence, for a person. */
  readonly said: string;
  /** The model name the provider suggested, if it suggested one. */
  readonly instead?: string;
  /** Whether changing the model name is what would fix it. */
  readonly aboutTheModel: boolean;
  /** How long to wait, when waiting is the answer. Milliseconds. */
  readonly after?: number;
}

export function explain(id: string, said: string): Refusal {
  const model = namely(id);
  const gone =
    /no longer available|has been (?:retired|deprecated|removed)|model[_ ]not[_ ]found|does not exist|is not found|unknown model|NOT_FOUND/i.test(
      said,
    );
  const notEntitled = /tier_not_allowed|not available in your subscription|do not have access|不支持/i.test(said);
  const badKey = /invalid[_ ]api[_ ]key|unauthorized|authentication|invalid x-api-key|\b401\b/i.test(said);
  const instead = replacementFor(said);

  if (gone) {
    return {
      said:
        `${model} is not there any more. ` +
        (instead === undefined
          ? "The provider has retired it; open Models and keys and set the name they list now."
          : `The provider says to use ${instead} instead — open Models and keys and change the name.`),
      ...(instead === undefined ? {} : { instead }),
      aboutTheModel: true,
    };
  }

  // Before the entitlement check, because a spent quota and an excluded model
  // both say the word "quota" and only one of them is fixed by waiting.
  if (isRateLimit(said)) {
    if (hasNoAllowance(said)) {
      return {
        said:
          `This key has no quota for ${model} — the provider allows it none at all, ` +
          `so waiting will not help. Turn on billing for the account the key belongs to, ` +
          `or open Models and keys and pick a model the account can use.`,
        aboutTheModel: true,
      };
    }
    const after = retryAfter(said);
    return {
      said:
        `Too many requests to ${model} just now. ` +
        (after === undefined
          ? "The provider is rate-limiting this key; wait a moment and send it again."
          : `The provider asks for about ${String(Math.ceil(after / 1000))} seconds.`),
      aboutTheModel: false,
      ...(after === undefined ? {} : { after }),
    };
  }

  if (notEntitled) {
    return {
      said:
        `Your account cannot use ${model}. ` +
        (instead === undefined
          ? "It exists, but this plan is not entitled to it; pick a model your plan includes in Models and keys."
          : `Try ${instead}, or another model your plan includes.`),
      ...(instead === undefined ? {} : { instead }),
      aboutTheModel: true,
    };
  }
  if (badKey) {
    return {
      said: `The key for ${model} was refused. Check it in Models and keys, or paste a new one.`,
      aboutTheModel: false,
    };
  }
  return { said, aboutTheModel: false };
}
