"use client"

import {
  LockingScript,
  P2PKH,
  PrivateKey,
  SatoshisPerKilobyte,
  Script,
  Transaction,
  isBroadcastFailure,
  type BroadcastFailure,
  type BroadcastResponse,
  type UnlockingScript,
} from "@bsv/sdk"

import { BitailsBroadcaster, fetchUnspentOutputs as fetchBitailsUnspent } from "./bitails"
import { HandCashKeyring, describeKeyPairProblem } from "./keyring"
import {
  WhatsOnChainBroadcaster,
  fetchOutputScript,
  fetchSpentOutpoints,
  fetchUnspentOutputs as fetchWocUnspent,
  fetchUsedAddresses,
} from "./whatsOnChain"
import { mapLimit } from "./concurrency"
import {
  DEFAULT_GAP_LIMIT,
  DERIVATION_ROOTS,
  SCAN_BATCH_SIZE,
  derivationPath,
} from "./derivation"
import {
  BSV20_CONTENT_TYPE,
  bsv20TransferLock,
  bsv21TransferLock,
  isCosignedScript,
  parseInscription,
} from "./inscription"
import {
  composeMneeTransfer,
  fetchMneeConfig,
  fetchMneeUtxos,
  splitMneeTransfer,
  submitMneeTransfer,
  type MneeUtxo,
} from "./mnee"
import {
  fetchOwnedTxos,
  inscriptionType,
  itemMetadata,
  outpointOf,
  type OneSatTxo,
} from "./oneSat"
import type {
  MneeTransferPlan,
  RawUtxo,
  RecoveryResult,
  ScanProgress,
  SweepPlan,
  SweepProgress,
  SweepResult,
  TokenBalance,
  WalletUtxo,
} from "./types"

/**
 * 1 satoshi per byte. The long-standing BSV relay standard — high enough that
 * every miner accepts the sweep, low enough to be immaterial (a 100-input
 * recovery costs roughly 15,000 satoshis).
 */
export const FEE_SATOSHIS_PER_KILOBYTE = 1000

/** Byte length of a P2PKH unlocking script: signature push plus pubkey push. */
const P2PKH_UNLOCK_LENGTH = 108

/** Tokens are keyed by BSV-21 id, or by `tick:<ticker>` for legacy BSV-20 v1. */
function tokenKey(id?: string, tick?: string): string | undefined {
  if (id) return id
  if (tick) return `tick:${tick.toUpperCase()}`
  return undefined
}

/**
 * An output found during the scan, before classification. Each source sees a
 * different slice of the wallet:
 *
 * - `plain` — Bitails / WhatsOnChain: outputs locked to the plain P2PKH script
 *   of the address. BSV, and items that were *transferred* (a transfer produces
 *   a plain 1-sat P2PKH output).
 * - `inscribed` — the 1Sat indexer: *minted* items and tokens, whose script is
 *   P2PKH plus an inscription envelope.
 * - `mnee` — the MNEE API: MNEE outputs under a cosigned lock.
 */
type Discovered = { path: string; root: string } & (
  | { source: "plain"; utxo: RawUtxo }
  | { source: "inscribed"; txo: OneSatTxo }
  | { source: "mnee"; utxo: MneeUtxo }
)

export class HandCashWallet {
  private readonly keyring: HandCashKeyring

  private constructor(keyring: HandCashKeyring) {
    this.keyring = keyring
  }

  /** Explains why a pair of keys was rejected, or returns null if both are usable. */
  static describeProblem(first: string, second: string): string | null {
    return describeKeyPairProblem(first, second)
  }

  /**
   * Rebuilds the wallet from the two extended private keys the HandCash app
   * exports.
   *
   * Each key is one share of a two-party key; the shares are composed
   * multiplicatively at each derivation path. See `HandCashKeyring` for the
   * reasoning.
   *
   * Addresses are derived as `deriveChild(root).deriveChild(childIndex)`,
   * rooted at each exported key.
   */
  static fromExtendedKeys(first: string, second: string): HandCashWallet {
    return new HandCashWallet(HandCashKeyring.fromExtendedKeys(first, second))
  }

  addressAt(path: string): string {
    return this.keyring.addressAt(path)
  }

  privateKeyAt(path: string): PrivateKey {
    return this.keyring.privateKeyAt(path)
  }

