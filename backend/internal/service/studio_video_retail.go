package service

import (
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

// These usage-log discriminators represent unknown procurement cost, never
// zero cost. Native API accounting does not use them.
const StudioVideoRetailUsageMode = "studio_video_retail"
const StudioVideoRetailBindingVersion = "account_video_v2"

func videoRetailAccounting(a *Account, resolved mediaworkbench.ResolvedVideoOffer, at time.Time) (AccountAccountingSnapshot, error) {
	return mediaRetailAccounting(a, resolved.Offer, resolved.PublishedRevision, resolved.SpecHash, 1, at, StudioVideoRetailUsageMode)
}

func validateVideoRetailAccounting(b *StudioVideoBinding) error {
	if validateMediaRetailAccounting(b.Accounting, b.AccountQuotaEnabled, b.Offer, b.PublishedRevision, b.SpecHash, 1, StudioVideoRetailUsageMode) != nil {
		return ErrStudioVideoInvalidOrder
	}
	return nil
}
