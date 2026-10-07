// Studio identity/forwarding closure. No automatic migrations or paid workers.
package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/internal/studiobridge"
	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal("bridge config unavailable")
	}
	db, err := sql.Open("postgres", cfg.Database.DSNWithTimezone(cfg.Timezone))
	if err != nil {
		log.Fatal("bridge database unavailable")
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(cfg.Database.MaxOpenConns)
	db.SetMaxIdleConns(cfg.Database.MaxIdleConns)
	opts := &redis.Options{Addr: cfg.Redis.Address(), Username: cfg.Redis.Username, Password: cfg.Redis.Password, DB: cfg.Redis.DB, DialTimeout: time.Duration(cfg.Redis.DialTimeoutSeconds) * time.Second, ReadTimeout: time.Duration(cfg.Redis.ReadTimeoutSeconds) * time.Second, WriteTimeout: time.Duration(cfg.Redis.WriteTimeoutSeconds) * time.Second, PoolSize: cfg.Redis.PoolSize, MinIdleConns: cfg.Redis.MinIdleConns}
	if cfg.Redis.EnableTLS {
		opts.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.Redis.Host}
	}
	rdb := redis.NewClient(opts)
	defer func() { _ = rdb.Close() }()
	token := os.Getenv("STUDIO_BRIDGE_SERVICE_TOKEN")
	auth := service.NewAuthService(nil, nil, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	identity, err := studiobridge.New(studiobridge.Options{Auth: auth, Users: studiobridge.NewSQLUserReader(db), Redis: rdb, ServiceToken: token})
	if err != nil {
		log.Fatal("bridge identity configuration unavailable")
	}
	group, _ := strconv.ParseInt(os.Getenv("STUDIO_IMAGE_GROUP_ID"), 10, 64)
	image, err := studiobridge.NewImage(studiobridge.ImageOptions{ServiceToken: token, GroupID: group, CoreURL: os.Getenv("STUDIO_IMAGE_CORE_URL"), Verify: identity.VerifySession, Keys: studiobridge.SQLImageCredentialReader{DB: db}})
	if err != nil {
		log.Fatal("image bridge configuration unavailable")
	}
	mux := http.NewServeMux()
	mux.Handle(studiobridge.ImagePath, image)
	if raw := os.Getenv("STUDIO_VIDEO_GROUP_ID"); raw != "" {
		videoGroup, _ := strconv.ParseInt(raw, 10, 64)
		video, e := studiobridge.NewVideo(studiobridge.ImageOptions{ServiceToken: token, GroupID: videoGroup, VideoSubmissionEnabled: os.Getenv("STUDIO_VIDEO_ACCOUNT_SUBMISSION") == "true", CoreURL: os.Getenv("STUDIO_IMAGE_CORE_URL"), Verify: identity.VerifySession, Keys: studiobridge.SQLImageCredentialReader{DB: db, Video: true}})
		if e != nil {
			log.Fatal("video bridge configuration unavailable")
		}
		mux.Handle(studiobridge.VideoPath, video)
	}
	mux.Handle("/", identity.Handler())
	addr := os.Getenv("STUDIO_BRIDGE_LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8091"
	}
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 17 * time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("image bridge stopped")
	}
}
