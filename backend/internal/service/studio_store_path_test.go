package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The path-traversal boundary is hashing external identities, not cleaning
// them. These checks intentionally do not claim protection against a local
// actor who can replace entries inside the server-owned private directory.
func TestStudioStorePathsHashUntrustedIdentity(t *testing.T) {
	root := t.TempDir()
	image := NewStudioImageStore(root)
	video := &StudioVideoStore{Root: root}
	uploader := &HTTPAccountBoundReferenceUploader{StateRoot: root}
	for _, id := range []string{"", "../outside", "../../outside", "/tmp/outside", `C:\outside`, `..\outside`, "a/b\\c", "\x00", "%2e%2e%2foutside"} {
		t.Run(id, func(t *testing.T) {
			paths := []string{
				image.path("result", id),
				image.path("retention", id) + ".lock",
				video.path("retention", id) + ".lock",
				video.path("reference-lock", id),
				uploader.statePath(44, id, id) + ".lock",
			}
			for _, name := range paths {
				require.Equal(t, root, filepath.Dir(name))
				rel, err := filepath.Rel(root, name)
				require.NoError(t, err)
				require.False(t, filepath.IsAbs(rel))
				require.NotContains(t, rel, "..")
				require.False(t, strings.ContainsAny(rel, `/\\`))
				unlock, err := studioFileLock(name)
				require.NoError(t, err)
				unlock()
				info, err := os.Lstat(name)
				require.NoError(t, err)
				require.True(t, info.Mode().IsRegular())
			}
			require.Equal(t, "result-"+HashUsageRequestPayload([]byte(id)), filepath.Base(paths[0]))
		})
	}
}
