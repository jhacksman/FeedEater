// Pinned closure of the portable backfill capture kit: every file compose C1 and its six pinned components execute or
// read, each bound to its immutable source commit, tree, git blob id and sha256. Rendering is deterministic.
import crypto from "node:crypto";

export const KIT_SCHEMA = "backfill-capture-kit/1";
export const SUMS = "SHA256SUMS";
export const INDEX = "KIT.json";
export const COMMITS = Object.freeze({
  "42185f2170fb68e5d55b5e8507f480229f58b4df": Object.freeze({ tree: "146efd1a55e286d54969106f166b27876af9f4c1", role: "filter manifest compiler + pinned aromer-5669951 source declarations" }),
  "a345d48a2f003348d3fe21910518ec1e6e54db35": Object.freeze({ tree: "d2846f9f2b60bb8ceb5a3dfd18870a3d1c722ffd", role: "backfill planner C1" }),
  "56f8f3bcc072f86d13b55f34f6f3632bd142f6ba": Object.freeze({ tree: "7fd9f337987cfa90215aa0c1d8971377275466c0", role: "receipt capture C1" }),
  "d568aee4779d648f669753a009e564ed2be4d456": Object.freeze({ tree: "a65c2837847ed8b72ce297d2916fcf13cbadcc29", role: "full-coverage filter contract" }),
  "83aec5d72f6712711b5f22ef29777858c5b797e0": Object.freeze({ tree: "81b6875f680ca687375ff244a6da868a77924912", role: "offline receipt verifier" }),
  "7d06dde846d34cd62ffe51e669e29cc7d8d2f1a9": Object.freeze({ tree: "a8c8e1cd137db8b34f5ea7f52e275be4ec7ae9e1", role: "capture-input compose C1 (docs correction of 7ee6ead)" }),
});
const f = (p, commit, blob, bytes, sha256) => Object.freeze({ path: p, commit, repoPath: `measurements/${p}`, blob, bytes, sha256 });
const M = "42185f2170fb68e5d55b5e8507f480229f58b4df", S = "filter-manifest/sources/aromer-5669951/";
export const FILES = Object.freeze([
  f("filter-manifest/compile.mjs", M, "8b5fbc79180497b4c5334edb5a819b5302ddb065", 15887, "a01e632ea490479b517ca676d8664e15920e633e977dd2d6c844f3019d55c903"),
  f("filter-manifest/keccak.mjs", M, "7f8209ee58de011401aa67b1a49964a43462b969", 2015, "f2cd3d33fe6ec210ff085f5de7b7e24b7a228775ad3e7fc015712614530df142"),
  f(`${S}constants.py`, M, "681cca850c376d4abc1e6900a494d9e08d8250b7", 18288, "b7d7801149635e65592e0e10159c9dc23f0c0ebb30a8c717f88f00e286a07391"),
  f(`${S}o1-census-contract-20261010.json`, M, "f347ba080b0c3d43954a846232acedc6ef129d2a", 34156, "efda199ea09fabf1f8250ea5a15fb611e36bb088fc4e07ba8004132b8142cff8"),
  f(`${S}production-contracts.md`, M, "c8cd738275cd9c6859f8002d407dbc89d3f7772f", 73423, "b0f53ce4c745407aac8bb42aadc43450e36ffa204c0cf37f8128efd1eff4e4fc"),
  f(`${S}launch-contract-suites.checkpoint-html.INVALID`, M, "dd1d45306dae903b8d4b63084db99a1b38f07848", 34152, "d019f01a9132cd93da42c11646066f476a65e45ee8ccdab68f1ae12e2123612f"),
  f("backfill-plan/plan.mjs", "a345d48a2f003348d3fe21910518ec1e6e54db35", "ab968702b9a015b2bb539b98ef76e0b75e396092", 17827, "c527e1808fcd4efa00a34a0c1dd957bffa8d56adadb584d056babe8084edcf7a"),
  f("backfill-receipt-capture/capture.mjs", "56f8f3bcc072f86d13b55f34f6f3632bd142f6ba", "b9f0aaa92e306b5a8cecdd7d0fcfd61b2110f2a0", 21134, "d2c1395331150c50bdee6a0bec6c7a1fb94f90499b8923b0dcb152a15ac93e9a"),
  f("full-coverage-filter-contract/check.mjs", "d568aee4779d648f669753a009e564ed2be4d456", "5d1ebce73d20106654c40512b82c813ab7503efc", 24365, "d1d450d3f48846e897b46cd8540a25131310fa1de1b2108b43c784591c75e416"),
  f("backfill-receipts/verify.mjs", "83aec5d72f6712711b5f22ef29777858c5b797e0", "2d8f34a6b76416b897191b25a83a57148e902b8c", 21245, "0eb02c033103a13053b5797614dedf8724c686f24d42bdf3f476fc1f303fda56"),
  f("backfill-capture-compose/compose.mjs", "7d06dde846d34cd62ffe51e669e29cc7d8d2f1a9", "09f7b52574cb6bbff2494df166b94da954487499", 13406, "e99c18fe7f71e9f3a8c6092a980d525b22428b68d03149d52a21725d354dede0"),
  f("backfill-capture-compose/README.md", "7d06dde846d34cd62ffe51e669e29cc7d8d2f1a9", "efe2d0c7973fdcac44d685969585f0fc1d9375e5", 6263, "df530de2d1bbca1daf55969eddd9bde46713db08f286d3327b4fe7b8d04d25e2"),
].sort((a, b) => (a.path < b.path ? -1 : 1)));
export const KIT_PATHS = Object.freeze([...FILES.map((x) => x.path), SUMS, INDEX].sort());

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const gitObjectId = (type, b) => crypto.createHash("sha1").update(`${type} ${b.length}\0`).update(b).digest("hex");

