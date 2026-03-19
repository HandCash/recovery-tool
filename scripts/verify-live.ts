/**
 * Live integration check against mainnet indexers and the MNEE API.
 *
 *   npx tsx scripts/verify-live.ts
 *
 * Uses public addresses with known holdings — no keys involved — to prove that
 * discovery and classification agree with what is actually on chain.
 */
import { P2PKH, Script, Utils } from "@bsv/sdk"

import { fetchUnspentOutputs as fetchBitailsUnspent } from "../lib/handcash/bitails"
import { isCosignedScript, parseInscription } from "../lib/handcash/inscription"
import { fetchMneeConfig, mneeTransferLock } from "../lib/handcash/mnee"
import { fetchOwnedTxos, inscriptionType } from "../lib/handcash/oneSat"
import {
  fetchOutputScript,
  fetchUnspentOutputs as fetchWocUnspent,
  fetchUsedAddresses,
} from "../lib/handcash/whatsOnChain"
import { HandCashWallet } from "../lib/handcash/wallet"

// Holds 1-sat items: some minted here (inscribed), some transferred in (plain).
const ITEMS_ADDRESS = "17k4thtSCtLcmMnvTaTBTe8n2MtCqemtLQ"
// Holds only plain BSV.
const COINS_ADDRESS = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5"
// Received funds and was swept clean: transaction history, zero unspent
// outputs. This is the case the gap limit has to survive.
const SWEPT_ADDRESS = "1GWD1sriC9Eyp8ZVNSgKXy35mJT66fmQzG"
// Composed from the BIP-32 test vector master keys at an index nobody would
// reach, so it is valid, correctly formatted, and certain to have no history.
const UNUSED_ADDRESS = HandCashWallet.fromExtendedKeys(
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
  "xprv9s21ZrQH143K31xYSDQpPDxsXRTUcvj2iNHm5NUtrGiGG5e2DtALGdso3pGz6ssrdK4PFmM8NSpSBHNqPqm55Qn3LqFtT2emdEXVYsCzC2U"
).addressAt("m/9/987654")
// MNEE's approver (cosigner) public key.
const MNEE_APPROVER = "020a177d6a5e6f3a8689acd2e313bd1cf0dcf5a243d1cc67b7218602aee9e04b2f"

