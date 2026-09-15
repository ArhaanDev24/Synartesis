/**
 * Every flag `synartesis proxy` takes.
 *
 * In its own file because two things read it and they must not drift apart:
 * the proxy itself, which rejects anything not here, and the cli, which has to
 * tell somebody who typed `--http` on `list` that it is a real flag on the
 * wrong command rather than a word nobody has heard of. Getting that wrong
 * sends people to the help page looking for a flag that is already in it.
 */
export const PROXY_FLAGS = [
  "--manifest",
  "--journal",
  "--server",
  "--gate-timeout",
  "--log-level",
  "--http",
  "--http-host",
  "--http-idle",
  "--token",
] as const;
