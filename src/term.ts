// What the terminal gets: color only where it helps, debug lines on request. Both go to stderr.

const env = process.env;

/**
 * Color on stderr, following clig.dev: FORCE_COLOR turns it on (FORCE_COLOR=0 off), and NO_COLOR, TERM=dumb,
 * --no-color or a stderr that isn't a terminal turn it off.
 */
export function colorEnabled(stream: { isTTY?: boolean } = process.stderr) {
  if (env.CLONVO_NO_COLOR_FLAG) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return !!stream.isTTY;
}

const paint = (open: string, close: string) => (s: string) => (colorEnabled() ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const dim = paint("2", "22");
export const red = paint("31", "39");
export const yellow = paint("33", "39");

/** --debug or CLONVO_DEBUG=1: one line per HTTP request on stderr, with no headers or bodies. */
export const debugEnabled = () => !!env.CLONVO_DEBUG && env.CLONVO_DEBUG !== "0" && env.CLONVO_DEBUG !== "false";

export function debug(line: string) {
  if (debugEnabled()) process.stderr.write(`${dim(`[debug] ${line}`)}\n`);
}

/** Running in CI, where nothing should prompt or nag. */
export const inCI = () => !!(env.CI || env.GITHUB_ACTIONS || env.BUILDKITE || env.CIRCLECI || env.GITLAB_CI || env.JENKINS_URL || env.TF_BUILD);
