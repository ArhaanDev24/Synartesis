import { explain } from "./explain.js";
import type { Ask, Provider, Turn } from "./types.js";

/**
 * Waiting out a rate limit, rather than handing it to the person.
 *
 * Every hosted provider refuses when too many requests arrive at once, and
 * every one of them says how long to wait. A turn that fails on that has not
 * gone wrong -- it has arrived early -- and making somebody read a paragraph
 * of JSON and press send again is the app failing to do a thing it knows
 * exactly how to do.
 *
 * Three rules keep this from being a way to hide real failures:
 *
 *  - Only when the provider named a delay. A refusal that is not about
 *    volume, and a quota that is zero rather than spent, are shown at once:
 *    no amount of waiting fixes billing.
 *  - Never after the model has started speaking. A retry replays the request
 *    from the beginning, and words already on screen would be said twice.
 *    Rate limits arrive before the first token in practice; this is here for
 *    the time they do not.
 *  - Twice at most, and the wait is visible while it happens. An app that
 *    silently stalls for a minute is indistinguishable from one that has hung.
 */

/** How many times one turn will wait before the refusal reaches the person. */
const WAITS = 2;

/** No single wait longer than this, whatever the provider asks for. */
const LONGEST = 45_000;

/** A little past what was asked, since their clock is the one that counts. */
const MARGIN = 250;

function rest(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stopped = (): void => {
      reject(new Error("you stopped it while it was waiting for the provider"));
    };
    if (signal?.aborted === true) {
      stopped();
      return;
    }
    const timer = setTimeout(resolve, ms);
    // Once, and left attached: the signal belongs to this turn and goes away
    // with it, so there is nothing here to leak into the next one.
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        stopped();
      },
      { once: true },
    );
  });
}

export function patient(
  provider: Provider,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = rest,
): Provider {
  return {
    ...provider,
    async respond(ask: Ask): Promise<Turn> {
      /**
       * Whether anything has reached the screen. Once true, never retried.
       * Held in an object because it is set from inside a callback, and a
       * plain flag would be narrowed to its initial value by every reader.
       */
      const spoken = { already: false };
      const watched: Ask = {
        ...ask,
        onText: (chunk: string) => {
          spoken.already = true;
          ask.onText?.(chunk);
        },
      };

      for (let waited = 0; ; waited += 1) {
        try {
          return await provider.respond(watched);
        } catch (error: unknown) {
          const raw = error instanceof Error ? error.message : String(error);
          const { after } = explain(provider.id, raw);
          if (
            after === undefined ||
            waited >= WAITS ||
            spoken.already ||
            ask.signal?.aborted === true
          ) {
            throw error;
          }
          const pause = Math.min(after + MARGIN, LONGEST);
          ask.onWait?.(pause);
          await sleep(pause, ask.signal);
        }
      }
    },
  };
}
