# web-ssh

自建 Web SSH 网关:浏览器里管理 VPS 连接、SSH 终端、SFTP 文件面板。单二进制(V 语言)，前端内嵌，数据默认只存在你自己的浏览器本地。

- 纯前端保存 VPS 信息:连接配置、密码、私钥都存在 localStorage,导出/导入完全不经过服务端
- WebSocket 隧道承载终端与文件传输
- 默认只监听 `127.0.0.1`,对外暴露时请自行加 TLS(推荐反代)

## 快速部署

```bash
git clone git@github.com:bitscr/web-ssh.git
cd web-ssh
chmod +x setup.sh
sudo ./setup.sh install
```

默认效果:构建二进制 → 安装到 `/opt/web-ssh/webssh` → 注册 systemd 服务 → 启动并健康检查,服务监听 `http://127.0.0.1:23456/`。

## setup.sh 用法

```text
./setup.sh [install|update|remove|status] [选项]

动作(默认 install)
  install   构建并安装为 systemd 服务,enable --now + 健康检查
  update    重新构建、备份旧二进制、覆盖安装(mv -f 避免 Text file busy)
  remove    停止并禁用服务、删除单元文件(你的连接数据在浏览器 localStorage,不受影响)
  status    查看服务状态 + 健康检查

选项
  --port N                监听端口(默认 23456)
  --host HOST             监听地址(默认 127.0.0.1;对外暴露用 0.0.0.0 并自行加 TLS)
  --no-origin-check       关闭 WebSocket 同源校验(仅反向代理场景需要)
  -h, --help              帮助
```

已有服务时升级:

```bash
sudo ./setup.sh update --port 23456
```

卸载:

```bash
sudo ./setup.sh remove
```

### 依赖

- 需要 V 工具链(`go`,v1.26+)。`go vet` 与 `go build` 均需可用;依赖首次构建会联网拉取,缓存后离线可构建。
- 系统需 `systemd` 与 `curl`(健康检查用)。

### systemd 之外

不需要 systemd 时可直接运行二进制:

```bash
./webssh --listen 127.0.0.1:23456
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
go vet ./...                 # 静态检查
go build -o /tmp/webssh .    # 构建
go test ./internal/...       # 后端测试
node --test tests/*.test.js  # 前端 JS 回归
```

前端改动后浏览器会缓存资源,记得 bump `assets/index.html` 里 `app.css?v=N` / `app.js?v=N` 的版本号。

## 安全说明

- 凭据默认只存浏览器 localStorage,导出/导入是纯前端行为,不经服务端。
- 服务器端不存储任何用户凭据,不提供多用户/登录界面;请勿直接暴露到公网,务必置于 TLS 反代之后。
- 对公网监听时,SSH 隧道与 WebSocket 均无加密,须 TLS 终结于反代层。