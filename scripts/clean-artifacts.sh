#!/usr/bin/env bash
#
# Reclaim disk space from generated artifacts in THIS repo, plus the caches its
# test tooling keeps outside it.
#
# Everything here is regenerable. Nothing tracked by git is touched, and the
# script refuses to run anywhere except this repository.
#
#   ./scripts/clean-artifacts.sh              # test output only (the safe default)
#   ./scripts/clean-artifacts.sh --dry-run    # show what would go, delete nothing
#   ./scripts/clean-artifacts.sh --builds     # + build output (keeps .dmg files)
#   ./scripts/clean-artifacts.sh --caches     # + re-downloadable test tooling
#   ./scripts/clean-artifacts.sh --xcode      # + stale simulators/runtimes/symbols
#   ./scripts/clean-artifacts.sh --all        # every tier above
#   ./scripts/clean-artifacts.sh --all --dmgs # also delete built .dmg installers
#
# --xcode keeps whatever is needed to build and run this app: the newest iOS
# simulator runtime and its devices, plus symbols for any attached device. It
# removes older runtimes, their simulators, orphaned simulators, and this
# project's DerivedData. Other projects' DerivedData is left alone.
#
set -euo pipefail

DRY_RUN=0; DO_BUILDS=0; DO_CACHES=0; DO_DMGS=0; DO_XCODE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --builds)     DO_BUILDS=1 ;;
    --caches)     DO_CACHES=1 ;;
    --dmgs)       DO_DMGS=1 ;;
    --xcode)      DO_XCODE=1 ;;
    --all)        DO_BUILDS=1; DO_CACHES=1; DO_XCODE=1 ;;
    -h|--help)    sed -n '2,18p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Guard: only ever operate on this project, so a stray copy of this script
# cannot start deleting from an unrelated directory.
if [[ ! -f package.json ]] || ! grep -q '"name": "checkbook"' package.json; then
  echo "refusing to run: $REPO does not look like the checkbook repo" >&2
  exit 1
fi

FREE_BEFORE_KB=$(df -k /System/Volumes/Data | awk 'NR==2{print $4}')
TOTAL_KB=0
PLANNED=()
ACTIONS=()      # shell commands (simctl etc), run after path deletions
ACTION_DESCS=()

# Queue a path for deletion if it exists and is non-empty.
plan() {
  local path="$1" label="$2"
  [[ -e "$path" ]] || return 0
  local kb; kb=$(du -sk "$path" 2>/dev/null | cut -f1 || echo 0)
  [[ "${kb:-0}" -gt 0 ]] || return 0
  TOTAL_KB=$((TOTAL_KB + kb))
  PLANNED+=("$path")
  printf '  %8s  %-34s %s\n' "$(du -sh "$path" 2>/dev/null | cut -f1)" "$label" "${path/#$HOME/~}"
}

# Queue a command whose freed bytes we already measured separately.
plan_cmd() {
  local kb="$1" label="$2" detail="$3" cmd="$4"
  TOTAL_KB=$((TOTAL_KB + kb))
  ACTIONS+=("$cmd")
  ACTION_DESCS+=("$label")
  printf '  %8s  %-34s %s\n' "$(awk -v k="$kb" 'BEGIN{if(k>1048576)printf "%.1fG",k/1048576; else if(k>1024)printf "%.0fM",k/1024; else printf "%dK",k}')" "$label" "$detail"
}

