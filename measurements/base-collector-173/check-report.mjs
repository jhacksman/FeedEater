// Reject-only checklist for a FeedEater #173 (5206f90) `measure` report plus raw captures.
// It never certifies and is not an admission contract: NO_REJECT_FOUND only means none of the
// checks below fired.
//
// usage: node check-report.mjs MEASURE.json --nats-capture NATS.jsonl --direct-capture DIRECT.jsonl
//        --env RUN/base-collector.env [--status-interval-ms N] [--heartbeat-ms N]
//
// --env binds the run: status/heartbeat intervals (collector defaults 5000/5000 for keys the file
// does not set) and the expected filters/digest, rebuilt with the checkout dist (FE, default ../..).
// Missing/invalid intervals, or claimed flags that differ from the recorded settings, exit 2.
//
// Clock: measure.json marks/observations and every capture line `hrNs` are process.hrtime.bigint()
// read on the same host (libuv: CLOCK_MONOTONIC on Linux, mach_absolute_time on macOS), so they are
// one comparable clock. Each capture must bracket measure's warmup_start..teardown_end, or the run
// is rejected as not comparable.
import fs from "node:fs";
import path from "node:path";

const P = "feedeater.base_collector";
const NOT_CERTIFIABLE_AT_5206F90 = [
  "a7_g1_status_cadence_not_in_report_scope",
  "malformed_status_dropped_silently_by_measure",
  "direct_ws_loss_not_in_report_scope",
  "factory_and_reorg_coverage_not_in_report_scope",
];

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
if (args[0] === undefined || args[0].startsWith("--")) {
  process.stderr.write("usage: node check-report.mjs MEASURE.json --nats-capture F --direct-capture F --env RUN/base-collector.env [--status-interval-ms N] [--heartbeat-ms N]\n");
  process.exit(2);
}
const rep = JSON.parse(fs.readFileSync(args[0], "utf8"));
// Intervals are bound to the run's recorded settings (--env base-collector.env, collector defaults
// 5000/5000 for keys it does not set). Claimed flags must match them; anything else exits 2.
const usage2 = (why) => {
  process.stderr.write(`check-report: ${why}\n`);
  process.exit(2);
};
const envFile = opt("env");
if (envFile === undefined) usage2("--env <run base-collector.env> is required to bind status/heartbeat intervals");
let envText;
try {
  envText = fs.readFileSync(envFile, "utf8");
} catch {
  usage2(`cannot read --env ${envFile}`);
}
const envKv = Object.fromEntries(envText.split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const bound = (key, flagName) => {
  const raw = envKv[key] ?? "5000";
  if (!/^[1-9][0-9]*$/.test(raw)) usage2(`${key}=${raw} in --env is not a positive integer`);
  const v = Number(raw);
  const claimed = opt(flagName);
  if (args.includes(`--${flagName}`) && (claimed === undefined || !/^[1-9][0-9]*$/.test(claimed))) usage2(`--${flagName} must be a positive integer`);
  if (claimed !== undefined && Number(claimed) !== v) usage2(`--${flagName} ${claimed} differs from recorded ${key}=${v}`);
  return v;
};
let runCfg;
const FE = process.env.FE ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const dist = await import(`${FE}/modules/base-collector/dist/index.js`);
try {
  runCfg = dist.loadSettings(envKv);
} catch (e) {
  usage2(`--env does not load as collector settings: ${e instanceof Error ? e.message : String(e)}`);
}
const norm = (x) => JSON.stringify(x ?? null).toLowerCase();
const runFilters = dist.buildFilters(runCfg);
const runDigest = dist.filterDigest(runCfg);
const statusMs = bound("BASE_COLLECTOR_STATUS_INTERVAL_MS", "status-interval-ms");
const hbMs = bound("BASE_COLLECTOR_PERSIST_HEARTBEAT_MS", "heartbeat-ms");
const reject = [];
const ns = (s) => BigInt(s);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const between = (t, a, b) => t >= a && t <= b;
const maxGapMs = (times, a, b) => {
  const t = [a, ...[...times].sort(cmp), b];
  let g = 0n;
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > g) g = t[i] - t[i - 1];
  return Number(g / 1000n) / 1000;
};

