package segment

import "os"

func readQuerySource() ([]byte, error) {
	return os.ReadFile("query.go")
}