  /**
   * Walks every HandCash derivation root with gap-limit scanning, then
   * classifies each discovered output as BSV, an item, a token or MNEE.
   */
  async scan(
    onProgress?: (progress: ScanProgress) => void,
    { gapLimit = DEFAULT_GAP_LIMIT }: { gapLimit?: number } = {}
  ): Promise<RecoveryResult> {
    const discovered: Discovered[] = []
    let addressesScanned = 0
    let complete = true

    for (const [rootNumber, root] of DERIVATION_ROOTS.entries()) {
      let index = 0
      let lastHitIndex = -1

      for (;;) {
        const indexByAddress = new Map<string, number>()
        const addresses = Array.from({ length: SCAN_BATCH_SIZE }, (_, offset) => {
          const childIndex = index + offset
          const address = this.addressAt(derivationPath(root.path, childIndex))
          indexByAddress.set(address, childIndex)
          return address
        })
        const at = (childIndex: number) => ({
          path: derivationPath(root.path, childIndex),
          root: root.path,
        })

        // The three sources each see outputs the others cannot, so all of them
        // run for every step. Minted items only ever land on the items root, and
        // the 1Sat indexer has no bulk lookup, so it is asked there alone.
        const [history, mnee, inscribed] = await Promise.allSettled([
          fetchUsedAddresses(addresses),
          fetchMneeUtxos(addresses),
          root.expects === "items" ? fetchOwnedTxos(addresses) : Promise.resolve([]),
        ])

        // A failed lookup must not read as "nothing here": that would end the
        // scan early and report the wallet emptier than it is. Record it so the
        // user is told to scan again.
        for (const [name, result] of [["history", history], ["MNEE", mnee], ["1Sat", inscribed]] as const) {
          if (result.status === "rejected") {
            console.warn(`${name} lookup failed; the scan may be incomplete`, result.reason)
            complete = false
          }
        }

        // Only an address with plain history can hold a plain unspent output, so
        // when history is known the unspent lookup is limited to those. Without
        // it, every address is checked.
        const used = history.status === "fulfilled" ? history.value : null
        const candidates = used ? addresses.filter((address) => used.has(address)) : addresses
        const plain = await this.fetchPlainUnspent(candidates)
        addressesScanned += addresses.length

        const hits = new Set<string>(used ?? [])
        for (const utxo of plain) {
          const childIndex = indexByAddress.get(utxo.address)
          if (childIndex === undefined) continue
          discovered.push({ source: "plain", utxo, ...at(childIndex) })
          hits.add(utxo.address)
        }
        for (const utxo of mnee.status === "fulfilled" ? mnee.value : []) {
          const childIndex = indexByAddress.get(utxo.address)
          if (childIndex === undefined) continue
          discovered.push({ source: "mnee", utxo, ...at(childIndex) })
          hits.add(utxo.address)
        }
        for (const txo of inscribed.status === "fulfilled" ? inscribed.value : []) {
          const childIndex = txo.owner ? indexByAddress.get(txo.owner) : undefined
          if (childIndex === undefined) continue
          discovered.push({ source: "inscribed", txo, ...at(childIndex) })
          hits.add(txo.owner!)
        }

        // Outputs the history index cannot see (MNEE, minted items) still mark
        // their address as used, or a run of them would read as a gap.
        for (const address of hits) {
          lastHitIndex = Math.max(lastHitIndex, indexByAddress.get(address) ?? -1)
        }

        onProgress?.({
          root: root.path,
          rootLabel: root.label,
          rootNumber: rootNumber + 1,
          rootCount: DERIVATION_ROOTS.length,
          addressesScanned,
          utxosFound: discovered.length,
          done: false,
        })

        index += SCAN_BATCH_SIZE
        if (index - lastHitIndex - 1 >= gapLimit) break
      }
    }

    // The 1Sat indexer's spend index lags, so anything only it reported is
    // checked against WhatsOnChain. A spent output left in would invalidate the
    // whole sweep.
    const plainOutpoints = new Set(
      discovered.flatMap((d) => (d.source === "plain" ? [outpointOf(d.utxo.txid, d.utxo.vout)] : []))
    )
    const unvetted = discovered.flatMap((d) =>
      d.source === "inscribed" && !plainOutpoints.has(d.txo.outpoint) ? [d.txo.outpoint] : []
    )
    let spent = new Set<string>()
    try {
      spent = await fetchSpentOutpoints(unvetted)
    } catch (error) {
      console.warn("Could not confirm item outputs are unspent", error)
      complete = false
    }
    const utxos = await this.classify(
      discovered.filter((d) => d.source !== "inscribed" || !spent.has(d.txo.outpoint))
    )

    onProgress?.({
      root: "",
      rootLabel: "Complete",
      rootNumber: DERIVATION_ROOTS.length,
      rootCount: DERIVATION_ROOTS.length,
      addressesScanned,
      utxosFound: utxos.length,
      done: true,
    })

    return {
      utxos,
      satoshis: utxos
        .filter((utxo) => utxo.kind === "bsv")
        .reduce((total, utxo) => total + utxo.satoshis, 0),
      items: utxos.filter((utxo) => utxo.kind === "item"),
      tokens: aggregateTokens(utxos),
      addressesScanned,
      complete,
    }
  }

