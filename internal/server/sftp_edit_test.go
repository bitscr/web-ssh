package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateEditableContent(t *testing.T) {
	tests := []struct {
		name    string
		data    []byte
		wantErr string
	}{
		{name: "empty text", data: nil},
		{name: "utf8 text", data: []byte("你好，SFTP\nhello\n")},
		{name: "exactly one MiB", data: bytes.Repeat([]byte("a"), 1<<20)},
		{name: "over one MiB", data: bytes.Repeat([]byte("a"), (1<<20)+1), wantErr: "1 MiB"},
		{name: "invalid utf8", data: []byte{0xff, 0xfe, 0xfd}, wantErr: "UTF-8"},
		{name: "nul byte binary", data: []byte("hello\x00world"), wantErr: "二进制"},
		{name: "binary control bytes", data: bytes.Repeat([]byte{0x01, 0x02, 0x03, 0x04}, 16), wantErr: "二进制"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateEditableContent(tc.data)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("validateEditableContent() unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("validateEditableContent() expected error containing %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("validateEditableContent() error = %q, want substring %q", err, tc.wantErr)
			}
		})
	}
}

func TestSFTPEditLimitIsOneMiB(t *testing.T) {
	if sftpEditMaxBytes != 1<<20 {
		t.Fatalf("sftpEditMaxBytes = %d, want %d", sftpEditMaxBytes, 1<<20)
	}
}

func TestSFTPEditRouteAlwaysReturnsJSON(t *testing.T) {
	handler := Handler(NewRegistry(Config{}), NewFileRegistry(), "test", true)
	tests := []struct {
		name       string
		method     string
		token      string
		body       string
		wantStatus int
	}{
		{name: "post missing token", method: http.MethodPost, body: `{"path":"/tmp/test","content":"p"}`, wantStatus: http.StatusBadRequest},
		{name: "post invalid token", method: http.MethodPost, token: "invalid-regression-token", body: `{"path":"/tmp/test","content":"p"}`, wantStatus: http.StatusBadRequest},
		{name: "wrong method", method: http.MethodPut, body: `{"path":"/tmp/test","content":"p"}`, wantStatus: http.StatusMethodNotAllowed},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			url := "/api/sftp/edit"
			if tc.token != "" {
				url += "?token=" + tc.token
			}
			req := httptest.NewRequest(tc.method, url, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body=%q", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if got := rr.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
				t.Fatalf("Content-Type = %q, want application/json; body=%q", got, rr.Body.String())
			}
			if strings.Contains(strings.ToLower(rr.Body.String()), "<!doctype html") {
				t.Fatalf("route returned index.html: %q", rr.Body.String())
			}
			var payload map[string]any
			if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
				t.Fatalf("invalid JSON: %v; body=%q", err, rr.Body.String())
			}
			if tc.wantStatus >= 400 && payload["error"] == nil {
				t.Fatalf("error response lacks error field: %#v", payload)
			}
		})
	}
}
