#!/usr/bin/env bash
# =============================================================================
# web-ssh setup.sh — 一键安装 / 更新 / 卸载 web-ssh(以 systemd 服务方式运行)
#
# 环境:
#   - Linux + systemd
#   - 默认从 GitHub Release 下载预编译二进制(无需本机安装 Go 工具链)
#   - 仓库开发者也可用 --local 在仓库内本地构建
#
# 用法:
#   ./setup.sh [install|update|remove|status] [--port 23456] [--host 127.0.0.1]
#      [--version vX.Y.Z] [--local] [--download-url URL]
#
# 默认行为 = install(从最新 Release 下载):
#   1. 取 GitHub 最新 Release 的 webssh-linux-<arch>(amd64/arm64)
#   2. 校验 sha256 → 二进制 → /opt/web-ssh/webssh
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
#   WEBSSH_REPO         默认 bitscr/web-ssh(GitHub 仓库,下载用)
# =============================================================================
set -euo pipefail

APP_NAME="web-ssh"
BIN_NAME="webssh"

: "${WEBSSH_INSTALL_DIR:=/opt/web-ssh}"
: "${WEBSSH_SERVICE_FILE:=/etc/systemd/system/web-ssh.service}"
: "${WEBSSH_SERVICE_NAME:=web-ssh}"
: "${WEBSSH_REPO:=bitscr/web-ssh}"

INSTALL_DIR="$WEBSSH_INSTALL_DIR"
SERVICE_FILE="$WEBSSH_SERVICE_FILE"
SERVICE_NAME="$WEBSSH_SERVICE_NAME"
REPO="$WEBSSH_REPO"
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
  install   从 GitHub Release 下载并安装为 systemd 服务,enable --now + 健康检查
  update    下载新版、备份旧二进制、覆盖安装(mv -f 避免 Text file busy)
  remove    停止并禁用服务、删除单元文件(数据在浏览器 localStorage,不受影响)
  status    查看服务状态 + 健康检查

选项:
  --port N                监听端口(默认 23456)
  --host HOST             监听地址(默认 127.0.0.1;对外暴露用 0.0.0.0 并自行加 TLS)
  --version vX.Y.Z        指定版本(默认最新 Release;latest=最新)
  --local                 在仓库内本地构建(需 Go 1.26 工具链;开发者用)
  --download-url URL      直接指定二进制下载地址(覆盖 Release 逻辑)
  --no-origin-check       关闭 WebSocket 同源校验(仅反代场景)
  -h, --help              显示本帮助

环境变量(测试/容器覆盖):
  WEBSSH_INSTALL_DIR / WEBSSH_SERVICE_FILE / WEBSSH_SERVICE_NAME / WEBSSH_REPO

退出码:0=成功 1=错误 2=参数错误 3=健康检查失败
EOF
  exit 0
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# ---------- 参数 ----------
ACTION="install"
PORT="$DEFAULT_PORT"
HOST="$DEFAULT_HOST"
VERSION="latest"
USE_LOCAL=0
DOWNLOAD_URL=""
NO_ORIGIN_CHECK=0

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
      --version)
        [[ $# -ge 2 ]] || die "--version 需要值(如 v0.2.0 或 latest)" 2
        VERSION="$2"; shift ;;
      --local) USE_LOCAL=1 ;;
      --download-url)
        [[ $# -ge 2 ]] || die "--download-url 需要值" 2
        DOWNLOAD_URL="$2"; shift ;;
      --no-origin-check) NO_ORIGIN_CHECK=1 ;;
      -h|--help|-help) usage ;;
      *) die "未知参数: $1(可用: install|update|remove|status)" 2 ;;
    esac
    shift
  done
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) die "不支持的架构: $(uname -m)(仅 amd64/arm64 有预编译包)" 1 ;;
  esac
}

resolve_version() {
  local v="$1"
  if [[ "$v" == "latest" ]]; then
    v="$(curl -fsSL --max-time 15 -o /dev/null -w '%{url_effective}' \
      "https://github.com/${REPO}/releases/latest" | grep -oE '[^/]+$')"
    [[ -n "$v" ]] || die "无法获取最新 Release 版本" 1
    log "最新版本: $v"
  fi
  # 归一化:允许 0.2.0 / v0.2.0 两种写法
  [[ "$v" == v* ]] || v="v$v"
  echo "$v"
}

fetch_binary() {
  local dest="$1" arch url base
  arch="$(detect_arch)"
  if [[ -n "$DOWNLOAD_URL" ]]; then
    url="$DOWNLOAD_URL"
  else
    local ver
    ver="$(resolve_version "$VERSION")"
    base="https://github.com/${REPO}/releases/download/${ver}/webssh-linux-${arch}"
    url="$base"
    log "下载: $base (+ .sha256 校验)"
    curl -fsSL --max-time 60 -o "${dest}.sha256" "${base}.sha256" \
      || die "下载 sha256 失败: ${base}.sha256 (版本 $ver 是否存在?)" 1
  fi
  curl -fsSL --max-time 120 -o "$dest" "$url" \
    || die "下载二进制失败: $url" 1
  chmod +x "$dest"
  if [[ -f "${dest}.sha256" ]]; then
    ( cd "$(dirname "$dest")" && sha256sum -c "$(basename "$dest").sha256" ) \
      || die "sha256 校验失败,停止安装(文件可能损坏或被篡改)" 1
    log "sha256 校验通过"
    rm -f "${dest}.sha256"
  else
    warn "--download-url 未附带校验文件,跳过 sha256 校验"
  fi
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

# ---------- 本地构建(仓库开发者用,V 工具链) ----------
build_local() {
  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  log "在仓库内构建: $repo_dir"
  if ! have_cmd go; then
    die "未检测到 Go 工具链;请安装 Go 1.26+(见 README 开发章节),或去掉 --local 改用 Release 下载" 1
  fi
  # 依赖缓存命中时离线可构建;cache miss 则拉取。失败不阻断,后续 build 会报真实错误。
  ( cd "$repo_dir" && go mod download >/dev/null 2>&1 ) || true
  ( cd "$repo_dir" && go vet ./... )
  ( cd "$repo_dir" && go build -o "${INSTALL_DIR}/${BIN_NAME}.new" . )
}

# ---------- 单元文件 ----------
write_service() {
  local origin_check=""
  if [[ "$NO_ORIGIN_CHECK" == "1" ]]; then
    origin_check=" --no-origin-check"
  fi
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Web SSH gateway (Go, single binary)
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

  if [[ "$USE_LOCAL" == "1" ]]; then
    build_local
  else
    fetch_binary "${INSTALL_DIR}/${BIN_NAME}.new"
  fi

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