import { LockingScript, OP, Script, Utils } from "@bsv/sdk"

/**
 * 1Sat Ordinals script handling.
 *
 * A 1Sat output is a normal P2PKH locking script with an inscription envelope
 * appended:
 *
 *   <P2PKH> OP_FALSE OP_IF "ord" OP_1 <contentType> OP_0 <content> OP_ENDIF
 *
 * BSV-21 tokens are inscriptions whose content type is `application/bsv-20` and
 * whose content is a JSON payload describing a deploy/mint/transfer.
 */

const ORD_MARKER = "ord"
export const BSV20_CONTENT_TYPE = "application/bsv-20"

export interface Bsv20Payload {
  p: string
  op: string
  /** BSV-21 token id, `<txid>_<vout>` of the deploy+mint output. */
  id?: string
  /** BSV-20 v1 ticker. */
  tick?: string
  amt?: string
  dec?: string | number
  sym?: string
  icon?: string
}

export interface ParsedInscription {
  contentType?: string
  content?: number[]
  bsv20?: Bsv20Payload
}

function isPush(chunk: { op: number; data?: number[] }): boolean {
  return chunk.data !== undefined
}

function asText(data?: number[]): string | undefined {
  if (!data) return undefined
  try {
    return Utils.toUTF8(data)
  } catch {
    return undefined
  }
}

/**
 * Extracts the inscription envelope from a locking script, if present.
 * Returns `undefined` for a plain (uninscribed) output.
 */
export function parseInscription(script: Script): ParsedInscription | undefined {
  const chunks = script.chunks

  for (let i = 0; i + 3 < chunks.length; i++) {
    // Look for OP_FALSE OP_IF <"ord">
    const isFalse = chunks[i].op === OP.OP_0 && !isPush(chunks[i])
    if (!isFalse || chunks[i + 1].op !== OP.OP_IF) continue
    if (asText(chunks[i + 2].data) !== ORD_MARKER) continue

    let contentType: string | undefined
    let content: number[] | undefined

    // Fields are (tag, value) pairs terminated by OP_0 followed by the body.
    let cursor = i + 3
    while (cursor + 1 < chunks.length && chunks[cursor].op !== OP.OP_ENDIF) {
      const tag = chunks[cursor]
      if (tag.op === OP.OP_0 && !isPush(tag)) {
        content = chunks[cursor + 1]?.data
        cursor += 2
        break
      }
      if (tag.op === OP.OP_1) {
        contentType = asText(chunks[cursor + 1]?.data)
      }
      cursor += 2
    }

    const inscription: ParsedInscription = { contentType, content }

    if (contentType === BSV20_CONTENT_TYPE && content) {
      const text = asText(content)
      if (text) {
        try {
          const payload = JSON.parse(text) as Bsv20Payload
          if (payload?.p === "bsv-20") inscription.bsv20 = payload
        } catch {
          // Malformed token payload — treat the output as a plain inscription.
        }
      }
    }

    return inscription
  }

  return undefined
}

function pushChunk(data: number[]): { op: number; data: number[] } {
  const length = data.length
  if (length <= 75) return { op: length, data }
  if (length <= 0xff) return { op: OP.OP_PUSHDATA1, data }
  if (length <= 0xffff) return { op: OP.OP_PUSHDATA2, data }
  return { op: OP.OP_PUSHDATA4, data }
}

/** `OP_FALSE OP_IF "ord" OP_1 <contentType> OP_0 <content> OP_ENDIF` */
export function envelopeChunks(contentType: string, content: number[]) {
  return [
    { op: OP.OP_0 },
    { op: OP.OP_IF },
    pushChunk(Utils.toArray(ORD_MARKER, "utf8")),
    { op: OP.OP_1 },
    pushChunk(Utils.toArray(contentType, "utf8")),
    { op: OP.OP_0 },
    pushChunk(content),
    { op: OP.OP_ENDIF },
  ]
}

/**
 * Builds `<P2PKH to address> <inscription envelope>` — the canonical 1Sat
 * output layout, verified against live inscriptions on chain.
 */
export function inscribedLock(
  p2pkh: LockingScript,
  contentType: string,
  content: number[]
): LockingScript {
  return new LockingScript([...p2pkh.chunks, ...envelopeChunks(contentType, content)])
}

/**
 * True for a lock that needs a second signature from a fixed cosigner key —
 * `… OP_CHECKSIGVERIFY <33-byte pubkey> OP_CHECKSIG`, the shape MNEE uses.
 * A plain P2PKH unlock can never satisfy it, and one such input invalidates the
 * whole transaction it is in, so the sweep refuses to sign one.
 */
export function isCosignedScript(script: Script): boolean {
  const chunks = script.chunks
  const n = chunks.length
  return (
    n >= 3 &&
    chunks[n - 1].op === OP.OP_CHECKSIG &&
    chunks[n - 2].data?.length === 33 &&
    chunks[n - 3].op === OP.OP_CHECKSIGVERIFY
  )
}

/** Locking script that moves `amount` base units of BSV-21 token `id`. */
export function bsv21TransferLock(
  p2pkh: LockingScript,
  id: string,
  amount: string
): LockingScript {
  const payload = JSON.stringify({ p: "bsv-20", op: "transfer", id, amt: amount })
  return inscribedLock(p2pkh, BSV20_CONTENT_TYPE, Utils.toArray(payload, "utf8"))
}

/** Locking script that moves `amount` base units of BSV-20 v1 ticker `tick`. */
export function bsv20TransferLock(
  p2pkh: LockingScript,
  tick: string,
  amount: string
): LockingScript {
  const payload = JSON.stringify({ p: "bsv-20", op: "transfer", tick, amt: amount })
  return inscribedLock(p2pkh, BSV20_CONTENT_TYPE, Utils.toArray(payload, "utf8"))
}
