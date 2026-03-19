import { createLimiter, fetchWithTimeout, withRetry } from "./concurrency"

/**
 * GorillaPool's 1Sat Ordinals indexer.
 *
 * It is the only source that finds **minted items**: their locking script is
 * P2PKH followed by an inscription envelope, which address indexers
 * (WhatsOnChain, Bitails) do not associate with the address at all. The
 * indexer keys outputs by owner instead.
 *
 * It does not return plain P2PKH outputs, so it complements the address
 * indexers rather than replacing them. Its bulk outpoint lookup
 * (`POST /api/txos/outpoints`) now answers `[]` for everything, so only the
 * per-owner endpoint is used.
 */
const API = "https://ordinals.gorillapool.io"

/** The owner endpoint pages with `limit` and `offset`. */
const PAGE_SIZE = 1000

const limit = createLimiter(4)

export interface OneSatMap {
  name?: string
  app?: string
  subType?: string
  subTypeData?: { collectionId?: string }
}

export interface OneSatTxoData {
  map?: OneSatMap
  insc?: { file?: { type?: string; size?: number } }
}

export interface OneSatTxo {
  txid: string
  vout: number
  outpoint: string
  satoshis: number
  owner: string | null
  data: OneSatTxoData | null
  origin: {
    outpoint: string
    data?: OneSatTxoData
  } | null
}

export function outpointOf(txid: string, vout: number): string {
  return `${txid}_${vout}`
}

export function contentUrl(origin: string): string {
  return `${API}/content/${origin}`
}

async function fetchOwnedByAddress(address: string): Promise<OneSatTxo[]> {
  const txos: OneSatTxo[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await limit(() =>
      withRetry(async () => {
        const response = await fetchWithTimeout(
          `${API}/api/txos/address/${address}/unspent?limit=${PAGE_SIZE}&offset=${offset}`
        )
        if (!response.ok) throw new Error(`1Sat owner lookup failed: ${response.status}`)
        return (await response.json()) as OneSatTxo[]
      })
    )
    txos.push(...page)
    if (page.length < PAGE_SIZE) return txos
  }
}

/**
 * Unspent inscription outputs owned by `addresses`. Throws if a lookup fails
 * after retries, so the caller can flag the scan as incomplete instead of
 * mistaking an outage for an empty wallet.
 */
export async function fetchOwnedTxos(addresses: string[]): Promise<OneSatTxo[]> {
  const results = await Promise.all(addresses.map(fetchOwnedByAddress))
  return results.flat()
}

/** The content type of the output's own inscription, if it has one. */
export function inscriptionType(txo: OneSatTxo): string | undefined {
  return txo.data?.insc?.file?.type
}

/** Pulls the best available metadata for an item, preferring its origin. */
export function itemMetadata(txo: OneSatTxo | undefined) {
  if (!txo) return undefined
  const data = txo.origin?.data ?? txo.data ?? undefined
  return {
    origin: txo.origin?.outpoint,
    name: data?.map?.name,
    collection: data?.map?.subTypeData?.collectionId,
    contentType: data?.insc?.file?.type,
  }
}
