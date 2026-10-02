// 静态资源中间件:gzip 压缩 + 按版本号缓存。
//
// 缓存策略跟着 index.html 里的 ?v=N 缓存击穿开关走:
//   - URL 带 ?v= 参数 → 内容视为不可变,长缓存;改内容必须 bump v,
//     规则见 deploy/web-ssh 部署手册。取 7 天而不是 1 年,是给自己
//     留后路:万一忘 bump 版本号,一周后浏览器也会自愈。
//   - 不带 ?v= → 维持旧的 no-store 行为,绝不给中间态资源长期缓存。
package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"
)

var gzipPool = sync.Pool{
	New: func() any {
		// 静态内容是 embed 的固定文本,Default 比 BestSpeed 再省 ~20% 传输,
		// 单用户场景 CPU 无感
		zw, _ := gzip.NewWriterLevel(io.Discard, gzip.DefaultCompression)
		return zw
	},
}

// gzipable 按请求路径的扩展名决定是否压缩。
// 只压文本类;jpg 之类已自带压缩,压了白耗 CPU。
func gzipable(path string) bool {
	switch {
	case strings.HasSuffix(path, ".js"),
		strings.HasSuffix(path, ".css"),
		strings.HasSuffix(path, ".html"),
		strings.HasSuffix(path, ".svg"),
		strings.HasSuffix(path, ".json"):
		return true
	}
	return false
}

type gzipWriter struct {
	http.ResponseWriter
	zw          *gzip.Writer
	wroteHeader bool
	skipBody    bool // 状态码非 200:不压缩,原样透传
}

func (g *gzipWriter) WriteHeader(code int) {
	g.wroteHeader = true
	if code != http.StatusOK {
		// 304/404/500 等原样发:去掉 gzip 声明,不占压缩通道
		g.skipBody = true
		g.Header().Del("Content-Encoding")
	} else {
		// ServeContent 已按未压缩尺寸设了 Content-Length,压缩后无意义,
		// 删掉让 Go 自动转 chunked
		g.Header().Del("Content-Length")
	}
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipWriter) Write(p []byte) (int, error) {
	if g.skipBody {
		return g.ResponseWriter.Write(p)
	}
	if !g.wroteHeader {
		// handler 隐式 200(直接 Write)也要走一遍头部清理
		g.WriteHeader(http.StatusOK)
	}
	return g.zw.Write(p)
}

// Flush 透传给底层:流式响应不憋包。
func (g *gzipWriter) Flush() {
	if g.skipBody {
		if f, ok := g.ResponseWriter.(http.Flusher); ok {
			f.Flush()
		}
		return
	}
	_ = g.zw.Flush()
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// gzipHandler 对可压缩的静态资源按 Accept-Encoding 压缩响应。
func gzipHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 只压 GET:HEAD 没有正文,压了只会让头里的 Content-Encoding 骗人
		if r.Method != http.MethodGet || !gzipable(r.URL.Path) ||
			!strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Accept-Encoding")
		// 必须在 next 之前设:FileServer 的 ServeContent 会在写正文前
		// 先调 WriteHeader(200),等 Write 时再设就晚了(实测丢头)。
		// 非 200 分支会在 WriteHeader 里把它删掉。
		w.Header().Set("Content-Encoding", "gzip")
		zw := gzipPool.Get().(*gzip.Writer)
		zw.Reset(w)
		gw := &gzipWriter{ResponseWriter: w, zw: zw}
		defer func() {
			if !gw.skipBody {
				_ = zw.Close() // 写出 gzip 尾部;skip 时从未写过 zw,不 Close
			}
			gzipPool.Put(zw)
		}()
		next.ServeHTTP(gw, r)
	})
}

// versionedCache 带 ?v= 的资源给 7 天缓存,其余保持 no-store。
func versionedCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("v") {
			w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// staticHandler 组装静态资源管道:缓存头 → gzip → 文件服务。
func staticHandler(files http.Handler) http.Handler {
	return versionedCache(gzipHandler(files))
}
