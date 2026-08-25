'use strict';
/**
 * selftest.js — proves the guards actually fire.
 *
 * A canary you have never seen fail is not a canary, it is a comment. Every guard in
 * qi-agent.js exists to convert a silent wrong answer into a loud one, so each one is tested
 * here by ACTUALLY TRIGGERING IT — bogus RPC, unopened channel, sub-minimum conversion, wrong
 * wallet shape — and asserting the specific error type comes back.
 *
 * The POSITIVE CONTROL is the important one: a suite where everything throws would pass all
 * the negative tests vacuously. Test 1 proves the real RPC connects and the canary passes, so
 * the failures below are discriminating rather than universal.
 *
 * Run: node selftest.js            (needs network for tests 1 and 6; the rest are offline)
 * Exit: 0 all passed · 1 a guard did not fire · 2 the positive control failed (suite untrusted)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { QiAgent, QiUntrustedError, QiTrapError, DEFAULT_DIR, quais } = require('./qi-agent');
const quaisParse = (s) => quais.parseQi(String(s));

const results = [];
const ok = (n, d) => { results.push({ n, pass: true, d }); console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { results.push({ n, pass: false, d }); console.log(`  FAIL  ${n} — ${d}`); };

async function expectThrow(name, fn, Type, matcher) {
  try {
    await fn();
    bad(name, 'no error thrown — THE GUARD DID NOT FIRE');
  } catch (e) {
    if (Type && !(e instanceof Type)) return bad(name, `threw ${e.name} (${e.message}), expected ${Type.name}`);
    if (matcher && !matcher.test(e.message)) return bad(name, `message did not match ${matcher}: ${e.message}`);
    ok(name, e.message.slice(0, 90));
  }
}

(async () => {
  const dir = process.env.QI_WALLET_DIR || DEFAULT_DIR;
  const haveWallets = fs.existsSync(path.join(dir, 'agent-alice.json'));
  console.log(`wallet dir     : ${dir}${haveWallets ? '' : '  (no agent-alice.json — using a throwaway identity)'}\n`);

  // A subject wallet. Prefer the real one so the positive control exercises a real identity.
  let subject;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-selftest-'));
  if (haveWallets) subject = await QiAgent.load({ name: 'agent-alice', dir });
  else subject = await QiAgent.create({ name: 'selftest-agent', dir: tmp });

  // ── 1. POSITIVE CONTROL ────────────────────────────────────────────────────
  // If this fails, every negative test below is meaningless and the suite is UNTRUSTED.
  let live = false;
  try {
    await subject.connect();
    live = true;
    ok('1 positive control: real RPC connects, canary passes', `block ${subject.blockNumber}`);
  } catch (e) {
    bad('1 positive control: real RPC connects, canary passes', e.message);
    console.log('\nUNTRUSTED — the positive control failed, so a passing negative test proves nothing.');
    process.exit(2);
  }

  // ── 2. dead provider must throw, not report zero ───────────────────────────
  await expectThrow('2 canary fires on a dead RPC (no false zero)', async () => {
    const a = await QiAgent.load({ name: subject.name, dir: subject.dir, rpc: 'http://127.0.0.1:9/cyprus1' });
    await a.connect();
    // If connect() ever stops throwing, this is the silent-failure shape we are guarding:
    return await a.balance();
  }, undefined, /canary FAILED|fetch failed|ECONNREFUSED|UNTRUSTED/i);

  // ── 3. the block-height comparison is live, not a no-op ───────────────────
  // Test 2 proves the canary catches an unreachable node, but a comparison that never
  // actually compares would also pass it. Forcing an impossible tolerance shows the
  // agreement check itself is wired up and can reject a provider that DID answer.
  await expectThrow('3 the agreement check is wired (rejects on impossible tolerance)', async () => {
    const a = await QiAgent.load({ name: subject.name, dir: subject.dir });
    await a.connect({ tolerance: -1 });
  }, QiUntrustedError, /canary FAILED/);

  // ── 4. reading a balance before/without a proven provider must throw ───────
  await expectThrow('4 balance() refuses to answer while untrusted', async () => {
    const a = await QiAgent.load({ name: subject.name, dir: subject.dir });
    return await a.balance(); // never connected
  }, QiUntrustedError, /refusing to report/);

  // ── 5. the unopened-channel trap must be loud, not an infinite wait ────────
  await expectThrow('5 waitForPayment refuses with no open channel', async () => {
    const a = await QiAgent.load({ name: subject.name, dir: subject.dir });
    await a.connect();
    return await a.waitForPayment({ timeoutMs: 1000, pollMs: 100 });
  }, QiTrapError, /invisible/);

  // ── 6. zero must be self-labelling ─────────────────────────────────────────
  // A balance read with no channels open reports zeroIsConclusive:false. This is the field
  // that stops a caller from turning "I cannot see it" into "it never arrived".
  {
    const a = await QiAgent.load({ name: subject.name, dir: subject.dir });
    await a.connect();
    const b = await a.balance();
    if (b.zeroIsConclusive === false && b.channelsOpen === 0) ok('6 zero labels itself inconclusive with no channels', `spendable=${b.spendableQi}, channelsOpen=0`);
    else bad('6 zero labels itself inconclusive with no channels', `channelsOpen=${b.channelsOpen}, zeroIsConclusive=${b.zeroIsConclusive}`);
  }

  // ── 6b. the gap-limit sweep must be honest about what the SDK alone would say ─
  // Measured on Orchard 2026-08-11: scan() reported 3401.008 Qi while the wallet actually
  // owned 3800.978. The invariant that must hold on ANY wallet: the swept balance is never
  // below the naive one, and underReported says so exactly when they differ.
  {
    const a = await QiAgent.load({ name: subject.name, dir: subject.dir });
    await a.connect();
    const b = await a.balance();
    const consistent = b.spendable >= (b.sdkScanQi === null ? 0n : quaisParse(b.sdkScanQi))
      && b.underReported === (b.recoveredQi !== null && parseFloat(b.recoveredQi) > 0);
    if (consistent) ok('6b gap-limit sweep reports honestly', `sdk=${b.sdkScanQi} swept=${b.spendableQi} recovered=${b.recoveredQi}`);
    else bad('6b gap-limit sweep reports honestly', `sdk=${b.sdkScanQi} swept=${b.spendableQi} underReported=${b.underReported}`);
  }

  // ── 7. sub-minimum conversion must be refused LOCALLY, before paying gas ───
  await expectThrow('7 conversion below the 10 QUAI minimum is refused locally', async () => {
    const a = await QiAgent.load({ name: subject.name, dir: subject.dir });
    await a.connect();
    return await a.convert('1', { dryRun: true });
  }, QiTrapError, /minimum/);

  // ── 8. wallet-shape branch ─────────────────────────────────────────────────
  // A serialized-only wallet file has no mnemonic, so it cannot touch the QUAI ledger. The old
  // failure mode was an opaque "cannot read properties of undefined" from inside the SDK.
  if (fs.existsSync(path.join(dir, 'agent-bob.json'))) {
    const bob = await QiAgent.load({ name: 'agent-bob', dir });
    await bob.connect(); // must succeed: a serialized Qi wallet restores fine
    ok('8a serialized-only wallet restores and connects', `code ${bob.paymentCode.slice(0, 14)}…`);
    await expectThrow('8b serialized-only wallet refuses to convert with a clear reason', async () => {
      return await bob.convert('10', { dryRun: true });
    }, QiTrapError, /serialized/);
  } else {
    console.log('  SKIP  8 wallet-shape branch (no agent-bob.json present)');
  }

  // ── 9. refusing to overwrite an existing wallet file ──────────────────────
  await expectThrow('9 create() refuses to overwrite an existing wallet', async () => {
    await QiAgent.create({ name: subject.name, dir: subject.dir });
  }, undefined, /already exists/);

  // ── 10. paying yourself proves nothing and is refused ─────────────────────
  await expectThrow('10 self-payment refused', async () => {
    const a = await QiAgent.load({ name: subject.name, dir: subject.dir });
    await a.connect();
    return await a.pay(a.paymentCode, '1');
  }, undefined, /yourself/);

  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} guards fired correctly (live=${live}).`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(2); });