  /**
   * Bitails first, because its bulk lookup is fast. Any batch it fails or
   * truncates goes to WhatsOnChain, which pages through every output.
   */
  private async fetchPlainUnspent(addresses: string[]): Promise<RawUtxo[]> {
    if (addresses.length === 0) return []
    const { utxos, unresolved } = await fetchBitailsUnspent(addresses)
    if (unresolved.length === 0) return utxos
    return [...utxos, ...(await fetchWocUnspent(unresolved))]
  }

  /**
   * Turns discovered outputs into spendable, classified ones.
   *
   * The same outpoint can be reported by more than one source. The most
   * specific wins: MNEE, then inscribed, then plain — a cosigned or inscribed
   * output signed as plain P2PKH would never validate.
   *
   * One overlap is expected: the 1Sat indexer also tracks items that were
   * *transferred* in, which are plain P2PKH and so also reported by the address
   * indexers. Those keep the indexer's name and image but are signed as P2PKH,
   * with no script to fetch — address indexers only ever report plain scripts.
   */
  private async classify(discovered: Discovered[]): Promise<WalletUtxo[]> {
    const precedence = { mnee: 0, inscribed: 1, plain: 2 } as const
    const byOutpoint = new Map<string, Discovered>()
    const plainOutpoints = new Set<string>()
    for (const entry of discovered) {
      const { txid, vout } = entry.source === "inscribed" ? entry.txo : entry.utxo
      const key = outpointOf(txid, vout)
      if (entry.source === "plain") plainOutpoints.add(key)
      const current = byOutpoint.get(key)
      if (!current || precedence[entry.source] < precedence[current.source]) {
        byOutpoint.set(key, entry)
      }
    }

    const hasMnee = Array.from(byOutpoint.values()).some((entry) => entry.source === "mnee")
    const mneeConfig = hasMnee ? await fetchMneeConfig() : undefined

    const classified = await mapLimit(
      Array.from(byOutpoint.values()),
      4,
      async (entry): Promise<WalletUtxo | null> => {
        const base = { derivationPath: entry.path, derivationRoot: entry.root }

        if (entry.source === "mnee") {
          const { utxo } = entry
          return {
            ...base,
            txid: utxo.txid,
            vout: utxo.vout,
            satoshis: 1,
            address: utxo.address,
            kind: "mnee",
            lockingScript: utxo.script,
            token: {
              id: mneeConfig!.tokenId,
              symbol: "MNEE",
              decimals: mneeConfig!.decimals,
              amount: utxo.amount.toString(),
            },
          } satisfies WalletUtxo
        }

        if (entry.source === "plain") {
          const { utxo } = entry
          // Found by the plain P2PKH script, so that *is* its locking script.
          // Transferring a 1Sat ordinal produces exactly this kind of output — the
          // item travels with the satoshi — so anything worth exactly 1 satoshi is
          // treated as an item. Being wrong that way costs one satoshi sent as its
          // own output; the opposite mistake destroys a collectible.
          return {
            ...base,
            txid: utxo.txid,
            vout: utxo.vout,
            satoshis: utxo.satoshis,
            address: utxo.address,
            kind: utxo.satoshis === 1 ? "item" : "bsv",
            ...(utxo.satoshis === 1 ? { item: {} } : {}),
          } satisfies WalletUtxo
        }

        const { txo } = entry
        const inscribedBase = {
          ...base,
          txid: txo.txid,
          vout: txo.vout,
          satoshis: txo.satoshis,
          address: txo.owner!,
        }

        if (inscriptionType(txo) === BSV20_CONTENT_TYPE) {
          // Token scripts are small, and the amount has to be read from the
          // script itself to merge outputs exactly.
          let script: Script
          try {
            script = await fetchOutputScript(txo.txid, txo.vout)
          } catch (error) {
            console.warn(`Skipping ${txo.outpoint}: locking script unavailable`, error)
            return null
          }
          if (isCosignedScript(script)) {
            // A cosigned token the MNEE API did not report cannot be moved with
            // these keys alone. Leaving it out keeps the sweep valid.
            console.warn(`Skipping ${txo.outpoint}: cosigned output not recognised as MNEE`)
            return null
          }
          const bsv20 = parseInscription(script)?.bsv20
          const key = tokenKey(bsv20?.id, bsv20?.tick)
          if (bsv20 && key && bsv20.amt) {
            return {
              ...inscribedBase,
              kind: "token",
              lockingScript: script.toHex(),
              token: {
                id: key,
                symbol: bsv20.sym ?? bsv20.tick ?? key.slice(0, 8),
                decimals: Number(bsv20.dec ?? 0),
                amount: bsv20.amt,
              },
            } satisfies WalletUtxo
          }
        }

        return {
          ...inscribedBase,
          kind: "item",
          fetchScriptToSign: !plainOutpoints.has(txo.outpoint),
          item: itemMetadata(txo) ?? {},
        } satisfies WalletUtxo
      }
    )

    return classified.filter((utxo): utxo is WalletUtxo => utxo !== null)
  }

