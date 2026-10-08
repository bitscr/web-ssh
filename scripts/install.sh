#!/usr/bin/env bash
# web-ssh install — curl 拉取二进制 + systemd 一键部署
#
# 用法(一行命令):
#   curl -fsSL https://github.com/bitscr/web-ssh/releases/latest/download/install.sh | sudo bash
#
# 行为:
#   1. 从 GitHub Release 最新版下载对应架构 tar.gz(内含 webssh 二进制)
#   2. 解压安装到 /opt/web-ssh/
#   3. 注册 systemd 服务 web-ssh.service(监听 0.0.0.0:23456)
#   4. enable --now + 健康检查
set -euo pipefail

BIN_DIR=/opt/web-ssh
SERVICE_NAME=web-ssh
REPO=bitscr/web-ssh

# --- 架构检测 ---
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "不支持的架构: $arch(仅 amd64/arm64)" >&2; exit 1 ;;
esac

echo "[web-ssh] 架构=$arch 拉取最新 Release..."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- 解析 tag:latest 时取重定向后路径 ---
tag=$(curl -fsS --max-time 15 -o /dev/null -w '%{url_effective}' \
  "https://github.com/${REPO}/releases/latest" | grep -oE '[^/]+$')
echo "[web-ssh] 版本=$tag"

# --- 下载 + 解压 ---
url="https://github.com/${REPO}/releases/download/${tag}/webssh-linux-${arch}.tar.gz"
curl -fsSL --max-time 120 -o "${tmp}/webssh.tar.gz" "$url"
tar -xf "${tmp}/webssh.tar.gz" -C "${tmp}"

# --- 安装 ---
mkdir -p "$BIN_DIR"
mv "${tmp}/webssh" "${BIN_DIR}/webssh"
chmod +x "${BIN_DIR}/webssh"
echo "[web-ssh] 二进制就位: ${BIN_DIR}/webssh"

# --- systemd 服务 ---
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

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
sleep 1

# --- 健康检查 ---
if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:23456/; then
  echo "[web-ssh] ✅ 部署完成: http://$(hostname -I | awk '{print $1}'):23456"
else
  echo "[web-ssh] ❌ 部署失败: 健康检查 127.0.0.1:23456 无响应" >&2
  exit 3
fi