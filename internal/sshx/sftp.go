// Package sshx 的 SFTP 侧:复用 ConnSpec 认证(密码/私钥/口令),
// 提供远程文件系统操作。连接独立于终端会话,可同时打开多个。
package sshx

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"sort"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// FileInfo 传输给前端的最小文件元数据。
type FileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"` // 相对当前浏览目录的全路径
	Size    int64  `json:"size"`
	Mode    string `json:"mode"` // 权限串,如 drwxr-xr-x
	IsDir   bool   `json:"isDir"`
	ModTime int64  `json:"modTime"` // unix 秒
}

// SFTPSession 一条 SFTP 连接。持有底层 ssh.Client 以便按需创建 sftp.Client。
// 注意:一个 ssh.Client 只能 NewClient 出一个 sftp.Client,真正调用多路复用;
// 这里按惯例直接长期持有单一 sftp.Client。
type SFTPSession struct {
	Token     string
	Spec      ConnSpec
	sshClient *ssh.Client
	client    *sftp.Client
	cwd       string
	created   time.Time
}

// Close 幂等关闭。
func (s *SFTPSession) Close() error {
	var errs []error
	if s.client != nil {
		if err := s.client.Close(); err != nil {
			errs = append(errs, err)
		}
		s.client = nil
	}
	if s.sshClient != nil {
		if err := s.sshClient.Close(); err != nil {
			errs = append(errs, err)
		}
		s.sshClient = nil
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

// dialSSHClient 复用 ConnSpec 的认证配置拨号(与 Dial 同一套密钥逻辑)。
// 抽出来免得两处维护;主键认证、TOFU 指纹校验都在这里。
func dialSSHClient(spec ConnSpec) (*ssh.Client, error) {
	var auths []ssh.AuthMethod
	switch spec.AuthType {
	case "", "password":
		auths = append(auths, ssh.Password(spec.Password))
		auths = append(auths, ssh.KeyboardInteractive(
			func(user, instruction string, questions []string, echos []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range answers {
					answers[i] = spec.Password
				}
				return answers, nil
			}))
	case "key":
		var signer ssh.Signer
		var err error
		if spec.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(spec.PrivateKey), []byte(spec.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(spec.PrivateKey))
		}
		if err != nil {
			return nil, fmt.Errorf("私钥解析失败: %v", err)
		}
		auths = append(auths, ssh.PublicKeys(signer))
	default:
		return nil, errors.New("未知认证方式")
	}

	cfg := &ssh.ClientConfig{
		User:    spec.User,
		Auth:    auths,
		Timeout: 6 * time.Second,
		HostKeyCallback: func(host string, remote net.Addr, key ssh.PublicKey) error {
			fp := ssh.FingerprintSHA256(key)
			if spec.Fingerprint != "" {
				if fp != spec.Fingerprint {
					return fmt.Errorf("主机密钥不匹配:服务器 %s ≠ 已保存 %s(可能被中间人攻击,或服务器重装系统)", fp, spec.Fingerprint)
				}
				return nil
			}
			return nil // TOFU:首连捕获,由上层记录
		},
	}
	return ssh.Dial("tcp", spec.addr(), cfg)
}

// NewSFTP 建立 SFTP 会话:先 SSH 拨号,再开 sftp 通道。
func NewSFTP(spec ConnSpec) (*SFTPSession, error) {
	sc, err := dialSSHClient(spec)
	if err != nil {
		return nil, err
	}
	fc, err := sftp.NewClient(sc)
	if err != nil {
		sc.Close()
		return nil, fmt.Errorf("SFTP 初始化失败: %v", err)
	}
	if cwd, err := fc.Getwd(); err == nil {
		return &SFTPSession{
			Token:     NewToken(),
			Spec:      spec,
			sshClient: sc,
			client:    fc,
			cwd:       cwd,
			created:   time.Now(),
		}, nil
	}
	return nil, fmt.Errorf("读取初始目录失败: %v", err)
}

// resolve 解析可能为相对路径的请求为绝对路径(防路径穿越)。
func (s *SFTPSession) resolve(p string) string {
	if p == "" {
		return s.cwd
	}
	if p[0] != '/' {
		p = path.Join(s.cwd, p)
	}
	return path.Clean("/" + p)
}

// List 列出目录内容:目录在前,按名称排序。
func (s *SFTPSession) List(p string) ([]FileInfo, string, error) {
	abs := s.resolve(p)
	entries, err := s.client.ReadDir(abs)
	if err != nil {
		return nil, abs, err
	}
	out := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		info := FileInfo{
			Name:    e.Name(),
			Path:    path.Join(abs, e.Name()),
			Size:    e.Size(),
			Mode:    e.Mode().String(),
			IsDir:   e.IsDir(),
			ModTime: e.ModTime().Unix(),
		}
		out = append(out, info)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})
	return out, abs, nil
}

// Stat 获取单文件信息(供下载/详情)。
func (s *SFTPSession) Stat(p string) (FileInfo, error) {
	abs := s.resolve(p)
	fi, err := s.client.Stat(abs)
	if err != nil {
		return FileInfo{}, err
	}
	return FileInfo{
		Name:    fi.Name(),
		Path:    abs,
		Size:    fi.Size(),
		Mode:    fi.Mode().String(),
		IsDir:   fi.IsDir(),
		ModTime: fi.ModTime().Unix(),
	}, nil
}

// Open 打开远程文件用于读取(流式下载)。
func (s *SFTPSession) Open(p string) (*sftp.File, error) {
	return s.client.Open(s.resolve(p))
}

// Mkdir 创建目录(含父级,类似 mkdir -p)。
func (s *SFTPSession) Mkdir(p string) error {
	abs := s.resolve(p)
	return s.client.MkdirAll(abs)
}

// Remove 删除文件或空目录;目录非空返回错误。
func (s *SFTPSession) Remove(p string) error {
	abs := s.resolve(p)
	return s.client.Remove(abs)
}

// Rename 重命名/移动。
func (s *SFTPSession) Rename(oldp, newp string) error {
	if newp == "" || newp[0] != '/' {
		return errors.New("目标路径必须为绝对路径")
	}
	return s.client.Rename(s.resolve(oldp), path.Clean("/"+newp))
}

// ReadFile 整个读入(小文件场景,UI 预览用)。
func (s *SFTPSession) ReadFile(p string) ([]byte, error) {
	f, err := s.client.Open(s.resolve(p))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// WriteFile 整体写入(小文件场景)。权限默认 0644。
func (s *SFTPSession) WriteFile(p string, data []byte, perm os.FileMode) error {
	abs := s.resolve(p)
	if perm == 0 {
		perm = 0o644
	}
	f, err := s.client.Create(abs)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return err
	}
	return f.Chmod(perm)
}

// StreamUpload 流式写入远程文件(大文件上传)。返回已写字节数。
func (s *SFTPSession) StreamUpload(p string, r io.Reader) (int64, error) {
	abs := s.resolve(p)
	f, err := s.client.Create(abs)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	n, err := io.Copy(f, r)
	if err != nil {
		return n, err
	}
	return n, f.Chmod(0o644)
}
