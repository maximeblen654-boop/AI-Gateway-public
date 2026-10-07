package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

type HTTPAccountBoundReferenceUploader struct {
	Core      *OpenAIGatewayService
	StateRoot string
}
type referenceUploadState struct {
	AccountID             int64  `json:"account_id"`
	OwnerID               int64  `json:"owner_id"`
	AssetRef              string `json:"asset_ref"`
	SHA256                string `json:"sha256"`
	MimeType              string `json:"mime_type"`
	Size                  int    `json:"size"`
	UploadID              string `json:"upload_id"`
	Status                string `json:"status"`
	Source                string `json:"source,omitempty"`
	Received              []int  `json:"received,omitempty"`
	EndpointFingerprint   string `json:"endpoint_fingerprint"`
	CredentialFingerprint string `json:"credential_fingerprint"`
	ProxyFingerprint      string `json:"proxy_fingerprint"`
}

func NewHTTPAccountBoundReferenceUploader(core *OpenAIGatewayService) *HTTPAccountBoundReferenceUploader {
	return &HTTPAccountBoundReferenceUploader{Core: core, StateRoot: func() string {
		root := strings.TrimSpace(os.Getenv("STUDIO_VIDEO_BINDING_ROOT"))
		if root == "" {
			root = filepath.Join("data", "studio-video-bindings")
		}
		return filepath.Join(root, "reference-uploads")
	}()}
}

func (u *HTTPAccountBoundReferenceUploader) Upload(ctx context.Context, account *Account, owner StudioImageOwner, offer mediaworkbench.Offer, input StudioVideoReferenceAsset, content []byte) (StudioVideoReferenceReceipt, error) {
	var out StudioVideoReferenceReceipt
	_ = offer
	if u == nil || u.Core == nil || account == nil || owner.UserID <= 0 || len(content) != input.Size || account.GetOpenAIProtocolAPIKey() == "" {
		return out, ErrStudioVideoReferenceUploadUnavailable
	}
	if account.ProxyID != nil && (account.Proxy == nil || account.Proxy.ID != *account.ProxyID) {
		return out, ErrStudioVideoReferenceUploadUnavailable
	}
	root := strings.TrimRight(account.GetOpenAIBaseURL(), "/")
	if root == "" {
		return out, ErrStudioVideoReferenceUploadUnavailable
	}
	if !strings.HasSuffix(root, "/v1") {
		root += "/v1"
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(content))
	if input.SHA256 != "" && !strings.EqualFold(input.SHA256, digest) {
		return out, fmt.Errorf("reference content digest mismatch")
	}
	// Different preparation intents may reuse one private asset. Serialize its
	// uploader too, so a shared upload ID never gets concurrent complete calls.
	statePath := u.statePath(account.ID, input.AssetRef, digest)
	if statePath == "" {
		return out, errors.New("reference upload state root unavailable")
	}
	if e := os.MkdirAll(filepath.Dir(statePath), 0700); e != nil {
		return out, e
	}
	unlock, e := studioFileLock(statePath + ".lock")
	if e != nil {
		return out, e
	}
	defer unlock()
	ownerID := owner.UserID
	endpointFP := studioHash(root)
	credentialFP := videoCredentialFingerprint(account)
	proxy := ""
	if account.Proxy != nil {
		proxy = account.Proxy.URL()
	}
	proxyFP := studioHash(proxy)
	st, err := u.loadState(account.ID, input.AssetRef, digest)
	if err != nil {
		return out, err
	}
	if st.UploadID == "" {
		if st.Status == "initializing" {
			return out, errors.New("reference upload init unknown")
		}
		st = referenceUploadState{AccountID: account.ID, OwnerID: ownerID, AssetRef: input.AssetRef, SHA256: digest, MimeType: input.MimeType, Size: len(content), Status: "initializing", EndpointFingerprint: endpointFP, CredentialFingerprint: credentialFP, ProxyFingerprint: proxyFP}
		if err = u.saveState(st, true); err != nil {
			return out, err
		}
		body, _ := json.Marshal(map[string]any{"size": len(content), "sha256": digest, "mime_type": input.MimeType})
		resp, e := u.do(ctx, account, http.MethodPost, root+"/media/uploads", body, "application/json")
		if e != nil {
			return out, e
		}
		var init struct {
			ID       string `json:"id"`
			UploadID string `json:"upload_id"`
		}
		if e = json.Unmarshal(resp, &init); e != nil {
			return out, e
		}
		st.UploadID = init.ID
		if st.UploadID == "" {
			st.UploadID = init.UploadID
		}
		if !safeUploadID(st.UploadID) {
			return out, errors.New("invalid supplier upload id")
		}
		st.Status = "uploading"
		if err = u.saveState(st, false); err != nil {
			return out, err
		}
	}
	if st.OwnerID != ownerID || st.AccountID != account.ID || st.EndpointFingerprint != endpointFP || st.CredentialFingerprint != credentialFP || st.ProxyFingerprint != proxyFP || st.Size != len(content) || !strings.EqualFold(st.SHA256, digest) {
		return out, errors.New("reference upload identity changed")
	}
	status, e := u.do(ctx, account, http.MethodGet, root+"/media/uploads/"+st.UploadID, nil, "")
	if e != nil {
		return out, e
	}
	var s struct {
		ID         string `json:"id"`
		Bytes      int    `json:"bytes"`
		Status     string `json:"status"`
		ChunkSize  int    `json:"chunk_size"`
		ChunkCount int    `json:"chunk_count"`
		Size       int    `json:"size"`
		SHA256     string `json:"sha256"`
		Received   []int  `json:"received"`
		Source     string `json:"source"`
	}
	if e = json.Unmarshal(status, &s); e != nil {
		return out, e
	}
	if s.Size == 0 {
		s.Size = s.Bytes
	}
	if s.ID != st.UploadID || (s.Status != "uploading" && s.Status != "complete") || s.ChunkSize <= 0 || s.Size != len(content) || !strings.EqualFold(s.SHA256, digest) || s.ChunkCount != (len(content)+s.ChunkSize-1)/s.ChunkSize {
		return out, errors.New("supplier upload metadata mismatch")
	}
	for _, i := range s.Received {
		if i < 0 || i >= s.ChunkCount {
			return out, errors.New("supplier upload chunk state invalid")
		}
	}
	if s.Status == "complete" {
		if !strings.HasPrefix(s.Source, "https://") {
			return out, errors.New("supplier source is not https")
		}
		st.Status = "complete"
		st.Source = s.Source
		st.Received = s.Received
		if e = u.saveState(st, false); e != nil {
			return out, e
		}
		return StudioVideoReferenceReceipt{AssetRef: input.AssetRef, Kind: input.Kind, MimeType: input.MimeType, Size: len(content), SHA256: digest, Source: s.Source, UploadID: st.UploadID, DurationSeconds: input.DurationSeconds}, nil
	}
	seen := map[int]bool{}
	for _, i := range s.Received {
		seen[i] = true
	}
	count := (len(content) + s.ChunkSize - 1) / s.ChunkSize
	for i := 0; i < count; i++ {
		if seen[i] {
			continue
		}
		a, b := i*s.ChunkSize, (i+1)*s.ChunkSize
		if b > len(content) {
			b = len(content)
		}
		if _, e = u.do(ctx, account, http.MethodPut, root+"/media/uploads/"+st.UploadID+"/chunks/"+strconv.Itoa(i), content[a:b], "application/octet-stream"); e != nil {
			return out, e
		}
		st.Received = append(st.Received, i)
		if e = u.saveState(st, false); e != nil {
			return out, e
		}
	}
	complete, e := u.do(ctx, account, http.MethodPost, root+"/media/uploads/"+st.UploadID+"/complete", []byte("{}"), "application/json")
	if e != nil {
		return out, e
	}
	var rec struct {
		Status string `json:"status"`
		Source string `json:"source"`
	}
	if e = json.Unmarshal(complete, &rec); e != nil {
		return out, e
	}
	if rec.Status != "complete" || !strings.HasPrefix(rec.Source, "https://") {
		return out, errors.New("supplier source is not https")
	}
	st.Status = "complete"
	st.Source = rec.Source
	if e = u.saveState(st, false); e != nil {
		return out, e
	}
	return StudioVideoReferenceReceipt{AssetRef: input.AssetRef, Kind: input.Kind, MimeType: input.MimeType, Size: len(content), SHA256: digest, Source: rec.Source, UploadID: st.UploadID, DurationSeconds: input.DurationSeconds}, nil
}