echo "== test session output =="
plan "playwright-report"                    "Playwright HTML report"
plan "test-results"                         "Playwright run state"
plan "e2e/web/.auth"                        "saved E2E login session"
plan "blob-report"                          "Playwright blob report"
# Jest writes its cache outside the repo; ask Jest where rather than guessing.
JEST_CACHE="$(npx --no-install jest --showConfig 2>/dev/null \
  | sed -n 's/.*"cacheDirectory": "\([^"]*\)".*/\1/p' | head -1 || true)"
[[ -n "${JEST_CACHE:-}" ]] && plan "$JEST_CACHE" "Jest transform cache"
plan "${TMPDIR:-/tmp}metro-cache"           "Metro bundler cache"
plan "coverage"                             "coverage report"

if [[ $DO_BUILDS -eq 1 ]]; then
  echo "== build output =="
  plan "dist"                               "Expo web export"
  plan "electron/dist-main"                 "compiled Electron main"
  plan "ios/build"                          "Xcode codegen output"
  plan "ios/Pods"                           "CocoaPods (pod install)"
  plan ".expo"                              "Expo dev cache"
  # The packaged .app is large and always rebuilt; the .dmg installers are the
  # actual deliverables, so they only go when explicitly requested.
  plan "dist-electron/mac-arm64"            "packaged .app bundle"
  if [[ $DO_DMGS -eq 1 ]]; then
    while IFS= read -r -d '' f; do plan "$f" "built installer"; done \
      < <(find dist-electron -maxdepth 1 -name '*.dmg' -print0 2>/dev/null)
  elif compgen -G "dist-electron/*.dmg" >/dev/null; then
    echo "  (keeping $(ls -1 dist-electron/*.dmg | wc -l | tr -d ' ') .dmg installer(s) — pass --dmgs to remove)"
  fi
fi

if [[ $DO_CACHES -eq 1 ]]; then
  echo "== re-downloadable test tooling =="
  plan "$HOME/Library/Caches/ms-playwright"  "Playwright browsers"
  plan "$HOME/.maestro"                      "Maestro CLI + runtime"
fi

if [[ $DO_XCODE -eq 1 ]]; then
  echo "== stale Xcode / simulator data =="

  # This project's DerivedData only. Other projects are deliberately untouched.
  for dd in "$HOME/Library/Developer/Xcode/DerivedData"/Nestworth-*; do
    [[ -d "$dd" ]] && plan "$dd" "DerivedData (this project)"
  done
  plan "$HOME/Library/Developer/Xcode/DerivedData/ModuleCache.noindex" "Xcode module cache"

  # Python helpers kept in variables so quoting stays sane.
  read -r -d '' PY_ORPHAN <<'PYEOF' || true
import json,sys,os,subprocess
base=os.path.expanduser("~/Library/Developer/CoreSimulator/Devices")
tot=0
for rt,devs in json.load(sys.stdin)["devices"].items():
    for d in devs:
        if not d.get("isAvailable"):
            p=os.path.join(base,d["udid"])
            if os.path.isdir(p):
                tot+=int(subprocess.run(["du","-sk",p],capture_output=True,text=True).stdout.split()[0] or 0)
print(tot)
PYEOF

  read -r -d '' PY_DEVICES <<'PYEOF' || true
import json,sys,os,subprocess
keep=os.environ.get("KEEP","")
base=os.path.expanduser("~/Library/Developer/CoreSimulator/Devices")
for rt,devs in json.load(sys.stdin)["devices"].items():
    if rt==keep or "SimRuntime.iOS" not in rt:
        continue
    for d in devs:
        if not d.get("isAvailable"):
            continue          # already covered by 'delete unavailable'
        p=os.path.join(base,d["udid"])
        if not os.path.isdir(p):
            continue
        kb=int(subprocess.run(["du","-sk",p],capture_output=True,text=True).stdout.split()[0] or 0)
        if kb>1024:
            print("%s|%d|%s|%s" % (d["udid"], kb, d["name"], rt.rsplit(".",1)[-1]))
PYEOF

  # Superseded runtime images: newest of each platform is kept.
  read -r -d '' PY_RUNTIMES <<'PYEOF' || true
import json,sys,re
try:
    data=json.load(sys.stdin)
except Exception:
    sys.exit(0)
by={}
for uuid,v in data.items():
    if not isinstance(v,dict) or not v.get("deletable"):
        continue
    ident=v.get("runtimeIdentifier","")
    m=re.search(r"SimRuntime\.([A-Za-z]+)-([\d-]+)", ident)
    if not m:
        continue
    plat=m.group(1)
    ver=tuple(int(x) for x in re.findall(r"\d+", v.get("version") or m.group(2).replace("-",".")))
    kb=(v.get("sizeBytes") or 0)//1024
    if kb>0:
        by.setdefault(plat,[]).append((ver,uuid,kb,"%s %s" % (plat, v.get("version") or m.group(2))))
for plat,items in by.items():
    items.sort()
    for ver,uuid,kb,label in items[:-1]:      # keep newest per platform
        print("%s|%d|%s (superseded)" % (uuid,kb,label))
PYEOF

  if command -v xcrun >/dev/null 2>&1; then
    # Newest installed iOS runtime — what builds and Maestro flows target.
    KEEP_RT=$(xcrun simctl list runtimes 2>/dev/null \
      | sed -n 's/^iOS \([0-9.]*\) .*- \(com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]*\)$/\1 \2/p' \
      | sort -V | tail -1 | awk '{print $2}') || true
    [[ -n "${KEEP_RT:-}" ]] && echo "  (keeping newest iOS runtime: ${KEEP_RT##*.} and its simulators)"

    SIM_JSON=$(xcrun simctl list devices --json 2>/dev/null || echo '{"devices":{}}')

    # Simulators whose runtime is gone — always safe, they can never boot.
    ORPHAN_KB=$(printf '%s' "$SIM_JSON" | python3 -c "$PY_ORPHAN" 2>/dev/null || echo 0)
    [[ "${ORPHAN_KB:-0}" -gt 0 ]] && plan_cmd "$ORPHAN_KB" "orphaned simulators" \
      "their runtime is already gone" "xcrun simctl delete unavailable"

    # Simulators on superseded iOS runtimes (any state inside them is lost).
    while IFS='|' read -r udid kb name rt; do
      [[ -z "${udid:-}" ]] && continue
      plan_cmd "$kb" "simulator: $name" "$rt" "xcrun simctl delete $udid"
    done < <(printf '%s' "$SIM_JSON" | KEEP="${KEEP_RT:-}" python3 -c "$PY_DEVICES" 2>/dev/null || true)

    # Superseded runtime disk images (~8 GB each; Xcode re-downloads on demand).
    while IFS='|' read -r uuid kb label; do
      [[ -z "${uuid:-}" ]] && continue
      plan_cmd "$kb" "runtime image" "$label" "xcrun simctl runtime delete $uuid"
    done < <(xcrun simctl runtime list -j 2>/dev/null | python3 -c "$PY_RUNTIMES" 2>/dev/null || true)

    # Device symbol caches for iOS versions no attached device is running.
    DS="$HOME/Library/Developer/Xcode/iOS DeviceSupport"
    if [[ -d "$DS" ]]; then
      # grep exits 1 with no match; guard it so `set -e` doesn't abort here.
      CONNECTED=$(xcrun devicectl list devices 2>/dev/null \
        | grep -oE '\([0-9]+\.[0-9]+(\.[0-9]+)?\)' | tr -d '()' | sort -u || true)
      for dir in "$DS"/*; do
        [[ -d "$dir" ]] || continue
        dver=$(basename "$dir" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)
        if [[ -n "${CONNECTED:-}" ]] && grep -qx "${dver:-none}" <<<"$CONNECTED"; then
          echo "  (keeping symbols for attached device: $dver)"
        else
          plan "$dir" "device symbols (${dver:-unknown})"
        fi
      done
    fi
  fi
fi

if [[ ${#PLANNED[@]} -eq 0 && ${#ACTIONS[@]} -eq 0 ]]; then
  echo; echo "Nothing to clean."; exit 0
fi

HUMAN=$(echo "$TOTAL_KB" | awk '{ if ($1>1048576) printf "%.1f GB", $1/1048576; else if ($1>1024) printf "%.0f MB", $1/1024; else printf "%d KB", $1 }')
echo
if [[ $DRY_RUN -eq 1 ]]; then
  echo "DRY RUN — nothing deleted. Would reclaim $HUMAN across $(( ${#PLANNED[@]} + ${#ACTIONS[@]} )) item(s)."
  exit 0
fi

for p in "${PLANNED[@]:-}"; do [[ -n "$p" ]] && rm -rf -- "$p"; done
for i in "${!ACTIONS[@]}"; do
  echo "  running: ${ACTION_DESCS[$i]}"
  eval "${ACTIONS[$i]}" >/dev/null 2>&1 || echo "    (skipped — ${ACTIONS[$i]} failed)"
done

FREE_AFTER_KB=$(df -k /System/Volumes/Data | awk 'NR==2{print $4}')
GAINED=$(( (FREE_AFTER_KB - FREE_BEFORE_KB) / 1024 ))
echo "Removed $(( ${#PLANNED[@]} + ${#ACTIONS[@]} )) item(s), ~$HUMAN."
echo "Free space: $(df -h /System/Volumes/Data | awk 'NR==2{print $4}') (+${GAINED} MB)"
echo
echo "To restore: npm ci (deps) · npx pod-install (ios/Pods) · npx playwright install (browsers)"
[[ $DO_XCODE -eq 1 ]] && echo "Xcode re-downloads simulator runtimes and device symbols on demand."
