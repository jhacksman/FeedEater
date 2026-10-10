# backfill-capture-kit

Portable, pinned distribution of the backfill capture toolchain: exactly the files compose C1 (`7d06dde`) and its six
pinned components execute or read, extracted from immutable commits, with no `.git`, network, environment or hidden
default path needed to use them. Distribution preparation only: no component byte changes, no transport, no source
admission, latency, completeness or one-clock claim; Q1/Q2 stay UNADOPTED.

## Closure (12 files + `SHA256SUMS` + `KIT.json`)

Kit layout mirrors `measurements/`, so `--components "$KIT"` and the compose handoff's `$COMPONENTS/...` paths work unchanged.

| kit path | source commit | tree | git blob | sha256 |
|---|---|---|---|---|
| `filter-manifest/compile.mjs` | `42185f2` | `146efd1a` | `8b5fbc79` | `a01e632e…` |
| `filter-manifest/keccak.mjs` | `42185f2` | `146efd1a` | `7f8209ee` | `f2cd3d33…` |
| `filter-manifest/sources/aromer-5669951/constants.py` | `42185f2` | `146efd1a` | `681cca85` | `b7d78011…` |
| `filter-manifest/sources/aromer-5669951/o1-census-contract-20261010.json` | `42185f2` | `146efd1a` | `f347ba08` | `efda199e…` |
| `filter-manifest/sources/aromer-5669951/production-contracts.md` | `42185f2` | `146efd1a` | `c8cd7382` | `b0f53ce4…` |
| `filter-manifest/sources/aromer-5669951/launch-contract-suites.checkpoint-html.INVALID` | `42185f2` | `146efd1a` | `dd1d4530` | `d019f01a…` |
| `backfill-plan/plan.mjs` | `a345d48` | `d2846f9f` | `ab968702` | `c527e180…` |
| `backfill-receipt-capture/capture.mjs` | `56f8f3b` | `7fd9f337` | `b9f0aaa9` | `d2c13953…` |
| `full-coverage-filter-contract/check.mjs` | `d568aee` | `a65c2837` | `5d1ebce7` | `d1d450d3…` |
| `backfill-receipts/verify.mjs` | `83aec5d` | `81b6875f` | `2d8f34a6` | `0eb02c03…` |
| `backfill-capture-compose/compose.mjs` | `7d06dde` | `a8c8e1cd` | `09f7b525` | `e99c18fe…` |
| `backfill-capture-compose/README.md` | `7d06dde` | `a8c8e1cd` | `efe2d0c7` | `df530de2…` |

Full ids, byte counts and repo paths are in `kit.mjs` and the emitted `KIT.json` (`evidence/KIT.json`).

## Build (needs explicit local git objects)

    node build-kit.mjs --git <absolute git binary> --git-dir <repo .git> --out <new dir>

- All three arguments required exactly once; `--git` must be absolute. No PATH/env lookup; git runs with a literal
  empty-config env, `--no-replace-objects`, and only `cat-file <type> <oid>`. It never fetches.
- Every commit, tree and blob read is re-hashed (sha1 over `"<type> <len>\0" + raw`) and must equal its oid; each
  commit's tree must equal the pinned tree; each path is walked tree by tree (dirs `40000`, files `100644`, duplicate
  entries refused); each blob must equal the pinned blob id, byte count and sha256. Only git objects are read, so a
  dirty work tree cannot leak in.
- `--out` must not exist; every ancestor must exist and not be a symlink. The kit is created 0700, files
  `O_EXCL|O_NOFOLLOW` 0600, written in an offset loop, fsynced and read back; `SHA256SUMS` then `KIT.json` last.
- Exit: 0 `BUILT` (`kitPersisted:true`, all 14 shas, `kitJsonSha256`); 2 refused (`{refused, detail}`, no output
  created); 4 internal; 5 `WRITE_FAILED` (`kitPersisted:false`, `persisted[]` with their shas, `writeFailure{file,
  stage, bytesWritten, code}`). No cleanup or retry.

