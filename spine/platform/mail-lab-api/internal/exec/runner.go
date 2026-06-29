// Package exec wraps shell exec so handlers can be tested with a mock.
//
// Mail Lab admin operations (account create, delete, list) need to call
// docker-mailserver's `setup` CLI inside the running container. The
// production runner shells out to `docker exec mail-lab-seznam setup ...`;
// tests inject a fake runner that records calls without touching docker.
package exec

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
)

// Runner runs a command with arguments and returns combined stdout+stderr.
// The interface is small so tests can plug in fakes.
//
// RunWithStdin (ML3.1) is needed for bounce delivery — sendmail reads the
// DSN body from stdin, not from arguments. The default DockerRunner
// implements both; tests typically embed a fakeRunner that defines
// RunWithStdin alongside Run.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (string, error)
	RunWithStdin(ctx context.Context, stdin []byte, name string, args ...string) (string, error)
}

// DockerRunner is the production Runner — it shells out via os/exec.
type DockerRunner struct{}

func (DockerRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("%s %v: %w (output: %s)", name, args, err, out.String())
	}
	return out.String(), nil
}

func (DockerRunner) RunWithStdin(ctx context.Context, stdin []byte, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = bytes.NewReader(stdin)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("%s %v (stdin %d bytes): %w (output: %s)", name, args, len(stdin), err, out.String())
	}
	return out.String(), nil
}
