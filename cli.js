#!/usr/bin/env node
'use strict';
/**
 * qi-agent CLI — the same primitives from a shell, for agents that drive tools rather than
 * import libraries.
 *
 *   node cli.js new <name>                       create an identity (writes wallets/<name>.json, 0600)
 *   node cli.js id <name>                        print the payment code to publish + address to fund
 *   node cli.js balance <name> [--from <code>]   scan and report (canary-gated)
 *   node cli.js pay <from> <toCodeOrName> <qi> [--send]
 *   node cli.js watch <name> --from <code> [--timeout 300] [--poll 15]
 *   node cli.js convert <name> --amount <quai> [--send]
 *   node cli.js lockup <name>                    live conversion lockup in real days
 *
 * Exit codes are the contract: 0 = did the thing, 1 = a real negative answer (no money, not
 * paid), 2 = UNTRUSTED, i.e. the answer is unknown and must not be read as a zero.
 * Money-moving commands are dry-run unless --send is passed.
 */
const path = require('path');
const fs = require('fs');
const { QiAgent, QiUntrustedError, QiTrapError, DEFAULT_DIR, DEFAULT_RPC } = require('./qi-agent');

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : dflt;
};
const has = (name) => argv.includes(`--${name}`);
const DIR = flag('dir', DEFAULT_DIR);
const RPC = flag('rpc', DEFAULT_RPC);