  /**
   * Estimates what a sweep of `utxos` to `destination` would move, without
   * signing anything. Throws for the same reasons `sweep` would.
   */
  async plan(destination: string, utxos: WalletUtxo[]): Promise<SweepPlan> {
    assertAddress(destination)
    const { main, mnee } = splitByTransfer(utxos)
    if (main.length === 0 && mnee.length === 0) {
      throw new Error("There is nothing to recover.")
    }

    let bsv = { satoshisToSend: 0, itemCount: 0, tokenCount: 0, feeSatoshis: 0 }
    if (main.length > 0) {
      const { tx, satoshisIn, fixedOutputSatoshis, itemCount, tokenCount } =
        this.composeSweep(destination, main)
      const fee = await new SatoshisPerKilobyte(FEE_SATOSHIS_PER_KILOBYTE).computeFee(tx)
      const change = satoshisIn - fixedOutputSatoshis - fee
      if (change <= 0) {
        throw new InsufficientFundsError(fee, satoshisIn - fixedOutputSatoshis)
      }
      bsv = { satoshisToSend: change, itemCount, tokenCount, feeSatoshis: fee }
    }

    return {
      destination,
      ...bsv,
      inputCount: main.length,
      mnee: mnee.length > 0 ? await planMnee(mnee) : null,
    }
  }

  /**
   * Moves everything to `destination`: one transaction for BSV, items and
   * tokens, then — if the wallet holds MNEE — a second one through the MNEE
   * cosigner.
   *
   * The main sweep goes first. If it fails, nothing has moved and the error is
   * thrown. If it succeeds and the MNEE transfer then fails, the result says so
   * rather than throwing, because the first transaction is already on chain.
   */
  async sweep(
    destination: string,
    utxos: WalletUtxo[],
    onProgress?: (progress: SweepProgress) => void
  ): Promise<SweepResult> {
    assertAddress(destination)
    const { main, mnee } = splitByTransfer(utxos)
    const result: SweepResult = {}

    if (main.length > 0) {
      const scriptsToFetch = main.filter((utxo) => utxo.fetchScriptToSign).length
      let fetched = 0
      onProgress?.({ stage: "scripts", completed: 0, total: scriptsToFetch })

      const { tx, satoshisIn, fixedOutputSatoshis } = this.composeSweep(destination, main, () => {
        fetched += 1
        onProgress?.({ stage: "scripts", completed: fetched, total: scriptsToFetch })
      })

      const fee = await new SatoshisPerKilobyte(FEE_SATOSHIS_PER_KILOBYTE).computeFee(tx)
      const change = satoshisIn - fixedOutputSatoshis - fee
      if (change <= 0) {
        throw new InsufficientFundsError(fee, satoshisIn - fixedOutputSatoshis)
      }
      tx.outputs[tx.outputs.length - 1].satoshis = change

      await tx.sign()

      onProgress?.({ stage: "broadcast" })
      result.txid = await broadcast(tx)
    }

    if (mnee.length > 0) {
      onProgress?.({ stage: "mnee" })
      try {
        const config = await fetchMneeConfig()
        const pathByOutpoint = new Map(mnee.map((u) => [outpointOf(u.txid, u.vout), u.derivationPath]))
        const { tx } = await composeMneeTransfer(mnee.map(toMneeUtxo), destination, config, (utxo) =>
          this.privateKeyAt(pathByOutpoint.get(outpointOf(utxo.txid, utxo.vout))!)
        )
        result.mneeTxid = await submitMneeTransfer(tx)
      } catch (error) {
        if (!result.txid) throw error
        result.mneeError = error instanceof Error ? error.message : "The MNEE transfer failed."
      }
    }

    return result
  }

