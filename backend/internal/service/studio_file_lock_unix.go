//go:build !windows

package service

import (
	"golang.org/x/sys/unix"
	"os"
)

// Kernel locks release on process exit; an interrupted upload can resume using
// its durable intent rather than guessing whether a stale lock file is live.
func studioFileLock(name string) (func(), error) {
	f, err := os.OpenFile(name, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, err
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); _ = f.Close() }, nil
}
