// Package sshx 负责 SSH 侧:拨号、主机密钥校验(TOFU)、PTY 会话管理。
// WebSocket 泵在 server 层驱动,这里只暴露纯 SSH 流,职责单一。
package sshx

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// ConnSpec 连接参数。前端 POST /api/session 提交,凭据只走请求体,绝不进 URL。
type ConnSpec struct {
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	AuthType    string `json:"authType"` // password | key
	Password    string `json:"password,omitempty"`
	PrivateKey  string `json:"privateKey,omitempty"`
	Passphrase  string `json:"passphrase,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"` // sha256 主机指纹;空则 TOFU 首连捕获
}

func (c *ConnSpec) addr() string {
	port := c.Port
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(c.Host, strconv.Itoa(port))
}

// Session 一条活跃的 SSH 会话。只关心 SSH 侧;WS 泵由 server 层驱动。
type Session struct {
	Token       string
	Spec        ConnSpec
	Client      *ssh.Client
	SSHSess     *ssh.Session
	Stdin       io.WriteCloser
	Stdout      io.Reader
	StderrPipe  io.Reader
	Fingerprint string

	IdleTimeout time.Duration
	MaxLifetime time.Duration

	mu      sync.Mutex
	lastSeen time.Time
	started time.Time
	closed  bool
}

func (s *Session) Touch() {
	s.mu.Lock()
	s.lastSeen = time.Now()
	s.mu.Unlock()
}

func (s *Session) IdleFor() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastSeen.IsZero() {
		return 0
	}
	return time.Since(s.lastSeen)
}

func (s *Session) AliveFor() time.Duration {
	return time.Since(s.started)
}

// AliveStart 返回会话创建时间。
func (s *Session) AliveStart() time.Time {
	return s.started
}

// Stderr 返回 stderr 读取器(可能为 nil)。
func (s *Session) Stderr() (io.Reader, bool) {
	if s.StderrPipe == nil {
		return nil, false
	}
	return s.StderrPipe, true
}

// Close 幂等关闭全部资源。
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()

	if s.Stdin != nil {
		s.Stdin.Close()
	}
	if s.SSHSess != nil {
		s.SSHSess.Close()
	}
	if s.Client != nil {
		s.Client.Close()
	}
}

// WindowChange 同步 PTY 尺寸。
func (s *Session) WindowChange(rows, cols int) error {
	if rows < 1 {
		rows = 1
	}
	if cols < 1 {
		cols = 1
	}
	if s.SSHSess == nil {
		return errors.New("session not initialized")
	}
	return s.SSHSess.WindowChange(rows, cols)
}

// NewToken 生成会话令牌(安全随机)。
func NewToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Dial 建立 SSH 连接并拉起交互 shell。
//   - 主机密钥:spec.Fingerprint 非空则严格比对,不符即拒绝(防中间人);
//     为空则 TOFU——首连捕获并返回指纹,由前端随连接保存,后续复用。
//   - 认证:password 同时自动应答 keyboard-interactive;key 支持带口令的私钥。
//   - 超时 6 秒快速失败,UI 无需等待。
func Dial(spec ConnSpec, idle, lifetime time.Duration) (*Session, error) {
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

	var captured ssh.PublicKey
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
			captured = key
			return nil
		},
	}

	client, err := ssh.Dial("tcp", spec.addr(), cfg)
	if err != nil {
		return nil, err
	}

	fp := spec.Fingerprint
	if fp == "" && captured != nil {
		fp = ssh.FingerprintSHA256(captured)
	}

	ss, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, err
	}

	stdin, err := ss.StdinPipe()
	if err != nil {
		ss.Close()
		client.Close()
		return nil, err
	}
	stdout, err := ss.StdoutPipe()
	if err != nil {
		stdin.Close()
		ss.Close()
		client.Close()
		return nil, err
	}
	stderr, err := ss.StderrPipe()
	if err != nil {
		stdin.Close()
		ss.Close()
		client.Close()
		return nil, err
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := ss.RequestPty("xterm-256color", 35, 150, modes); err != nil {
		stdin.Close()
		ss.Close()
		client.Close()
		return nil, fmt.Errorf("请求 PTY 失败: %v", err)
	}
	if err := ss.Shell(); err != nil {
		stdin.Close()
		ss.Close()
		client.Close()
		return nil, fmt.Errorf("启动 shell 失败: %v", err)
	}

	now := time.Now()
	return &Session{
		Token:       NewToken(),
		Spec:        spec,
		Client:      client,
		SSHSess:     ss,
		Stdin:       stdin,
		Stdout:      stdout,
		StderrPipe:  stderr,
		Fingerprint: fp,
		IdleTimeout: idle,
		MaxLifetime: lifetime,
		lastSeen:    now,
		started:     now,
	}, nil
}