// ---- measure.json: phase marks and window -------------------------------------------------------
const mark = (p) => rep.marks.find((m) => m.phase === p);
const ph = ["warmup_start", "window_start", "window_end", "teardown_end"].map(mark);
if (ph.some((m) => m === undefined)) {
  reject.push("phase_marks_missing");
  process.stdout.write(`${JSON.stringify({ verdict: "REJECT", reject }, null, 2)}\n`);
  process.exit(1);
}
const [T0, W0, W1, T1] = ph.map((m) => ns(m.atNs));
for (let i = 1; i < ph.length; i++) if (ns(ph[i].atNs) <= ns(ph[i - 1].atNs)) reject.push("phase_marks_out_of_order");
if (rep.filterDigest !== runDigest) reject.push("report_filter_digest_differs_from_run_settings");
if (ns(rep.window.startNs) !== W0 || ns(rep.window.endNs) !== W1) reject.push("report_window_differs_from_marks");
if (rep.marks.some((m) => m.phase === "direct_ws_closed" && ns(m.atNs) <= T1)) reject.push("measure_direct_ws_lost_before_teardown_end");
if (ph[1].headBlock === null || ph[2].headBlock === null) reject.push("measure_direct_head_not_observed");
else {
  if (rep.window.fromBlock !== ph[1].headBlock + 1) reject.push("window_fromBlock_not_window_start_head_plus_1");
  // Base: one block per 2 s.
  if (ph[2].headBlock - ph[1].headBlock < 0.9 * (rep.settings.windowS / 2)) reject.push("measure_direct_heads_stale");
}

// ---- measure.json: in-window samples and scope -------------------------------------------------
const repSt = rep.observations.statuses.filter((x) => x.inWindow);
const repHb = rep.observations.heartbeats.filter((x) => x.inWindow);
const repStGap = maxGapMs(repSt.map((x) => ns(x.atNs)), W0, W1);
const repHbGap = maxGapMs(repHb.map((x) => ns(x.atNs)), W0, W1);
if (repStGap > 2 * statusMs) reject.push(`report_status_stale_or_silent(maxGapMs=${repStGap})`);
if (repHbGap > 2 * hbMs) reject.push(`report_heartbeat_stale_or_silent(maxGapMs=${repHbGap})`);
const countIf = (xs, f) => xs.filter(f).length;
const pushN = (name, n) => n > 0 && reject.push(`${name}(n=${n})`);
pushN("report_status_persistence_not_ok", countIf(repSt, (x) => x.persistence !== "ok"));
pushN("report_status_not_connected", countIf(repSt, (x) => x.connected !== true));
pushN("report_status_coverage_incomplete", countIf(repSt, (x) => x.coverageComplete !== true));
pushN("report_status_filter_digest_mismatch", countIf(repSt, (x) => x.filterDigestMatch !== true));
if (rep.scope.sourceValidationWindow !== true) reject.push(`scope_not_covered(${rep.scope.notCovered.join(",")})`);
if (rep.dat011.pass !== true) reject.push("dat011_fail");
if (rep.addedLatencyMs.negative > 0) reject.push("negative_latency_samples");
if (rep.addedLatencyMs.n !== rep.deliveredLive) reject.push("latency_n_differs_from_delivered");
if (rep.extraLive > 0 || rep.lateLiveAfterBackfill > 0 || rep.backfillOnLiveSubjects > 0) reject.push("live_extra_late_or_contaminated");

// ---- raw captures -------------------------------------------------------------------------------
const readJsonl = (p, name) => {
  if (p === undefined) {
    reject.push(`${name}_capture_not_supplied`);
    return null;
  }
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  } catch (e) {
    reject.push(`${name}_capture_unreadable`);
    return null;
  }
};
const natsRows = readJsonl(opt("nats-capture"), "nats");
const directRows = readJsonl(opt("direct-capture"), "direct");
const clock = {
  basis: "process.hrtime.bigint on one host",
  comparable: true,
  hosts: [],
  limits: [
    "capture hosts are the self-reported os.hostname() in each capture meta line; not independently verified",
    "measure.json records no host, so binding measure to the capture host is by procedure (run-native.sh runs all on one host), not checked",
    "hrtime is comparable only within one boot of one host; a reboot or a different host invalidates comparison",
  ],
};
const metaOf = (rows, name) => {
  const start = rows.find((r) => r.type === "meta" && r.phase === "start");
  const stop = rows.find((r) => r.type === "meta" && r.phase === "stop");
  if (start === undefined || stop === undefined || start.clock !== "process.hrtime.bigint") {
    reject.push(`${name}_capture_meta_missing`);
    clock.comparable = false;
    return start;
  }
  clock.hosts.push(start.host);
  if (!(ns(start.hrNs) < T0 && ns(stop.hrNs) > T1)) {
    reject.push(`${name}_capture_not_bracketing_measure_clock`);
    clock.comparable = false;
  }
  return start;
};

const observed = {
  initialize: { reportExpected: rep.byKind.initialize?.expected ?? 0, directRaw: null, liveRaw: null },
  swap: { reportExpectedTracked: rep.byKind.swap?.expected ?? 0, directRawAllPools: null, liveRaw: null },
  factory: { reportExpected: rep.byKind.factory?.expected ?? 0, directRaw: null, liveRaw: null },
  reorgRemoval: { directRaw: null, liveRaw: null },
};
let directKind = null;
let directLogs = null;
let rawStGap = null;
let rawHbGap = null;

