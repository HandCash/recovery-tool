# HandCash Recovery

A browser-only tool that rebuilds a HandCash wallet from the two extended
private keys the HandCash app exports, finds every asset it holds on the Bitcoin
SV blockchain, and moves all of it to an address the user controls.

```
Enter keys  →  Scan derivation paths  →  Review assets  →  Transfer everything
```

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## How recovery works

### The export is two keys, not one

The HandCash app exports a wallet as **two extended private keys** (`xprv…`,
standard [BIP-32 serialization][bip32]). Each is one share of a [two-party
ECDSA][2p] key, and neither can spend on its own.

The shares are **multiplicative**, so holding both lets the tool compose the
real private key and then sign completely normally:

```
d = (d₁ · d₂) mod n
```

Both shares are derived at the *same* path first, then combined.

Because multiplication mod `n` is commutative, the two keys can be entered in
either order. Each key carries a base58 checksum, so a mistyped or truncated key
is rejected outright — and named by field — rather than silently producing a
different wallet. The form also refuses:

- an `xpub` — it cannot sign, so the recovery would find funds it cannot move;
- the same key twice — that composes `d₁²`, a valid key for a wallet nobody
  owns.

Pasting the whole export into either field splits it into both.

Earlier versions of the app exported the same two shares as a 24-word phrase
(two 12-word BIP-39 mnemonics). That format is no longer accepted.

[bip32]: https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
[2p]: https://medium.com/cryptoadvance/ecdsa-is-not-that-bad-two-party-signing-without-schnorr-or-bls-1941806ec36f

### Derivation

