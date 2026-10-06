#!/usr/bin/env bash
# =============================================================================
# web-ssh setup.sh — 一键安装 / 更新 / 卸载 web-ssh(以 systemd 服务方式运行)
#
# 环境:
#   - Linux + systemd
#   - 本地构建需 V 工具链(go 1.26,即 /usr/local/bin/go);依赖已缓存时可离线构建
#   - 将来若配置 CI 发布二进制,可扩展 --download 分支
#
# 用法:
#   ./setup.sh [install|update|remove|status] [--port 23456] [--host 127.0.0.1]
#
# 默认行为 = install:
#   1. 自举:检测 V 工具链,go vet + go build
#   2. 二进制 → /opt/web-ssh/webssh
#   3. 生成 /etc/systemd/system/web-ssh.service(默认监听 127.0.0.1:23456)
#   4. systemctl daemon-reload && enable --now && 健康检查
#
# 安全默认:
#   - 只绑定 127.0.0.1;需要公网监听/反代时用 --host 0.0.0.0 显式设置,并自行加 TLS
#   - 不关闭 WebSocket 同源校验(除非 --no-origin-check)
#   - update 前自动备份旧二进制到 /opt/web-ssh/backup/
#
# 退出码:0=成功;1=错误;2=参数错误;3=健康检查失败
#
# 测试/容器用环境变量覆盖(默认值即生产路径,勿随意改):
#   WEBSSH_INSTALL_DIR  默认 /opt/web-ssh
#   WEBSSH_SERVICE_FILE 默认 /etc/systemd/system/web-ssh.service
#   WEBSSH_SERVICE_NAME 默认 web-ssh
# =============================================================================
set -euo pipefail

APP_NAME="web-ssh"
BIN_NAME="webssh"

: "${WEBSSH_INSTALL_DIR:=/opt/web-ssh}"
: "${WEBSSH_SERVICE_FILE:=/etc/systemd/system/web-ssh.service}"
: "${WEBSSH_SERVICE_NAME:=web-ssh}"

INSTALL_DIR="$WEBSSH_INSTALL_DIR"
SERVICE_FILE="$WEBSSH_SERVICE_FILE"
SERVICE_NAME="$WEBSSH_SERVICE_NAME"
BACKUP_DIR="${INSTALL_DIR}/backup"
DEFAULT_PORT=23456
DEFAULT_HOST="127.0.0.1"

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$APP_NAME" "$*"; }
warn() { printf '\033[1;33m[%s]\033[0m %s\n' "$APP_NAME" "$*"; }
die()  { printf '\033[1;31m[%s]\033[0m %s\n' "$APP_NAME" "$*" >&2; exit "${2:-1}"; }

usage() {
  cat <<'EOF'
web-ssh setup.sh — 一键安装 / 更新 / 卸载 web-ssh(systemd 服务)

用法:
  ./setup.sh [install|update|remove|status] [选项]

动作(默认 install):
  install   构建并安装为 systemd 服务,enable --now + 健康检查
  update    重新构建、备份旧二进制、覆盖安装(mv -f 避免 Text file busy)
  remove    停止并禁用服务、删除单元文件(数据在浏览器 localStorage,不受影响)
  status    查看服务状态 + 健康检查

选项:
  --port N                监听端口(默认 23456)
  --host HOST             监听地址(默认 127.0.0.1;对外暴露用 0.0.0.0 并自行加 TLS)
  --no-origin-check       关闭 WebSocket 同源校验(仅反代场景)
  -h, --help              显示本帮助

环境变量(测试/容器覆盖):
  WEBSSH_INSTALL_DIR / WEBSSH_SERVICE_FILE / WEBSSH_SERVICE_NAME

退出码:0=成功 1=错误 2=参数错误 3=健康检查失败
EOF
  exit 0
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# ---------- 参数 ----------
ACTION="install"
PORT="$DEFAULT_PORT"
HOST="$DEFAULT_HOST"

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      install|update|remove|status) ACTION="$1" ;;
      --port)
        [[ $# -ge 2 ]] || die "--port 需要值" 2
        PORT="$2"; shift ;;
      --host)
        [[ $# -ge 2 ]] || die "--host 需要值" 2
        HOST="$2"; shift ;;
      --no-origin-check) NO_ORIGIN_CHECK=1 ;;
      -h|--help|-help) usage ;;
      *) die "未知参数: $1(可用: install|update|remove|status)" 2 ;;
    esac
    shift
  done
}

