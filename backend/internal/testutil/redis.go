package testutil

import (
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// NewRedisGatewayCache returns a real Redis-backed gateway cache for tests.
func NewRedisGatewayCache(t *testing.T) service.GatewayCache {
	t.Helper()

	redisServer := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })

	return repository.NewGatewayCache(redisClient)
}

// NewStudioTicketStore uses the production adapter with an isolated Redis.
func NewStudioTicketStore(t *testing.T) (service.StudioTicketStore, *redis.Client) {
	t.Helper()
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return repository.NewStudioTicketStore(client), client
}
