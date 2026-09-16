import type { Bridge } from "../shared/ipc.js";

/**
 * The engine, as the window can reach it.
 *
 * The interface itself lives in `shared/ipc.ts`, which is the one file both
 * sides of the boundary can see -- the preload is compiled by the root
 * project, this directory is not, so shared is the only place a type can be
 * declared once and conformed to by the preload that actually implements it.
 *
 * It used to be declared here as well, in full, imported by nobody but this
 * file and connected to the preload by nothing. The two copies had already
 * drifted: `stop` returned a promise in one and not the other, and the shared
 * one was missing a method the preload exposed.
 *
 * Everything crosses a process boundary as plain data, so nothing that comes
 * back can be trusted to have a shape merely because TypeScript says so. It is
 * typed for the window's benefit; the checking that matters happens on the
 * other side, where the data is produced.
 */
export type { Bridge };

declare global {
  interface Window {
    readonly synartesis: Bridge;
  }
}

export const engine: Bridge = window.synartesis;