func (u *HTTPAccountBoundReferenceUploader) do(ctx context.Context, account *Account, method, url string, body []byte, ct string) ([]byte, error) {
	req, e := http.NewRequestWithContext(WithHTTPUpstreamRedirectsDisabled(ctx), method, url, bytes.NewReader(body))
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+account.GetOpenAIProtocolAPIKey())
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	proxy := ""
	if account.Proxy != nil {
		proxy = account.Proxy.URL()
	}
	resp, e := u.Core.httpUpstream.Do(req, proxy, account.ID, account.Concurrency)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	b, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return nil, errors.New("supplier response unreadable")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("supplier status %d", resp.StatusCode)
	}
	return b, nil
}
func (u *HTTPAccountBoundReferenceUploader) statePath(a int64, ref, digest string) string {
	if u.StateRoot == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d:%s:%s", a, ref, digest)))
	return filepath.Join(u.StateRoot, hex.EncodeToString(sum[:])+".json")
}
func (u *HTTPAccountBoundReferenceUploader) loadState(a int64, ref, digest string) (referenceUploadState, error) {
	var st referenceUploadState
	p := u.statePath(a, ref, digest)
	if p == "" {
		return st, errors.New("reference upload state root unavailable")
	}
	e := studioRead(p, &st)
	if os.IsNotExist(e) {
		return st, nil
	}
	if e != nil {
		return st, e
	}
	return st, e
}
func (u *HTTPAccountBoundReferenceUploader) saveState(st referenceUploadState, exclusive bool) error {
	p := u.statePath(st.AccountID, st.AssetRef, st.SHA256)
	if p == "" {
		return errors.New("reference upload state root unavailable")
	}
	if e := os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	b, e := json.Marshal(st)
	if e != nil {
		return e
	}
	return studioWrite(p, b, exclusive)
}

var uploadIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)

func safeUploadID(v string) bool { return uploadIDPattern.MatchString(v) }
