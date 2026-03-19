export type AssetKind = "bsv" | "item" | "token" | "mnee"

/** An unspent output as an address indexer reports it. */
export interface RawUtxo {
  address: string
  txid: string
  vout: number
  satoshis: number
  blockHeight?: number
}

/** A spendable output owned by one of the wallet's derived addresses. */
export interface WalletUtxo {
  txid: string
  vout: number
  satoshis: number
  address: string
  /** Full path, e.g. `m/4/12`. */
  derivationPath: string
  /** Root path the address came from, e.g. `m/4`. */
  derivationRoot: string
  kind: AssetKind
  /**
   * The output's real locking script, hex, when it is not plain P2PKH to
   * `address` and is small enough to keep (tokens, MNEE).
   */
  lockingScript?: string
  /**
   * The locking script is not plain P2PKH and too large to keep in memory
   * (a minted item carries its whole image). It is fetched from WhatsOnChain
   * while signing, one output at a time. Signing against a reconstructed P2PKH
   * would produce a signature that never validates.
   */
  fetchScriptToSign?: boolean
  /** Present when `kind === "item"`. */
  item?: ItemDetails
  /** Present when `kind === "token"` or `kind === "mnee"`. */
  token?: TokenOutputDetails
}

export interface ItemDetails {
  /** 1Sat origin outpoint, `<txid>_<vout>`, stable across transfers. */
  origin?: string
  name?: string
  collection?: string
  contentType?: string
  imageUrl?: string
}

export interface TokenOutputDetails {
  /** BSV-21 token id (`<txid>_<vout>` of the deploy+mint). */
  id: string
  symbol: string
  decimals: number
  /** Raw amount in base units, as a decimal string (may exceed Number.MAX_SAFE_INTEGER). */
  amount: string
}

export interface TokenBalance {
  id: string
  symbol: string
  decimals: number
  iconUrl?: string
  /** Summed base units across all of the wallet's outputs. */
  amount: bigint
  outputCount: number
  /** MNEE: moved through the MNEE cosigner rather than the main sweep. */
  cosigned?: boolean
}

export interface ScanProgress {
  /** Derivation root currently being scanned. */
  root: string
  rootLabel: string
  /** Index of the root within `DERIVATION_ROOTS`. */
  rootNumber: number
  rootCount: number
  addressesScanned: number
  utxosFound: number
  done: boolean
}

export interface SweepProgress {
  stage: "scripts" | "broadcast" | "mnee"
  /** Item scripts fetched so far, during `scripts`. */
  completed?: number
  total?: number
}

export interface RecoveryResult {
  utxos: WalletUtxo[]
  satoshis: number
  items: WalletUtxo[]
  tokens: TokenBalance[]
  addressesScanned: number
  /**
   * False when a lookup failed during the scan — address history, the MNEE API
   * or the 1Sat indexer. The scan carried on, but it may have stopped early or
   * missed outputs only that source can see, so the user should scan again.
   */
  complete: boolean
}

export interface SweepPlan {
  destination: string
  satoshisToSend: number
  itemCount: number
  tokenCount: number
  inputCount: number
  feeSatoshis: number
  /** The MNEE transfer, when the wallet holds any. Sent as a second transaction. */
  mnee: MneeTransferPlan | null
}

export interface MneeTransferPlan {
  /** Atomic units that arrive at the destination. */
  send: bigint
  /** Atomic units the MNEE API keeps as its fee. */
  fee: bigint
  decimals: number
  inputCount: number
  /** Why the MNEE cannot be moved, when it cannot. */
  problem?: string
}

export interface SweepResult {
  /** The main sweep: BSV, items and other tokens. Absent when there was none. */
  txid?: string
  /** The MNEE transfer, cosigned and broadcast by the MNEE API. */
  mneeTxid?: string
  /** Set when the main sweep went through but the MNEE transfer did not. */
  mneeError?: string
}