  /**
   * Builds the unsigned main sweep. MNEE is never part of it.
   *
   * Ordering is load-bearing. 1Sat Ordinals are tracked by satoshi position, so
   * every item input must map onto the item output at the same offset: items
   * first (1:1, in order), then merged token outputs, then BSV change last.
   * Getting this wrong silently destroys collectibles.
   */
  private composeSweep(destination: string, utxos: WalletUtxo[], onScriptFetched?: () => void) {
    if (utxos.length === 0) {
      throw new Error("There is nothing to recover.")
    }
    assertAddress(destination)

    const items = utxos.filter((utxo) => utxo.kind === "item")
    const tokens = utxos.filter((utxo) => utxo.kind === "token")
    const coins = utxos.filter((utxo) => utxo.kind === "bsv")
    if (items.length + tokens.length + coins.length !== utxos.length) {
      throw new Error("MNEE outputs are moved through the MNEE cosigner, not the main sweep.")
    }

    const tx = new Transaction()

    for (const utxo of [...items, ...tokens, ...coins]) {
      tx.addInput({
        sourceTXID: utxo.txid,
        sourceOutputIndex: utxo.vout,
        unlockingScriptTemplate: this.unlockTemplate(utxo, onScriptFetched),
        sequence: 0xffffffff,
      })
    }

    // Items: one output each, same order as the inputs.
    for (let i = 0; i < items.length; i++) {
      tx.addOutput({ lockingScript: new P2PKH().lock(destination), satoshis: 1 })
    }

    // Tokens: all outputs of a given token merge into one, so no token change
    // is needed and nothing can be stranded.
    const tokenTotals = new Map<string, { amount: bigint; tick?: string }>()
    for (const utxo of tokens) {
      const token = utxo.token!
      const current = tokenTotals.get(token.id) ?? {
        amount: 0n,
        tick: token.id.startsWith("tick:") ? token.id.slice(5) : undefined,
      }
      current.amount += BigInt(token.amount)
      tokenTotals.set(token.id, current)
    }

    for (const [id, { amount, tick }] of tokenTotals) {
      const p2pkh = new P2PKH().lock(destination)
      tx.addOutput({
        lockingScript: tick
          ? bsv20TransferLock(p2pkh, tick, amount.toString())
          : bsv21TransferLock(p2pkh, id, amount.toString()),
        satoshis: 1,
      })
    }

    // BSV change, last. Placeholder amount — the byte width is fixed, so it
    // does not affect fee estimation.
    tx.addOutput({ lockingScript: new P2PKH().lock(destination), satoshis: 1 })

    const satoshisIn = utxos.reduce((total, utxo) => total + utxo.satoshis, 0)
    const fixedOutputSatoshis = items.length + tokenTotals.size

    return {
      tx,
      satoshisIn,
      fixedOutputSatoshis,
      itemCount: items.length,
      tokenCount: tokenTotals.size,
    }
  }