**Acceptance (only route):** `node "$KIT_TOOLS/check-kit.mjs" --kit "$KIT"` exit 0 `KIT_VERIFIED`, where
`check-kit.mjs` and `kit.mjs` are taken from the reviewed candidate commit (their literal pins), by explicit path,
outside the kit. Neither a `KIT.json` existing nor any checksum list in the kit is sufficient: a `WRITE_FAILED` directory
is incomplete even if a (possibly zero-byte or partial) `KIT.json` exists, and `SHA256SUMS` is a mutable informational
listing that authenticates neither `KIT.json` nor itself. A build's exit 0 `BUILT` + `kitPersisted:true` is necessary
but does not replace `KIT_VERIFIED` on the directory actually used.

## Check (offline, no git, node only)

    node "$KIT_TOOLS/check-kit.mjs" --kit "$KIT"

The checker's closure is `check-kit.mjs` + `kit.mjs` (pins and deterministic renders); it reads nothing from the kit
except the files it verifies. Refuses (exit 2) a missing kit, a symlinked root, any symlinked or non-regular entry, any
missing or extra file (including `.git`, case-colliding names), any byte/sha256/blob-id mismatch, and any
`KIT.json`/`SHA256SUMS` that is not byte-equal to its deterministic render (so a forged claim, a zero-byte or partial
`KIT.json`, or a component edited together with a matching `SHA256SUMS` are all refused). Exit 0 `KIT_VERIFIED`.

## Use (by path, any cwd, no `.git`)

    node "$KIT/backfill-capture-compose/compose.mjs" --spec "$ROOT_SPEC" --components "$KIT" --out "$ROOT_COMPOSE_OUT"
    cd "$ROOT_COMPOSE_OUT"; export COMPONENTS="$KIT"   # then handoff.json commands.rebuildManifest, rebuildPlan, checkContract

`KIT`, `KIT_TOOLS`, `ROOT_SPEC`, `ROOT_COMPOSE_OUT` (and later `ROOT_ENDPOINT`, `ROOT_CAPTURE_OUT`) are root-supplied.
Capture and verify are root-operated only. Genuine C/H with hashes and times, `sourceId`, hash/removed evidence, L,
caps, window, direct/native filters, clock id/window and subjects stay UNRESOLVED until Codex supplies them; compose
refuses them otherwise.

## Tests

    node test.mjs   # from this directory; needs /usr/bin/git and a checkout holding the six pinned commits

52 cases: build reproduction against `git show` bytes and pins; byte-identical rebuild; deploy to a realpath temp dir
outside any work tree; check-kit (direct and the single published `use.checkKit` command); by-path compose from cwd=/ with an empty env reproducing all 8
`7ee6ead`/`7d06dde` `evidence/composed` bytes (manifest `3a5431c2`, six-factory ALL-topics + Initialize/Swap);
handoff rebuild/check commands with `COMPONENTS=$KIT`; unresolved-input refusal through the kit; check-kit
refusals (missing, extra, capability-aware case collision, dirty, forged `KIT.json` claim, partial/zero-byte `KIT.json`,
component edited with a matching `SHA256SUMS`, symlinks); compose's own refusal in a dirty kit; build CLI/`--out` refusals;
missing objects, missing git, `git replace` ignored, corrupted blob/tree/commit from a fake git; 7 B short writes;
EIO on `KIT.json` (zero-byte file disclosed and refused by check-kit) and on `compose.mjs`; static checks.

## Limits

- SHA-1 object ids are recomputed, so provenance is as strong as SHA-1 plus the pinned sha256 of every file.
- `check-kit.mjs` lives in this candidate, not in the kit; there is no tool-free acceptance route.
- On a case-insensitive filesystem a case-colliding name aliases the pinned file, so it is refused as `kit_file_mismatch`
  (or as an inventory mismatch on a case-sensitive one); the tests probe the capability and assert the matching refusal.
- Directory fsync is not performed; readback proves bytes through the same fd, not media durability.
- File modes in the kit are 0600 / dirs 0700 (not the repo's 100644); copy tools may change them.
- `compile.mjs`'s own CLI has a `--sources` default relative to itself; the documented commands always pass `--sources`.
- Synthetic inputs only; no real node, endpoint or source measurement.
