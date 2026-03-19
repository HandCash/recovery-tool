import { LockingScript, OP, P2PKH, PrivateKey, Script, Transaction, Utils } from "@bsv/sdk"

import { chunk, createLimiter, fetchWithTimeout, sleep, withRetry } from "./concurrency"
import { BSV20_CONTENT_TYPE, envelopeChunks } from "./inscription"

/**
 * MNEE — a USD stablecoin on BSV.
 *
 * An MNEE output is a BSV-21 inscription in front of a **cosigned** lock:
 *
 *   <envelope> OP_DUP OP_HASH160 <owner pkh> OP_EQUALVERIFY
 *              OP_CHECKSIGVERIFY <approver pubkey> OP_CHECKSIG
 *
 * Spending it needs the owner's signature *and* the MNEE approver's. The owner
 * signs with `SIGHASH_ALL | ANYONECANPAY`, so the MNEE API can add its own
 * funding input (it pays the network fee), add the approver signature and
 * broadcast. The keys plus the public MNEE API are enough. Fees are paid in
 * MNEE, as an extra output to the API's fee address.
 *
 * Mirrors MNEE's official SDK (`@mnee/ts-sdk` 1.2.0 — `buildUnsignedMneeTransaction`,
 * `createSignatureRequests`, `submitRawTx`).
 *
 * Address indexers do not see these outputs at all, so the MNEE API is also
 * where they are discovered.
 */
const API = "https://proxy-api.mnee.net"

/**
 * The public production token MNEE ships in its official SDK
 * (`PUBLIC_PROD_MNEE_API_TOKEN`) for client-side use. It is not a secret.
 */
const PUBLIC_API_TOKEN = "92982ec1c0975f31979da515d46bae9f"

/** Addresses per UTXO lookup. The API answers 200 in about a second. */
const ADDRESS_BATCH_SIZE = 200
/** Page size the SDK uses. */
const UTXO_PAGE_SIZE = 250

/** How long to wait for the API to report the cosigned transfer broadcast. */
const TICKET_TIMEOUT_MS = 120_000
const TICKET_POLL_MS = 1_000

const limit = createLimiter(3)

export interface MneeConfig {
  decimals: number
  /** Cosigner public key, hex. */
  approver: string
  feeAddress: string
  tokenId: string
  fees: Array<{ min: number; max: number; fee: number }>
}

export interface MneeUtxo {
  address: string
  txid: string
  vout: number
  /** Atomic units, `10^decimals` per dollar. */
  amount: bigint
  /** The output's locking script, hex. Small (~200 bytes), so kept in memory. */
  script: string
}

interface MneeApiUtxo {
  txid: string
  vout: number
  owners?: string[]
  script: string
  data: {
    bsv21?: { id?: string; op?: string; amt?: number }
    cosign?: { address?: string; cosigner?: string }
  }
}

function url(path: string, query = ""): string {
  return `${API}${path}?auth_token=${PUBLIC_API_TOKEN}${query}`
}

async function request(path: string, query = "", init?: RequestInit): Promise<Response> {
  return limit(() =>
    withRetry(async () => {
      const response = await fetchWithTimeout(url(path, query), init)
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`MNEE ${path} failed: ${response.status} ${body}`.trim())
      }
      return response
    })
  )
}

let configPromise: Promise<MneeConfig> | undefined

export function fetchMneeConfig(): Promise<MneeConfig> {
  configPromise ??= request("/v1/config")
    .then((response) => response.json() as Promise<MneeConfig>)
    .catch((error) => {
      configPromise = undefined
      throw error
    })
  return configPromise
}

/**
 * Every spendable MNEE output on `addresses`. Throws if the API cannot be
 * reached, so a scan is flagged incomplete rather than reporting no MNEE.
 */
