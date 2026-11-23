#!/usr/bin/env bash
# run-slow-lane.sh — 场景 8 安装层 e2e 的宿主编排（root 跑；podman 全部以 e2e-cpr 身份 rootless 执行）。
#
# 职责：
#   1. e2e-cpr 用户 + subuid/subgid 就位（幂等；rootless podman 硬要求）
#   2. 镜像构建（只构造一次；e2e-cpr 自己的 storage）+ 套件/产物 staging 到 /home/e2e-cpr（/root 对该用户不可见）
#   3. 每遍：宿主生产 llm-cpr 快照（只读）→ 容器全流程 → 退出码 + report 判绿 → 生产快照比对 → 残留容器检查
#   4. 默认连跑两遍（$1 可改遍数）
#
# 用法：bash run-slow-lane.sh [遍数，默认 2]
# 宿主红线：绝不写 /root/.llm-cpr、~/.hermes；对生产只做只读查询（systemctl --user show）。

set -uo pipefail

# 路径锚点：脚本自带定位（进仓后仓内仓外都能跑）；REPO 可用 CPR_E2E_REPO 覆盖（默认=仓根）。
LANE=$(cd "$(dirname "$0")" && pwd)
E2E=$(dirname "$LANE")
if [ -n "${CPR_E2E_REPO:-}" ]; then REPO="$CPR_E2E_REPO"; elif [ -f "$E2E/../cli/package.json" ]; then REPO=$(cd "$E2E/../cli" && pwd); else REPO=$(cd "$E2E/../.." && pwd); fi
STAGE=/home/e2e-cpr/llm-cpr-e2e-stage
IMAGE=localhost/llm-cpr-e2e:24.04
CNAME=llm-cpr-e2e-slow
RUNS=${1:-2}

log() { echo "[slow-lane] $*"; }
die() { echo "[slow-lane] RED: $*" >&2; exit 1; }

# ---- 1. e2e-cpr 用户（幂等） ----
id e2e-cpr >/dev/null 2>&1 || useradd -m -s /bin/bash e2e-cpr
usermod --add-subuids 165536-231071 --add-subgids 165536-231071 e2e-cpr 2>/dev/null || true
RUN_UID=$(id -u e2e-cpr)
mkdir -p "/run/user/$RUN_UID"
chown e2e-cpr:e2e-cpr "/run/user/$RUN_UID"
chmod 700 "/run/user/$RUN_UID"
loginctl enable-linger e2e-cpr >/dev/null 2>&1 || true
log "user e2e-cpr uid=$RUN_UID subuid=$(grep ^e2e-cpr: /etc/subuid)"

# ---- 2. staging（/root 不对 e2e-cpr 开放；套件文件镜像到该用户可读处） ----
mkdir -p "$STAGE/e2e/slow-lane" "$STAGE/artifacts"
cp "$E2E/fake-upstream.ts" "$STAGE/e2e/"
cp "$LANE/run-install-e2e.ts" "$LANE/fake-registry.ts" "$STAGE/e2e/slow-lane/"
chown -R e2e-cpr:e2e-cpr "$STAGE"

# ---- 镜像（缺则构建，e2e-cpr 身份；构建期要外网，运行期容器 --network=none 零外网） ----
if ! su - e2e-cpr -c "podman image exists $IMAGE"; then
  log "building image $IMAGE (as e2e-cpr, rootless)"
  cp "$LANE/Containerfile" "$STAGE/slow-lane/"
  rm -rf "$STAGE/slow-lane/image-files" && cp -r "$LANE/image-files" "$STAGE/slow-lane/"
  chown -R e2e-cpr:e2e-cpr "$STAGE"
  su - e2e-cpr -c "cd $STAGE/slow-lane && podman build -t $IMAGE ." >/dev/null || die "image build failed"
fi
log "image ready"

# ---- npm pack 产物（被测仓每次现打，防版本陈旧；staging 处交给 e2e-cpr 只读挂载） ----
rm -f "$STAGE/artifacts"/ffrfree-llm-cpr-*.tgz
(cd "$REPO" && npm pack --pack-destination "$STAGE/artifacts") >/dev/null || die "npm pack failed"
chmod 644 "$STAGE/artifacts"/ffrfree-llm-cpr-*.tgz
chown e2e-cpr:e2e-cpr "$STAGE/artifacts"/ffrfree-llm-cpr-*.tgz
log "artifact: $(ls "$STAGE/artifacts")"

# ---- 宿主生产快照（只读硬红线） ----
prod_snapshot() { XDG_RUNTIME_DIR=/run/user/0 systemctl --user show llm-cpr -p MainPID,ActiveState 2>&1; }
PROD_START=$(prod_snapshot)
log "prod before: $PROD_START"

GREEN=0; RED=0
for i in $(seq 1 "$RUNS"); do
  STAMP=$(date +%H%M%S)
  RUNDIR=$STAGE/runs/run-$i-$STAMP
  mkdir -p "$RUNDIR"
  chown e2e-cpr:e2e-cpr "$RUNDIR"

  BEFORE=$(prod_snapshot)
  log "run $i: container starting ($RUNDIR)"
  timeout -k 15 720 su - e2e-cpr -c "podman rm -f $CNAME >/dev/null 2>&1; podman run --rm --name $CNAME --network=none --stop-signal=SIGRTMIN+3 \
    --hostname llm-cpr-e2e \
    -v $STAGE/e2e:/mnt/e2e:ro -v $STAGE/artifacts:/mnt/pkg:ro -v $RUNDIR:/mnt/run \
    $IMAGE"
  RC=$?
  AFTER=$(prod_snapshot)

  if [ "$BEFORE" != "$AFTER" ]; then
    log "run $i: PROD DRIFT! before=[$BEFORE] after=[$AFTER]"; RED=$((RED+1)); continue
  fi

  if [ "$RC" -ne 0 ]; then
    log "run $i: container exit=$RC (非 0)"; RED=$((RED+1)); continue
  fi

  OK=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RUNDIR/report.json','utf8')).ok)" 2>/dev/null || echo parse-error)
  if [ "$OK" != "true" ]; then
    log "run $i: report not green (ok=$OK)"; RED=$((RED+1)); continue
  fi

  LEFT=$(su - e2e-cpr -c "podman ps -a --filter name=$CNAME -q" 2>/dev/null | wc -l)
  if [ "$LEFT" -ne 0 ]; then
    log "run $i: leftover containers: $LEFT"; RED=$((RED+1)); continue
  fi

  GREEN=$((GREEN+1))
  mkdir -p "$E2E/runs/slow-lane/run-$i-$STAMP"
  cp -r "$RUNDIR"/. "$E2E/runs/slow-lane/run-$i-$STAMP"/
  log "run $i: GREEN (exit=0, report ok, prod untouched, no leftovers; 产物已拷回 $E2E/runs/slow-lane/run-$i-$STAMP)"
done

PROD_END=$(prod_snapshot)
log "prod after: $PROD_END"
[ "$PROD_START" = "$PROD_END" ] || die "production llm-cpr changed across the whole suite: [$PROD_START] -> [$PROD_END]"

log "summary: green=$GREEN red=$RED (of $RUNS)"
[ "$GREEN" -eq "$RUNS" ] && [ "$RED" -eq 0 ] || die "not all runs green"
log "ALL GREEN — $RUNS runs, production untouched"
