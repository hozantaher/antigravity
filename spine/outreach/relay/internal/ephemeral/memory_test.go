package ephemeral

import (
	"testing"
)

func TestSecureBufferAlloc(t *testing.T) {
	buf := Alloc(64)
	defer buf.Zero()

	if buf.Len() != 64 {
		t.Fatalf("expected 64 bytes, got %d", buf.Len())
	}
}

func TestSecureBufferWriteRead(t *testing.T) {
	buf := Alloc(32)
	defer buf.Zero()

	data := []byte("hello secure world 1234567890ab")
	buf.Write(0, data)

	got := buf.Bytes()
	for i, b := range data {
		if got[i] != b {
			t.Fatalf("byte %d mismatch", i)
		}
	}
}

func TestSecureBufferZero(t *testing.T) {
	buf := Alloc(32)
	buf.Write(0, []byte("sensitive data here 1234567890ab"))
	buf.Zero()

	for _, b := range buf.Bytes() {
		if b != 0 {
			t.Fatal("buffer not zeroed")
		}
	}
}

func TestSecureBufferDoubleZeroSafe(t *testing.T) {
	buf := Alloc(16)
	buf.Zero()
	buf.Zero() // should not panic
}

func TestWipeSlice(t *testing.T) {
	data := []byte("sensitive information here")
	WipeSlice(data)

	for _, b := range data {
		if b != 0 {
			t.Fatal("slice not wiped")
		}
	}
}

func TestWipeAllRegistry(t *testing.T) {
	buf1 := Alloc(16)
	buf2 := Alloc(16)
	Register(buf1)
	Register(buf2)

	buf1.Write(0, []byte("secret1 data xxx"))
	buf2.Write(0, []byte("secret2 data xxx"))

	WipeAll()

	for _, b := range buf1.Bytes() {
		if b != 0 {
			t.Fatal("buf1 not wiped by WipeAll")
		}
	}
	for _, b := range buf2.Bytes() {
		if b != 0 {
			t.Fatal("buf2 not wiped by WipeAll")
		}
	}
}
