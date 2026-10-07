package studiobridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const ImagePath = "/api/v1/internal/studio/image/"

type ImageCredential struct {
	ID  int64
	Key string
}
type ImageCredentialReader interface {
	Resolve(context.Context, int64, int64, int64) (ImageCredential, error)
	ResolveReceipt(context.Context, int64, int64, int64) (ImageCredential, error)
}
type SQLImageCredentialReader struct {
	DB    *sql.DB
	Video bool
}

func (r SQLImageCredentialReader) Resolve(ctx context.Context, user, group, keyID int64) (ImageCredential, error) {
	return r.resolve(ctx, user, group, keyID, false)
}

// Only original-task GETs may retain access after the original customer key's
// quota/expiry gate closes. Native Core auth still enforces user, IP and disabled
// key restrictions; no alternate key can be selected for recovery.
func (r SQLImageCredentialReader) ResolveReceipt(ctx context.Context, user, group, keyID int64) (ImageCredential, error) {
	if keyID <= 0 {
		return ImageCredential{}, errors.New("original customer key required")
	}
	return r.resolve(ctx, user, group, keyID, true)
}

func (r SQLImageCredentialReader) resolve(ctx context.Context, user, group, keyID int64, receipt bool) (ImageCredential, error) {
	var k ImageCredential
	if r.DB == nil || user <= 0 || group <= 0 || keyID < 0 {
		return k, errors.New("image customer key unavailable")
	}
	// Existing customer credentials only. No supplier credentials, price queries,
	// writes, or alternate key retry after Core rejects the frozen key.
	keyGate := "k.status='active' AND (k.expires_at IS NULL OR k.expires_at>NOW())"
	imageGate := " AND g.allow_image_generation=TRUE"
	if r.Video {
		imageGate = ""
	}
	if receipt {
		keyGate = "k.status IN ('active','expired','quota_exhausted')"
		imageGate = "" // generation pause does not revoke original result ownership
	}
	err := r.DB.QueryRowContext(ctx, `SELECT k.id,k.key FROM api_keys k JOIN users u ON u.id=k.user_id JOIN groups g ON g.id=k.group_id WHERE k.user_id=$1 AND k.group_id=$2 AND ($3=0 OR k.id=$3) AND k.deleted_at IS NULL AND u.deleted_at IS NULL AND g.deleted_at IS NULL AND `+keyGate+` AND u.status='active' AND g.status='active'`+imageGate+` AND g.platform='openai' ORDER BY k.id LIMIT 1`, user, group, keyID).Scan(&k.ID, &k.Key)
	if err != nil || k.ID <= 0 || k.Key == "" {
		return ImageCredential{}, errors.New("image customer key unavailable")
	}
	return k, nil
}

type ImageOptions struct {
	VideoSubmissionEnabled bool
	ServiceToken           string
	GroupID                int64
	CoreURL                string
	Verify                 func(context.Context, string) (int64, error)
	Keys                   ImageCredentialReader
	Client                 *http.Client
}
type ImageBridge struct {
	opts    ImageOptions
	base    *url.URL
	client  *http.Client
	enabled bool
	video   bool
}

