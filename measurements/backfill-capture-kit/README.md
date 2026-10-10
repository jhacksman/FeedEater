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

**Acceptance:** a `KIT.json` existing is not sufficient. A `WRITE_FAILED` directory is incomplete even if a (possibly
zero-byte or partial) `KIT.json` exists. A kit is established only by exit 0 `BUILT` + `kitPersisted:true` and then
`check-kit.mjs` `KIT_VERIFIED` (or the tool-free check below) on the directory actually used.

## Check (offline, no git)

    node check-kit.mjs --kit "$KIT"

Refuses (exit 2) a missing kit, a symlinked root, any symlinked or non-regular entry, any missing or extra file
(including `.git`, case-colliding names), any byte/sha256/blob-id mismatch, and any `KIT.json`/`SHA256SUMS` that is not
byte-equal to its deterministic render. Exit 0 `KIT_VERIFIED`.

Tool-free (`KIT.json` `use.checkKitNoTools`):

    cd "$KIT" && sha256sum -c SHA256SUMS && test "$(find . -type f | wc -l)" -eq 14 && test -z "$(find . -type l)"

## Use (by path, any cwd, no `.git`)

    node "$KIT/backfill-capture-compose/compose.mjs" --spec "$ROOT_SPEC" --components "$KIT" --out "$ROOT_COMPOSE_OUT"
    cd "$ROOT_COMPOSE_OUT"; export COMPONENTS="$KIT"   # then handoff.json commands.rebuildManifest, rebuildPlan, checkContract

`KIT`, `KIT_TOOLS`, `ROOT_SPEC`, `ROOT_COMPOSE_OUT` (and later `ROOT_ENDPOINT`, `ROOT_CAPTURE_OUT`) are root-supplied.
Capture and verify are root-operated only. Genuine C/H with hashes and times, `sourceId`, hash/removed evidence, L,
caps, window, direct/native filters, clock id/window and subjects stay UNRESOLVED until Codex supplies them; compose
refuses them otherwise.

## Tests

    node test.mjs   # from this directory; needs /usr/bin/git and a checkout holding the six pinned commits

47 cases: build reproduction against `git show` bytes and pins; byte-identical rebuild; deploy to a temp dir outside
any work tree; check-kit and the tool-free check; by-path compose from cwd=/ with an empty env reproducing all 8
`7ee6ead`/`7d06dde` `evidence/composed` bytes (manifest `3a5431c2`, six-factory ALL-topics + Initialize/Swap);
handoff rebuild/check commands with `COMPONENTS=$KIT`; unresolved-input refusal through the kit; check-kit
refusals (missing, extra, dirty, symlinks); compose's own refusal in a dirty kit; build CLI/`--out` refusals;
missing objects, missing git, `git replace` ignored, corrupted blob/tree/commit from a fake git; 7 B short writes;
EIO on `KIT.json` (zero-byte file disclosed and refused by check-kit) and on `compose.mjs`; static checks.

## Limits

- SHA-1 object ids are recomputed, so provenance is as strong as SHA-1 plus the pinned sha256 of every file.
- `check-kit.mjs` lives in this candidate, not in the kit; the tool-free check covers a kit alone.
- Directory fsync is not performed; readback proves bytes through the same fd, not media durability.
- File modes in the kit are 0600 / dirs 0700 (not the repo's 100644); copy tools may change them.
- `compile.mjs`'s own CLI has a `--sources` default relative to itself; the documented commands always pass `--sources`.
- Synthetic inputs only; no real node, endpoint or source measurement.
