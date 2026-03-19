import { Curve, HD, PrivateKey } from "@bsv/sdk"

/**
 * HandCash two-party key recovery.
 *
 * The HandCash app exports a wallet as **two extended private keys** (`xprv…`),
 * one per share of a two-party ECDSA key. Neither can spend on its own:
 *
 *   https://medium.com/cryptoadvance/ecdsa-is-not-that-bad-two-party-signing-without-schnorr-or-bls-1941806ec36f
 *
 * The shares are **multiplicative**, so holding both lets us compose the real
 * private key directly and sign normally:
 *
 *   d = (d₁ · d₂) mod n
 *
 * The public key is then `(d₁·d₂)·G`, the same point as `(d₁·G)·d₂`.
 *
 * Both shares are derived at the *same* path before being combined, and paths
 * are taken relative to the exported keys.
 */

export const KEY_SHARE_COUNT = 2

const XPRV_PREFIX = "xprv"

/**
 * Pulls every extended key out of pasted text, so an export copied as one
 * block — both keys, labels, line breaks — still lands in the right fields.
 */
export function extractExtendedKeys(text: string): string[] {
  return text.match(/\b[xt](?:prv|pub)[1-9A-HJ-NP-Za-km-z]{100,}/g) ?? []
}

/** Parses one exported share, or returns null if it is not a usable xprv. */
export function parseExtendedPrivateKey(input: string): HD | null {
  const key = input.trim()
  if (!key.startsWith(XPRV_PREFIX)) return null
  try {
    const hd = HD.fromString(key)
    // `fromString` also accepts an xpub; only a private key can sign.
    return hd.privKey ? hd : null
  } catch {
    return null
  }
}

/** Explains why a single key was rejected, or returns null if it is fine. */
export function describeKeyProblem(input: string): string | null {
  const key = input.trim()

  if (key.length === 0) return "Paste the key here."
  if (parseExtendedPrivateKey(key)) return null

  if (key.startsWith("xpub")) {
    return "This is a public key (xpub). Recovery needs the private key, which starts with xprv."
  }
  if (key.startsWith("tprv") || key.startsWith("tpub")) {
    return "This is a testnet key. HandCash wallets use mainnet keys, which start with xprv."
  }
  if (!key.startsWith(XPRV_PREFIX)) {
    return "An extended private key starts with xprv."
  }
  return "This key is not valid. Make sure it was copied in full, with no characters missing or changed."
}

/**
 * Explains why the pair was rejected, or returns null if both keys are usable.
 * Checks each key first so the message points at the field that is wrong.
 */
export function describeKeyPairProblem(first: string, second: string): string | null {
  const firstProblem = describeKeyProblem(first)
  if (firstProblem) return `First key: ${firstProblem}`

  const secondProblem = describeKeyProblem(second)
  if (secondProblem) return `Second key: ${secondProblem}`

  // The same share twice composes d², a valid key for a wallet nobody owns.
  if (first.trim() === second.trim()) {
    return "Both fields hold the same key. Enter the two different keys from your export."
  }
  return null
}

export class HandCashKeyring {
  /** One extended key per share. */
  private readonly shares: HD[]

  /**
   * Derivation is the hot path — a scan derives well over a thousand
   * addresses — so the `m/<root>` node is derived once per root and only the
   * child index is derived per address.
   */
  private readonly rootNodes = new Map<string, HD[]>()
  private readonly addresses = new Map<string, string>()

  private constructor(shares: HD[]) {
    this.shares = shares
  }

  /**
   * Builds the keyring from the two exported keys. Order does not matter:
   * multiplication mod n is commutative.
   */
  static fromExtendedKeys(first: string, second: string): HandCashKeyring {
    const problem = describeKeyPairProblem(first, second)
    if (problem) throw new Error(problem)

    return new HandCashKeyring([
      parseExtendedPrivateKey(first) as HD,
      parseExtendedPrivateKey(second) as HD,
    ])
  }

  private nodesForRoot(rootPath: string): HD[] {
    const cached = this.rootNodes.get(rootPath)
    if (cached) return cached
    const nodes = this.shares.map((share) => share.derive(rootPath))
    this.rootNodes.set(rootPath, nodes)
    return nodes
  }

  /** Composes the spendable private key at `path` (e.g. `m/4/12`). */
  privateKeyAt(path: string): PrivateKey {
    const separator = path.lastIndexOf("/")
    const rootPath = path.slice(0, separator)
    const childIndex = Number(path.slice(separator + 1))

    const [first, second] = this.nodesForRoot(rootPath).map(
      (node) => node.deriveChild(childIndex).privKey
    )

    const composed = first.mul(second).umod(new Curve().n)
    if (composed.isZero()) {
      // Only reachable if a share is a multiple of n, which a valid BIP-32
      // derivation never produces.
      throw new Error(`Recovered an invalid key at ${path}.`)
    }
    return PrivateKey.fromHex(composed.toHex(32))
  }

  addressAt(path: string): string {
    const cached = this.addresses.get(path)
    if (cached) return cached
    const address = this.privateKeyAt(path).toPublicKey().toAddress().toString()
    this.addresses.set(path, address)
    return address
  }
}