HandCash wallets do not use BIP-44. Every address is derived directly from each
exported key as `m/<path>/<index>`, with no account or purpose level in between.
The tool walks ten paths, `m/0` through `m/9`, all in the same way. `m/9` is
where items are expected, so it is also checked for minted items (see
[Finding assets](#finding-assets)).

### When scanning stops

Each path keeps a sliding window: scanning continues until 1,000 consecutive
addresses past the highest hit come back unused. Both numbers can be changed —
see [Adjusting the scan](#adjusting-the-scan).

An address counts as **used** if it has any transaction history, or holds MNEE
or minted items. Those last two need saying because address indexers cannot see
them at all — not even in history — so without them a run of item addresses
would read as a gap.

History, not unspent outputs, is the main signal. An address that received funds
and was later emptied holds nothing today but still marks the sequence as live,
and wallet addresses are routinely emptied after use.

A HandCash wallet can have long runs of addresses that were never used, so the
gap is much larger than the usual BIP-44 convention of 20. Even so, 1,000 is a
compromise, not a guarantee: some wallets have longer runs, and need the gap
raised to be recovered completely.

A wallet with nothing in it finishes at 10,000 address checks across the ten
paths, which takes a few minutes on the explorers' free tiers.

If a lookup fails after retries, the scan carries on rather than aborting, and
the result carries `complete: false` so the UI can warn that the scan may be
incomplete.

### Finding assets

No single source sees the whole wallet, so every 40-address step asks several:

| Source | Finds | Why it is needed |
| --- | --- | --- |
| [WhatsOnChain](https://api.whatsonchain.com) | Transaction history | Drives the gap limit. |
| [Bitails](https://api.bitails.io), then WhatsOnChain | Plain P2PKH outputs: BSV, and items that were *transferred* in | Bitails' bulk lookup is fast, but it silently stops at 1,000 outputs per request. Any batch that errors or reaches that cap is answered by WhatsOnChain instead, which pages through every output. |
| [GorillaPool's 1Sat indexer](https://ordinals.gorillapool.io) | *Minted* items and tokens, plus names and images | Their script is P2PKH followed by an inscription, and address indexers do not associate it with the address. Asked on `m/9` only, where items are expected: it has no bulk lookup. |
| [MNEE API](https://proxy-api.mnee.net) | MNEE | MNEE sits under a cosigned lock that no address indexer sees. |

The 1Sat indexer's spend index lags, so every output only it reports is checked
against WhatsOnChain's spent-output lookup before it is kept. One already-spent
input would invalidate the whole sweep.

Each output is then classified:

- From the MNEE API → **MNEE**.
- An `application/bsv-20` inscription → **token** (BSV-21 by id, or BSV-20 v1 by
  ticker). Its script is read to get the exact amount.
- Worth exactly 1 satoshi, or known to the 1Sat indexer → **item**.
- Anything else → **BSV**.

The one-satoshi rule matters. Transferring a 1Sat ordinal produces a *plain*
P2PKH output — the inscription envelope only ever exists in the original mint
output, and the item travels with the satoshi itself. Classifying by script
alone would miss every item a user has ever received.

### The sweep

Everything except MNEE moves in a single transaction. Ordering is load-bearing:

```
inputs :  [items…]           [tokens…]              [BSV…]
outputs:  [1 sat per item…]  [1 merged per token…]  [BSV change]
```

1Sat ordinals are tracked by satoshi position, so each item input must land on
the item output at the same offset — items first, one-to-one, in order. Tokens
are merged: all outputs of a given token become one output carrying the exact
summed amount, so no token change is needed and nothing can be stranded. BSV
change goes last and absorbs the remainder.

Every input is signed against its **real** locking script, because the signature
commits to it. A minted item's script includes the whole inscription — often tens
of kilobytes, occasionally many megabytes — so it is fetched from WhatsOnChain
while that input is signed and dropped straight after. A large collection never
has to sit in memory at once, but signing it takes a while; the button shows
progress.

Fee is 1 satoshi/byte. If the wallet holds items or tokens but no BSV, the sweep
is refused with an explanation rather than attempted — there is nothing to pay
the fee with. Broadcasting goes to Bitails, then WhatsOnChain if Bitails refuses.

### MNEE

MNEE outputs are locked to the owner **and** MNEE's approver key:

```
<inscription> OP_DUP OP_HASH160 <owner> OP_EQUALVERIFY OP_CHECKSIGVERIFY <approver> OP_CHECKSIG
```

Signing one as plain P2PKH can never validate, and a single such input would
invalidate the whole main sweep, so MNEE goes in a second transaction through the
public MNEE API — the same flow as MNEE's official SDK. It needs only the keys
and the API:

1. Every MNEE output becomes an input, signed `SIGHASH_ALL | ANYONECANPAY`.
2. Two outputs: the total minus the fee to the destination, and the fee to MNEE's
   fee address — both under the same cosigned lock, so the MNEE stays MNEE.
3. The API adds its own funding input (it pays the network fee), adds the
   approver signature and broadcasts. `ANYONECANPAY` is what lets it add that
   input without invalidating ours.

The fee is paid in MNEE, from the tiers the API publishes (currently $0.001 up to
$10 sent, $0.01 above). A balance too small to cover the fee is left behind, and
the transfer panel says so.

The main sweep goes first. If it fails, nothing has moved. If it succeeds and the
MNEE transfer then fails, the success screen says so, and scanning again retries
the MNEE on its own.

## Security model

- The two private keys are parsed into `HD` keys **in memory only**. They are
  never written to `localStorage`, `sessionStorage`, a cookie, or a server.
  Closing the tab discards the keys.
- There is no backend. Every derivation and signature happens in the browser.
- Public block explorers, the 1Sat indexer and the MNEE API see the derived
  **addresses** — never the exported keys or any private key. The MNEE API also
  receives the signed MNEE transfer, which is what it cosigns.
- The MNEE API is called with the public token MNEE publishes in its official SDK
  for client-side use; it is not a secret.

## Verification

```bash
npm run verify        # offline: derivation, signing, sweep and MNEE construction
npm run verify:live   # mainnet: discovery, classification and the MNEE API
```

`verify` asserts the things that would silently lose money if they were wrong:

- item inputs and outputs stay aligned, merged token amounts are exact, and
  satoshis balance to the last unit;
- inputs validate in the script interpreter against their real locking script,
  and a signature over plain P2PKH does *not* validate for an inscribed output;
- an MNEE transfer conserves tokens exactly, keeps every output under the
  cosigner lock, and — once a stand-in approver adds a funding input and its
  signature, as the MNEE API does — validates. The owner's signature alone does
  not;
- MNEE never enters the main sweep, and a cosigned script is never signed as
  plain P2PKH;
- a Bitails batch at its 1,000-output cap is handed to WhatsOnChain rather than
  trusted.

`verify:live` checks real mainnet addresses: that Bitails and WhatsOnChain agree,
that a swept-clean address still counts as used, that the 1Sat indexer finds
minted items the address indexers cannot see, and that the transfer script we
build matches real MNEE outputs on chain.

The two-party composition is checked against
`scripts/reference/tss_reference.py` — a standard-library Python implementation
written from the specs, sharing no code or dependencies with the TypeScript. Its
inputs are the master keys of BIP-32 test vectors 1 and 2, and it first checks
that its own xprv parser recovers them from the spec's published seeds.
Its output is baked into `verify` as fixtures, so the two implementations have
to agree on every composed key and address or the suite fails. Regenerate the
fixtures with that script if they ever need to change, never by copying what the
TypeScript happens to output.

## Troubleshooting

### A balance you expected is missing

Work through these in order:

1. **Check the keys.** Both must come from the same, most recent export of the
   same wallet. Keys from two different exports are each valid on their own, so
   the tool accepts them, but together they make a different, empty wallet.
2. **Look for the "This scan may be incomplete" warning** above the asset list.
   It means a block explorer, the 1Sat indexer or the MNEE API did not respond
   during the scan. Press **Scan again** (the refresh icon) once your connection
   is stable.
3. **Scan further.** If the wallet has handed out a long run of unused
   addresses, funds can sit past the point where the scan stops. Raise the gap
   limit as described below and scan again.

### Adjusting the scan

The scan walks each derivation path (`m/0` … `m/9`) one address at a time and
moves on to the next path after a long enough run of **unused addresses**. An
address counts as used if it has any transaction history or holds MNEE or minted
items — so one that received funds and was later emptied still resets the run.

Three settings control this, all in [`lib/handcash/derivation.ts`](lib/handcash/derivation.ts):

| Setting             | Default     | What it does                                                    |
| ------------------- | ----------- | --------------------------------------------------------------- |
| `DEFAULT_GAP_LIMIT` | `1000`      | Unused addresses in a row before a path counts as finished.     |
| `SCAN_BATCH_SIZE`   | `40`        | Addresses checked per step. The stop check runs after each step. |
| `DERIVATION_ROOTS`  | `m/0`–`m/9` | The list of paths to walk.                                      |

Because the stop check only runs after a whole step, the real gap is
`DEFAULT_GAP_LIMIT` rounded up to the next step: with the defaults, a path
ends 1,000–1,039 unused addresses after its last used one. A path with no
activity at all ends after 1,000 addresses.

#### Scan further past the last used address

1. Stop the dev server if it is running (<kbd>Ctrl</kbd>+<kbd>C</kbd>).
2. Open `lib/handcash/derivation.ts` and find:

   ```ts
   export const DEFAULT_GAP_LIMIT = 1000
   ```

3. Change `1000` to a larger number, such as `7000`.
4. Start the app again, enter the keys, and scan:

   ```bash
   npm run dev
   ```

5. Once you have recovered the funds, set the value back to `1000`.

A larger gap makes the scan slower and costs more explorer calls: an empty path
costs `DEFAULT_GAP_LIMIT` addresses, and there are ten of them. With `7000`, a
wallet with nothing in it checks 70,000 addresses instead of 10,000 — expect the
scan to take several times longer. If the explorers start refusing requests, the
incomplete-scan warning appears; wait a minute and press **Scan again**.

#### Make each step larger or smaller

Change `SCAN_BATCH_SIZE` the same way. Any positive number works: requests are
split into the sizes each explorer accepts on their own. Smaller steps stop
closer to the gap limit; larger steps need fewer round trips. Most users should
leave it at `40`.

#### Scan an extra path

Add an entry to `DERIVATION_ROOTS`, for example:

```ts
{ path: "m/10", label: "Extra", expects: "bsv" },
```

`npm run verify` checks that exactly ten single-digit paths are scanned, so it
will fail after this change. That is expected: update the
`every derivation root is scanned the same way` check in `scripts/verify.ts` to
match your list.

#### After any change

```bash
npm run verify
```

The suite runs offline and confirms that key derivation and sweep construction
still behave correctly.
