#!/usr/bin/env bash
# web-ssh 一键部署 — 下载预编译二进制 + 注册 systemd 服务
#
# 用法(一行命令):
#   curl -fsSL https://github.com/bitscr/web-ssh/releases/latest/download/install.sh | sudo bash
#
# 指定版本:
#   curl -fsSL https://github.com/bitscr/web-ssh/releases/latest/download/install.sh | sudo TAG=v0.2.0 bash
#
# 行为:
#   1. 识别架构(amd64/arm64)
#   2. 下载对应 tar.gz + 校验 sha256(不匹配即中止)
#   3. 解压安装到 /opt/web-ssh/webssh
#   4. 写 systemd 单元 web-ssh.service,enable --now
#   5. 健康检查 127.0.0.1:23456
#
# 二进制内置监听 0.0.0.0:23456,无启动参数。
set -euo pipefail

BIN_DIR=/opt/web-ssh
SERVICE_NAME=web-ssh
REPO=bitscr/web-ssh
TAG="${TAG:-latest}"

log() { printf '[web-ssh] %s\n' "$*"; }
die() { printf '[web-ssh] %s\n' "$*" >&2; exit "${2:-1}"; }

[ "$(id -u)" -eq 0 ] || die "需要 root 权限运行(请用 sudo bash)" 1

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "不支持的架构: $(uname -m)(仅提供 amd64/arm64)" 1 ;;
esac
log "架构=$ARCH 版本=$TAG"

# --- 解析 latest ---
if [ "$TAG" = "latest" ]; then
  TAG=$(curl -fsS --max-time 15 -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest" | grep -oE '[^/]+$') \
    || die "无法获取最新版本(网络不通?)" 1
  [ -n "$TAG" ] || die "无法解析最新版本号" 1
  log "最新版本=$TAG"
fi

BASE="https://github.com/${REPO}/releases/download/${TAG}"
PKG="webssh-linux-${ARCH}.tar.gz"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- 下载 + 校验 ---
log "下载 $PKG"
curl -fsSL --max-time 120 -o "${TMP}/${PKG}" "${BASE}/${PKG}" \
  || die "下载失败: ${BASE}/${PKG}(版本或架构包是否存在?)" 1

if curl -fsSL --max-time 30 -o "${TMP}/${PKG}.sha256" "${BASE}/${PKG}.sha256"; then
  ( cd "$TMP" && sha256sum -c "${PKG}.sha256" ) >/dev/null \
    || die "sha256 校验失败,已中止(下载损坏或被篡改)" 1
  log "sha256 校验通过"
else
  log "警告: 未找到 ${PKG}.sha256,跳过校验"
fi

tar -xzf "${TMP}/${PKG}" -C "$TMP" || die "解压失败" 1
[ -f "${TMP}/webssh" ] || die "压缩包内缺少 webssh 二进制" 1

# --- 安装(mv 到同目录再 rename,避免 Text file busy) ---
mkdir -p "$BIN_DIR"
if ! mv -f "${TMP}/webssh" "${BIN_DIR}/webssh" 2>/dev/null; then
  cp -f "${TMP}/webssh" "${BIN_DIR}/webssh.new"
  mv -f "${BIN_DIR}/webssh.new" "${BIN_DIR}/webssh"
fi
chmod +x "${BIN_DIR}/webssh"
log "二进制就位: ${BIN_DIR}/webssh"

# --- systemd ---
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Web SSH gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${BIN_DIR}
ExecStart=${BIN_DIR}/webssh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
log "写入单元文件: /etc/systemd/system/${SERVICE_NAME}.service"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"
sleep 1

# --- 健康检查 ---
if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:23456/; then
  log "✅ 部署完成"
  log "   访问: http://<服务器IP>:23456/"
  log "   服务: systemctl status ${SERVICE_NAME}"
else
  die "健康检查失败: 127.0.0.1:23456 无响应(查看 systemctl status ${SERVICE_NAME} / journalctl -u ${SERVICE_NAME})" 3
fi