export async function fetchMneeUtxos(addresses: string[]): Promise<MneeUtxo[]> {
  if (addresses.length === 0) return []
  const config = await fetchMneeConfig()
  const wanted = new Set(addresses)

  const pages = await Promise.all(
    chunk(addresses, ADDRESS_BATCH_SIZE).map(async (batch) => {
      const found: MneeApiUtxo[] = []
      for (let page = 1; ; page++) {
        const response = await request("/v2/utxos", `&page=${page}&size=${UTXO_PAGE_SIZE}&order=asc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        })
        const results = (await response.json()) as MneeApiUtxo[]
        found.push(...results)
        if (results.length < UTXO_PAGE_SIZE) return found
      }
    })
  )

  const utxos: MneeUtxo[] = []
  for (const utxo of pages.flat()) {
    const bsv21 = utxo.data?.bsv21
    const op = bsv21?.op?.toLowerCase()
    // Same filter as the SDK: only transfer and deploy+mint outputs are spendable.
    if (bsv21?.id !== config.tokenId || (op !== "transfer" && op !== "deploy+mint")) continue
    const address = [utxo.data.cosign?.address, ...(utxo.owners ?? [])].find(
      (candidate): candidate is string => candidate !== undefined && wanted.has(candidate)
    )
    if (!address) continue
    utxos.push({
      address,
      txid: utxo.txid,
      vout: utxo.vout,
      amount: BigInt(bsv21.amt ?? 0),
      script: Utils.toHex(Utils.toArray(utxo.script, "base64")),
    })
  }
  return utxos
}

/** `<envelope> <P2PKH> OP_CHECKSIGVERIFY <approver> OP_CHECKSIG` moving `amount` of MNEE. */
export function mneeTransferLock(address: string, amount: bigint, config: MneeConfig): LockingScript {
  const payload = JSON.stringify({ p: "bsv-20", op: "transfer", id: config.tokenId, amt: amount.toString() })
  const pkh = new P2PKH().lock(address).chunks[2].data!
  return new LockingScript([
    ...envelopeChunks(BSV20_CONTENT_TYPE, Utils.toArray(payload, "utf8")),
    { op: OP.OP_DUP },
    { op: OP.OP_HASH160 },
    { op: pkh.length, data: pkh },
    { op: OP.OP_EQUALVERIFY },
    { op: OP.OP_CHECKSIGVERIFY },
    { op: 33, data: Utils.toArray(config.approver, "hex") },
    { op: OP.OP_CHECKSIG },
  ])
}

export interface MneeTransferAmounts {
  /** What arrives at the destination. */
  send: bigint
  /** What the MNEE API keeps as its fee. */
  fee: bigint
}

/**
 * Splits `total` into what is sent and the fee, using the API's fee tiers. The
 * tier is chosen by the amount *sent*, as the SDK does, so the fee must be
 * found such that `total − fee` lands inside the tier it came from.
 *
 * Returns null when nothing can be moved: the balance does not even cover the
 * fee, or it falls in the sliver between tiers where no fee is self-consistent.
 */
export function splitMneeTransfer(total: bigint, config: MneeConfig): MneeTransferAmounts | null {
  for (const tier of config.fees) {
    const fee = BigInt(tier.fee)
    const send = total - fee
    if (send > 0n && send >= BigInt(tier.min) && send <= BigInt(tier.max)) {
      return { send, fee }
    }
  }
  return null
}

/**
 * Builds and signs the owner's half of an MNEE transfer that merges every
 * `utxos` output into one, sent to `destination`.
 *
 * Outputs are the transfer, then the fee — the order the SDK uses. There is no
 * BSV fee or change: the MNEE API funds the transaction when it cosigns.
 */
export async function composeMneeTransfer(
  utxos: MneeUtxo[],
  destination: string,
  config: MneeConfig,
  keyFor: (utxo: MneeUtxo) => PrivateKey
): Promise<{ tx: Transaction; amounts: MneeTransferAmounts }> {
  const total = utxos.reduce((sum, utxo) => sum + utxo.amount, 0n)
  const amounts = splitMneeTransfer(total, config)
  if (!amounts) {
    throw new Error("The MNEE balance is too small to cover the MNEE transfer fee.")
  }

  const tx = new Transaction()
  for (const utxo of utxos) {
    tx.addInput({
      sourceTXID: utxo.txid,
      sourceOutputIndex: utxo.vout,
      // anyoneCanPay: the API appends its funding input after we sign.
      unlockingScriptTemplate: new P2PKH().unlock(keyFor(utxo), "all", true, 1, Script.fromHex(utxo.script)),
      sequence: 0xffffffff,
    })
  }
  tx.addOutput({ lockingScript: mneeTransferLock(destination, amounts.send, config), satoshis: 1 })
  tx.addOutput({ lockingScript: mneeTransferLock(config.feeAddress, amounts.fee, config), satoshis: 1 })

  await tx.sign()
  return { tx, amounts }
}

interface MneeTicket {
  id: string
  status: string
  tx_id?: string
  errors?: string
}

/**
 * Hands the signed transfer to the MNEE API, which cosigns, funds and
 * broadcasts it, then waits for the resulting transaction id.
 */
export async function submitMneeTransfer(tx: Transaction): Promise<string> {
  // Not retried: a second submission of the same inputs is rejected as locked.
  const response = await fetchWithTimeout(
    url("/v2/transfer"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawtx: Utils.toBase64(tx.toBinary()) }),
    },
    60_000
  )
  const body = (await response.text()).trim()
  if (!response.ok) {
    throw new Error(`The MNEE cosigner rejected the transfer: ${body || response.status}`)
  }
  const ticketId = body.replace(/^"|"$/g, "")

  const deadline = Date.now() + TICKET_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(TICKET_POLL_MS)
    const ticket = (await (await request("/v2/ticket", `&ticketID=${ticketId}`)).json()) as MneeTicket
    if (ticket.status === "FAILED") {
      throw new Error(`The MNEE transfer failed: ${ticket.errors ?? "no reason given"}`)
    }
    if ((ticket.status === "SUCCESS" || ticket.status === "MINED") && ticket.tx_id) {
      return ticket.tx_id
    }
  }
  throw new Error(`The MNEE transfer was submitted (ticket ${ticketId}) but did not confirm in time.`)
}
