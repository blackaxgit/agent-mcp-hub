/**
 * Canonical zero-dep `ansi-regex` pattern source. Matches 7-bit `ESC[…`, 8-bit
 * CSI (``), OSC (`ESC]…BEL`), private `?`/`#` params, SGR, and cursor
 * moves. Built with the `g` flag so `.replace` clears every occurrence. Kept as
 * a string so the source is auditable against upstream.
 */
const ANSI_PATTERN =
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))";

/**
 * Remove ANSI escape sequences and collapse carriage-return spinner runs so the
 * text is safe to embed in a plain MCP message. Pure: no I/O.
 */
export function stripAnsi(s: string): string {
  return s.replace(new RegExp(ANSI_PATTERN, "g"), "").replace(/\r+/g, "");
}
