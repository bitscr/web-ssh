package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 200 + Accept-Encoding: gzip → 响应头带 Content-Encoding,内容可还原
func TestGzip200(t *testing.T) {
	body := strings.Repeat("hello world ", 500)
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		w.Header().Set("Content-Length", "6000") // 模拟 ServeContent 预设长度
		_, _ = io.WriteString(w, body)
	}))

	req := httptest.NewRequest(http.MethodGet, "/assets/app.js?v=1", nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	res := rec.Result()
	if got := res.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if res.Header.Get("Content-Length") != "" {
		t.Fatalf("压缩后不应保留未压缩的 Content-Length: %q", res.Header.Get("Content-Length"))
	}
	if got := res.Header.Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Fatalf("Vary = %q, 应包含 Accept-Encoding", got)
	}

	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("响应体不是合法 gzip: %v", err)
	}
	got, _ := io.ReadAll(zr)
	if string(got) != body {
		t.Fatalf("解压内容不一致: len=%d, want %d", len(got), len(body))
	}
	if len(rec.Body.Bytes()) >= len(body) {
		t.Fatalf("压缩后(%d)不应比原文(%d)大", rec.Body.Len(), len(body))
	}
}

// 非 200(以 304 为例)→ 摘掉 gzip 声明,原样透传,不能把 0 字节谎称 gzip
func TestGzipNon200Passthrough(t *testing.T) {
	for _, code := range []int{http.StatusNotModified, http.StatusNotFound} {
		h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		req := httptest.NewRequest(http.MethodGet, "/assets/app.js?v=1", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		res := rec.Result()
		if res.StatusCode != code {
			t.Fatalf("状态码 = %d, want %d", res.StatusCode, code)
		}
		if got := res.Header.Get("Content-Encoding"); got != "" {
			t.Fatalf("HTTP %d 不应带 Content-Encoding: %q", code, got)
		}
	}
}

func TestGzipSkips(t *testing.T) {
	cases := []struct {
		name, path, accept, method string
	}{
		{"图片不压", "/assets/img/bg.jpg?v=1", "gzip", http.MethodGet},
		{"无 Accept-Encoding 不压", "/assets/app.js?v=1", "", http.MethodGet},
		{"HEAD 不压", "/assets/app.js?v=1", "gzip", http.MethodHead},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, "x")
			}))
			req := httptest.NewRequest(c.method, c.path, nil)
			req.Header.Set("Accept-Encoding", c.accept)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if got := rec.Result().Header.Get("Content-Encoding"); got != "" {
				t.Fatalf("不应压缩,Content-Encoding = %q", got)
			}
		})
	}
}

func TestVersionedCache(t *testing.T) {
	h := versionedCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "x")
	}))

	req := httptest.NewRequest(http.MethodGet, "/assets/app.js?v=16", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Result().Header.Get("Cache-Control"); !strings.Contains(got, "max-age=604800") {
		t.Fatalf("带 v 参数应 7 天缓存, got %q", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Result().Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("不带 v 参数应 no-store, got %q", got)
	}
}