  /**
   * Signs against the output's *real* locking script — the signature commits to
   * it, so a reconstructed P2PKH only works for outputs that are plain P2PKH.
   *
   * Minted items carry their whole image in the script, so theirs is fetched
   * only when the input is signed and dropped straight after: a large
   * collection never has to sit in memory at once.
   */
  private unlockTemplate(utxo: WalletUtxo, onScriptFetched?: () => void) {
    const key = this.privateKeyAt(utxo.derivationPath)
    const unlockWith = (script: Script) => {
      if (isCosignedScript(script)) {
        throw new Error(`${utxo.txid}_${utxo.vout} needs a cosigner signature and cannot be swept here.`)
      }
      return new P2PKH().unlock(key, "all", false, utxo.satoshis, script)
    }

    if (!utxo.fetchScriptToSign) {
      const script = utxo.lockingScript
        ? Script.fromHex(utxo.lockingScript)
        : new P2PKH().lock(utxo.address)
      return unlockWith(script)
    }

    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        const script = await fetchOutputScript(utxo.txid, utxo.vout)
        onScriptFetched?.()
        return unlockWith(script).sign(tx, inputIndex)
      },
      estimateLength: async () => P2PKH_UNLOCK_LENGTH,
    }
  }
}

function assertAddress(destination: string): LockingScript {
  try {
    return new P2PKH().lock(destination)
  } catch {
    throw new Error("That is not a valid Bitcoin SV address.")
  }
}

function splitByTransfer(utxos: WalletUtxo[]) {
  return {
    main: utxos.filter((utxo) => utxo.kind !== "mnee"),
    mnee: utxos.filter((utxo) => utxo.kind === "mnee"),
  }
}

function toMneeUtxo(utxo: WalletUtxo): MneeUtxo {
  return {
    address: utxo.address,
    txid: utxo.txid,
    vout: utxo.vout,
    amount: BigInt(utxo.token!.amount),
    script: utxo.lockingScript!,
  }
}

async function planMnee(utxos: WalletUtxo[]): Promise<MneeTransferPlan> {
  const config = await fetchMneeConfig()
  const total = utxos.reduce((sum, utxo) => sum + BigInt(utxo.token!.amount), 0n)
  const amounts = splitMneeTransfer(total, config)
  return amounts
    ? { ...amounts, decimals: config.decimals, inputCount: utxos.length }
    : {
        send: 0n,
        fee: 0n,
        decimals: config.decimals,
        inputCount: utxos.length,
        problem: "The MNEE balance is too small to cover the MNEE transfer fee.",
      }
}

/**
 * Bitails first, WhatsOnChain as the alternative. If Bitails accepted the
 * transaction but its answer was lost, WhatsOnChain reports it as already
 * known — that is a success, not a failure.
 */
async function broadcast(tx: Transaction): Promise<string> {
  const failures: BroadcastFailure[] = []
  for (const broadcaster of [new BitailsBroadcaster(), new WhatsOnChainBroadcaster()]) {
    const result: BroadcastResponse | BroadcastFailure = await tx.broadcast(broadcaster)
    if (!isBroadcastFailure(result)) return result.txid
    if (/already (known|in the mempool|have)|txn-already/i.test(result.description)) {
      return tx.id("hex")
    }
    failures.push(result)
  }
  throw new Error(`Broadcast rejected: ${failures.map((failure) => failure.description).join(" / ")}`)
}

export class InsufficientFundsError extends Error {
  constructor(
    readonly feeSatoshis: number,
    readonly availableSatoshis: number
  ) {
    super(
      `This wallet does not hold enough BSV to pay the ${feeSatoshis.toLocaleString()} satoshi network fee.`
    )
    this.name = "InsufficientFundsError"
  }
}

function aggregateTokens(utxos: WalletUtxo[]): TokenBalance[] {
  const balances = new Map<string, TokenBalance>()

  for (const utxo of utxos) {
    if ((utxo.kind !== "token" && utxo.kind !== "mnee") || !utxo.token) continue
    const { id, symbol, decimals, amount } = utxo.token
    const existing = balances.get(id)
    if (existing) {
      existing.amount += BigInt(amount)
      existing.outputCount += 1
    } else {
      balances.set(id, {
        id,
        symbol,
        decimals,
        amount: BigInt(amount),
        outputCount: 1,
        cosigned: utxo.kind === "mnee",
      })
    }
  }

  return Array.from(balances.values()).sort((a, b) => a.symbol.localeCompare(b.symbol))
}
