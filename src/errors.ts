// The CLI's error type, and the guards on what reaches your terminal.

export class ClonvoError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/**
 * Text from the network (error messages, tool descriptions, key labels) with control characters removed, so a page
 * a tool read can't send escape sequences to your terminal. Tabs and newlines stay.
 */
export const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "");

/**
 * JSON for the terminal. JSON.stringify already escapes C0 controls; this also escapes DEL, the C1 range (an 8-bit
 * CSI is U+009B) and bidirectional overrides, which it leaves raw.
 */
export const safeJson = (value: unknown, compact: boolean) =>
  (compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)).replace(
    /[\u007f-\u009f​-‏‪-‮⁦-⁩]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
