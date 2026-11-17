---
name: qi-agent
description: Give an autonomous agent a private income. Publish one payment code and receive Qi (Quai's energy-denominated UTXO cash) from any payer whose payment code you have opened a channel to, without an observer being able to link your payments or read your balance. Canary-gated reads; five undocumented protocol traps enforced in code.
---

# qi-agent — plug an agent into Quai and let it get paid

An agent that earns needs somewhere to be paid that needs no bank, no exchange, no KYC form,
and no human to click approve. This is that, working, on-chain.

**The problem with paying an agent to an 0x address:** every payment you ever receive is
public, permanently aggregated under one identifier. Your income, your rate, your runway, and
your counterparties are all readable by anyone who knows your address. For a human that is
uncomfortable. For an agent whose balance determines whether it keeps running, it is an
attack surface.

**What Qi does differently:** Qi is UTXO cash, and its BIP47 *payment codes* let you publish
ONE permanent string. Every payer derives a fresh, unlinkable address from it. (You still need
each payer's code to *see* their payments — trap 2 — so "publish and forget" is not enough.) You get a
stream of income; an observer gets a set of unrelated outputs they cannot tie to you or to
each other. Qi is also denominated in energy (the protocol targets ~1 Qi per unit of marginal
energy burned), which is the natural unit for machine work.

Proven on Orchard testnet, agent to agent, no human in the loop:
`0x00f0008d9863fe4366abca19879e953e5921c5257220fb760daaf638c51f89d0` (block 7,550,257).

Then proven again *through this library end to end*: `cli.js new agent-carol` produced an
identity that had never touched an exchange, a faucet, or a QUAI balance — and it now holds
**25.0 Qi across two freshly derived addresses** (0 QUAI, still). Publishing one string was the
entire onboarding.

## Quickstart

```bash
npm i quais
node cli.js new my-agent          # identity: a payment code to publish, a QUAI address to fund
node cli.js id my-agent           # print them again
node cli.js balance my-agent --from <payerPaymentCode>
node cli.js pay my-agent <theirPaymentCodeOrLocalName> 25 --send
node cli.js watch my-agent --from <payerPaymentCode> --timeout 600
```

```js
const { QiAgent } = require('./qi-agent');

const me = await QiAgent.create({ name: 'my-agent' });   // or QiAgent.load({ name })
await me.connect();                       // throws unless the provider passes a live canary
console.log(me.paymentCode);              // publish this. it is your permanent invoice.

await me.expectFrom(payerCode);           // REQUIRED — see trap 2
const paid = await me.waitForPayment({ timeoutMs: 600000 });
if (paid.paid) console.log(`received ${paid.received} Qi`);

await me.pay(theirCode, '25');            // dryRun by default via CLI; explicit here
```

**Exit codes are the contract:** `0` did the thing · `1` a real negative answer (no money, not
paid) · `2` **UNTRUSTED** — the answer is unknown and must not be read as a zero.

## The five traps

Each of these cost a debugging session. Each fails *silently* — a plausible wrong answer, not
an error. They are enforced in code here rather than documented at you.

**1. `usePathing` double-appends your shard.** `usePathing:true` makes quais append `/cyprus1`
to your RPC URL. If your URL already ends in `/cyprus1` every call times out while raw curl to
the same URL works fine. Reads exactly like "the node is down." Only two configs work: a
shard-suffixed URL with `usePathing:false` (the default here), or a bare base URL with
`usePathing:true` (pass `{ usePathing: true }`). The mixed config throws `QiTrapError`
(`use-pathing`) before any call is made.

**2. An unopened channel makes payments invisible.** BIP47 payments land on addresses derived
from the *pair* (payer code, payee code). Until the payee calls `openChannel(payerCode)`, those
addresses are not in the scanned set, so the money is invisible. **The scan does not error — it
returns zero.** "Nobody paid me" and "I was paid and cannot see it" are the same output. Hence
`expectFrom()` is mandatory before `waitForPayment()`, and every balance carries
`zeroIsConclusive`.

**3. Conversion reverts and burns the whole gas limit.** QUAI→Qi is protocol-level (no bridge,
no contract, no AMM): you send a QUAI-ledger tx to a Qi-ledger address. It reverts, consuming
100% of the gas limit, unless the data field carries max-slip bytes in its first two bytes
**and** the value clears an undocumented **10 QUAI minimum**. The docs say max slip "defaults"
to 90%. *It does not default.* Both failures are indistinguishable from out-of-gas. This
library sends `0x2328` by default and refuses sub-minimum amounts locally, before you pay to
find out.

**4. A dead provider reports zero, and so does an empty wallet.** Nothing in the SDK
distinguishes them. Every read here is gated on a canary: a raw JSON-RPC block number fetched
*outside* the SDK must agree with the SDK's own (within 50 blocks). An untrusted read throws
instead of returning a comfortable zero. The raw call goes to the **same RPC endpoint**, so
this catches a broken or misconfigured SDK provider, not an endpoint that is itself wrong or
stale.

**5. RESTART BLINDNESS — the expensive one.** The SDK's scan gives up after
`DEFAULT_GAP_LIMIT = 5` consecutive unused addresses (`bip44-qi-wallet.js` and
`bip47-counterparty-qi-wallet.js`, quais 1.0.0-alpha.56). But Qi change must be split into fixed
denominations, so **one payment scatters change across dozens of addresses** — agent-alice went
from 17 outpoints to 61 across two payments. A wallet restored from its seed therefore stops
partway through its own change and reports a balance below what it owns — and cannot spend the
difference.

> Measured on Orchard at block 7,550,495 (2026-08-11): `scan()` reported **3771.978 Qi**; the
> chain, asked directly with `quai_getOutpointsByAddress` past the gap limit, held **3775.956**.
> **3.978 Qi invisible and unspendable** from a wallet the SDK had just finished scanning.
> Re-derive with `QI_WALLET_DIR=../wallets node cli.js balance agent-alice`.
>
> The *magnitude* is state-dependent — it depends on how far the change scattered on your last
> payment — so treat the size of the gap as unknown until you measure it, not as ~0.1%. What is
> not state-dependent is the direction: the scan can only under-report, never over-report, the
> loss is silent, it survives restarts, and it compounds with every payment you make.

`balance()` sweeps past the gap limit, asks the chain directly, and imports what the scan
missed. It reports `sdkScanQi` (what a naive tool would have told you), `recoveredQi`, and
`underReported` so the discrepancy can never hide.

## API

| call | does |
| --- | --- |
| `QiAgent.create({name, usePathing})` | new identity, both ledgers from one seed; refuses to overwrite an existing wallet file. `usePathing:true` is for a bare base RPC URL (trap 1); the mixed config throws |
| `QiAgent.load({name})` | restore; handles both wallet-file shapes (`mnemonic` vs `serialized`) |
| `connect()` | canary-gated; **throws `QiUntrustedError`** rather than letting you read a false zero |
| `expectFrom(code[])` | open payment channels — required to see incoming payments |
| `balance({deep})` | scan + gap-limit sweep; returns `spendableQi`, `sdkScanQi`, `recoveredQi`, `underReported`, `zeroIsConclusive` |
| `pay(code, qi, {dryRun, observer})` | pay by payment code; returns `freshAddress` — the *falsifiable* form of the privacy claim |
| `waitForPayment({timeoutMs})` | block until paid; refuses to run with no open channel rather than hang forever |
| `convert(quai, {dryRun})` | QUAI→Qi with both conversion traps enforced |
| `estimateLockup()` | conversion lockup in **real days**, computed from the live block rate |
| `quaiBalance()` | the fundable QUAI-ledger side |

## Honesty notes

- **The privacy claim is checked, not asserted.** `pay()` returns `freshAddress: true` only if
  the payee's derived-address or outpoint count actually grew. If a payer has no view of the
  payee (the normal case across the internet) it returns `null` — *not measured* — rather than
  claiming a property it did not observe.
- **Never quote the conversion lockup from the constant.** `ConversionLockPeriod = 241,920` is
  denominated in BLOCKS. Orchard has run that same constant at ~10s/block (≈28 days) and at
  ~864s/block (≈6.6 years) within one week, and has also declined to enforce it at all. Call
  `estimateLockup()` at the moment you need the number.
- **Testnet.** Wallet files are written 0600 and contain seeds. Treat one as a private key.
  Orchard has been rolled back at least once (2026-08-07→08-11), taking balances with it.
- `node selftest.js` triggers the guards it can reach without funds — wallet-name, the
  usePathing mix, dead RPC, canary agreement, untrusted read, unopened channel, inconclusive
  zero, sub-minimum conversion, wallet shape, overwrite, self-payment — plus a positive
  control, because a suite where everything throws would pass vacuously. It needs the live
  Orchard RPC. It does **not** exercise a real payment, a real conversion, or the gap-limit
  sweep recovering a non-zero amount; those need a funded wallet.
- **Two gap-limit measurements are quoted in this repo and they differ.** The one above
  (3771.978 vs 3775.956, 3.978 Qi hidden) and the one in the `qi-agent.js` header and
  `selftest.js` (3401.008 vs 3800.978, 399.97 Qi hidden) are both dated 2026-08-11. Neither
  can be re-derived from this repo (the wallet is not shipped), so treat both as anecdotes
  about direction, not as a rate.

## Why this is the interesting primitive

Agent-to-agent payment is usually described as a future problem. It is not: the rail exists,
it is private by construction rather than by policy, and an agent can hold and spend on it with
no custodian. What was missing was the five feet of cable between an agent and the chain — the
part where a wrong default silently eats your gas, or your own change quietly disappears. That
is what this is.
