package server

import "testing"

func TestSanitizeUTF8(t *testing.T) {
	tests := []struct {
		name string
		in   []byte
		want string
	}{
		{
			name: "valid UTF-8 remains unchanged",
			in:   []byte("hello, 世界"),
			want: "hello, 世界",
		},
		{
			name: "invalid byte is replaced",
			in:   []byte{'a', 0xff, 'b'},
			want: "a@b",
		},
		{
			name: "multiple invalid bytes are replaced individually",
			in:   []byte{0xff, 0xfe},
			want: "@@",
		},
		{
			name: "empty input remains empty",
			in:   []byte{},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := string(sanitizeUTF8(tt.in))
			if got != tt.want {
				t.Fatalf("sanitizeUTF8(%v) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
