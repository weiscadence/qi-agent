'use strict';
/**
 * qi-agent — plug an agent into Quai so it can receive and send private money (Qi).
 *
 * WHAT THIS IS FOR
 * An autonomous agent that earns needs somewhere to be paid that does not require a bank, an
 * exchange, a KYC form, or a human to click approve. Quai's Qi is UTXO cash denominated in
 * energy, and its BIP47 payment codes let an agent publish ONE permanent string and receive an
 * unbounded stream of payments that an observer cannot link together into a balance. That is
 * the property a plain EVM address structurally cannot give you: publish an 0x address and
 * every payment you ever receive is a public, aggregated, permanent record of your income.
 *
 * WHAT THIS LIBRARY ADDS OVER THE RAW SDK
 * Five undocumented traps, each of which cost us a debugging session and each of which fails
 * SILENTLY — that is, produces a plausible wrong answer rather than an error:
 *
 *   1. usePathing. `usePathing:true` makes quais APPEND the shard path to your RPC URL. If your
 *      URL already ends in /cyprus1 it double-appends and every call times out, while raw curl
 *      to the same URL works fine. Reads as "the node is down".
 *   2. The unopened channel. A payee who has not called openChannel(payerCode) CANNOT SEE a
 *      payment made to their own payment code. The scan returns an honest, empty zero that is
 *      indistinguishable from "nobody ever paid me". Money not lost, just unaddressed.
 *   3. The conversion revert. QUAI->Qi conversion reverts and burns the ENTIRE gas limit unless
 *      the data field carries max-slip bytes and the value clears an undocumented 10 QUAI
 *      minimum. The docs say max slip "defaults" to 90%. It does not default. Both failures
 *      are indistinguishable from out-of-gas.
 *   4. The dead-provider zero. Any balance read through a broken provider is 0. An unfunded
 *      wallet is also 0. Nothing in the SDK distinguishes them.
 *   5. RESTART BLINDNESS — the expensive one. The SDK's address scan has a gap limit of FIVE
 *      (`_GAP_LIMIT = 5`), while a single Qi payment scatters its change across ~26 addresses,
 *      because a UTXO change amount must be broken into fixed denominations. So after one
 *      payment, a wallet restored from its seed finds only the first few change outputs and
 *      reports a balance far below what it owns. Measured on Orchard 2026-08-11: true balance
 *      3800.978 Qi, `scan()` and `sync()` both reported 3401.008 — 399.97 Qi (10.5%) invisible
 *      AND UNSPENDABLE, while raw quai_getOutpointsByAddress confirmed those outputs unspent.
 *      The loss is silent, it survives restarts, and it grows with every payment you make.
 *      balance() here sweeps past the gap limit and imports what the scan missed.
 *
 * So every read in here is CANARY-GATED: the SDK provider is proven against a raw JSON-RPC
 * block number before any number it reports is believed, and an untrusted read THROWS rather
 * than returning a comfortable zero. Scope of that guarantee: the canary compares the SDK
 * against a raw call to the SAME RPC endpoint, within a 50-block tolerance. It catches a
 * misconfigured or dead SDK provider; it cannot catch an endpoint that is itself wrong or
 * lagging, and a zero with no channel open is still inconclusive (see zeroIsConclusive).
 *
 * TESTNET SAFETY: seeds are written to 0600 files. Treat any wallet file as a private key.
 *
 *   const { QiAgent } = require('./qi-agent');
 *   const me = await QiAgent.create({ name: 'my-agent' });   // or QiAgent.load({ name })
 *   await me.connect();                                      // canary-gated
 *   console.log(me.paymentCode);                             // publish this to get paid
 *   await me.expectFrom(theirPaymentCode);                   // REQUIRED before you can see it
 *   await me.balance();                                      // { spendable, locked, ... }
 *   await me.pay(theirPaymentCode, '100');                   // fresh address, unlinkable
 */
const fs = require('fs');
const path = require('path');
const quais = require('quais');

const DEFAULT_RPC = process.env.QI_RPC || 'https://orchard.rpc.quai.network/cyprus1';
const DEFAULT_DIR = process.env.QI_WALLET_DIR || path.join(process.cwd(), 'wallets');

