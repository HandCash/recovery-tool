import type { BroadcastFailure, BroadcastResponse, Broadcaster, Transaction } from "@bsv/sdk"

import { chunk, fetchWithTimeout, mapLimit, withRetry } from "./concurrency"
import type { RawUtxo } from "./types"

const API = "https://api.bitails.io"

/** Addresses per multi-address lookup. */
const ADDRESS_BATCH_SIZE = 40
const REQUEST_CONCURRENCY = 4

/**
 * The bulk endpoint returns at most this many outputs per request **in total**,
 * whatever `limit` is set to, and silently drops the rest — measured on
 * mainnet: two addresses holding 958 and 940 outputs came back as 958 and 42.
 * A batch that reaches the cap is therefore treated as unanswered.
 */
export const BITAILS_MULTI_RESULT_CAP = 1000

interface BitailsUnspentResponse {
  address: string
  unspent: Array<{
    txid: string
    vout: number
    satoshis: number
    blockheight?: number
  }>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (!response.ok) {
    throw new Error(`Bitails ${path} failed: ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

export interface BitailsUnspentResult {
  utxos: RawUtxo[]
  /**
   * Addresses Bitails could not answer for completely — the batch failed or hit
   * the result cap. The caller must look these up elsewhere.
   */
  unresolved: string[]
}

/**
 * Bitails' bulk lookup is fast, so it goes first. It is never trusted blindly:
 * any batch that errors or reaches the result cap is handed back as
 * `unresolved`, for WhatsOnChain to answer instead.
 */
export async function fetchUnspentOutputs(addresses: string[]): Promise<BitailsUnspentResult> {
  const batches = chunk(addresses, ADDRESS_BATCH_SIZE)

  const results = await mapLimit(batches, REQUEST_CONCURRENCY, async (batch) => {
    try {
      const entries = await withRetry(() =>
        request<BitailsUnspentResponse[]>("/address/unspent/multi?limit=10000", {
          method: "POST",
          body: JSON.stringify({ addresses: batch }),
        })
      )
      const total = entries.reduce((sum, entry) => sum + entry.unspent.length, 0)
      if (total >= BITAILS_MULTI_RESULT_CAP) return { entries: [], unresolved: batch }
      return { entries, unresolved: [] as string[] }
    } catch {
      return { entries: [], unresolved: batch }
    }
  })

  return {
    utxos: results.flatMap(({ entries }) =>
      entries.flatMap((entry) =>
        entry.unspent.map((utxo) => ({
          address: entry.address,
          txid: utxo.txid,
          vout: utxo.vout,
          satoshis: utxo.satoshis,
          blockHeight: utxo.blockheight,
        }))
      )
    ),
    unresolved: results.flatMap(({ unresolved }) => unresolved),
  }
}

export class BitailsBroadcaster implements Broadcaster {
  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    try {
      const response = await fetchWithTimeout(
        `${API}/tx/broadcast`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw: tx.toHex() }),
        },
        120_000
      )
      const data = await response.json()

      if (data?.txid) {
        return { status: "success", txid: data.txid, message: "broadcast" }
      }
      return {
        status: "error",
        code: String(data?.error?.code ?? response.status),
        description: data?.error?.message ?? data?.message ?? "Broadcast rejected",
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
