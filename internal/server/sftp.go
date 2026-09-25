package server

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"

	"github.com/bitscr/web-ssh/internal/sshx"
)

// FileRegistry 管理 SFTP 文件浏览器会话。每个连接一个,按 token 索引。
type FileRegistry struct {
	mu sync.RWMutex
	m  map[string]*sshx.SFTPSession
}

func NewFileRegistry() *FileRegistry {
	return &FileRegistry{m: make(map[string]*sshx.SFTPSession)}
}

func (fr *FileRegistry) Create(spec sshx.ConnSpec) (*sshx.SFTPSession, string, error) {
	s, err := sshx.NewSFTP(spec)
	if err != nil {
		return nil, "", err
	}
	fr.mu.Lock()
	fr.m[s.Token] = s
	fr.mu.Unlock()
	return s, s.Token, nil
}

func (fr *FileRegistry) Get(token string) (*sshx.SFTPSession, bool) {
	fr.mu.RLock()
	s, ok := fr.m[token]
	fr.mu.RUnlock()
	return s, ok
}

func (fr *FileRegistry) Remove(token string) {
	fr.mu.Lock()
	s, ok := fr.m[token]
	if ok {
		delete(fr.m, token)
	}
	fr.mu.Unlock()
	if ok {
		s.Close()
	}
}

func (fr *FileRegistry) Shutdown() {
	fr.mu.Lock()
	defer fr.mu.Unlock()
	for t, s := range fr.m {
		delete(fr.m, t)
		s.Close()
	}
}

// FileAPI 挂到 mux 上的 handler 集合。
type FileAPI struct {
	reg *FileRegistry
}

func NewFileAPI(reg *FileRegistry) *FileAPI { return &FileAPI{reg: reg} }

func (api *FileAPI) Routes(mux *http.ServeMux) {
	// 建立 SFTP 连接(上传/下载文件用)
	mux.HandleFunc("POST /api/sftp/connect", api.Connect)
	// 列出目录
	mux.HandleFunc("GET /api/sftp/list", api.List)
	// 下载文件
	mux.HandleFunc("GET /api/sftp/download", api.Download)
	// 上传文件(单文件,multipart)
	mux.HandleFunc("POST /api/sftp/upload", api.Upload)
	// 删除 / 重命名 / 建目录
	mux.HandleFunc("POST /api/sftp/delete", api.Delete)
	mux.HandleFunc("POST /api/sftp/rename", api.Rename)
	mux.HandleFunc("POST /api/sftp/mkdir", api.Mkdir)
	mux.HandleFunc("GET /api/sftp/stat", api.Stat)
}

// withSftp 从 query/form 取 token 并解析会话。
func (api *FileAPI) withSftp(r *http.Request) (*sshx.SFTPSession, error) {
	token := r.URL.Query().Get("token")
	if token == "" {
		token = r.FormValue("token")
	}
	if token == "" {
		return nil, errors.New("missing token")
	}
	s, ok := api.reg.Get(token)
	if !ok {
		return nil, errors.New("SFTP 会话不存在或已过期")
	}
	return s, nil
}

// ---- 建立连接 ----

func (api *FileAPI) Connect(w http.ResponseWriter, r *http.Request) {
	var spec sshx.ConnSpec
	// 前端把上次的 spec + 凭据 POST 过来;密码/私钥仍在请求体
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&spec); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体无效: " + err.Error()})
		return
	}
	if spec.Host == "" || spec.User == "" || (spec.Password == "" && spec.PrivateKey == "") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "host/user/凭据不能为空"})
		return
	}
	s, token, err := api.reg.Create(spec)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "SFTP 连接失败: " + err.Error()})
		return
	}
	log.Printf("[sftp] connected %s host=%s user=%s", token[:8], spec.Host, spec.User)
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"cwd":   s.Spec.Host, // 占位,真实 cwd 从 list 拿
		"host":  spec.Host,
		"user":  spec.User,
	})
}

// ---- 目录 ----

func (api *FileAPI) List(w http.ResponseWriter, r *http.Request) {
	s, err := api.withSftp(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	dir := r.URL.Query().Get("path")
	entries, abs, err := s.List(dir)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "列目录失败: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": abs, "entries": entries})
}

func (api *FileAPI) Stat(w http.ResponseWriter, r *http.Request) {
	s, err := api.withSftp(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	info, err := s.Stat(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, info)
}

// ---- 下载 ----

func (api *FileAPI) Download(w http.ResponseWriter, r *http.Request) {
	s, err := api.withSftp(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	remote := r.URL.Query().Get("path")
	info, err := s.Stat(remote)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	if info.IsDir {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "不能下载目录"})
		return
	}
	f, err := s.Open(remote)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	defer f.Close()
	w.Header().Set("Content-Disposition", `attachment; filename="`+safeFilename(info.Name)+`"`)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// 不设 Content-Length:让 Go 自动用 chunked 传输。
	// 硬编码长度 + 流式拷贝若中途出错,实际字节数对不上,
	// Go 会 RST 连接,反代(Cloudflare/nginx)看到的就是 520/502。
	n, copyErr := io.Copy(w, f)
	if copyErr != nil {
		log.Printf("[sftp] download error host=%s path=%s wrote=%d err=%v", s.Spec.Host, remote, n, copyErr)
		return
	}
	log.Printf("[sftp] download ok host=%s path=%s bytes=%d", s.Spec.Host, remote, n)
}

// ---- 上传 ----

func (api *FileAPI) Upload(w http.ResponseWriter, r *http.Request) {
	s, err := api.withSftp(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	err = r.ParseMultipartForm(32 << 20) // 32MB
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "解析上传失败: " + err.Error()})
		return
	}
	dir := r.FormValue("dir")
	if dir == "" {
		dir = r.FormValue("path")
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少文件: " + err.Error()})
		return
	}
	defer file.Close()

	// 聚合成远程路径
	target := strings.TrimSuffix(dir, "/") + "/" + safeFilename(header.Filename)
	if _, err := s.StreamUpload(target, file); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "上传失败: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// ---- 删除 / 重命名 / 建目录 ----

func (api *FileAPI) Delete(w http.ResponseWriter, r *http.Request) {
	s, err := api.withSftp(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体无效: " + err.Error()})
		return
	}
	if err := s.Remove(req.Path); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "删除失败: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

func (api *FileAPI) Rename(w http.ResponseWriter, r *http.Request) {
	s, err := api.withSftp(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var req struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体无效: " + err.Error()})
		return
	}
	if req.Old == "" || req.New == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "old/new 不能为空"})
		return
	}
	if err := s.Rename(req.Old, req.New); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "重命名失败: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

func (api *FileAPI) Mkdir(w http.ResponseWriter, r *http.Request) {
	s, err := api.withSftp(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体无效: " + err.Error()})
		return
	}
	if err := s.Mkdir(req.Path); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "建目录失败: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// safeFilename 去掉路径分隔符,防止文件名注入。
func safeFilename(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "." || name == "" {
		return "download"
	}
	return name
}
