# web-ssh

自建 Web SSH 网关:浏览器里管理 VPS 连接、SSH 终端、SFTP 文件面板。单二进制(Go),前端内嵌,数据默认只存在你自己的浏览器本地。

- 纯前端保存 VPS 信息:连接配置、密码、私钥都存在 localStorage,导出/导入完全不经过服务端
- WebSocket 隧道承载终端与文件传输
- 二进制固定监听 `0.0.0.0:23456`,无多余选项

## 一键部署

在目标 VPS 上执行一条命令(自动识别 amd64/arm64,拉取最新 Release,部署为 systemd 服务):

```bash
curl -fsSL https://github.com/bitscr/web-ssh/releases/latest/download/install.sh | sudo bash
```

部署完成后访问:

```
http://你的服务器IP:23456/
```

安装路径与系统服务:

- 二进制: `/opt/web-ssh/webssh`
- systemd: `web-ssh.service`

指定版本(默认 latest):

```bash
curl -fsSL https://github.com/bitscr/web-ssh/releases/download/v0.2.0/install.sh | sudo TAG=v0.2.0 bash
```

## 发版(维护者)

二进制由 GitHub Actions 手动构建发布:

1. Actions → `release` → Run workflow
2. 输入 tag(格式 `vX.Y.Z`,如 `v0.2.0`),测试包勾 pre-release
3. Action 自动跑 `go vet` + 后端测试 + 前端 30 项回归,全过才构建
4. 产出 `webssh-linux-amd64.tar.gz` / `webssh-linux-arm64.tar.gz`(内含 `webssh` + `install.sh`)+ sha256,发到该 tag 的 Release

## 开发

```bash
git clone git@github.com:bitscr/web-ssh.git
cd web-ssh
go vet ./...                 # 静态检查
go build -o /tmp/webssh .    # 构建
go test ./internal/...       # 后端测试
node --test tests/*.test.js  # 前端 JS 回归
```

前端改动后浏览器会缓存资源,记得 bump `assets/index.html` 里 `app.css?v=N` / `app.js?v=N` 的版本号。

## 安全说明

- 凭据默认只存浏览器 localStorage,导出/导入是纯前端行为,不经服务端。
- 服务器端不存储任何用户凭据,不提供多用户/登录界面。
- 二进制监听 `0.0.0.0:23456`,SSH 隧道与 WebSocket 均无加密,请务必置于 TLS 反代之后,勿裸暴露公网。