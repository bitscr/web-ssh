# web-ssh

自建 Web SSH 网关:浏览器里管理 VPS 连接、SSH 终端、SFTP 文件面板。单二进制(Go)，前端内嵌，数据默认只存在你自己的浏览器本地。

- 纯前端保存 VPS 信息:连接配置、密码、私钥都存在 localStorage,导出/导入完全不经过服务端
- WebSocket 隧道承载终端与文件传输
- 默认只监听 `127.0.0.1`,对外暴露时请自行加 TLS(推荐反代)

## 安装(从 Release 下载)

不需要本机装 Go 工具链。从 GitHub Release 页下载对应版本包:

```bash
# 1. 下载安装脚本(以 v0.1.0 为例,去 Release 页拿最新 tag)
curl -fsSL -o setup.sh \
  https://github.com/bitscr/web-ssh/releases/download/v0.1.0/setup.sh
chmod +x setup.sh

# 2. 一键安装(自动识别 amd64/arm64,从最新 Release 下载二进制并校验 sha256)
sudo ./setup.sh install
```

默认效果:二进制 → `/opt/web-ssh/webssh` → 注册 systemd 服务 → 启动并健康检查,服务监听 `http://127.0.0.1:23456/`。

指定版本 / 架构包名:

```bash
sudo ./setup.sh install --version v0.1.0   # 装指定版本(默认 latest)
# 二进制包名:webssh-linux-amd64 / webssh-linux-arm64(+.sha256 校验文件)
```

升级与卸载:

```bash
sudo ./setup.sh update --version v0.2.0   # 下载新版、备份旧二进制、无缝覆盖
sudo ./setup.sh remove                    # 停服务删单元文件(浏览器里的连接数据不受影响)
sudo ./setup.sh status                    # 看状态 + 健康检查
```

## setup.sh 用法

```text
./setup.sh [install|update|remove|status] [选项]

选项
  --port N                监听端口(默认 23456)
  --host HOST             监听地址(默认 127.0.0.1;对外暴露用 0.0.0.0 并自行加 TLS)
  --version vX.Y.Z        指定版本(默认 latest=最新 Release)
  --local                 在仓库内本地构建(需 Go 1.26;开发者用,免下载)
  --download-url URL      直接指定二进制地址(覆盖 Release 逻辑,无校验文件时跳过 sha256)
  --no-origin-check       关闭 WebSocket 同源校验(仅反向代理场景需要)
  -h, --help              帮助
```

## 发版流程(维护者)

二进制由 GitHub Actions 手动构建发布,不需要本地打包:

1. 打开仓库 Actions → `release` → Run workflow
2. 输入 tag(格式 `vX.Y.Z`,如 `v0.2.0`),测试包勾上 pre-release
3. Action 自动跑 `go vet` + 后端测试 + 前端 30 项回归,全过才构建
4. 构建 `linux/amd64` + `linux/arm64` 两个二进制(注入版本号,附 sha256),连同 `setup.sh` 一起发到该 tag 的 Release

## systemd 之外

不需要 systemd 时可直接运行二进制:

```bash
./webssh-linux-amd64 --listen 127.0.0.1:23456
```

环境变量/CLI 参数(优先级:CLI > 环境变量 > 默认):

| 配置 | 环境变量 | CLI | 默认 |
|---|---|---|---|
| 监听地址 | `WEBSSH_LISTEN` | `--listen host:port` | `127.0.0.1:23456` |
| 空闲超时(分钟) | `WEBSSH_IDLE_MIN` | `--idle N` | `10`(0=不限制) |
| 会话总寿命(分钟) | `WEBSSH_MAX_MIN` | `--max N` | `180`(0=不限制) |
| 关闭同源校验 | — | `--no-origin-check` | 关闭(不开) |

## 开发

```bash
git clone git@github.com:bitscr/web-ssh.git
cd web-ssh
go vet ./...                 # 静态检查
go build -o /tmp/webssh .    # 构建
go test ./internal/...       # 后端测试
node --test tests/*.test.js  # 前端 JS 回归
sudo ./setup.sh install --local   # 本地构建并装成服务(免下载)
```

前端改动后浏览器会缓存资源,记得 bump `assets/index.html` 里 `app.css?v=N` / `app.js?v=N` 的版本号。

## 安全说明

- 凭据默认只存浏览器 localStorage,导出/导入是纯前端行为,不经服务端。
- 服务器端不存储任何用户凭据,不提供多用户/登录界面;请勿直接暴露到公网,务必置于 TLS 反代之后。
- 对公网监听时,SSH 隧道与 WebSocket 均无加密,须 TLS 终结于反代层。