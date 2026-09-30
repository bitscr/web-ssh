package server

import (
	"testing"

	"github.com/gorilla/websocket"
)

func TestClassifyTerminalInput(t *testing.T) {
	tests := []struct {
		name        string
		messageType int
		payload     string
		wantControl bool
	}{
		{name: "lowercase p is terminal input", messageType: websocket.TextMessage, payload: "p", wantControl: false},
		{name: "ping heartbeat is control", messageType: websocket.TextMessage, payload: "ping", wantControl: true},
		{name: "resize is control", messageType: websocket.TextMessage, payload: "r:24:80", wantControl: true},
		{name: "binary p is terminal input", messageType: websocket.BinaryMessage, payload: "p", wantControl: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTerminalControlMessage(tc.messageType, []byte(tc.payload)); got != tc.wantControl {
				t.Fatalf("isTerminalControlMessage(%d, %q) = %v, want %v", tc.messageType, tc.payload, got, tc.wantControl)
			}
		})
	}
}
