# Sourced by run-native.sh (and verify-offline.sh). Requires RUN and RUNID.
# Only processes and containers registered here by this run are ever signalled or removed:
#  - a PID is acted on only while its process start time (ps lstart) equals the one recorded at
#    registration, so a reused PID is never signalled;
#  - a container is removed only if its fe173.run label equals this RUNID.
FE173_REG="$RUN/registry"
mkdir -p "$FE173_REG"
: >>"$FE173_REG/pids"
: >>"$FE173_REG/containers"

fe_log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fe_lstart() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }
fe_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

fe_register_pid() { # pid label
  local st
  st=$(fe_lstart "$1")
  [ -n "$st" ] || { fe_log "register: pid $1 is not running"; return 1; }
  printf '%s\t%s\t%s\n' "$1" "$2" "$st" >>"$FE173_REG/pids"
}

fe_owned() { # pid: 0 if registered by this run, same start time, and not a zombie
  local line st stat
  line=$(awk -F'\t' -v p="$1" '$1 == p { l = $0 } END { print l }' "$FE173_REG/pids")
  [ -n "$line" ] || return 1
  stat=$(ps -o stat= -p "$1" 2>/dev/null | sed 's/^ *//')
  case "$stat" in "" | Z*) return 1 ;; esac
  st=$(fe_lstart "$1")
  [ "$st" = "$(printf '%s\n' "$line" | cut -f3)" ]
}

fe_stop_pid() { # pid: TERM, up to 10 s, then KILL; only if owned
  local i
  fe_owned "$1" || return 0
  kill -TERM "$1" 2>/dev/null || return 0
  for i in $(seq 1 20); do
    fe_owned "$1" || return 0
    sleep 0.5
  done
  if fe_owned "$1"; then kill -KILL "$1" 2>/dev/null || true; fi
  return 0
}

fe_start() { # label stdout-file cmd...: background, register, write $RUN/<label>.pid
  local label=$1 out=$2 pid
  shift 2
  "$@" >"$out" 2>>"$RUN/$label.log" &
  pid=$!
  fe_register_pid "$pid" "$label" || return 1
  echo "$pid" >"$RUN/$label.pid"
}
fe_pid() { cat "$RUN/$1.pid"; }

fe_start_container() { # name docker-run-args...
  local name=$1 id
  shift
  id=$(docker run -d --rm --name "$name" --label "fe173.run=$RUNID" "$@") || return 1
  printf '%s\t%s\n' "$id" "$name" >>"$FE173_REG/containers"
}

fe_cleanup() {
  local rc=$? pid id name
  for pid in $(awk -F'\t' '{ a[NR] = $1 } END { for (i = NR; i > 0; i--) print a[i] }' "$FE173_REG/pids"); do
    fe_stop_pid "$pid"
  done
  while IFS="$(printf '\t')" read -r id name; do
    [ -n "$id" ] || continue
    if [ "$(docker inspect -f '{{index .Config.Labels "fe173.run"}}' "$id" 2>/dev/null)" = "$RUNID" ]; then
      docker rm -f "$id" >/dev/null 2>&1 || true
    fi
  done <"$FE173_REG/containers"
  fe_log "cleanup done (run $RUNID, exit $rc)"
  return "$rc"
}

fe_wait_until() { # deadline_s interval_s description fn; fn returns 0 done, 1 keep waiting, other abort
  local end=$((SECONDS + $1)) r
  while :; do
    "$4" && r=0 || r=$?
    [ "$r" = 0 ] && return 0
    [ "$r" = 1 ] || { fe_log "$3: aborted ($r)"; return 2; }
    [ "$SECONDS" -lt "$end" ] || { fe_log "$3: deadline $1 s exceeded"; return 1; }
    sleep "$2"
  done
}

fe_wait_pid() { # pid deadline_s description: exit code of the process, or 124 at the deadline
  local end=$((SECONDS + $2))
  while fe_owned "$1"; do
    [ "$SECONDS" -lt "$end" ] || { fe_log "$3: deadline $2 s exceeded"; return 124; }
    sleep 1
  done
  wait "$1" 2>/dev/null && return 0 || return $?
}