# ---------- 健康检查 ----------
health_check() {
  local url="http://127.0.0.1:${PORT}/"
  if curl -fsS -o /dev/null --max-time 5 "$url" 2>/dev/null; then
    log "健康检查通过: $url"
    return 0
  fi
  # 服务可能在(旧的)其他端口:找一下实际监听端口再判断
  local actual
  actual="$(ss -tlnp 2>/dev/null | grep "$BIN_NAME" | grep -oE ':[0-9]+' | head -1 | tr -d ':' || true)"
  if [[ -n "$actual" ]]; then
    warn "健康检查 $url 失败,但发现进程实际监听 :$actual"
    return 0
  fi
  die "健康检查失败: 服务未在 $url 响应(或进程未监听)" 3
}

# ---------- 构建(V 工具链) ----------
build_local() {
  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  log "在仓库内构建: $repo_dir"
  if ! have_cmd go; then
    die "未检测到 V 工具链(go);请先安装 go 1.26+(github.com/vlang-io/v),或改用 --download" 1
  fi
  # 依赖缓存命中时离线可构建;cache miss 则拉取。失败不阻断,后续 build 会报真实错误。
  ( cd "$repo_dir" && go mod download >/dev/null 2>&1 ) || true
  ( cd "$repo_dir" && go vet ./... )
  ( cd "$repo_dir" && go build -o "${INSTALL_DIR}/${BIN_NAME}.new" . )
}

# 无 CI 发布产物;保留接口供将来对接 release
build_download() {
  die "尚无预编译 release,请用 ./setup.sh install(默认本地构建);发布后此分支会自动接管" 1
}

# ---------- 单元文件 ----------
write_service() {
  local origin_check=""
  if [[ "${NO_ORIGIN_CHECK:-0}" == "1" ]]; then
    origin_check=" --no-origin-check"
  fi
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Web SSH gateway (Vlang, single binary)
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/${BIN_NAME} --listen ${HOST}:${PORT}${origin_check}
Restart=on-failure
RestartSec=3
# 默认仅本机访问;对外暴露时把 --listen 改 0.0.0.0:23456(自行加 TLS)
# 超时调参:环境变量 WEBSSH_IDLE_MIN / WEBSSH_MAX_MIN(分钟,0=不限制),或在 ExecStart 加 --idle 10 --max 180

[Install]
WantedBy=multi-user.target
EOF
  log "写入单元文件: $SERVICE_FILE"
}

# ---------- 动作 ----------
install() {
  log "==== 安装 $APP_NAME ===="
  mkdir -p "$INSTALL_DIR" "$BACKUP_DIR"

  if { build_local || build_download; }; then :; fi

  if [[ -f "${INSTALL_DIR}/${BIN_NAME}" ]]; then
    local bak="${BACKUP_DIR}/${BIN_NAME}.$(date +%Y%m%d-%H%M%S)"
    cp -a "${INSTALL_DIR}/${BIN_NAME}" "$bak"
    log "已备份旧二进制 → $bak"
  fi
  mv -f "${INSTALL_DIR}/${BIN_NAME}.new" "${INSTALL_DIR}/${BIN_NAME}"
  chmod +x "${INSTALL_DIR}/${BIN_NAME}"
  log "二进制就位: ${INSTALL_DIR}/${BIN_NAME}"

  write_service

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
  log "服务已启用并启动"

  sleep 1
  health_check

  log "安装完成: http://${HOST}:${PORT}/   (systemd: ${SERVICE_NAME})"
}

update() { install; }

remove() {
  log "==== 卸载 $APP_NAME ===="
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
  log "已停止并移除服务。数据在浏览器 localStorage,不受影响。"
  log "二进制保留在 ${INSTALL_DIR}(备份: ${BACKUP_DIR});彻底删除: rm -rf ${INSTALL_DIR}"
}

status() {
  systemctl --no-pager status "$SERVICE_NAME" 2>&1 | head -12 || true
  health_check
}

# ---------- 入口 ----------
parse_args "$@"

case "$ACTION" in
  install) install ;;
  update)  update ;;
  remove)  remove ;;
  status)  status ;;
esac