func NewImage(opts ImageOptions) (*ImageBridge, error) {
	base, err := url.Parse(opts.CoreURL)
	if err != nil {
		return nil, ErrInvalidBridgeConfig
	}
	loopback := base.Hostname() == "127.0.0.1" || base.Hostname() == "localhost" || base.Hostname() == "::1"
	secureTransport := base.Scheme == "https" || base.Scheme == "http" && loopback
	if base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || base.Path != "" && base.Path != "/" || !secureTransport || len(opts.ServiceToken) < 32 || opts.GroupID <= 0 || opts.Verify == nil || opts.Keys == nil {
		return nil, ErrInvalidBridgeConfig
	}
	client := &http.Client{Timeout: 16 * time.Minute}
	if opts.Client != nil {
		*client = *opts.Client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &ImageBridge{opts: opts, base: base, client: client}, nil
}

var imageTaskPath = regexp.MustCompile(`^tasks/[A-Za-z0-9_-]{1,128}(?:/result)?$`)

func imageOperation(method, path string) bool {
	if method == http.MethodGet {
		return path == "catalog" || path == "readiness" || imageTaskPath.MatchString(path)
	}
	return method == http.MethodPost && (path == "quotes" || path == "tasks")
}
func (b *ImageBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	prefix, contract, corePath := ImagePath, mediaworkbench.ImageBindingVersion, "/v1/studio/images/"
	operationAllowed := imageOperation
	if b.video {
		prefix, contract, corePath = VideoPath, service.StudioVideoBindingVersion, "/v1/studio/videos/"
		operationAllowed = videoOperation
	}

	token := r.Header.Get("X-Studio-Service-Token")
	want, got := sha256.Sum256([]byte(b.opts.ServiceToken)), sha256.Sum256([]byte(token))
	if subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
		writeError(w, 401, "unauthorized service")
		return
	}
	if r.Header.Get("X-Studio-Binding-Contract") != contract {
		writeError(w, 409, "binding contract mismatch")
		return
	}
	operation := strings.TrimPrefix(r.URL.Path, prefix)
	if !strings.HasPrefix(r.URL.Path, prefix) || !operationAllowed(r.Method, operation) || r.URL.RawQuery != "" {
		writeError(w, 404, "unknown image operation")
		return
	}
	user, err := b.opts.Verify(r.Context(), r.Header.Get("X-Studio-Session-Proof"))
	if err != nil || user <= 0 {
		writeError(w, 401, "invalid image session")
		return
	}
	if r.Method == http.MethodPost && operation == "tasks" && !b.enabled {
		writeError(w, 503, "published image paid gate off")
		return
	}
	var envelope struct {
		KeyID   int64           `json:"key_ref"`
		Payload json.RawMessage `json:"payload"`
	}
	if r.Method == http.MethodGet {
		raw := r.Header.Get("X-Studio-Key-Ref")
		if raw != "" {
			envelope.KeyID, err = strconv.ParseInt(raw, 10, 64)
			if err != nil || envelope.KeyID <= 0 {
				writeError(w, 400, "invalid customer key reference")
				return
			}
		}
	} else {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&envelope) != nil || decoder.Decode(new(any)) != io.EOF {
			writeError(w, 400, "invalid image envelope")
			return
		}
	}
	if (operation == "tasks" || strings.HasPrefix(operation, "tasks/")) && envelope.KeyID <= 0 {
		writeError(w, 400, "original customer key required")
		return
	}
	var key ImageCredential
	if strings.HasPrefix(operation, "tasks/") {
		key, err = b.opts.Keys.ResolveReceipt(r.Context(), user, b.opts.GroupID, envelope.KeyID)
	} else {
		key, err = b.opts.Keys.Resolve(r.Context(), user, b.opts.GroupID, envelope.KeyID)
	}
	if err != nil {
		writeError(w, 403, "image customer key unavailable")
		return
	}
	var body io.Reader
	if r.Method == http.MethodPost {
		body = bytes.NewReader(envelope.Payload)
	}
	target := b.base.ResolveReference(&url.URL{Path: corePath + operation})
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), body)
	if err != nil {
		writeError(w, 502, "core unavailable")
		return
	}
	req.GetBody = nil // no automatic POST replay
	req.Header.Set("Authorization", "Bearer "+key.Key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Studio-Binding-Contract", contract)
	if b.video {
		req.Header.Set("X-Studio-Service-Token", b.opts.ServiceToken)
	}
	response, err := b.client.Do(req) //nolint:gosec // G704: protected validated Core origin, allowlisted path, redirects disabled; browser cannot choose destination.
	if err != nil {
		writeError(w, 502, "core outcome unknown; use receipt GET")
		return
	}
	defer func() { _ = response.Body.Close() }()
	if b.video && r.Method == http.MethodGet && strings.HasSuffix(operation, "/result") {
		data, e := io.ReadAll(io.LimitReader(response.Body, 100_000_001))
		mime := response.Header.Get("Content-Type")
		if e != nil || len(data) > 100_000_000 || response.StatusCode != 200 || response.Header.Get("X-Video-Quality") != "original" || (mime != "video/mp4" && mime != "video/webm") {
			writeError(w, 502, "original unavailable")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeSuccess(w, map[string]any{"contract": contract, "key_ref": key.ID, "payload": map[string]string{"mime_type": mime, "bytes_base64": base64.StdEncoding.EncodeToString(data)}})
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (32<<20)+1))
	if err != nil || len(data) > 32<<20 || !json.Valid(data) || response.StatusCode >= 300 {
		writeError(w, responseStatus(response.StatusCode), "core image operation unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeSuccess(w, struct {
		Contract string          `json:"contract"`
		KeyID    int64           `json:"key_ref"`
		Payload  json.RawMessage `json:"payload"`
	}{contract, key.ID, data})
}
func responseStatus(status int) int {
	if status >= 400 && status <= 599 {
		return status
	}
	return http.StatusBadGateway
}

const VideoPath = "/api/v1/internal/studio/video/"

func NewVideo(opts ImageOptions) (*ImageBridge, error) {
	b, e := NewImage(opts)
	if e != nil {
		return nil, e
	}
	b.video = true
	b.enabled = opts.VideoSubmissionEnabled
	return b, nil
}

var videoTaskOperation = regexp.MustCompile(`^tasks/av_[A-Za-z0-9_-]{1,120}(?:/(result|capture|release))?$`)

func videoOperation(method, path string) bool {
	if method == http.MethodGet {
		return path == "readiness" || path == "catalog" || videoTaskOperation.MatchString(path) && !strings.HasSuffix(path, "/capture") && !strings.HasSuffix(path, "/release")
	}
	return method == http.MethodPost && (path == "quotes" || path == "prepare" || path == "tasks" || videoTaskOperation.MatchString(path) && (strings.HasSuffix(path, "/capture") || strings.HasSuffix(path, "/release")))
}
