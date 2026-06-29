package amnesic

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	pbkdf2Iterations = 1000
	os.Exit(m.Run())
}
