/**
 * Correctness checks for the parts of the recovery tool that move real money.
 * Runs entirely offline.
 *
 *   npx tsx scripts/verify.ts
 */
import {
  HD,
  Hash,
  LockingScript,
  P2PKH,
  PrivateKey,
  Script,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
} from "@bsv/sdk"

import {
  BSV20_CONTENT_TYPE,
  bsv21TransferLock,
  inscribedLock,
  isCosignedScript,
  parseInscription,
} from "../lib/handcash/inscription"
import { BITAILS_MULTI_RESULT_CAP, fetchUnspentOutputs as fetchBitailsUnspent } from "../lib/handcash/bitails"
import { createLimiter, sleep } from "../lib/handcash/concurrency"
import {
  composeMneeTransfer,
  mneeTransferLock,
  splitMneeTransfer,
  type MneeConfig,
} from "../lib/handcash/mnee"
import { DERIVATION_ROOTS } from "../lib/handcash/derivation"
import {
  describeKeyPairProblem,
  describeKeyProblem,
  extractExtendedKeys,
  parseExtendedPrivateKey,
} from "../lib/handcash/keyring"
import { HandCashWallet } from "../lib/handcash/wallet"

/**
 * The master keys of BIP-32 test vectors 1 and 2, used as the two exported
 * shares. Published constants, so the reference can check its parser against
 * the spec's seeds.
 */
const SHARE_ONE =
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"
const SHARE_TWO =
  "xprv9s21ZrQH143K31xYSDQpPDxsXRTUcvj2iNHm5NUtrGiGG5e2DtALGdso3pGz6ssrdK4PFmM8NSpSBHNqPqm55Qn3LqFtT2emdEXVYsCzC2U"

/**
 * Produced by `python3 scripts/reference/tss_reference.py`. Regenerate with
 * that script if these ever need to change — never by copying what the
 * TypeScript happens to output.
 */
const REFERENCE = {
  "m/0/0": { address: "1LkcACs528gaqBWgvcEUVnYGwQQUKpuePQ", wif: "L3ujiNTFqrvxAEHpHDTbsVy9JDj95rNpFhje4DvocWDYyT7t4i8n" },
  "m/3/0": { address: "1P624wXhkRRLXUmNQXsoRPXx4WkNCJ42yt", wif: "L3h8BZ7p3ZLte8QfznvntorpbhHEzAVTiYjmZMCqUd1qsKRysQn6" },
  "m/4/12": { address: "125KHQTjxSHApu4D5YHTFt6FcBKcNkyedr", wif: "L1QfhfWRDbQLQbQrGD1hHdYNntJJtc4NyXfyHJBAciyHWtZBiXd2" },
  "m/9/7": { address: "198HTBsBXAhc9WHUTaXE8sT5PDJy1MnbuY", wif: "L239TSZ4wkm51KqB613j3bwTUMnVcWBXZXcqcD4a3XEz3c1VoMPB" },
  "m/0/2147483647": { address: "1QEFMnKRpaxjfjvtzJonM2YoVYEY4noHpQ", wif: "L28Cg4DkhgyPY8ALFn1byZnZ2aMwQBoU13Pa3w1DjZS15bA3Ujhi" },
} as const

let failures = 0