// go-quai params/protocol_params.go: ConversionLockPeriod = 2 * BlocksPerWeek.
// Denominated in BLOCKS, never in days — the wall-clock wait is a function of the live block
// rate and must be computed at call time. Orchard has run this constant at both ~10s/block
// (28 days) and ~864s/block (6.6 years) within one week, and has also declined to enforce it
// at all. Never quote a duration for this from memory; call estimateLockup().
const CONVERSION_LOCK_BLOCKS = 241920;
const CONVERSION_MIN_QUAI = 10n; // undocumented protocol minimum; below this, silent revert.

class QiUntrustedError extends Error {
  constructor(msg) { super(msg); this.name = 'QiUntrustedError'; this.code = 'UNTRUSTED'; }
}
class QiTrapError extends Error {
  constructor(msg, trap) { super(msg); this.name = 'QiTrapError'; this.code = 'TRAP'; this.trap = trap; }
}

/**
 * Wallet names become file names. Refuse anything that could leave the wallet directory
 * (`../x`, `a/b`) instead of reading or writing a seed file somewhere unexpected.
 */
function safeWalletName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}
function assertWalletName(name) {
  if (!safeWalletName(name)) {
    throw new QiTrapError(`wallet name ${JSON.stringify(name)} is not a plain file name — use letters, digits, ".", "_" or "-"`, 'wallet-name');
  }
}

/** quais shard nicknames, as they appear as the last path segment of an RPC URL. */
const SHARD_PATH_RE = /\/(prime|cyprus[1-3]?|paxos[1-3]?|hydra[1-3]?)\/?$/i;

/**
 * Raw JSON-RPC, deliberately NOT through the SDK — this is the SDK-independent side of the
 * canary. It talks to the same endpoint, so it proves the SDK wiring, not the endpoint.
 */
async function rawBlockNumber(rpc) {
  let j;
  try {
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'quai_blockNumber', params: [] }),
    });
    j = await r.json();
  } catch (e) {
    // An unreachable node must surface as UNTRUSTED, not as a bare TypeError("fetch failed").
    throw new QiUntrustedError(`raw RPC unreachable at ${rpc}: ${e.cause?.code || e.message}`);
  }
  if (!j || typeof j.result !== 'string') throw new QiUntrustedError(`raw RPC returned no block number from ${rpc}`);
  return parseInt(j.result, 16);
}

async function rawBlockTimestamp(rpc, n) {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'quai_getBlockByNumber', params: ['0x' + n.toString(16), false] }),
  });
  const j = await r.json();
  const ts = j?.result?.woHeader?.timestamp;
  return ts ? parseInt(ts, 16) : null;
}

class QiAgent {
  constructor(record, opts = {}) {
    this.record = record;
    this.name = record.name;
    this.paymentCode = record.paymentCode;
    this.qiAddress = record.qiAddress || record.firstReceiveAddress || null;
    this.quaiAddress = record.quaiAddress || null;
    this.dir = opts.dir || DEFAULT_DIR;
    this.rpc = opts.rpc || DEFAULT_RPC;
    // Trap 1. false: `rpc` already names the shard (…/cyprus1). true: `rpc` is a bare base URL
    // and quais appends the shard path itself. Mixing the two is refused in connect().
    this.usePathing = opts.usePathing === true;
    this.zone = opts.zone || quais.Zone.Cyprus1;
    this.shard = opts.shard || quais.Shard.Cyprus1;
    this.provider = null;
    this.wallet = null;
    this.quaiWallet = null;
    this.trusted = false;
    this.blockNumber = null;
    this.channels = new Set();
  }

