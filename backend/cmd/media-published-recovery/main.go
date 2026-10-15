// Account 77 only. Default dry run; apply requires a reviewed plan and durable
// backup. No HTTP listener, credentials in arguments, supplier client or switch.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	_ "github.com/lib/pq"
	"os"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "recovery refused:", err)
		os.Exit(1)
	}
}
func run() error {
	planPath := flag.String("apply-plan", "", "reviewed dry-run JSON; omission performs no writes")
	backupPath := flag.String("backup", "", "new private original-config backup path (apply only)")
	flag.Parse()
	var expected *repository.PublishedRecoveryPlan
	at := time.Now().UTC()
	if *planPath != "" {
		b, e := os.ReadFile(*planPath)
		if e != nil {
			return e
		}
		expected = new(repository.PublishedRecoveryPlan)
		if e = json.Unmarshal(b, expected); e != nil {
			return e
		}
		at = expected.At
		if *backupPath == "" {
			return fmt.Errorf("backup required")
		}
	}
	dsn := os.Getenv("MEDIA_RECOVERY_DSN")
	if dsn == "" {
		return fmt.Errorf("MEDIA_RECOVERY_DSN required; use protected process input")
	}
	db, e := sql.Open("postgres", dsn)
	if e != nil {
		return fmt.Errorf("database connection setup failed")
	}
	defer func() { _ = db.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	backup := func(b []byte) error {
		f, e := os.OpenFile(*backupPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		defer func() { _ = f.Close() }()
		if _, e = f.Write(b); e != nil {
			return e
		}
		if e = f.Sync(); e != nil {
			return e
		}
		return f.Close()
	}
	p, e := repository.RecoverAccount77Published(ctx, db, at, expected, backup)
	if e != nil {
		return e
	}
	return json.NewEncoder(os.Stdout).Encode(p)
}