async function main() {

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}`, detail ?? "")
  }
}

// A real 1Sat ordinal locking script, taken from mainnet outpoint
// 21814ede2aa1aca099eac658df810ca9a6be7f95109b80d7b4209342b6ae44bd_0.
// Truncated to the envelope header plus a short body — the structure is what
// matters, not the PNG payload.
const REAL_ORDINAL_PREFIX =
  "76a91409931415e4ca70e8caba4cc411bff7ec2730feac88ac0063036f72645109696d6167652f706e6700"

console.log("\nInscription parsing")
{
  const script = Script.fromHex(`${REAL_ORDINAL_PREFIX}03414243${"68"}`)
  const parsed = parseInscription(script)
  check("detects an inscription on a real 1Sat script", parsed !== undefined)
  check("reads the content type", parsed?.contentType === "image/png", parsed?.contentType)
  check("reads the content", Utils.toUTF8(parsed?.content ?? []) === "ABC")
}

{
  const plain = new P2PKH().lock("1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5")
  check("plain P2PKH is not an inscription", parseInscription(plain) === undefined)
}

console.log("\nBSV-21 transfer output")
{
  const address = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5"
  const tokenId = "6a0a5f91ea03cdd4d7371b4ee0572dadb349588cb3b0bfc95fba0cd2a1987488_0"
  const lock = bsv21TransferLock(new P2PKH().lock(address), tokenId, "123456789")

  // Round-trips through serialization the same way a miner would read it.
  const reparsed = parseInscription(Script.fromBinary(lock.toBinary()))
  check("round-trips through serialization", reparsed !== undefined)
  check("carries the bsv-20 content type", reparsed?.contentType === BSV20_CONTENT_TYPE)
  check("payload is a transfer", reparsed?.bsv20?.op === "transfer")
  check("payload keeps the token id", reparsed?.bsv20?.id === tokenId)
  check("payload keeps the exact amount", reparsed?.bsv20?.amt === "123456789")

  const hex = lock.toHex()
  const p2pkhPrefix = new P2PKH().lock(address).toHex()
  check("P2PKH comes first, matching mainnet layout", hex.startsWith(p2pkhPrefix))
  check("envelope opens with OP_FALSE OP_IF 'ord'", hex.slice(p2pkhPrefix.length).startsWith("0063036f7264"))
  check("envelope closes with OP_ENDIF", hex.endsWith("68"))
}

console.log("\nKey parsing")
{
  check("accepts an exported xprv", parseExtendedPrivateKey(SHARE_ONE) !== null)
  check("ignores surrounding whitespace", parseExtendedPrivateKey(`  ${SHARE_TWO}\n`) !== null)
  check("accepts the pair", describeKeyPairProblem(SHARE_ONE, SHARE_TWO) === null)

  const xpub = HD.fromString(SHARE_ONE).toPublic().toString()
  check("rejects an xpub — it cannot sign", parseExtendedPrivateKey(xpub) === null)
  check("says why an xpub is rejected", describeKeyProblem(xpub)?.includes("public key") === true)

  // A single changed character must fail the base58 checksum rather than
  // silently produce a different wallet.
  const typo = `${SHARE_ONE.slice(0, 40)}${SHARE_ONE[40] === "a" ? "b" : "a"}${SHARE_ONE.slice(41)}`
  check("rejects a one-character typo", parseExtendedPrivateKey(typo) === null)
  check("rejects a truncated key", parseExtendedPrivateKey(SHARE_ONE.slice(0, -1)) === null)
  check("rejects a mnemonic", parseExtendedPrivateKey("abandon ".repeat(11) + "about") === null)
  check("rejects an empty field", describeKeyProblem("   ") !== null)

  // The same share twice composes d², a valid key for a wallet nobody owns.
  check("rejects the same key entered twice", describeKeyPairProblem(SHARE_ONE, ` ${SHARE_ONE}`) !== null)
  check("points at the field that is wrong",
    describeKeyPairProblem(SHARE_ONE, typo)?.startsWith("Second key") === true &&
    describeKeyPairProblem(typo, SHARE_TWO)?.startsWith("First key") === true)

  const pasted = `Key 1:\n${SHARE_ONE}\n\nKey 2: ${SHARE_TWO}\n`
  check("finds both keys in a pasted export", extractExtendedKeys(pasted).join("|") === `${SHARE_ONE}|${SHARE_TWO}`)
  check("finds a single pasted key on its own", extractExtendedKeys(SHARE_TWO).length === 1)
}

console.log("\nTwo-party key composition")
{
  // Fixtures come from scripts/reference/tss_reference.py — a standard-library
  // Python implementation written from the specs, sharing no code or
  // dependencies with the TypeScript. If the two ever disagree, this fails.
  const wallet = HandCashWallet.fromExtendedKeys(SHARE_ONE, SHARE_TWO)

  for (const [path, expected] of Object.entries(REFERENCE)) {
    check(`composed address matches the reference at ${path}`, wallet.addressAt(path) === expected.address, {
      got: wallet.addressAt(path),
      expected: expected.address,
    })
    check(`composed key matches the reference at ${path}`, wallet.privateKeyAt(path).toWif() === expected.wif)
  }

  // (d1·d2) mod n is commutative, so a user who enters the keys the other way
  // round still recovers the same wallet.
  check(
    "key order does not change the wallet",
    HandCashWallet.fromExtendedKeys(SHARE_TWO, SHARE_ONE).addressAt("m/3/0") === wallet.addressAt("m/3/0")
  )

  // Guards against the composition silently collapsing to one share — the exact
  // bug that would make the tool scan the wrong wallet and report it empty.
  const shareOnly = HD.fromString(SHARE_ONE)
  check(
    "composed key is not just the first share",
    wallet.privateKeyAt("m/3/0").toWif() !== shareOnly.derive("m/3/0").privKey.toWif()
  )
  check(
    "composed address differs from either share alone",
    wallet.addressAt("m/3/0") !== shareOnly.derive("m/3/0").pubKey.toAddress().toString()
  )

  check("derives a mainnet P2PKH address", /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(wallet.addressAt("m/0/0")))
  check("distinct roots give distinct addresses", wallet.addressAt("m/0/0") !== wallet.addressAt("m/1/0"))
  check("distinct indices give distinct addresses", wallet.addressAt("m/0/0") !== wallet.addressAt("m/0/1"))

  // Every root is walked identically — nothing is special-cased, including m/2,
  // which HandCash uses only for signing.
  check(
    "every derivation root is scanned the same way",
    DERIVATION_ROOTS.every((root) => /^m\/\d$/.test(root.path)) && DERIVATION_ROOTS.length === 10
  )

  console.log(`       m/0/0 = ${wallet.addressAt("m/0/0")}`)
}

console.log("\nSweep construction")
{
  // Signs with composed two-party keys, the way a real recovery does.
  const wallet = HandCashWallet.fromExtendedKeys(SHARE_ONE, SHARE_TWO)
  const destination = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5"

  const utxos = [
    {
      txid: "a".repeat(64), vout: 0, satoshis: 1, address: wallet.addressAt("m/9/0"),
      derivationPath: "m/9/0", derivationRoot: "m/9", kind: "item" as const, item: {},
    },
    {
      txid: "b".repeat(64), vout: 1, satoshis: 1, address: wallet.addressAt("m/9/1"),
      derivationPath: "m/9/1", derivationRoot: "m/9", kind: "item" as const, item: {},
    },
    {
      txid: "c".repeat(64), vout: 0, satoshis: 1, address: wallet.addressAt("m/7/0"),
      derivationPath: "m/7/0", derivationRoot: "m/7", kind: "token" as const,
      token: { id: "deadbeef_0", symbol: "MNEE", decimals: 5, amount: "1000" },
    },
    {
      txid: "d".repeat(64), vout: 0, satoshis: 2, address: wallet.addressAt("m/8/0"),
      derivationPath: "m/8/0", derivationRoot: "m/8", kind: "token" as const,
      token: { id: "deadbeef_0", symbol: "MNEE", decimals: 5, amount: "2500" },
    },
    {
      txid: "e".repeat(64), vout: 3, satoshis: 500_000, address: wallet.addressAt("m/0/5"),
      derivationPath: "m/0/5", derivationRoot: "m/0", kind: "bsv" as const,
    },
  ]

  const plan = await wallet.plan(destination, utxos)
  check("plans two items", plan.itemCount === 2)
  check("merges both token outputs into one", plan.tokenCount === 1)
  check("counts every input", plan.inputCount === 5)
  check("charges a non-zero fee", plan.feeSatoshis > 0, plan.feeSatoshis)

  const totalIn = utxos.reduce((sum, u) => sum + u.satoshis, 0)
  check(
    "satoshis balance exactly",
    plan.satoshisToSend + plan.feeSatoshis + plan.itemCount + plan.tokenCount === totalIn,
    { plan, totalIn }
  )

  // Rebuild and sign, then assert the on-chain layout.
  const composed = (wallet as any).composeSweep(destination, utxos)
  const tx: Transaction = composed.tx
  tx.outputs[tx.outputs.length - 1].satoshis = plan.satoshisToSend
  await tx.sign()

  check("input order is items, tokens, then coins", [
    "a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64),
  ].every((txid, i) => tx.inputs[i].sourceTXID === txid))

  check("item outputs sit at the same offsets as their inputs",
    tx.outputs[0].satoshis === 1 && tx.outputs[1].satoshis === 1)
  check("items are plain P2PKH at the destination",
    tx.outputs[0].lockingScript.toHex() === new P2PKH().lock(destination).toHex())

  const tokenOut = parseInscription(tx.outputs[2].lockingScript)
  check("token output is a bsv-20 transfer", tokenOut?.bsv20?.op === "transfer")
  check("token amounts are summed, not dropped", tokenOut?.bsv20?.amt === "3500", tokenOut?.bsv20?.amt)

  check("change is the final output", tx.outputs[3].satoshis === plan.satoshisToSend)
  check("every input is signed", tx.inputs.every((i) => (i.unlockingScript?.toBinary().length ?? 0) > 0))

  // A signature is only valid against the exact locking script it committed to.
  const key: PrivateKey = wallet.privateKeyAt("m/0/5")
  check("signing key matches the funding address",
    key.toPublicKey().toAddress().toString() === wallet.addressAt("m/0/5"))
}

console.log("\nInsufficient funds")
{
  const wallet = HandCashWallet.fromExtendedKeys(SHARE_ONE, SHARE_TWO)
  const utxos = [{
    txid: "f".repeat(64), vout: 0, satoshis: 1, address: wallet.addressAt("m/9/0"),
    derivationPath: "m/9/0", derivationRoot: "m/9", kind: "item" as const, item: {},
  }]
  let threw = false
  try {
    await wallet.plan("1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5", utxos)
  } catch (error) {
    threw = (error as Error).name === "InsufficientFundsError"
  }
  check("refuses to sweep items with no BSV for the fee", threw)
}

/** Runs the script interpreter on one input of a signed transaction. */
function inputValidates(tx: Transaction, inputIndex: number, lockingScript: Script, satoshis: number): boolean {
  const input = tx.inputs[inputIndex]
  try {
    return new Spend({
      sourceTXID: input.sourceTXID!,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: satoshis,
      lockingScript: LockingScript.fromHex(lockingScript.toHex()),
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
      outputs: tx.outputs,
      unlockingScript: input.unlockingScript!,
      inputSequence: input.sequence ?? 0xffffffff,
      inputIndex,
      lockTime: tx.lockTime,
    }).validate()
  } catch {
    return false
  }
}

console.log("\nSigning against the real locking script")
{
  // A minted item's script is P2PKH plus an inscription envelope, and the
  // signature commits to all of it. The old sweep signed every input against a
  // reconstructed P2PKH, which only validates for plain outputs.
  const wallet = HandCashWallet.fromExtendedKeys(SHARE_ONE, SHARE_TWO)
  const address = wallet.addressAt("m/9/3")
  const inscribed = inscribedLock(new P2PKH().lock(address), "image/png", [1, 2, 3, 4])
  const utxos = [
    {
      txid: "1".repeat(64), vout: 0, satoshis: 1, address, derivationPath: "m/9/3", derivationRoot: "m/9",
      kind: "item" as const, item: {}, lockingScript: inscribed.toHex(),
    },
    {
      txid: "2".repeat(64), vout: 0, satoshis: 50_000, address: wallet.addressAt("m/0/1"),
      derivationPath: "m/0/1", derivationRoot: "m/0", kind: "bsv" as const,
    },
  ]
  const { tx } = (wallet as any).composeSweep("1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5", utxos)
  tx.outputs[tx.outputs.length - 1].satoshis = 40_000
  await tx.sign()

  check("an inscribed input validates against its real script", inputValidates(tx, 0, inscribed, 1))
  check("a plain input validates against P2PKH", inputValidates(tx, 1, new P2PKH().lock(utxos[1].address), 50_000))

  // The bug this replaces: the same input signed against plain P2PKH.
  const wrong = new Transaction()
  wrong.addInput({
    sourceTXID: utxos[0].txid, sourceOutputIndex: 0, sequence: 0xffffffff,
    unlockingScriptTemplate: new P2PKH().unlock(wallet.privateKeyAt("m/9/3"), "all", false, 1, new P2PKH().lock(address)),
  })
  wrong.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 1 })
  await wrong.sign()
  check("a signature over plain P2PKH does not validate for an inscribed output", !inputValidates(wrong, 0, inscribed, 1))
}

/** A cosigner we control, standing in for the MNEE approver. */
const APPROVER = PrivateKey.fromHex("11".repeat(32))
const MNEE_CONFIG: MneeConfig = {
  decimals: 5,
  approver: APPROVER.toPublicKey().toString(),
  feeAddress: "19Vq2TV8aVhFNLQkhDMdnEQ7zT96x6F3PK",
  tokenId: "ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0",
  // The live tiers, as served by /v1/config.
  fees: [
    { min: 0, max: 1_000_000, fee: 100 },
    { min: 1_000_001, max: 9_007_199_254_740_991, fee: 1_000 },
  ],
}

console.log("\nMNEE fee tiers")
{
  const split = (total: bigint) => splitMneeTransfer(total, MNEE_CONFIG)
  check("small balance pays the 100 fee", split(24_500n)?.send === 24_400n && split(24_500n)?.fee === 100n)
  check("top of the low tier still pays 100", split(1_000_100n)?.send === 1_000_000n && split(1_000_100n)?.fee === 100n)
  check("large balance pays the 1,000 fee", split(5_000_000n)?.send === 4_999_000n && split(5_000_000n)?.fee === 1_000n)
  // Between the tiers no fee is self-consistent: sending more than 1,000,000
  // costs 1,000, which leaves less than 1,000,001 to send.
  check("refuses the sliver between tiers rather than guessing", split(1_000_500n) === null)
  check("refuses a balance that cannot cover the fee", split(100n) === null && split(50n) === null)
}

console.log("\nMNEE transfer")
{
  const wallet = HandCashWallet.fromExtendedKeys(SHARE_ONE, SHARE_TWO)
  const destination = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5"
  const paths = ["m/7/3", "m/7/9", "m/8/2"]
  const amounts = [900n, 23_000n, 600n]
  const utxos = paths.map((path, i) => ({
    address: wallet.addressAt(path),
    txid: String(i + 3).repeat(64),
    vout: i,
    amount: amounts[i],
    script: mneeTransferLock(wallet.addressAt(path), amounts[i], MNEE_CONFIG).toHex(),
  }))
  const pathOf = new Map(utxos.map((u, i) => [u.txid, paths[i]]))

  check("MNEE outputs are recognised as cosigned", utxos.every((u) => isCosignedScript(Script.fromHex(u.script))))
  check("plain and inscribed outputs are not", !isCosignedScript(new P2PKH().lock(destination)) &&
    !isCosignedScript(inscribedLock(new P2PKH().lock(destination), "image/png", [1])))

  const { tx, amounts: split } = await composeMneeTransfer(utxos, destination, MNEE_CONFIG, (u) =>
    wallet.privateKeyAt(pathOf.get(u.txid)!)
  )

  check("merges everything into one transfer plus the fee", tx.outputs.length === 2)
  const sent = parseInscription(tx.outputs[0].lockingScript)?.bsv20
  const fee = parseInscription(tx.outputs[1].lockingScript)?.bsv20
  check("sends the total minus the fee", sent?.amt === "24400" && split.send === 24_400n, sent)
  check("pays the fee to the fee address", fee?.amt === "100" &&
    tx.outputs[1].lockingScript.toHex() === mneeTransferLock(MNEE_CONFIG.feeAddress, 100n, MNEE_CONFIG).toHex())
  check("tokens are conserved exactly", BigInt(sent!.amt!) + BigInt(fee!.amt!) === 24_500n)
  check("keeps the MNEE token id", sent?.id === MNEE_CONFIG.tokenId && fee?.id === MNEE_CONFIG.tokenId)
  check("both outputs stay under the cosigner lock",
    isCosignedScript(tx.outputs[0].lockingScript) && isCosignedScript(tx.outputs[1].lockingScript))
  check("the transfer is locked to the destination",
    tx.outputs[0].lockingScript.toHex() === mneeTransferLock(destination, 24_400n, MNEE_CONFIG).toHex())
  check("adds no BSV change — the cosigner funds it", tx.outputs.every((o) => o.satoshis === 1))

  // SIGHASH_ALL | ANYONECANPAY | FORKID = 0xc1: lets the API add its funding
  // input without invalidating ours.
  check("every input is signed ALL|ANYONECANPAY|FORKID", tx.inputs.every((input) => {
    const sig = input.unlockingScript!.chunks[0].data!
    return sig[sig.length - 1] === 0xc1
  }))

  // Do what the MNEE API does: append a funding input, then put the approver's
  // signature in front of ours. Our signatures must survive the extra input.
  tx.addInput({
    sourceTXID: "f".repeat(64), sourceOutputIndex: 0, sequence: 0xffffffff,
    unlockingScript: new UnlockingScript(),
  })
  const scope = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_ANYONECANPAY | TransactionSignature.SIGHASH_FORKID
  utxos.forEach((utxo, inputIndex) => {
    const input = tx.inputs[inputIndex]
    const preimage = TransactionSignature.format({
      sourceTXID: utxo.txid,
      sourceOutputIndex: utxo.vout,
      sourceSatoshis: 1,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
      inputIndex,
      outputs: tx.outputs,
      inputSequence: input.sequence!,
      subscript: Script.fromHex(utxo.script),
      lockTime: tx.lockTime,
      scope,
    })
    const raw = APPROVER.sign(Hash.sha256(preimage))
    const approverSig = new TransactionSignature(raw.r, raw.s, scope).toChecksigFormat()
    input.unlockingScript = new UnlockingScript([
      { op: approverSig.length, data: approverSig },
      ...input.unlockingScript!.chunks,
    ])
  })
  check("once cosigned, every MNEE input validates", utxos.every((utxo, i) =>
    inputValidates(tx, i, Script.fromHex(utxo.script), 1)))

  // Without the approver, the owner's signature alone must not be enough.
  const alone = await composeMneeTransfer(utxos, destination, MNEE_CONFIG, (u) => wallet.privateKeyAt(pathOf.get(u.txid)!))
  check("the owner's signature alone does not spend MNEE",
    !inputValidates(alone.tx, 0, Script.fromHex(utxos[0].script), 1))

  // MNEE must never enter the main sweep: one cosigned input would make the
  // whole transaction invalid.
  const mneeUtxo = {
    txid: utxos[0].txid, vout: 0, satoshis: 1, address: utxos[0].address, derivationPath: "m/7/3",
    derivationRoot: "m/7", kind: "mnee" as const, lockingScript: utxos[0].script,
    token: { id: MNEE_CONFIG.tokenId, symbol: "MNEE", decimals: 5, amount: "900" },
  }
  let refused = false
  try {
    (wallet as any).composeSweep(destination, [mneeUtxo])
  } catch {
    refused = true
  }
  check("the main sweep refuses MNEE outputs", refused)

  // A cosigned script that slipped in as an ordinary token is refused before
  // anything is signed.
  const disguised = { ...mneeUtxo, kind: "token" as const }
  let signingRefused = false
  try {
    const { tx: composed } = (wallet as any).composeSweep(destination, [disguised, {
      txid: "e".repeat(64), vout: 0, satoshis: 10_000, address: wallet.addressAt("m/0/1"),
      derivationPath: "m/0/1", derivationRoot: "m/0", kind: "bsv" as const,
    }])
    composed.outputs[composed.outputs.length - 1].satoshis = 5_000
    await composed.sign()
  } catch {
    signingRefused = true
  }
  check("never signs a cosigned script as plain P2PKH", signingRefused)
}

console.log("\nBitails truncation")
{
  // The bulk endpoint silently stops at 1,000 outputs per request. A batch that
  // reaches the cap must be handed back for WhatsOnChain to answer.
  const realFetch = globalThis.fetch
  const addresses = Array.from({ length: 45 }, (_, i) => `addr${i}`)
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const batch = JSON.parse(String(init!.body)).addresses as string[]
    const full = batch.includes("addr0")
    const body = batch.map((address, i) => ({
      address,
      unspent: full && i < 2
        ? Array.from({ length: BITAILS_MULTI_RESULT_CAP / 2 }, (_, n) => ({ txid: "a".repeat(64), vout: n, satoshis: 1 }))
        : [{ txid: "b".repeat(64), vout: i, satoshis: 7 }],
    }))
    return new Response(JSON.stringify(body), { status: 201 })
  }) as typeof fetch
  try {
    const result = await fetchBitailsUnspent(addresses)
    check("a capped batch is reported unresolved, not trusted",
      result.unresolved.length === 40 && result.unresolved.includes("addr0"))
    check("its partial outputs are discarded", result.utxos.every((u) => u.satoshis === 7))
    check("other batches are kept", result.utxos.length === 5)
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log("\nShared request limiter")
{
  const run = createLimiter(2)
  let active = 0
  let peak = 0
  const order: number[] = []
  await Promise.all(Array.from({ length: 12 }, (_, i) => run(async () => {
    active += 1
    peak = Math.max(peak, active)
    await sleep(i % 3 === 0 ? 5 : 1)
    order.push(i)
    active -= 1
  })))
  check("never exceeds its limit", peak === 2, peak)
  check("runs every task", order.length === 12)
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
