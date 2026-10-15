package service

import (
	"context"
	"fmt"
	"os"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
)

// EnsureStudioCredential prepares the user's own native credential. The browser
// supplies only the media kind; the authenticated Bridge is the Group authority.
// Existing credentials (including disabled/limited keys) are never replaced.
// Actual catalog/quote/execute authorization remains in the native API pipeline.
func (s *APIKeyService) EnsureStudioCredential(ctx context.Context, userID int64, media string) error {
	if !validPaidMedia(media) || userID <= 0 {
		return infraerrors.BadRequest("STUDIO_MEDIA_INVALID", "invalid media kind")
	}
	bridge, err := paidSidecarStatus(ctx, firstNonEmptyString(os.Getenv("STUDIO_CONTROL_BRIDGE_URL"), "http://127.0.0.1:8091"))
	if err != nil || !bridge.CoreLoopback {
		return infraerrors.ServiceUnavailable("STUDIO_CREDENTIAL_UNAVAILABLE", "Studio connection unavailable")
	}
	groupID := bridge.ImageGroup
	if media == "video" {
		groupID = bridge.VideoGroup
	}
	if groupID <= 0 {
		return ErrGroupNotAllowed
	}
	if media == "image" {
		group, e := s.groupRepo.GetByID(ctx, groupID)
		if e != nil {
			return e
		}
		if group == nil || !group.AllowImageGeneration {
			return ErrGroupNotAllowed
		}
	}
	_, err, _ = s.studioCredentialGroup.Do(fmt.Sprintf("%d:%d", userID, groupID), func() (any, error) {
		return nil, s.ensureStudioCredential(ctx, userID, groupID)
	})
	return err
}

func (s *APIKeyService) ensureStudioCredential(ctx context.Context, userID, groupID int64) error {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}
	group, err := s.groupRepo.GetByID(ctx, groupID)
	if err != nil {
		return err
	}
	if user == nil || !user.IsActive() || group == nil || !group.IsActive() ||
		!s.canUserBindGroup(ctx, user, group) {
		return ErrGroupNotAllowed
	}
	// Include inactive/expired/quota-exhausted keys: never evade an existing limit
	// by silently allocating a second credential. Bridge/Core enforce those limits.
	keys, _, err := s.apiKeyRepo.ListByUserID(ctx, userID, pagination.PaginationParams{Page: 1, PageSize: 1}, APIKeyListFilters{GroupID: &groupID})
	if err != nil {
		return err
	}
	if len(keys) > 0 {
		return nil
	}
	_, err = s.Create(ctx, userID, CreateAPIKeyRequest{Name: "Studio media", GroupID: &groupID})
	return err
}