if (natsRows !== null) {
  metaOf(natsRows, "nats");
  const msgs = natsRows.filter((r) => r.type === "msg").map((r) => ({ ...r, t: ns(r.hrNs) }));
  const parse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const st = msgs.filter((r) => r.subject === `${P}.ctl.status` && between(r.t, W0, W1)).map((r) => ({ t: r.t, p: parse(r.payload) }));
  const wellFormed = (p) => p !== null && typeof p.persistence?.state === "string" && typeof p.connected === "boolean";
  const good = st.filter((x) => wellFormed(x.p));
  pushN("raw_status_malformed_in_window", st.length - good.length);
  pushN("raw_status_persistence_not_ok", countIf(good, (x) => x.p.persistence.state !== "ok"));
  pushN("raw_status_not_connected", countIf(good, (x) => x.p.connected !== true));
  pushN("raw_status_coverage_incomplete", countIf(good, (x) => x.p.coverage?.complete !== true));
  pushN("raw_status_filter_digest_mismatch", countIf(good, (x) => x.p.filterDigest !== rep.filterDigest));
  rawStGap = maxGapMs(good.map((x) => x.t), W0, W1);
  if (rawStGap > 2 * statusMs) reject.push(`raw_status_stale_or_silent(maxGapMs=${rawStGap})`);
  const hb = msgs.filter((r) => r.subject === `${P}.ctl.persister` && between(r.t, W0, W1));
  rawHbGap = maxGapMs(hb.map((r) => r.t), W0, W1);
  if (rawHbGap > 2 * hbMs) reject.push(`raw_heartbeat_stale_or_silent(maxGapMs=${rawHbGap})`);
  // Inner interval (1 s from each edge) so receipt skew between processes cannot move a sample across an edge.
  const a = W0 + 1_000_000_000n;
  const b = W1 - 1_000_000_000n;
  const rawN = countIf(good, (x) => between(x.t, a, b));
  const repN = countIf(repSt, (x) => between(ns(x.atNs), a, b));
  if (rawN !== repN) reject.push(`status_count_raw_vs_report(raw=${rawN},report=${repN})`);
  const rawHbN = countIf(hb, (r) => between(r.t, a, b));
  const repHbN = countIf(repHb, (x) => between(ns(x.atNs), a, b));
  if (rawHbN !== repHbN) reject.push(`heartbeat_count_raw_vs_report(raw=${rawHbN},report=${repHbN})`);
  const live = msgs.filter((r) => between(r.t, W0, T1));
  observed.initialize.liveRaw = countIf(live, (r) => r.subject === `${P}.initialize`);
  observed.swap.liveRaw = countIf(live, (r) => r.subject === `${P}.swap`);
  observed.factory.liveRaw = countIf(live, (r) => r.subject === `${P}.factory`);
  observed.reorgRemoval.liveRaw = countIf(live, (r) => r.subject.startsWith(`${P}.removed.`));
}