let failures = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}`, detail ?? "")
  }
}

const outpoints = (utxos: Array<{ txid: string; vout: number }>) =>
  utxos.map((u) => `${u.txid}_${u.vout}`).sort().join()

async function main() {
  console.log("\nGap signal (transaction history)")
  {
    const used = await fetchUsedAddresses([
      COINS_ADDRESS,
      SWEPT_ADDRESS,
      ITEMS_ADDRESS,
      UNUSED_ADDRESS,
    ])

    check("an address holding funds counts as used", used.has(COINS_ADDRESS))
    // This address is empty today, but the derivation sequence must keep going
    // past it.
    check("a swept-clean address still counts as used", used.has(SWEPT_ADDRESS))
    check("an unused address does not", !used.has(UNUSED_ADDRESS), UNUSED_ADDRESS)

    // Confirms the swept address really is the awkward case, not just a stale
    // fixture that quietly acquired a balance.
    const unspent = await fetchWocUnspent([SWEPT_ADDRESS])
    check("the swept address genuinely holds nothing", unspent.length === 0, unspent)
  }

  console.log("\nPlain BSV address")
  {
    const bitails = await fetchBitailsUnspent([COINS_ADDRESS])
    const woc = await fetchWocUnspent([COINS_ADDRESS])
    check("Bitails finds unspent outputs", bitails.utxos.length > 0 && bitails.unresolved.length === 0)
    // WhatsOnChain is the alternative whenever Bitails fails or truncates, so the
    // two have to agree exactly.
    check("WhatsOnChain agrees with Bitails", outpoints(woc) === outpoints(bitails.utxos), {
      bitails: bitails.utxos.length,
      woc: woc.length,
    })
    console.log(
      `       ${woc.length} outputs, ${woc.reduce((s, u) => s + u.satoshis, 0).toLocaleString()} sats`
    )
  }

  console.log("\nItem-holding address")
  {
    const inscribed = await fetchOwnedTxos([ITEMS_ADDRESS])
    const plain = await fetchWocUnspent([ITEMS_ADDRESS])

    const plainSet = new Set(plain.map((u) => `${u.txid}_${u.vout}`))
    const minted = inscribed.filter((t) => !plainSet.has(t.outpoint))
    const transferred = inscribed.filter((t) => plainSet.has(t.outpoint))

    check("the 1Sat indexer finds minted items", minted.length > 0, minted.length)
    check("every item holds exactly 1 satoshi", inscribed.every((t) => t.satoshis === 1))
    check("each minted item carries its own inscription", minted.every((t) => Boolean(inscriptionType(t))))
    // Items transferred in are plain P2PKH, so both sources report them. The
    // indexer is still worth asking: it knows what the item is.
    check("transferred items are known to both, with their origin", transferred.every((t) => Boolean(t.origin)))
    for (const t of transferred.slice(0, 2)) {
      const script = await fetchOutputScript(t.txid, t.vout)
      check("an item reported by both is plain P2PKH", script.toHex() === new P2PKH().lock(ITEMS_ADDRESS).toHex())
    }

    const sample = minted[0]
    if (sample) {
      const script = await fetchOutputScript(sample.txid, sample.vout)
      const p2pkh = new P2PKH().lock(ITEMS_ADDRESS).toHex()
      check("fetches a single output's script", script.toBinary().length > 25)
      check("the script carries the inscription", parseInscription(script) !== undefined)
      check("and pays the owner (P2PKH before or after the envelope)", script.toHex().includes(p2pkh.slice(6, 46)))
      check("is not a cosigned lock", !isCosignedScript(script))
      console.log(`       ${minted.length} minted, ${transferred.length} transferred, ${plain.length} plain; sample script ${script.toBinary().length.toLocaleString()} bytes`)
    }
  }

  console.log("\nMNEE API")
  {
    const config = await fetchMneeConfig()
    check("serves its config with the public token", Boolean(config.tokenId && config.feeAddress))
    check("the approver is MNEE's known cosigner key", config.approver === MNEE_APPROVER, config.approver)
    check("fee tiers are present", config.fees.length > 0, config.fees)

    // The fee address receives MNEE constantly, so it always has outputs. Only
    // the first page is read — it holds a very large number.
    const response = await fetch(
      "https://proxy-api.mnee.net/v2/utxos?auth_token=92982ec1c0975f31979da515d46bae9f&page=1&size=20",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([config.feeAddress]) }
    )
    const utxos = (await response.json()) as Array<{ script: string; data: { bsv21: { amt: number } } }>
    check("finds MNEE outputs", utxos.length > 0)

    // Our transfer script must match real MNEE outputs byte for byte, apart
    // from the JSON key order, which differs between MNEE clients.
    const matches = utxos.filter((utxo) => {
      const onChain = Script.fromBinary(Utils.toArray(utxo.script, "base64"))
      const ours = mneeTransferLock(config.feeAddress, BigInt(utxo.data.bsv21.amt), config)
      const payload = (s: Script) => JSON.stringify(Object.entries(parseInscription(s)?.bsv20 ?? {}).sort())
      const tail = (s: Script) => s.chunks.slice(s.chunks.findIndex((c) => c.op === 0x68)).map((c) => c.op + Utils.toHex(c.data ?? [])).join()
      return isCosignedScript(onChain) && payload(onChain) === payload(ours) && tail(onChain) === tail(ours)
    })
    check("our MNEE transfer script matches real MNEE outputs", matches.length === utxos.length, {
      matched: matches.length,
      of: utxos.length,
    })
  }

  console.log(failures === 0 ? "\nAll live checks passed.\n" : `\n${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
