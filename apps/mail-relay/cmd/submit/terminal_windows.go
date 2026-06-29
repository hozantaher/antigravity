//go:build windows

package main

import "fmt"

func disableEcho() (any, error) {
	return nil, fmt.Errorf("echo disable not implemented on Windows")
}

func restoreEcho(state any) {}