if (directRows !== null) {
  const meta = metaOf(directRows, "direct");
  if (meta !== undefined && meta.filterDigest !== rep.filterDigest) reject.push("direct_capture_filter_digest_differs_from_report");
  if (directRows.some((r) => r.type === "rpc_error")) reject.push("direct_capture_rpc_error");
  if (meta !== undefined && norm(meta.filters) !== norm(runFilters)) reject.push("direct_capture_filters_differ_from_run_settings");
  const stopRow = directRows.find((r) => r.type === "meta" && r.phase === "stop");
  const stopT = stopRow === undefined ? null : ns(stopRow.hrNs);
  if (directRows.some((r) => (r.type === "direct_ws_closed" || r.type === "ws_error") && (stopT === null || ns(r.hrNs) < stopT))) reject.push("direct_capture_ws_closed_or_error_before_stop");
  for (let i = 1; i <= runFilters.length; i++) {
    if (!directRows.some((r) => r.type === "ack" && r.id === i && typeof r.result === "string" && ns(r.hrNs) <= W0)) reject.push(`direct_capture_filter_ack_missing(id=${i})`);
  }
  const lc = (x) => (typeof x === "string" ? x.toLowerCase() : x);
  const pm = lc(meta?.filters?.[0]?.address?.[0]);
  const [tInit, tSwap] = (meta?.filters?.[0]?.topics?.[0] ?? []).map(lc);
  const factories = new Set((meta?.filters?.[1]?.address ?? []).map(lc));
  const logs = directRows.filter((r) => r.type === "log" && between(Number.parseInt(r.blockNumber, 16), rep.window.fromBlock, rep.window.toBlock));
  const isPm = (r, topic) => r.address.toLowerCase() === pm && r.topics[0]?.toLowerCase() === topic;
  directKind = (r) => (isPm(r, tInit) ? "initialize" : isPm(r, tSwap) ? "swap" : factories.has(r.address.toLowerCase()) ? "factory" : null);
  directLogs = logs;
  observed.initialize.directRaw = countIf(logs, (r) => isPm(r, tInit));
  observed.swap.directRawAllPools = countIf(logs, (r) => isPm(r, tSwap));
  observed.factory.directRaw = countIf(logs, (r) => factories.has(r.address.toLowerCase()));
  observed.reorgRemoval.directRaw = countIf(logs, (r) => r.removed === true);
}
// ---- identities: direct raw vs live raw vs report, per kind -------------------------------------
// Per blockHash:logIndex ordered active/removed transitions (same-state repeats collapsed).
// initialize/factory: direct and live transitions must match exactly and report expected must equal
// the direct transition count. swap: every live identity must be in direct with the same
// transitions (tracked-pool selection is the collector's, so direct swaps on untracked pools are
// not required on live).
if (directLogs !== null && natsRows !== null) {
  const tryParse = (x) => {
    try {
      return JSON.parse(x);
    } catch {
      return null;
    }
  };
  const seqs = () => ({ initialize: new Map(), swap: new Map(), factory: new Map() });
  const add = (m, key, removed) => {
    const q = m.get(key) ?? [];
    if (q.at(-1) !== removed) q.push(removed);
    m.set(key, q);
  };
  const d = seqs();
  let outside = 0;
  for (const r of directLogs) {
    const k = directKind(r);
    if (k === null) outside += 1;
    else add(d[k], `${r.blockHash.toLowerCase()}:${Number.parseInt(r.logIndex, 16)}`, r.removed === true);
  }
  pushN("direct_capture_log_outside_filters", outside);
  const l = seqs();
  const liveSubj = /^feedeater\.base_collector\.(?:removed\.)?(initialize|swap|factory)$/;
  for (const r of natsRows) {
    if (r.type !== "msg" || !liveSubj.test(r.subject) || !between(ns(r.hrNs), W0, T1)) continue;
    const p = tryParse(r.payload);
    if (p === null || !Number.isSafeInteger(p.blockNumber) || typeof p.blockHash !== "string") {
      reject.push("raw_live_record_malformed");
      continue;
    }
    if (!between(p.blockNumber, rep.window.fromBlock, rep.window.toBlock)) continue;
    add(l[liveSubj.exec(r.subject)[1]], `${p.blockHash.toLowerCase()}:${p.logIndex}`, p.removed === true);
  }
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
  for (const k of ["initialize", "swap", "factory"]) {
    const nTrans = (m) => [...m.values()].reduce((a, q) => a + q.length, 0);
    const missing = [...d[k].keys()].filter((key) => k !== "swap" && !same(d[k].get(key), l[k].get(key))).length;
    const extra = [...l[k].keys()].filter((key) => !same(d[k].get(key), l[k].get(key))).length;
    pushN(`identity_direct_not_on_live:${k}`, missing);
    pushN(`identity_live_not_matching_direct:${k}`, extra);
    const repExp = rep.byKind?.[k]?.expected;
    if (k !== "swap" && repExp !== nTrans(d[k])) reject.push(`report_vs_direct_transitions:${k}(direct=${nTrans(d[k])},report=${repExp})`);
    if (k === "swap" && !(repExp >= nTrans(l[k]))) reject.push(`report_swap_expected_below_live(live=${nTrans(l[k])},report=${repExp})`);
    observed[k].directTransitions = nTrans(d[k]);
    observed[k].liveTransitions = nTrans(l[k]);
  }
}

if (new Set(clock.hosts).size > 1) {
  reject.push("captures_from_different_hosts");
  clock.comparable = false;
}

const notObserved = [];
if (observed.initialize.reportExpected === 0 && !observed.initialize.directRaw) notObserved.push("initialize");
if (observed.swap.reportExpectedTracked === 0) notObserved.push("swap_tracked_o1");
if (observed.factory.reportExpected === 0 && !observed.factory.directRaw) notObserved.push("factory");
if (!observed.reorgRemoval.directRaw && !observed.reorgRemoval.liveRaw) notObserved.push("reorg_removal");
for (const k of notObserved) reject.push(`not_observed:${k}`);

const out = {
  tool: "check-report (reject-only; not an admission contract)",
  report: args[0],
  verdict: reject.length > 0 ? "REJECT" : "NO_REJECT_FOUND",
  reject: [...new Set(reject)],
  notObserved,
  observed,
  clock,
  statusMaxGapMs: { report: repStGap, raw: rawStGap },
  heartbeatMaxGapMs: { report: repHbGap, raw: rawHbGap },
  notCertifiableAt5206f90: NOT_CERTIFIABLE_AT_5206F90,
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(reject.length > 0 ? 1 : 0);
