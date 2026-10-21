package mediaworkbench

import (
	"go/parser"
	"go/token"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// A paid-generation spy alone could miss a call to a different endpoint. Keep
// the validator/plan source restricted to pure dependencies as a second guard.
func TestValidationHasNoNetworkOrCredentialDependencies(t *testing.T) {
	allowed := map[string]bool{
		"bytes": true, "encoding/base64": true, "io": true, // in-memory strict JSON and Data URI decoding only
		"github.com/Wei-Shaw/sub2api/internal/imagecontract": true, // pure reviewed endpoint identity
		"context": true, "embed": true, "reflect": true, "crypto/sha256": true, "encoding/json": true, "errors": true, "fmt": true, "net/url": true, "regexp": true, "slices": true, "sort": true, "strings": true, "time": true,
		"github.com/Wei-Shaw/sub2api/internal/pkg/errors": true,
		"github.com/Wei-Shaw/sub2api/internal/imageplan":  true,
		// Pure mapping precedence shared with the native Account service; no
		// transport, credentials or persistence dependency.
		"github.com/Wei-Shaw/sub2api/internal/modelmapping": true,
		"github.com/Wei-Shaw/sub2api/internal/videoplan":    true,
		"github.com/tidwall/gjson":                          true, "github.com/tidwall/sjson": true,
		// Pure decimal arithmetic for the CNY runtime contract; no transport,
		// credential, database, scheduler or billing-service dependency is admitted.
		"github.com/shopspring/decimal": true,
		"strconv":                       true, // pure integer parsing of pixel dimensions and ratios
		"sync":                          true, // request-local in-memory mutual exclusion; no I/O or admission dependency
	}
	for _, dir := range []string{".", "../imageplan", "../videoplan", "../imagecontract"} {
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range files {
			if strings.HasSuffix(path, "_test.go") {
				continue
			}
			f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if err != nil {
				t.Fatal(err)
			}
			for _, imp := range f.Imports {
				name, err := strconv.Unquote(imp.Path.Value)
				if err != nil {
					t.Fatal(err)
				}
				if !allowed[name] {
					t.Fatalf("%s imports an execution dependency: %s", path, name)
				}
			}
		}
	}
}
