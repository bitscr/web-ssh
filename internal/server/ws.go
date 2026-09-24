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

// Pump 驱动一条会话的 WebSocket 双向泵:
//   - 输入泵:浏览器 → SSH。文本帧 "r:rows:cols" 调 WindowChange,其余原样写 stdin。
//   - 输出泵:SSH stdout+stderr → 浏览器(单 writer 互斥)。
//   - 心跳:服务端每 25s 发 WebSocket Ping,浏览器自动回 Pong,
//     读超时用 PongHandler 续期,对端死亡(含 NAT 断开)45s 内必然被回收。
//   - 任一方向结束(远程 shell 退出 / 浏览器断开)即整体清理并回收会话。
func Pump(ws *websocket.Conn, s *sshx.Session, reg *Registry) {
	defer func() {
		if err := recover(); err != nil {
			log.Printf("[term] panic recovered: %v", err)
		}
	}()

	ws.SetReadLimit(1 << 20)
	_ = ws.SetReadDeadline(time.Now().Add(50 * time.Second))
	ws.SetPongHandler(func(string) error {
		_ = ws.SetReadDeadline(time.Now().Add(50 * time.Second))
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
			if mt == websocket.TextMessage {
				msg := string(p)
				if msg == "p" || msg == "ping" {
					continue // 心跳,忽略
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
	heartbeat := time.NewTicker(25 * time.Second)
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