export function renderSums() {
  return Buffer.from(FILES.map((x) => `${x.sha256}  ${x.path}\n`).join(""));
}

export function renderIndex() {
  const sums = renderSums();
  const c = (p) => `"$KIT/${p}"`;
  return Buffer.from(`${JSON.stringify({
    schema: KIT_SCHEMA,
    closure: "exactly the files compose C1 and its six pinned components execute or read; nothing else",
    commits: Object.entries(COMMITS).map(([commit, v]) => ({ commit, tree: v.tree, role: v.role })),
    files: FILES.map((x) => ({ path: x.path, sourceCommit: x.commit, sourceTree: COMMITS[x.commit].tree, repoPath: x.repoPath, gitBlob: x.blob, mode: "100644", bytes: x.bytes, sha256: x.sha256 })),
    sha256sums: { file: SUMS, bytes: sums.length, sha256: sha256(sums) },
    use: {
      variables: "KIT (this directory), KIT_TOOLS (reviewed backfill-capture-kit checkout, outside the kit), ROOT_SPEC, ROOT_COMPOSE_OUT (new directory) are root-supplied; nothing is defaulted",
      acceptance: `the only acceptance route: checkKit exit 0 KIT_VERIFIED, using check-kit.mjs + kit.mjs from the reviewed candidate commit (literal pins), never files inside the kit; ${SUMS} is an informational listing and authenticates neither ${INDEX} nor itself`,
      checkKit: `node "$KIT_TOOLS/check-kit.mjs" --kit "$KIT"`,
      compose: `node ${c("backfill-capture-compose/compose.mjs")} --spec "$ROOT_SPEC" --components "$KIT" --out "$ROOT_COMPOSE_OUT"`,
      afterCompose: `cd "$ROOT_COMPOSE_OUT" && export COMPONENTS="$KIT", then run handoff.json commands.rebuildManifest, rebuildPlan, checkContract; capture and verify are root-operated only`,
    },
    rootInputsStillRequired: ["ROOT_SPEC (genuine C/H with hashes and times, sourceId, hash/removed evidence, L, caps, window, direct/native filters, clockId and window, subjects)", "ROOT_COMPOSE_OUT", "ROOT_ENDPOINT and ROOT_CAPTURE_OUT for capture"],
    transportExecuted: false,
    claims: { sourceAdmission: "NOT_ESTABLISHED", completeness: "NOT_MEASURED", delivery: "NOT_MEASURED", latency: "NOT_MEASURED", oneClock: "NOT_ESTABLISHED", q1: "UNADOPTED", q2: "UNADOPTED" },
  }, null, 2)}\n`);
}
