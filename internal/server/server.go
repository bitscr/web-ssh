// Package server 提供 HTTP 路由、会话注册表和 WebSocket 泵。
// 设计取向:无状态 API(连接凭据只存在于内存,会话结束后即失)、
// 同源校验(防 CSWSH)、主机指纹 TOFU、空闲+总寿命双超时。
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/bitscr/web-ssh/assets"
	"github.com/bitscr/web-ssh/internal/sshx"
)

// Config 服务配置。
type Config struct {
	IdleTimeout time.Duration
	MaxLifetime time.Duration
}

// Registry 活跃 SSH 会话注册表。
type Registry struct {
	cfg  Config
	mu   sync.RWMutex
	m    map[string]*sshx.Session
	done chan struct{}
	wg   sync.WaitGroup
}

// NewRegistry 创建注册表并启动巡检协程(空闲/总寿命到期即回收)。
func NewRegistry(cfg Config) *Registry {
	r := &Registry{
		cfg:  cfg,
		m:    make(map[string]*sshx.Session),
		done: make(chan struct{}),
	}
	r.wg.Add(1)
	go r.reaper()
	return r
}

// Create 按 spec 拨号,注册并返回会话。
func (r *Registry) Create(spec sshx.ConnSpec) (*sshx.Session, error) {
	s, err := sshx.Dial(spec, r.cfg.IdleTimeout, r.cfg.MaxLifetime)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.m[s.Token] = s
	r.mu.Unlock()
	return s, nil
}

// Get 按令牌取会话。
func (r *Registry) Get(token string) (*sshx.Session, bool) {
	r.mu.RLock()
	s, ok := r.m[token]
	r.mu.RUnlock()
	return s, ok
}

// Remove 删除会话(幂等)。
func (r *Registry) Remove(token string) {
	r.mu.Lock()
	s, ok := r.m[token]
	if ok {
		delete(r.m, token)
	}
	r.mu.Unlock()
	if ok {
		s.Close()
	}
}

// Shutdown 停止巡检并清理所有会话。
func (r *Registry) Shutdown() {
	close(r.done)
	r.wg.Wait()
	r.mu.Lock()
	for t, s := range r.m {
		delete(r.m, t)
		s.Close()
	}
	r.mu.Unlock()
}

func (r *Registry) reaper() {
	defer r.wg.Done()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.done:
			return
		case <-tick.C:
			var stale []string
			now := time.Now()
			r.mu.RLock()
			for t, s := range r.m {
				if s.IdleTimeout > 0 && s.IdleFor() > s.IdleTimeout {
					stale = append(stale, t)
					continue
				}
				if s.MaxLifetime > 0 && now.Sub(s.AliveStart()) > s.MaxLifetime {
					stale = append(stale, t)
				}
			}
			r.mu.RUnlock()
			for _, t := range stale {
				log.Printf("[reap] closing idle/expired session %s", t[:8])
				r.Remove(t)
			}
		}
	}
}

// HTTP 层 ----------------------------------------------------------------

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 65536,
	CheckOrigin: func(r *http.Request) bool {
		// 严格同源:浏览器必须带 Origin 且与 Host 一致;非浏览器(无 Origin)允许。
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := parseOrigin(origin)
		if err != nil {
			return false
		}
		return u == r.Host
	},
}

// parseOrigin 提取 Origin 的 host[:port],与请求 Host 精确比较。
func parseOrigin(o string) (string, error) {
	if !strings.HasPrefix(o, "http://") && !strings.HasPrefix(o, "https://") {
		return "", errors.New("bad origin scheme")
	}
	rest := o[strings.Index(o, "//")+2:]
	host := rest
	if i := strings.IndexAny(rest, "/?"); i >= 0 {
		host = rest[:i]
	}
	if host == "" {
		return "", errors.New("empty origin host")
	}
	return host, nil
}

// Handler 组装全部路由。
func Handler(reg *Registry, version string, checkOrigin bool) http.Handler {
	if checkOrigin {
		upgrader.CheckOrigin = func(r *http.Request) bool {
			// 严格同源:浏览器必须带 Origin 且与 Host 一致;非浏览器(无 Origin)允许。
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true
			}
			u, err := parseOrigin(origin)
			if err != nil {
				return false
			}
			return u == r.Host
		}
	} else {
		upgrader.CheckOrigin = nil // 反向代理场景:完全信任(不推荐)
	}
	mux := http.NewServeMux()

	// 静态资源(单二进制 embed)
	assetsFS, _ := fs.Sub(assets.FS, ".")
	mux.Handle("GET /assets/", http.StripPrefix("/assets/", http.FileServer(http.FS(assetsFS))))

	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		// 单页首页
		b, err := assets.FS.ReadFile("index.html")
		if err != nil {
			http.Error(w, "index.html missing", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(b)
	})

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"version":%q}`, version)
	})

	// POST /api/session:创建 SSH 会话。凭据只在请求体内,不落 URL、不落盘。
	mux.HandleFunc("POST /api/session", func(w http.ResponseWriter, r *http.Request) {
		var spec sshx.ConnSpec
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&spec); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体无效: " + err.Error()})
			return
		}
		if spec.Host == "" || spec.User == "" || (spec.Password == "" && spec.PrivateKey == "") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "host/user/凭据不能为空"})
			return
		}
		s, err := reg.Create(spec)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "SSH 连接失败: " + err.Error()})
			return
		}
		log.Printf("[session] created %s host=%s user=%s fp=%s", s.Token[:8], s.Spec.Host, s.Spec.User, s.Fingerprint)
		writeJSON(w, http.StatusOK, map[string]any{
			"token":       s.Token,
			"fingerprint": s.Fingerprint,
			"host":        s.Spec.Host,
			"user":        s.Spec.User,
		})
	})

	// GET /ws/term?token=  :WebSocket 终端泵。二进制帧=输入,文本帧=控制。
	mux.HandleFunc("GET /ws/term", func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		if token == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing token"})
			return
		}
		s, ok := reg.Get(token)
		if !ok || s == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "会话不存在或已过期"})
			return
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		log.Printf("[term] attach %s host=%s", token[:8], s.Spec.Host)
		Pump(ws, s, reg)
	})

	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// listenAddr 解析监听地址:优先 WEBSSH_LISTEN(host:port),其次 host/port 组合。
func ListenAddr() string {
	if v := os.Getenv("WEBSSH_LISTEN"); v != "" {
		return v
	}
	host := os.Getenv("WEBSSH_HOST")
	if host == "" {
		host = "127.0.0.1" // 默认仅本机,除非显式设 0.0.0.0
	}
	port := os.Getenv("WEBSSH_PORT")
	if port == "" {
		port = "23456"
	}
	return net.JoinHostPort(host, port)
}

// IntEnv 读取环境整数,非法时回退默认值。
func IntEnv(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}