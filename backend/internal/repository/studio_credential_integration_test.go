//go:build integration

package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/internal/studiobridge"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// Real native repositories and Bridge credential selection, disposable PostgreSQL.
// Only authenticated JWT subject injection and the local runtime status are fixtures;
// credential creation, persistence and selection are the production implementations.
func TestStudioCredentialZeroKeyHTTPPostgresBridge(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	user := mustCreateUser(t, client, &service.User{Balance: 10})
	other := mustCreateUser(t, client, &service.User{Balance: 20})
	group := mustCreateGroup(t, client, &service.Group{Name: fmt.Sprintf("studio-entry-%d", time.Now().UnixNano()), Platform: service.PlatformOpenAI})
	_, err := client.Group.UpdateOneID(group.ID).SetAllowImageGeneration(true).Save(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		for _, row := range []struct {
			query string
			id    int64
		}{
			{"DELETE FROM api_keys WHERE user_id=$1", user.ID}, {"DELETE FROM api_keys WHERE user_id=$1", other.ID},
			{"DELETE FROM users WHERE id=$1", user.ID}, {"DELETE FROM users WHERE id=$1", other.ID}, {"DELETE FROM groups WHERE id=$1", group.ID},
		} {
			_, e := integrationDB.ExecContext(ctx, row.query, row.id)
			require.NoError(t, e)
		}
	})
	token := "synthetic-bridge-credential-integration-token"
	t.Setenv("STUDIO_BRIDGE_SERVICE_TOKEN", token)
	bridgeStatus := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/internal/studio/paid-control" || r.Header.Get("X-Studio-Service-Token") != token {
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"version": "managed-v1", "ready": true, "core_loopback": true, "image_group": group.ID, "video_group": group.ID})
	}))
	defer bridgeStatus.Close()
	t.Setenv("STUDIO_CONTROL_BRIDGE_URL", bridgeStatus.URL)
	keys := NewAPIKeyRepository(client, integrationDB)
	svc := service.NewAPIKeyService(keys, NewUserRepository(client, integrationDB), NewGroupRepository(client, integrationDB), nil, nil, nil, &config.Config{})
	h := handler.NewAPIKeyHandler(svc)
	router := gin.New()
	router.POST("/keys/studio-access", func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: user.ID})
		h.EnsureStudioCredential(c)
	})
	router.POST("/anonymous", h.EnsureStudioCredential)
	request := func(path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(w, r)
		return w
	}
	count, e := keys.CountByUserID(ctx, user.ID)
	require.NoError(t, e)
	require.Zero(t, count)
	require.Equal(t, 401, request("/anonymous", `{"media":"image"}`).Code)
	for _, body := range []string{`{"media":"image","group_id":999}`, `{"media":"image","user_id":999}`, `{"media":"image"}{}`, `{"media":"other"}`} {
		require.Equal(t, 400, request("/keys/studio-access", body).Code)
	}
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- request("/keys/studio-access", `{"media":"image"}`) }()
	}
	wg.Wait()
	close(results)
	for w := range results {
		require.Equal(t, 200, w.Code, w.Body.String())
		require.NotContains(t, w.Body.String(), "sk-")
		require.Contains(t, w.Body.String(), `"prepared":true`)
	}
	count, e = keys.CountByUserID(ctx, user.ID)
	require.NoError(t, e)
	require.Equal(t, int64(1), count)
	image := studiobridge.SQLImageCredentialReader{DB: integrationDB}
	credential, e := image.Resolve(ctx, user.ID, group.ID, 0)
	require.NoError(t, e)
	require.Positive(t, credential.ID)
	_, e = image.Resolve(ctx, other.ID, group.ID, credential.ID)
	require.Error(t, e)
	require.NoError(t, svc.EnsureStudioCredential(ctx, other.ID, "video"))
	video := studiobridge.SQLImageCredentialReader{DB: integrationDB, Video: true}
	second, e := video.Resolve(ctx, other.ID, group.ID, 0)
	require.NoError(t, e)
	require.NotEqual(t, credential.ID, second.ID)
	require.NotEqual(t, credential.Key, second.Key)
	_, e = integrationDB.ExecContext(ctx, "UPDATE api_keys SET status='inactive' WHERE id=$1", credential.ID)
	require.NoError(t, e)
	require.Equal(t, 200, request("/keys/studio-access", `{"media":"image"}`).Code)
	_, e = image.Resolve(ctx, user.ID, group.ID, 0)
	require.Error(t, e, "disabled credential must not be replaced")
	count, e = keys.CountByUserID(ctx, user.ID)
	require.NoError(t, e)
	require.Equal(t, int64(1), count)
	var balance float64
	var usage int
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance FROM users WHERE id=$1", user.ID).Scan(&balance))
	require.Equal(t, float64(10), balance)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM usage_logs WHERE user_id=$1", user.ID).Scan(&usage))
	require.Zero(t, usage)
}
