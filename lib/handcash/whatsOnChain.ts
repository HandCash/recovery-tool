import {
  Script,
  type BroadcastFailure,
  type BroadcastResponse,
  type Broadcaster,
  type Transaction,
} from "@bsv/sdk"

import { chunk, createLimiter, fetchWithTimeout, withRetry } from "./concurrency"
import type { RawUtxo } from "./types"

/**
 * WhatsOnChain. Three jobs:
 *
 * - **Transaction history**, which drives the gap limit. The gap has to be
 *   measured against history, not current unspent outputs: an address that
 *   received funds and was later swept holds nothing today but still marks the
 *   derivation sequence as live, and wallet addresses are routinely emptied
 *   after use.
 * - **Unspent outputs**, as the alternative to Bitails whenever Bitails fails
 *   or truncates its answer.
 * - **Locking scripts** of individual outputs and **broadcasting**, where the
 *   Bitails equivalents are unreliable.
 *
 * Like every address indexer, it keys addresses by the *plain* P2PKH script,
 * so outputs carrying an inscription or an MNEE cosigner lock are invisible
 * here — not even in history. Those come from the 1Sat indexer and the MNEE
 * API instead.
 */
const API = "https://api.whatsonchain.com/v1/bsv/main"

/** The bulk endpoints (history, spent) reject more than 20 entries per call with a 400. */
const ADDRESS_BATCH_SIZE = 20

/** Largest page the unspent endpoint serves; pages chain with `nextPageToken`. */
const UNSPENT_PAGE_SIZE = 1000

/**
 * The free tier allows roughly 3 requests per second. One limiter is shared by
 * every call in this module, so a history scan, an unspent fallback and script
 * fetches during signing cannot add up past it.
 */
const limit = createLimiter(2)

async function request(path: string, init?: RequestInit): Promise<Response> {
  return limit(() =>
    withRetry(async () => {
      const response = await fetchWithTimeout(`${API}${path}`, init)
      // 404 is a real answer ("no such output") and must not be retried away.
      if (!response.ok && response.status !== 404) {
        throw new Error(`WhatsOnChain ${path.split("?")[0]} failed: ${response.status}`)
      }
      return response
    })
  )
}

interface HistoryEntry {
  address: string
  history?: Array<{ tx_hash: string; height: number }> | null
  error?: string
}

/**
 * Returns the subset of `addresses` that have at least one transaction.
 *
 * Throws if the lookup fails after retries — the caller decides whether to
 * degrade, because silently returning an empty set would look identical to
 * "none of these addresses were ever used" and would end the scan early.
 */
export async function fetchUsedAddresses(addresses: string[]): Promise<Set<string>> {
  const results = await Promise.all(
    chunk(addresses, ADDRESS_BATCH_SIZE).map(async (batch) => {
      const response = await request("/addresses/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses: batch }),
      })
      return (await response.json()) as HistoryEntry[]
    })
  )

  const used = new Set<string>()
  for (const entry of results.flat()) {
    if (entry?.address && (entry.history?.length ?? 0) > 0) {
      used.add(entry.address)
    }
  }
  return used
}

interface UnspentPage {
  result?: Array<{ tx_hash: string; tx_pos: number; value: number; height?: number }> | null
  nextPageToken?: string
  error?: string
}

async function fetchUnspentForAddress(address: string): Promise<RawUtxo[]> {
  const utxos: RawUtxo[] = []
  const add = (page: UnspentPage) => {
    for (const utxo of page.result ?? []) {
      utxos.push({
        address,
        txid: utxo.tx_hash,
        vout: utxo.tx_pos,
        satoshis: utxo.value,
        blockHeight: utxo.height || undefined,
      })
    }
  }

  // Confirmed outputs are paged; follow every page, or a busy address would be
  // cut short exactly the way Bitails' bulk endpoint cuts it.
  let token: string | undefined
  do {
    const query = `limit=${UNSPENT_PAGE_SIZE}${token ? `&token=${token}` : ""}`
    const response = await request(`/address/${address}/confirmed/unspent?${query}`)
    // An address with no confirmed outputs is answered with a plain-text 404.
    if (response.status === 404) break
    const page = (await response.json()) as UnspentPage
    add(page)
    token = page.nextPageToken || undefined
  } while (token)

  add((await (await request(`/address/${address}/unconfirmed/unspent`)).json()) as UnspentPage)

  // A mempool output is listed in both while it confirms.
  const seen = new Set<string>()
  return utxos.filter((utxo) => {
    const key = `${utxo.txid}_${utxo.vout}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Every unspent output on `addresses`, confirmed or not, with no truncation. */
export async function fetchUnspentOutputs(addresses: string[]): Promise<RawUtxo[]> {
  const results = await Promise.all(addresses.map(fetchUnspentForAddress))
  return results.flat()
}

interface SpentEntry {
  utxo: { txid: string; vout: number }
  spentIn?: { txid: string }
}

/**
 * Which of `outpoints` (`<txid>_<vout>`) have already been spent. Used to vet
 * outputs the 1Sat indexer reports as unspent: its spend index lags, and a
 * single already-spent input makes the whole sweep transaction invalid.
 */
export async function fetchSpentOutpoints(outpoints: string[]): Promise<Set<string>> {
  const results = await Promise.all(
    chunk(outpoints, ADDRESS_BATCH_SIZE).map(async (batch) => {
      const response = await request("/utxos/spent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utxos: batch.map((outpoint) => {
            const [txid, vout] = outpoint.split("_")
            return { txid, vout: Number(vout) }
          }),
        }),
      })
      return (await response.json()) as SpentEntry[]
    })
  )
  return new Set(
    results
      .flat()
      .filter((entry) => entry.spentIn?.txid)
      .map((entry) => `${entry.utxo.txid}_${entry.utxo.vout}`)
  )
}

/**
 * Fetches the locking script of a single output. Minted items carry their whole
 * image in the script, so fetching one output rather than the transaction that
 * made it is the difference between ~70 KB and several megabytes.
 */
export async function fetchOutputScript(txid: string, vout: number): Promise<Script> {
  const response = await request(`/tx/${txid}/out/${vout}/hex`)
  if (!response.ok) {
    throw new Error(`Output ${txid}_${vout} was not found on WhatsOnChain.`)
  }
  return Script.fromHex((await response.text()).trim())
}

export class WhatsOnChainBroadcaster implements Broadcaster {
  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    try {
      const response = await limit(() =>
        fetchWithTimeout(
          `${API}/tx/raw`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txhex: tx.toHex() }),
          },
          120_000
        )
      )
      const body = (await response.text()).trim().replace(/^"|"$/g, "")
      if (response.ok && /^[0-9a-f]{64}$/i.test(body)) {
        return { status: "success", txid: body, message: "broadcast" }
      }
      return {
        status: "error",
        code: String(response.status),
        description: body || "Broadcast rejected",
      }
    } catch (error) {
      return {
        status: "error",
        code: "network",
        description: error instanceof Error ? error.message : "Network error",
      }
    }
  }
}
