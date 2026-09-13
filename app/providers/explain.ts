/**
 * What a provider's refusal actually means, in a sentence.
 *
 * Every one of them says no in its own dialect, wrapped in its own JSON, and
 * the window used to show the wrapper. The three that matter in practice are
 * a model that has been retired, a model the account is not entitled to, and
 * a key that is wrong -- and all three have the same shape of answer: here is
 * what is wrong, and here is the one thing to change.
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
  // OpenAI and the compatible ones tend to quote it plainly.
  const quoted = /(?:use|try|switch to|replaced by)\s+[`'"]?([A-Za-z0-9][A-Za-z0-9._:-]{2,})[`'"]?/i.exec(said);
  return quoted?.[1];
}

export interface Refusal {
  /** One sentence, for a person. */
  readonly said: string;
  /** The model name the provider suggested, if it suggested one. */
  readonly instead?: string;
  /** Whether changing the model name is what would fix it. */
  readonly aboutTheModel: boolean;
}

export function explain(model: string, said: string): Refusal {
  const gone =
    /no longer available|has been (?:retired|deprecated|removed)|model[_ ]not[_ ]found|does not exist|is not found|unknown model|NOT_FOUND/i.test(
      said,
    );
  const notEntitled = /tier_not_allowed|not available in your subscription|do not have access|insufficient_quota|不支持/i.test(said);
  const badKey = /invalid[_ ]api[_ ]key|unauthorized|authentication|invalid x-api-key|401/i.test(said);
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
