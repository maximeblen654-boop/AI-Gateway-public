//go:build unit

package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/internal/studiobridge"
	"github.com/Wei-Shaw/sub2api/internal/testutil"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type studioLogoutRefreshCache struct {
	userHandlerRefreshTokenCacheStub
	data *service.RefreshTokenData
}

func (c *studioLogoutRefreshCache) GetRefreshToken(context.Context, string) (*service.RefreshTokenData, error) {
	return c.data, nil
}

func TestStudioLegacyAndPublishedLogoutRevocation(t *testing.T) {
	for _, mode := range []string{"bearer", "refresh-only", "all", "service-all"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			store, rdb := testutil.NewStudioTicketStore(t)
			user := &service.User{ID: 7, Status: service.StatusActive, TokenVersion: 3}
			repo := &userHandlerRepoStub{user: user}
			refresh := &studioLogoutRefreshCache{}
			auth := service.NewAuthService(nil, repo, nil, refresh, &config.Config{JWT: config.JWTConfig{Secret: "synthetic-session-signing-secret-only", ExpireHour: 1}}, nil, nil, nil, nil, nil, nil, nil, nil)
			token, err := auth.GenerateToken(ctx, user)
			require.NoError(t, err)
			claims, err := auth.ValidateToken(token)
			require.NoError(t, err)
			refresh.data = &service.RefreshTokenData{UserID: user.ID, FamilyID: claims.SessionID, ExpiresAt: time.Now().Add(time.Hour)}
			record, _ := json.Marshal(refresh.data)
			require.NoError(t, rdb.Set(ctx, "refresh_token:synthetic", record, time.Hour).Err())
			_, err = rdb.SAdd(ctx, "token_family:"+claims.SessionID, "synthetic").Result()
			require.NoError(t, err)
			h := &AuthHandler{authService: auth, userService: service.NewUserService(repo, nil, nil, nil)}
			h.EnableStudioTickets(store)
			modern := studiobridge.NewStudioTicketService(rdb, repo)
			oldTicket, err := h.studioTickets.Issue(ctx, user.ID, claims.SessionID, claims.IssuedAt.Unix(), claims.ExpiresAt.Unix())
			require.NoError(t, err)
			newTicket, err := modern.Issue(ctx, user.ID, claims.SessionID, claims.IssuedAt.Unix(), claims.ExpiresAt.Unix())
			require.NoError(t, err)
			oldIdentity, err := h.studioTickets.Consume(ctx, oldTicket)
			require.NoError(t, err)
			newIdentity, err := modern.Consume(ctx, newTicket)
			require.NoError(t, err)
			_, err = modern.Verify(ctx, oldIdentity.SessionProof)
			require.Error(t, err)
			_, err = h.studioTickets.Verify(ctx, newIdentity.SessionProof)
			require.Error(t, err)
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
			c.Request.Header.Set("Authorization", "Bearer "+token)
			if mode == "refresh-only" {
				c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", strings.NewReader(`{"refresh_token":"rt_synthetic"}`))
				c.Request.Header.Set("Content-Type", "application/json")
			}
			if mode == "service-all" {
				require.NoError(t, auth.RevokeAllUserTokens(ctx, user.ID))
			} else if mode == "all" {
				c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: user.ID})
				h.RevokeAllSessions(c)
			} else {
				h.Logout(c)
			}
			require.Equal(t, http.StatusOK, w.Code)
			_, err = h.studioTickets.Verify(ctx, oldIdentity.SessionProof)
			require.Error(t, err)
			_, err = modern.Verify(ctx, newIdentity.SessionProof)
			require.Error(t, err)
			_, err = h.studioTickets.Issue(ctx, user.ID, claims.SessionID, claims.IssuedAt.Unix(), claims.ExpiresAt.Unix())
			require.Error(t, err, "a still-signed website JWT cannot reissue a revoked legacy ticket")
		})
	}
}

func TestStudioLegacyConsumerServiceAuthAndTicketPurpose(t *testing.T) {
	ctx := context.Background()
	store, _ := testutil.NewStudioTicketStore(t)
	repo := &userHandlerRepoStub{user: &service.User{ID: 7, Status: service.StatusActive}}
	h := &AuthHandler{userService: service.NewUserService(repo, nil, nil, nil)}
	h.EnableStudioTickets(store)
	secret := strings.Repeat("synthetic", 5)
	t.Setenv("STUDIO_BRIDGE_SERVICE_TOKEN", secret)
	ticket, err := h.studioTickets.Issue(ctx, 7, "legacy-family", time.Now().Unix(), time.Now().Add(time.Hour).Unix())
	require.NoError(t, err)
	r := gin.New()
	r.POST("/api/v1/internal/studio/tickets/consume", h.ConsumeStudioTicket)
	consume := func(serviceToken string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/internal/studio/tickets/consume", strings.NewReader(`{"ticket":"`+ticket+`"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Studio-Service-Token", serviceToken)
		r.ServeHTTP(w, request)
		return w
	}
	require.Equal(t, 401, consume("wrong").Code)
	require.Equal(t, 200, consume(secret).Code)
	require.Equal(t, 401, consume(secret).Code)
	t.Setenv("STUDIO_BRIDGE_SERVICE_TOKEN", "")
	require.Equal(t, 401, consume(secret).Code)
}
