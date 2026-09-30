package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/bitscr/web-ssh/internal/server"
)

var (
	version   = "0.1.0"
	buildDate = "dev"
)

func main() {
	idleDefault := 10
	if v := os.Getenv("WEBSSH_IDLE_MIN"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			idleDefault = n
		}
	}
	maxDefault := 180
	if v := os.Getenv("WEBSSH_MAX_MIN"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			maxDefault = n
		}
	}

	var (
		listen   = flag.String("listen", "", "监听地址 host:port(默认 127.0.0.1:23456,环境变量 WEBSSH_LISTEN 优先)")
		idleMin  = flag.Int("idle", idleDefault, "空闲超时(分钟),0 表示不限制;环境变量 WEBSSH_IDLE_MIN")
		maxMin   = flag.Int("max", maxDefault, "会话总寿命(分钟),0 表示不限制;环境变量 WEBSSH_MAX_MIN")
		noOrigin = flag.Bool("no-origin-check", false, "关闭 WebSocket 同源校验(不推荐,仅反向代理场景需要)")
	)
	flag.Parse()

	addr := *listen
	if addr == "" {
		addr = server.ListenAddr()
	}

	reg := server.NewRegistry(server.Config{
		IdleTimeout: time.Duration(*idleMin) * time.Minute,
		MaxLifetime: time.Duration(*maxMin) * time.Minute,
	})
	defer reg.Shutdown()

	fileReg := server.NewFileRegistry()
	defer fileReg.Shutdown()

	mux := server.Handler(reg, fileReg, fmt.Sprintf("%s (%s)", version, buildDate), *noOrigin)
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("web-ssh %s listening on http://%s (idle=%dm max=%dm)",
			version, addr, *idleMin, *maxMin)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	reg.Shutdown()
	log.Println("bye")
}
