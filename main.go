package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bitscr/web-ssh/internal/server"
)

var (
	version   = "0.1.0"
	buildDate = "dev"
)

func main() {
	var (
		listen   = flag.String("listen", "", "监听地址 host:port(默认 127.0.0.1:23456,环境变量 WEBSSH_LISTEN 优先)")
		idleMin  = flag.Int("idle", 10, "空闲超时(分钟),0 表示不限制")
		maxMin   = flag.Int("max", 180, "会话总寿命(分钟),0 表示不限制")
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

	mux := server.Handler(reg, fmt.Sprintf("%s (%s)", version, buildDate), *noOrigin)
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