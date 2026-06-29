package config

import (
	"bufio"
	"os"
	"strings"
)

// LoadSecretsFile reads a key=value secrets file into a map.
// Lines starting with # are comments. Empty lines are skipped.
// Values are trimmed of whitespace. No shell expansion.
//
// Usage: point SECRETS_FILE env var to a file with 0600 permissions containing:
//
//	DATA_ENCRYPTION_KEY_B64=<base64>
//	VAULT_ENCRYPTION_KEY_B64=<base64>
//	DEV_API_TOKEN=<token>
//	SMTP_PASSWORD=<password>
func LoadSecretsFile(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	secrets := make(map[string]string)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		secrets[key] = value
	}
	return secrets, scanner.Err()
}

// ApplySecrets sets environment variables from a secrets map.
// Only sets variables that are not already set in the environment.
func ApplySecrets(secrets map[string]string) {
	for key, value := range secrets {
		if os.Getenv(key) == "" { // envconfig-allowed: dynamic key in secrets loop
			os.Setenv(key, value)
		}
	}
}

// LoadAndApplySecretsFile loads a secrets file and applies it to the environment.
// If the path is empty or the file doesn't exist, this is a no-op.
func LoadAndApplySecretsFile(path string) error {
	if path == "" {
		return nil
	}
	secrets, err := LoadSecretsFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	ApplySecrets(secrets)
	return nil
}
