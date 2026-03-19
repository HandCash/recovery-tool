/**
 * HandCash HD derivation scheme.
 *
 * HandCash wallets do not use BIP-44. Addresses are derived directly from each
 * exported key as `m/<root>/<childIndex>`, with no account or purpose level in
 * between.
 */

export interface DerivationRoot {
  /** Root path, e.g. `m/4`. */
  path: string
  /** Human readable name, shown while scanning. */
  label: string
  /**
   * What the tool expects to find under this root. Every root is scanned for
   * BSV, items and MNEE alike; `items` additionally asks the 1Sat indexer for
   * minted items, which has no bulk lookup and is too slow to ask about every
   * root.
   */
  expects: "bsv" | "items" | "tokens"
}

/**
 * Every root is walked the same way rather than special-cased: with a
 * history-based gap an untouched root terminates quickly, and nothing has to be
 * assumed about which roots or indices are in use.
 */
export const DERIVATION_ROOTS: DerivationRoot[] = [
  { path: "m/0", label: "BSV", expects: "bsv" },
  { path: "m/1", label: "BSV", expects: "bsv" },
  { path: "m/2", label: "BSV", expects: "bsv" },
  { path: "m/3", label: "BSV", expects: "bsv" },
  { path: "m/4", label: "BSV", expects: "bsv" },
  { path: "m/5", label: "BSV", expects: "bsv" },
  { path: "m/6", label: "BSV", expects: "bsv" },
  { path: "m/7", label: "Tokens", expects: "tokens" },
  { path: "m/8", label: "Tokens", expects: "tokens" },
  { path: "m/9", label: "Items", expects: "items" },
]

/**
 * How many consecutive **unused** addresses to check before concluding a
 * derivation root is exhausted. An address counts as used if it has any
 * transaction history, or holds MNEE or minted items (which history cannot
 * see).
 *
 * History, not unspent outputs, is the signal: wallet addresses are routinely
 * emptied after use, so a used address is very often empty today.
 *
 * HandCash wallets can leave long runs of addresses that were never used, so
 * the gap is far larger than the usual BIP-44 convention of 20. 1,000 is a
 * compromise between coverage and scan time; see the README's troubleshooting
 * section for raising it.
 */
export const DEFAULT_GAP_LIMIT = 1000

/**
 * Addresses derived per scan step. The history endpoint caps at 20 per call, so
 * each step issues two of those concurrently.
 */
export const SCAN_BATCH_SIZE = 40

export function derivationPath(root: string, index: number): string {
  return `${root}/${index}`
}