  /**
   * Create a brand-new agent identity. One mnemonic yields BOTH ledgers: a QUAI 0x address
   * (fundable — this is how value gets IN, since Qi is mined-only with zero premine) and a Qi
   * wallet with a payment code (how the agent gets paid privately once it holds Qi).
   * Derivation is deliberately SYNC: it is pure key math, and the async variants scan the chain
   * and hang on a wallet that has no history yet.
   */
  static async create({ name, dir = DEFAULT_DIR, save = true, ...opts } = {}) {
    if (!name) throw new Error('create({ name }) requires a name');
    assertWalletName(name);
    const zone = opts.zone || quais.Zone.Cyprus1;
    const mnemonic = quais.Mnemonic.fromEntropy(quais.randomBytes(16));
    const qiWallet = quais.QiHDWallet.fromMnemonic(mnemonic);
    const quaiWallet = quais.QuaiHDWallet.fromMnemonic(mnemonic);
    const record = {
      name,
      mnemonic: mnemonic.phrase, // SECRET
      quaiAddress: quaiWallet.getNextAddressSync(0, zone).address,
      qiAddress: qiWallet.getNextAddressSync(0, zone).address,
      paymentCode: qiWallet.getPaymentCode(0),
      network: opts.network || 'orchard-testnet',
      createdAt: new Date().toISOString(),
    };
    if (!quais.isQiAddress(record.qiAddress)) {
      throw new Error(`derived a non-Qi address (${record.qiAddress}) — refusing to save a broken identity`);
    }
    if (save) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${name}.json`);
      if (fs.existsSync(file)) throw new Error(`${file} already exists — refusing to overwrite a wallet (that destroys keys)`);
      fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
    }
    return new QiAgent(record, { dir, ...opts });
  }

  /** Restore from a saved wallet file. See _restoreWallet for why the shape matters. */
  static async load({ name, dir = DEFAULT_DIR, ...opts } = {}) {
    assertWalletName(name);
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) throw new Error(`no wallet at ${file} — run create({ name: '${name}' }) first`);
    return new QiAgent(JSON.parse(fs.readFileSync(file, 'utf8')), { dir, ...opts });
  }

  /**
   * Wallet files in the wild are NOT one shape. A file written by a key generator carries a
   * `mnemonic`; one written by wallet.serialize() carries only a `serialized` blob. Restoring
   * the wrong way throws "Cannot read properties of undefined (reading 'toLowerCase')" from
   * deep inside the SDK, which reads like a provider fault and sends you looking in the wrong
   * place. Branch explicitly and say so out loud when neither field is present.
   */
  async _restoreWallet() {
    const r = this.record;
    if (r.mnemonic) return quais.QiHDWallet.fromMnemonic(quais.Mnemonic.fromPhrase(r.mnemonic));
    if (r.serialized) return await quais.QiHDWallet.deserialize(r.serialized);
    throw new QiTrapError(
      `wallet file for "${this.name}" has neither .mnemonic nor .serialized — cannot restore`,
      'wallet-shape');
  }

  /**
   * Connect and PROVE the connection before trusting anything it says.
   *
   * The canary is a raw JSON-RPC block number fetched outside the SDK, compared against the
   * SDK's own. They must agree within `tolerance` blocks. If the SDK is misconfigured (see the
   * usePathing trap) it times out or lags, and every balance it reports afterwards is 0 —
   * which is exactly what an unfunded wallet looks like. This is the guard that makes a zero
   * from this library mean something.
   */
  async connect({ tolerance = 50 } = {}) {
    // usePathing MUST be false when the URL names the shard (…/cyprus1). If yours does not,
    // pass an unsuffixed base URL and set usePathing:true — those are the only two configs
    // that work, and mixing them is the double-append timeout. Refuse the mix by name.
    if (this.usePathing && SHARD_PATH_RE.test(this.rpc)) {
      throw new QiTrapError(
        `usePathing:true with an RPC URL that already names a shard (${this.rpc}) — quais would append the shard path a second time and every call would time out. Drop the suffix or pass usePathing:false.`,
        'use-pathing');
    }
    this.provider = new quais.JsonRpcProvider(this.rpc, undefined, { usePathing: this.usePathing });
    // The raw side has no SDK to append the path for it.
    const rawUrl = this.usePathing ? `${this.rpc.replace(/\/+$/, '')}/cyprus1` : this.rpc;
    const raw = await rawBlockNumber(rawUrl);
    let sdk = null;
    try { sdk = await this.provider.getBlockNumber(this.shard); } catch (e) { sdk = null; }
    this.blockNumber = raw;
    this.sdkBlockNumber = sdk;
    if (sdk === null || Math.abs(sdk - raw) > tolerance) {
      this.trusted = false;
      throw new QiUntrustedError(
        `provider canary FAILED: raw RPC says block ${raw}, SDK says ${sdk}. ` +
        `Every balance read through this provider would be a false zero. RPC: ${this.rpc}`);
    }
    this.trusted = true;
    this.wallet = await this._restoreWallet();
    this.wallet.connect(this.provider);
    if (this.record.mnemonic) {
      this.quaiWallet = quais.QuaiHDWallet.fromMnemonic(quais.Mnemonic.fromPhrase(this.record.mnemonic));
      this.quaiWallet.connect(this.provider);
    }
    return this;
  }

  _assertTrusted() {
    if (!this.trusted) throw new QiUntrustedError('not connected, or the provider canary failed — refusing to report a number that could be a false zero. Call connect() and handle its error.');
  }

  /**
   * Declare a counterparty you expect to be paid by. THIS IS NOT OPTIONAL.
   *
   * BIP47 payments land on addresses derived from the PAIR (payer code, payee code). Until the
   * payee opens the channel to that specific payer, those addresses are not in the set the
   * wallet scans, so the money is invisible. The scan does not error — it returns zero. If you
   * only ever call balance() without this, "I was never paid" and "I was paid and cannot see
   * it" are the same output.
   */
  async expectFrom(paymentCode) {
    const codes = Array.isArray(paymentCode) ? paymentCode : [paymentCode];
    this._assertTrusted();
    for (const c of codes) {
      if (!c || c === this.paymentCode) continue;
      this.wallet.openChannel(c);
      this.channels.add(c);
    }
    return [...this.channels];
  }

  /** Open channels to every other wallet file in the directory. Convenience for local demos. */
  async expectFromLocalWallets() {
    const codes = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const other = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (other.paymentCode) codes.push(other.paymentCode);
      } catch (e) { /* a malformed neighbour file is not a reason to fail the scan */ }
    }
    return this.expectFrom(codes);
  }

  /**
   * Sweep PAST the SDK's gap limit and import what its scan could not see.
   *
   * `scan()`/`sync()` walk each branch until they hit `_GAP_LIMIT = 5` consecutive unused
   * addresses, then stop. One Qi payment's change is denominated across ~26 addresses, so the
   * scan stops in the middle of your own change and the rest of your money becomes invisible
   * and unspendable. This derives `depth` addresses on each branch, asks the chain directly
   * (quai_getOutpointsByAddress — outside the SDK, so it cannot inherit the SDK's blind spot),
   * and imports every unspent outpoint the scan missed.
   *
   * Cost: roughly `depth × (2 + openChannels)` RPC calls, a few seconds. Cheap next to losing
   * a tenth of your balance. Runs once per instance unless force:true.
   */
  async _deepSweep({ depth = 40, force = false } = {}) {
    if (this._swept && !force) return this._swept;
    const found = [];
    const seen = new Set();
    const ask = async (info, branch) => {
      if (!info?.address || seen.has(info.address)) return;
      seen.add(info.address);
      const r = await fetch(this.rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'quai_getOutpointsByAddress', params: [info.address] }),
      }).then((x) => x.json()).catch(() => null);
      // A failed query must not be read as "no outpoints here" — that is the same broken zero
      // one level down. Record it so the caller can see the sweep was incomplete.
      if (!r || !Array.isArray(r.result)) { this._sweepErrors = (this._sweepErrors || 0) + 1; return; }
      for (const o of r.result) {
        found.push({
          outpoint: { txhash: o.txHash, index: parseInt(o.index, 16), denomination: parseInt(o.denomination, 16), lock: parseInt(o.lock, 16) },
          address: info.address, zone: this.zone, account: 0,
          derivationPath: info.derivationPath ?? branch,
        });
      }
    };
    for (let i = 0; i < depth; i++) {
      try { await ask(this.wallet.getNextChangeAddressSync(0, this.zone), 'BIP44:change'); } catch (e) { break; }
    }
    for (let i = 0; i < depth; i++) {
      try { await ask(this.wallet.getNextAddressSync(0, this.zone), 'BIP44:external'); } catch (e) { break; }
    }
    // Payments made TO us land on channel-derived addresses, which have the same gap problem
    // once we have been paid more than a handful of times.
    for (const code of this.channels) {
      for (let i = 0; i < depth; i++) {
        try { await ask(this.wallet.getNextReceiveAddress(code, this.zone), code); } catch (e) { break; }
      }
    }
    let imported = 0;
    if (found.length) {
      try { this.wallet.importOutpoints(found); imported = found.length; }
      catch (e) { this._sweepImportError = e.message; }
    }
    this._swept = { swept: seen.size, imported, errors: this._sweepErrors || 0, importError: this._sweepImportError || null };
    return this._swept;
  }

  /**
   * Scan the chain and report holdings.
   *
   * Returns { spendable, locked, spendableQi, lockedQi, sdkScanQi, recoveredQi, underReported,
   *           outpoints, addresses, channelsOpen, zeroIsConclusive, block }.
   *
   * Two fields exist purely so the failure modes cannot hide:
   *   - `zeroIsConclusive` — a zero with no channels open tells you NOTHING about whether you
   *     were paid. Anything that alerts on "no money arrived" must check this first.
   *   - `underReported` / `recoveredQi` — how much money the SDK's own scan could not see.
   *     If this is ever non-zero, `spendableQi` is right and any other tool reading this wallet
   *     is wrong.
   */
  async balance({ deep = true, depth = 40, force = false } = {}) {
    this._assertTrusted();
    await this.wallet.scan(this.zone);
    const sdkScan = await this._bal('Spendable');
    if (deep) await this._deepSweep({ depth, force });
    const spendable = deep ? await this._bal('Spendable') : sdkScan;
    const locked = await this._bal('Locked');
    const outpoints = this.wallet.getOutpoints ? this.wallet.getOutpoints(this.zone) : [];
    const addresses = this.wallet.getAddressesForZone ? this.wallet.getAddressesForZone(this.zone) : [];
    const channelsOpen = this.channels.size;
    const recovered = (typeof spendable === 'bigint' && typeof sdkScan === 'bigint') ? spendable - sdkScan : null;
    return {
      spendable, locked,
      spendableQi: typeof spendable === 'bigint' ? quais.formatQi(spendable) : null,
      lockedQi: typeof locked === 'bigint' ? quais.formatQi(locked) : null,
      sdkScanQi: typeof sdkScan === 'bigint' ? quais.formatQi(sdkScan) : null,
      recoveredQi: recovered === null ? null : quais.formatQi(recovered),
      underReported: recovered === null ? null : recovered > 0n,
      sweep: this._swept ?? null,
      outpoints: Array.isArray(outpoints) ? outpoints.length : 0,
      outpointDetail: (Array.isArray(outpoints) ? outpoints : []).map((o) => ({
        address: o.address, denomination: o.outpoint?.denomination, lock: o.outpoint?.lock ?? null,
      })),
      addresses: Array.isArray(addresses) ? addresses.length : 0,
      channelsOpen,
      zeroIsConclusive: channelsOpen > 0,
      block: this.blockNumber,
    };
  }

  async _bal(kind) {
    for (const m of [`get${kind}BalanceForZone`, `get${kind}Balance`]) {
      if (typeof this.wallet[m] === 'function') {
        try { return await this.wallet[m](this.zone); } catch (e) { /* try the next spelling */ }
      }
    }
    // Do NOT fall back to 0n here. An unreadable balance is not an empty balance.
    throw new QiUntrustedError(`could not read ${kind.toLowerCase()} balance through any known SDK method`);
  }

  /** The QUAI-ledger (account model) balance — the fundable side. */
  async quaiBalance() {
    this._assertTrusted();
    if (!this.quaiAddress) return null;
    const b = await this.provider.getBalance(this.quaiAddress);
    return { wei: b, quai: quais.formatQuai(b) };
  }

  /**
   * Pay another agent by payment code. Never by address — an address is the thing you are
   * trying not to reuse.
   *
   * Returns { txHash, block, status, freshAddress, ... }. `freshAddress` is the FALSIFIABLE
   * form of the privacy claim: it is true only if the payee's derived-address or outpoint
   * count actually grew, i.e. the money really did land somewhere previously unexposed. If it
   * comes back false, the unlinkability property did not hold for that payment and you should
   * say so rather than assume it.
   *
   * `observer` (optional) is the payee's own QiAgent, used purely to measure the before/after
   * on their side. In production you do not have it — the payer cannot verify the payee's
   * privacy, only the payee can. Absent it, freshAddress is reported as null, not as true.
   */
  async pay(toPaymentCode, amountQi, { dryRun = false, observer = null } = {}) {
    this._assertTrusted();
    if (!toPaymentCode) throw new Error('pay() requires the payee payment code');
    if (toPaymentCode === this.paymentCode) throw new Error('refusing to pay yourself — that is not a test of anything');
    const amount = quais.parseQi(String(amountQi));

    // The payer must open the channel too: it is what lets them DERIVE the payee's next
    // address. Without it there is no address to pay to.
    await this.expectFrom(toPaymentCode);
    if (observer) await observer.expectFrom(this.paymentCode);

    const before = await this.balance();
    const obsBefore = observer ? await observer.balance() : null;
    if (typeof before.spendable === 'bigint' && before.spendable < amount) {
      throw new Error(`insufficient Qi: have ${before.spendableQi}, need ${quais.formatQi(amount)}`);
    }
    if (dryRun) {
      return { dryRun: true, from: this.paymentCode, to: toPaymentCode, amountQi: String(amountQi),
               spendableBefore: before.spendableQi, sent: false };
    }

    const tx = await this.wallet.sendTransaction(toPaymentCode, amount, this.zone, this.zone);
    const receipt = await tx.wait();
    const after = await this.balance();
    const obsAfter = observer ? await observer.balance() : null;

    const freshAddress = obsBefore && obsAfter
      ? (obsAfter.addresses > obsBefore.addresses || obsAfter.outpoints > obsBefore.outpoints)
      : null;

    return {
      txHash: tx.hash,
      block: receipt?.blockNumber ?? null,
      status: receipt?.status ?? null,
      amountQi: String(amountQi),
      payerBefore: before.spendableQi, payerAfter: after.spendableQi,
      payerDelta: (typeof after.spendable === 'bigint' && typeof before.spendable === 'bigint')
        ? quais.formatQi(after.spendable - before.spendable) : null,
      payeeDelta: (obsBefore && obsAfter && typeof obsAfter.spendable === 'bigint')
        ? quais.formatQi(obsAfter.spendable - obsBefore.spendable) : null,
      freshAddress,
      freshAddressNote: freshAddress === null
        ? 'not measured — no observer wallet passed; the payer cannot verify the payee\'s privacy'
        : (freshAddress ? 'payment landed on newly derived output(s)' : 'NO new address — do not claim unlinkability for this payment'),
      sent: true,
    };
  }

  /**
   * Block until a payment arrives (or the timeout expires). This is the "my agent has an
   * income" primitive: publish paymentCode, call waitForPayment, act when paid.
   *
   * Refuses to run without an open channel, because otherwise it would wait forever on money
   * that has already arrived and cannot be seen.
   */
  async waitForPayment({ timeoutMs = 300000, pollMs = 15000, minIncrease = 1n, onPoll = null } = {}) {
    this._assertTrusted();
    if (this.channels.size === 0) {
      throw new QiTrapError(
        'waitForPayment() called with no open channels — a payment to your code would be invisible and this would hang forever. Call expectFrom(payerCode) first.',
        'unopened-channel');
    }
    const start = Date.now();
    const first = await this.balance();
    const baseline = typeof first.spendable === 'bigint' ? first.spendable : 0n;
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const now = await this.balance();
      if (onPoll) onPoll(now);
      if (typeof now.spendable === 'bigint' && now.spendable - baseline >= minIncrease) {
        return { paid: true, received: quais.formatQi(now.spendable - baseline),
                 spendableQi: now.spendableQi, waitedMs: Date.now() - start, block: this.blockNumber };
      }
    }
    // Before returning a NEGATIVE, re-sweep past the gap limit. Otherwise "you were not paid"
    // could be an artifact of the scan stopping short — the exact silent-loss shape trap 5
    // describes, delivered as a confident no.
    const final = await this.balance({ force: true });
    if (typeof final.spendable === 'bigint' && final.spendable - baseline >= minIncrease) {
      return { paid: true, received: quais.formatQi(final.spendable - baseline), spendableQi: final.spendableQi,
               waitedMs: Date.now() - start, block: this.blockNumber,
               note: 'found only by the deep sweep — the SDK scan alone would have reported no payment' };
    }
    return { paid: false, waitedMs: Date.now() - start, spendableQi: final.spendableQi,
             note: 'timed out — a real "no payment": channels were open and a deep sweep past the gap limit also found nothing' };
  }

  /**
   * How long is conversion output locked, in wall-clock time, RIGHT NOW.
   * Computed from the live block rate over a real sample, never quoted from the constant.
   */
  async estimateLockup({ sample = 5000 } = {}) {
    this._assertTrusted();
    const tip = this.blockNumber;
    const t1 = await rawBlockTimestamp(this.rpc, tip);
    const t0 = await rawBlockTimestamp(this.rpc, tip - sample);
    if (t1 === null || t0 === null) {
      return { blocks: CONVERSION_LOCK_BLOCKS, secondsPerBlock: null, days: null,
               note: 'block rate UNAVAILABLE — the lockup in days cannot be computed, do not guess it' };
    }
    const secondsPerBlock = (t1 - t0) / sample;
    return {
      blocks: CONVERSION_LOCK_BLOCKS,
      secondsPerBlock,
      days: (CONVERSION_LOCK_BLOCKS * secondsPerBlock) / 86400,
      unlocksNearBlock: tip + CONVERSION_LOCK_BLOCKS,
      note: 'the protocol constant is in BLOCKS; observed testnets have both enforced and ignored it — verify with balance().locked after converting',
    };
  }

  /**
   * QUAI -> Qi, the protocol-level conversion. No bridge, no contract, no AMM: you send a
   * QUAI-ledger transaction whose recipient is a Qi-ledger address and the protocol converts.
   *
   * Both traps are enforced here rather than documented:
   *   - maxSlipBps MUST be in the first two bytes of the data field. The docs say it defaults
   *     to 9000. It does not default; empty data reverts and burns the whole gas limit.
   *   - value must clear an undocumented 10 QUAI minimum; below it, identical silent revert.
   * Both look exactly like out-of-gas, so we refuse locally instead of paying to find out.
   */
  async convert(amountQuai, { maxSlipBps = 9000, gasLimit = 1000000n, dryRun = true } = {}) {
    this._assertTrusted();
    if (!this.quaiWallet) throw new QiTrapError('conversion needs the QUAI ledger, which needs the mnemonic — this wallet file only has a serialized Qi blob', 'wallet-shape');
    const value = quais.parseQuai(String(amountQuai));
    if (BigInt(Math.floor(Number(amountQuai))) < CONVERSION_MIN_QUAI) {
      throw new QiTrapError(
        `${amountQuai} QUAI is below the undocumented ${CONVERSION_MIN_QUAI} QUAI conversion minimum — the protocol would revert and burn the entire gas limit, which is indistinguishable from out-of-gas`,
        'conversion-minimum');
    }
    const from = (await this.quaiWallet.getNextAddress(0, this.zone)).address;
    // Refuse to sign with a wallet that is not the funded one. A silently different derivation
    // path is another way to get a confident zero.
    if (this.quaiAddress && from.toLowerCase() !== this.quaiAddress.toLowerCase()) {
      throw new QiTrapError(`derived ${from} but wallet file says ${this.quaiAddress} — refusing to sign with a wallet that is not the funded one`, 'derivation-mismatch');
    }
    const bal = await this.provider.getBalance(from);
    if (bal < value) throw new Error(`QUAI balance ${quais.formatQuai(bal)} < requested ${amountQuai}`);

    let quoted = null;
    try { quoted = await this.provider.calculateConversionAmount({ from, to: this.qiAddress, value }); } catch (e) { /* quote is advisory */ }
    const data = '0x' + maxSlipBps.toString(16).padStart(4, '0');
    const lockup = await this.estimateLockup();
    const plan = { from, to: this.qiAddress, amountQuai: String(amountQuai), maxSlipBps, data,
                   gasLimit: String(gasLimit), quotedQi: quoted ? quais.formatQi(quoted) : null, lockup };
    if (dryRun) return { ...plan, dryRun: true, sent: false };

    const tx = await this.quaiWallet.sendTransaction({ from, to: this.qiAddress, value, gasLimit, data });
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) {
      throw new QiTrapError(`conversion receipt status ${rcpt.status} — reverted. Check max-slip bytes and the ${CONVERSION_MIN_QUAI} QUAI minimum; a revert burns the full gas limit and looks like out-of-gas.`, 'conversion-revert');
    }
    return { ...plan, txHash: tx.hash, block: rcpt.blockNumber, status: rcpt.status, sent: true };
  }
}

module.exports = {
  QiAgent, QiUntrustedError, QiTrapError, safeWalletName,
  CONVERSION_LOCK_BLOCKS, CONVERSION_MIN_QUAI,
  DEFAULT_RPC, DEFAULT_DIR,
  quais,
};