/** Accept either a raw payment code or the name of a local wallet file, so demos read cleanly. */
function resolveCode(x) {
  if (!x) return null;
  const f = path.join(DIR, `${x}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')).paymentCode;
  return x;
}

function usage(code = 0) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 20).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(code);
}

(async () => {
  if (!cmd || cmd === 'help' || cmd === '--help') usage(0);

  if (cmd === 'new') {
    const name = positional[0];
    if (!name) usage(1);
    const a = await QiAgent.create({ name, dir: DIR, rpc: RPC });
    console.log(`created        : ${name}  (wallets/${name}.json, 0600 — this file IS the private key)`);
    console.log(`payment code   : ${a.paymentCode}`);
    console.log(`QUAI address   : ${a.quaiAddress}   <- fund this (Qi is mined-only; QUAI converts in)`);
    console.log(`Qi address     : ${a.qiAddress}`);
    console.log('\nPublish the payment code. Never publish the wallet file.');
    return 0;
  }

  const name = positional[0];
  if (!name) usage(1);
  const agent = await QiAgent.load({ name, dir: DIR, rpc: RPC });

  if (cmd === 'id') {
    console.log(`agent          : ${agent.name}`);
    console.log(`payment code   : ${agent.paymentCode}`);
    console.log(`QUAI address   : ${agent.quaiAddress ?? '(none — Qi-only wallet file)'}`);
    console.log(`Qi address     : ${agent.qiAddress}`);
    return 0;
  }

  await agent.connect();
  console.log(`rpc            : ${agent.rpc}`);
  console.log(`block          : ${agent.blockNumber} (canary OK — SDK agrees with raw RPC)`);

  if (cmd === 'balance') {
    const from = flag('from');
    if (from) await agent.expectFrom(resolveCode(from));
    else await agent.expectFromLocalWallets();
    const b = await agent.balance();
    const q = await agent.quaiBalance();
    console.log(`agent          : ${agent.name}`);
    if (q) console.log(`QUAI           : ${q.quai}`);
    console.log(`Qi spendable   : ${b.spendableQi}`);
    console.log(`Qi locked      : ${b.lockedQi}`);
    if (b.underReported) {
      console.log(`⚠️  SDK scan alone would report ${b.sdkScanQi} — ${b.recoveredQi} Qi was past the`);
      console.log(`   gap limit and INVISIBLE/UNSPENDABLE until this sweep imported it.`);
    }
    console.log(`outpoints      : ${b.outpoints}   derived addrs: ${b.addresses}   channels: ${b.channelsOpen}`);
    for (const o of b.outpointDetail.slice(0, 10)) console.log(`   ${o.address} denom=${o.denomination} lock=${o.lock}`);
    if (b.spendable === 0n && !b.zeroIsConclusive) {
      console.log('\n⚠️  ZERO IS NOT CONCLUSIVE — no payment channels open. A payment made to your');
      console.log('   payment code would be invisible to this scan. Re-run with --from <payerCode>.');
      return 2;
    }
    return b.spendable === 0n ? 1 : 0;
  }

  if (cmd === 'pay') {
    const to = resolveCode(positional[1]);
    const amount = positional[2];
    if (!to || !amount) usage(1);
    // If the payee is a local wallet we can measure their side and thus make the privacy claim
    // falsifiable. Across the internet you cannot, and the tool says so instead of assuming.
    let observer = null;
    const localPayee = path.join(DIR, `${positional[1]}.json`);
    if (fs.existsSync(localPayee)) {
      observer = await QiAgent.load({ name: positional[1], dir: DIR, rpc: RPC });
      await observer.connect();
    }
    const r = await agent.pay(to, amount, { dryRun: !has('send'), observer });
    if (!r.sent) {
      console.log(`\nDRY RUN — would send ${r.amountQi} Qi. Spendable now ${r.spendableBefore}. Re-run with --send.`);
      return 0;
    }
    console.log(`\ntx             : ${r.txHash}`);
    console.log(`block / status : ${r.block} / ${r.status}`);
    console.log(`payer          : ${r.payerBefore} -> ${r.payerAfter}  (${r.payerDelta})`);
    console.log(`payee delta    : ${r.payeeDelta ?? '(not measured — payee wallet not local)'}`);
    console.log(`fresh address  : ${r.freshAddress === null ? 'NOT MEASURED' : (r.freshAddress ? 'YES' : 'NO')} — ${r.freshAddressNote}`);
    return r.status === 1 ? 0 : 1;
  }

  if (cmd === 'watch') {
    const from = flag('from');
    if (!from) { console.log('watch requires --from <payerCode|name> — without an open channel the payment is invisible and this would hang forever.'); return 2; }
    await agent.expectFrom(resolveCode(from));
    const r = await agent.waitForPayment({
      timeoutMs: Number(flag('timeout', 300)) * 1000,
      pollMs: Number(flag('poll', 15)) * 1000,
      onPoll: (b) => console.log(`   ...${new Date().toISOString()} spendable=${b.spendableQi}`),
    });
    console.log(r.paid ? `\nPAID: received ${r.received} Qi after ${Math.round(r.waitedMs / 1000)}s (now ${r.spendableQi})`
                       : `\nNOT PAID after ${Math.round(r.waitedMs / 1000)}s — ${r.note}`);
    return r.paid ? 0 : 1;
  }

  if (cmd === 'convert') {
    const r = await agent.convert(flag('amount', '10'), { dryRun: !has('send') });
    console.log(`from / to      : ${r.from} -> ${r.to}`);
    console.log(`amount         : ${r.amountQuai} QUAI   quoted out: ${r.quotedQi ?? 'unavailable'} Qi`);
    console.log(`max slip       : ${r.maxSlipBps} bps -> data ${r.data}   (NOT optional; empty data reverts)`);
    console.log(`lockup         : ${r.lockup.days === null ? 'UNKNOWN' : r.lockup.days.toFixed(1) + ' days'} (${r.lockup.blocks} blocks @ ${r.lockup.secondsPerBlock?.toFixed(2)}s)`);
    if (!r.sent) { console.log('\nDRY RUN — nothing broadcast. Re-run with --send.'); return 0; }
    console.log(`tx / block     : ${r.txHash} / ${r.block}`);
    return 0;
  }

  if (cmd === 'lockup') {
    const l = await agent.estimateLockup();
    console.log(`lock period    : ${l.blocks} blocks`);
    console.log(`block rate     : ${l.secondsPerBlock === null ? 'UNAVAILABLE' : l.secondsPerBlock.toFixed(2) + ' s/block'}`);
    console.log(`= wall clock   : ${l.days === null ? 'CANNOT BE COMPUTED — do not guess it' : l.days.toFixed(1) + ' days'}`);
    console.log(`unlocks near   : block ${l.unlocksNearBlock ?? '(unknown)'}`);
    console.log(`note           : ${l.note}`);
    return l.days === null ? 2 : 0;
  }

  usage(1);
})().then((code) => process.exit(code ?? 0)).catch((e) => {
  if (e instanceof QiUntrustedError) { console.error(`UNTRUSTED: ${e.message}`); process.exit(2); }
  if (e instanceof QiTrapError) { console.error(`TRAP [${e.trap}]: ${e.message}`); process.exit(2); }
  console.error(`FAILED: ${e.message}`);
  process.exit(2);
});
