package main

import (
	"context"
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

// 写死配置,无 CLI/env:监听 0.0.0.0:23456,空闲 10 分钟回收,会话最长 3 小时
const (
	listenAddr = "0.0.0.0:23456"
	idleMin    = 10
	maxMin     = 180
)

func main() {
	reg := server.NewRegistry(server.Config{
		IdleTimeout: time.Duration(idleMin) * time.Minute,
		MaxLifetime: time.Duration(maxMin) * time.Minute,
	})
	defer reg.Shutdown()
	fileReg := server.NewFileRegistry()
	defer fileReg.Shutdown()

	mux := server.Handler(reg, fileReg, fmt.Sprintf("%s (%s)", version, buildDate), false)
	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("web-ssh %s listening on http://%s (idle=%dm max=%dm)",
		version, listenAddr, idleMin, maxMin)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	log.Println("bye")
}
