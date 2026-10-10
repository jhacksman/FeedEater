#!/usr/bin/env bash
# Exact-byte assembly for compose-drill.sh (preparation only). Reads the reviewed HTTP guard and final
# controller (4df26b2) and the WS proxy (f694290) from git objects only, never from a working tree.
#   compose-assemble.sh REPO DEST       assemble into a new or empty absolute DEST (+ provenance.json)
#   compose-assemble.sh --verify DEST   re-hash DEST against DEST/ASSEMBLED.sha256
# Refuses (exit 3, "REFUSED <reason>" on stderr) on an unpinned head, a missing commit, a tree or
# MANIFEST mismatch, a file whose bytes differ from its head's MANIFEST, lib-run.sh differing between
# the heads, dirty or untracked component paths in REPO, a non-empty DEST, or a missing ws dependency.
# Exit 2 usage.
set -u
HTTP_HEAD=4df26b2bc2f90efd25e7dd3fb8f50ea4b3fa62a6
HTTP_TREE=e773035b2579770727ace91b78195de99a7f546c
HTTP_MANIFEST=127b0978a049da5b934896ebe170a9e8302f6725a60b883a6cd17a092990fcd5
HTTP_FILES="rpc-guard.mjs guard-run.sh lib-run.sh fake-upstream.mjs"
WS_HEAD=f694290cce356eb65a56e29b59a2abe6557767e8
WS_TREE=cf30de331bb31605ad7c4d9c4abc1a29c806a10c
WS_MANIFEST=ea1f954fd62689aecbc6e55c8b4115f89bd94e5691cd96a9795e4b492a914f61
WS_FILES="ws-guard.mjs fake-ws-upstream.mjs ws-contract-2026-10-10.json lib-run.sh"
P=measurements/base-collector-173
refuse() { echo "compose-assemble: REFUSED $*" >&2; exit 3; }
usage() { echo "usage: compose-assemble.sh REPO DEST | --verify DEST" >&2; exit 2; }
shatool() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
sha() { shatool "$1" | awk '{print $1}'; }
[ $# = 2 ] || usage
if [ "$1" = --verify ]; then
  [ -s "$2/ASSEMBLED.sha256" ] || refuse no_assembly
  (cd "$2" && shatool -c ASSEMBLED.sha256 >/dev/null 2>&1) || refuse assembled_bytes_changed
  [ "$(cd "$2" && ls | grep -v -x -e ASSEMBLED.sha256 -e provenance.json | LC_ALL=C sort | tr '\n' ' ')" = \
    "$(awk '{print $2}' "$2/ASSEMBLED.sha256" | LC_ALL=C sort | tr '\n' ' ')" ] || refuse assembled_file_set_changed
  echo "compose-assemble: verified $2"
  exit 0
fi
REPO=$1 DEST=$2
case "$DEST" in /*) ;; *) usage ;; esac
[ "${FE173_HTTP_HEAD:-$HTTP_HEAD}" = "$HTTP_HEAD" ] || refuse "http_head_not_pinned ${FE173_HTTP_HEAD:-}"
[ "${FE173_WS_HEAD:-$WS_HEAD}" = "$WS_HEAD" ] || refuse "ws_head_not_pinned ${FE173_WS_HEAD:-}"
[ ! -e "$DEST" ] || [ -z "$(ls -A "$DEST")" ] || refuse dest_not_empty
g() { git -C "$REPO" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || refuse not_a_git_repository
paths=$(for f in $HTTP_FILES $WS_FILES; do echo "$P/$f"; done | LC_ALL=C sort -u)
# shellcheck disable=SC2086
dirty=$(g status --porcelain --untracked-files=all -- $paths)
[ -z "$dirty" ] || refuse "dirty_inputs $(echo $dirty)"
mkdir -p "$DEST" || refuse dest_not_creatable
W=$DEST/.work
mkdir "$W" || refuse dest_not_creatable
: >"$W/prov"
for side in HTTP WS; do
  eval "head=\$${side}_HEAD tree=\$${side}_TREE man=\$${side}_MANIFEST files=\$${side}_FILES"
  lc=$(echo "$side" | tr 'A-Z' 'a-z')
  [ "$(g rev-parse -q --verify "$head^{commit}" 2>/dev/null)" = "$head" ] || refuse "${lc}_head_missing $head"
  [ "$(g rev-parse "$head^{tree}")" = "$tree" ] || refuse "${lc}_tree_mismatch"
  g cat-file blob "$head:$P/MANIFEST.sha256" >"$W/$side.manifest" 2>/dev/null || refuse "${lc}_manifest_missing"
  [ "$(sha "$W/$side.manifest")" = "$man" ] || refuse "${lc}_manifest_mismatch"
  mkdir "$W/$side"
  for f in $files; do
    g cat-file blob "$head:$P/$f" >"$W/$side/$f" 2>/dev/null || refuse "${lc}_file_missing $f"
    h=$(sha "$W/$side/$f")
    [ "$h" = "$(awk -v f="$f" '$2 == f { print $1 }' "$W/$side.manifest")" ] || refuse "${lc}_file_hash_mismatch $f"
    echo "$f $h $head $(g ls-tree "$head" -- "$P/$f" | awk '{print $1}')" >>"$W/prov"
  done
done
[ "$(sha "$W/HTTP/lib-run.sh")" = "$(sha "$W/WS/lib-run.sh")" ] || refuse lib_run_differs_between_heads
for f in $HTTP_FILES; do mv "$W/HTTP/$f" "$DEST/$f"; done
for f in $WS_FILES; do [ -e "$DEST/$f" ] || mv "$W/WS/$f" "$DEST/$f"; done
while read -r f _ _ m; do [ "$m" = 100755 ] && chmod +x "$DEST/$f"; done <"$W/prov"
wspkg=$(cd "$REPO/$P" && node -p 'require.resolve("ws/package.json")' 2>/dev/null) || refuse ws_dependency_missing
wsdir=$(dirname "$wspkg")
wshash=$(cd "$wsdir" && find . -type f ! -path './node_modules/*' | LC_ALL=C sort | while read -r x; do printf '%s  %s\n' "$(sha "$x")" "$x"; done | shatool | awk '{print $1}')
(cd "$DEST" && ls | grep -v -x -e .work | LC_ALL=C sort | while read -r x; do printf '%s  %s\n' "$(sha "$x")" "$x"; done) >"$W/ASSEMBLED.sha256"
PROV=$W/prov WSDIR=$wsdir WSHASH=$wshash HH=$HTTP_HEAD HT=$HTTP_TREE HM=$HTTP_MANIFEST WH=$WS_HEAD WT=$WS_TREE WM=$WS_MANIFEST node -e '
const fs = require("fs"), path = require("path"), e = process.env;
const files = fs.readFileSync(e.PROV, "utf8").trim().split("\n").map((l) => { const [name, sha256, head, mode] = l.split(" "); return { name, sha256, head, mode }; });
const pkg = JSON.parse(fs.readFileSync(path.join(e.WSDIR, "package.json"), "utf8"));
process.stdout.write(JSON.stringify({ heads: { http: { commit: e.HH, tree: e.HT, manifestSha256: e.HM }, ws: { commit: e.WH, tree: e.WT, manifestSha256: e.WM } },
  files, ws: { version: pkg.version, dir: e.WSDIR, nodePath: path.dirname(e.WSDIR), treeSha256: e.WSHASH, source: "REPO node_modules (not a git object)" }, node: process.version }, null, 2) + "\n");
' >"$W/provenance.json" || refuse provenance_write_failed
mv "$W/ASSEMBLED.sha256" "$W/provenance.json" "$DEST/"
rm -rf "$W"
echo "compose-assemble: assembled $DEST"
