package repository

import (
	"context"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/redis/go-redis/v9"
)

type studioTicketStore struct{ rdb *redis.Client }

func NewStudioTicketStore(rdb *redis.Client) service.StudioTicketStore {
	if rdb == nil {
		return nil
	}
	return &studioTicketStore{rdb: rdb}
}
func (s *studioTicketStore) MGet(ctx context.Context, keys ...string) ([]any, error) {
	return s.rdb.MGet(ctx, keys...).Result()
}
func (s *studioTicketStore) Get(ctx context.Context, key string) ([]byte, error) {
	return s.rdb.Get(ctx, key).Bytes()
}
func (s *studioTicketStore) GetDel(ctx context.Context, key string) ([]byte, error) {
	return s.rdb.GetDel(ctx, key).Bytes()
}
func (s *studioTicketStore) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
	return s.rdb.Set(ctx, key, value, ttl).Err()
}
func (s *studioTicketStore) Del(ctx context.Context, key string) error {
	return s.rdb.Del(ctx, key).Err()
}
