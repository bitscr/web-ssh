package server

import (
	"log"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"github.com/bitscr/web-ssh/internal/sshx"
)

// 心跳与超时策略:
//   - 服务端每 heartbeatInterval 发一次 Ping 探测对端存活。
//   - 读超时为 readTimeout,任何帧(数据/Pong/心跳文本)到达都会刷新它。
//   - 为什么以前"用着用着就断":
//     1) 旧代码只有 PongHandler 刷新读截止时间——浏览器在后台标签页/节能模式下
//     会延迟甚至暂停回 Pong,部分反向代理(Nginx/Caddy)还会吞掉 WS 控制帧,
//     50s 内只要没有 Pong 就会被判定死亡;
//     2) 用户正在打字也不会续期(数据帧不刷新 deadline),所以"明明在操作"照样断;
//     3) 空闲回收只看"输入",盯着终端输出不动 10 分钟(默认 idle)也会被回收。
//   - 对策:输入泵每收到任意帧都续期;加上前端应用层心跳(文本帧 "p",
//     反代通常只转发数据帧,该帧可靠性远高于控制帧);输出也算活跃。
const (
	heartbeatInterval = 15 * time.Second
	readTimeout       = 90 * time.Second
)

// Pump 驱动一条会话的 WebSocket 双向泵:
//   - 输入泵:浏览器 → SSH。文本帧 "r:rows:cols" 调 WindowChange,其余原样写 stdin。
//   - 输出泵:SSH stdout+stderr → 浏览器(单 writer 互斥);有输出即记为活跃,
//     防止"只看不动"被空闲超时回收。
//   - 心跳:服务端每 15s 发 WebSocket Ping,浏览器自动回 Pong;任何入站帧
//     (含前端 "p" 心跳)都会刷新读截止时间,对端真死(断网/NAT 失效)
//     约 105s 内被回收。
//   - 任一方向结束(远程 shell 退出 / 浏览器断开)即整体清理并回收会话。
func Pump(ws *websocket.Conn, s *sshx.Session, reg *Registry) {
	defer func() {
		if err := recover(); err != nil {
			log.Printf("[term] panic recovered: %v", err)
		}
	}()

	ws.SetReadLimit(1 << 20)
	_ = ws.SetReadDeadline(time.Now().Add(readTimeout))
	ws.SetPongHandler(func(string) error {
		_ = ws.SetReadDeadline(time.Now().Add(readTimeout))
		return nil
	})

	var wmu sync.Mutex
	write := func(mt int, p []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		return ws.WriteMessage(mt, p)
	}

	// ---- 输出泵:stdout + stderr 合并写入 WS ----
	var wg sync.WaitGroup
	copyDone := make(chan struct{})
	copyFn := func(r interface{ Read([]byte) (int, error) }) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				s.Touch() // 有输出也算活跃,避免看日志/发呆被 idle 回收
				if werr := write(websocket.TextMessage, sanitizeUTF8(buf[:n])); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyFn(s.Stdout)
	if r, ok := s.Stderr(); ok {
		go copyFn(r)
	} else {
		wg.Done()
	}
	go func() { wg.Wait(); close(copyDone) }()

	// ---- 输入泵:WS → stdin ----
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		for {
			mt, p, err := ws.ReadMessage()
			if err != nil {
				return
			}
			// 任意入站帧(打字、前端心跳、Pong)都续期,人活着连接就活着
			_ = ws.SetReadDeadline(time.Now().Add(readTimeout))
			if mt == websocket.TextMessage {
				msg := string(p)
				if msg == "p" || msg == "ping" {
					continue // 应用层心跳,忽略
				}
				if strings.HasPrefix(msg, "r:") {
					parts := strings.SplitN(msg, ":", 3)
					if len(parts) == 3 {
						rows, _ := strconv.Atoi(parts[1])
						cols, _ := strconv.Atoi(parts[2])
						_ = s.WindowChange(rows, cols)
					}
					continue
				}
			}
			if _, err := s.Stdin.Write(p); err != nil {
				return
			}
			s.Touch()
		}
	}()

	// ---- 心跳 + 主循环 ----
	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()

	for {
		select {
		case <-copyDone:
			// 远程 shell 已退出(exit/断开)
			reg.Remove(s.Token)
			_ = ws.Close()
			return
		case <-inputDone:
			// 浏览器断开
			reg.Remove(s.Token)
			_ = ws.Close()
			return
		case <-heartbeat.C:
			if err := write(websocket.PingMessage, nil); err != nil {
				reg.Remove(s.Token)
				_ = ws.Close()
				return
			}
		}
	}
}

// sanitizeUTF8 将非法 UTF-8 字节替换为 '@'(终端常有非 UTF8 输出)。
func sanitizeUTF8(p []byte) []byte {
	if utf8.Valid(p) {
		return p
	}
	out := make([]rune, 0, len(p))
	for _, r := range string(p) {
		if r == utf8.RuneError {
			out = append(out, '@')
		} else {
			out = append(out, r)
		}
	}
	return []byte(string(out))
}
