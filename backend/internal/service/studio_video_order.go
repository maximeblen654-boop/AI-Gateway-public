package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

var (
	ErrStudioVideoInvalidOrder          = errors.New("invalid studio video order")
	ErrStudioVideoNotFound              = errors.New("studio video order not found")
	ErrStudioVideoConflict              = errors.New("studio video order idempotency conflict")
	ErrStudioVideoTerminalConflict      = errors.New("studio video order has a different terminal state")
	ErrStudioVideoInsufficientBalance   = errors.New("insufficient balance for studio video hold")
	ErrStudioVideoFrozenBalance         = errors.New("insufficient frozen balance for studio video order")
	ErrStudioVideoSettlementExceedsHold = errors.New("studio video settlement exceeds hold")
)

const (
	StudioVideoHeld     = "HELD"
	StudioVideoCaptured = "CAPTURED"
	StudioVideoReleased = "RELEASED"
)

// Amounts retain the existing platform balance unit. Customer sale and Account
// cost are independent frozen values; no exchange rate is inferred here. The
// authenticated caller owns identity, quote and upstream evidence validation;
// this internal service has no HTTP exposure.
type StudioVideoReserveCommand struct {
	ChildID                                 string
	UserID, APIKeyID, GroupID               int64
	QuoteID, CapabilityVersion, RequestHash string
	HoldAmount                              float64
	Binding                                 *StudioVideoBinding
}

type StudioVideoCaptureCommand struct {
	ChildID                      string
	UserID                       int64
	ActualAmount                 float64
	SupplierTaskID, EvidenceHash string
	Binding                      *StudioVideoBinding
	ResultHash                   string
}

type StudioVideoReleaseCommand struct {
	ChildID              string
	UserID               int64
	Reason, EvidenceHash string
	Binding              *StudioVideoBinding
}

type StudioVideoOrder struct {
	ChildID                                         string
	UserID, APIKeyID, GroupID                       int64
	QuoteID, CapabilityVersion, RequestHash         string
	HoldFingerprint                                 string
	HoldAmount                                      float64
	Currency, State                                 string
	ActualAmount                                    *float64
	FinalFingerprint, SupplierTaskID, ReleaseReason string
	HoldBalance, HoldFrozenBalance                  float64
	FinalBalance, FinalFrozenBalance                *float64
	CreatedAt, UpdatedAt                            time.Time
	FinalizedAt                                     *time.Time
}

type StudioVideoOrderRepository interface {
	ReserveStudioVideoOrder(context.Context, *StudioVideoReserveCommand) (*StudioVideoOrder, error)
	CaptureStudioVideoOrder(context.Context, *StudioVideoCaptureCommand) (*StudioVideoOrder, error)
	ReleaseStudioVideoOrder(context.Context, *StudioVideoReleaseCommand) (*StudioVideoOrder, error)
	GetStudioVideoOrder(context.Context, int64, string) (*StudioVideoOrder, error)
}

type StudioVideoOrderService struct{ repo StudioVideoOrderRepository }

func NewStudioVideoOrderService(repo StudioVideoOrderRepository) *StudioVideoOrderService {
	return &StudioVideoOrderService{repo: repo}
}

func (s *StudioVideoOrderService) Reserve(ctx context.Context, c *StudioVideoReserveCommand) (*StudioVideoOrder, error) {
	if s == nil || s.repo == nil || c == nil || strings.TrimSpace(c.ChildID) == "" || c.UserID <= 0 || c.APIKeyID <= 0 || c.GroupID <= 0 ||
		strings.TrimSpace(c.QuoteID) == "" || strings.TrimSpace(c.CapabilityVersion) == "" || strings.TrimSpace(c.RequestHash) == "" || !validStudioVideoAmount(c.HoldAmount, true) {
		return nil, ErrStudioVideoInvalidOrder
	}
	copy := *c
	copy.ChildID = strings.TrimSpace(copy.ChildID)
	copy.QuoteID = strings.TrimSpace(copy.QuoteID)
	copy.CapabilityVersion = strings.TrimSpace(copy.CapabilityVersion)
	copy.RequestHash = strings.TrimSpace(copy.RequestHash)
	copy.HoldAmount = QuantizeUsageBillingAmount(copy.HoldAmount)
	if copy.HoldAmount <= 0 {
		return nil, ErrStudioVideoInvalidOrder
	}
	return s.repo.ReserveStudioVideoOrder(ctx, &copy)
}

func (s *StudioVideoOrderService) Capture(ctx context.Context, c *StudioVideoCaptureCommand) (*StudioVideoOrder, error) {
	if s == nil || s.repo == nil || c == nil || strings.TrimSpace(c.ChildID) == "" || c.UserID <= 0 || !validStudioVideoAmount(c.ActualAmount, false) || strings.TrimSpace(c.SupplierTaskID) == "" || strings.TrimSpace(c.EvidenceHash) == "" {
		return nil, ErrStudioVideoInvalidOrder
	}
	copy := *c
	copy.ChildID = strings.TrimSpace(copy.ChildID)
	copy.SupplierTaskID = strings.TrimSpace(copy.SupplierTaskID)
	copy.EvidenceHash = strings.TrimSpace(copy.EvidenceHash)
	copy.ActualAmount = QuantizeUsageBillingAmount(copy.ActualAmount)
	return s.repo.CaptureStudioVideoOrder(ctx, &copy)
}

func (s *StudioVideoOrderService) Release(ctx context.Context, c *StudioVideoReleaseCommand) (*StudioVideoOrder, error) {
	if s == nil || s.repo == nil || c == nil || strings.TrimSpace(c.ChildID) == "" || c.UserID <= 0 || strings.TrimSpace(c.Reason) == "" || strings.TrimSpace(c.EvidenceHash) == "" {
		return nil, ErrStudioVideoInvalidOrder
	}
	copy := *c
	copy.ChildID = strings.TrimSpace(copy.ChildID)
	copy.Reason = strings.TrimSpace(copy.Reason)
	copy.EvidenceHash = strings.TrimSpace(copy.EvidenceHash)
	return s.repo.ReleaseStudioVideoOrder(ctx, &copy)
}

func (s *StudioVideoOrderService) Get(ctx context.Context, userID int64, childID string) (*StudioVideoOrder, error) {
	if s == nil || s.repo == nil || userID <= 0 || strings.TrimSpace(childID) == "" {
		return nil, ErrStudioVideoInvalidOrder
	}
	return s.repo.GetStudioVideoOrder(ctx, userID, strings.TrimSpace(childID))
}

func validStudioVideoAmount(v float64, positive bool) bool {
	if math.IsNaN(v) || math.IsInf(v, 0) || v > 999999999999.99999999 {
		return false
	}
	if positive {
		return v > 0
	}
	return v >= 0
}

func studioVideoFingerprint(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		fmt.Fprintf(h, "%d:%s", len(part), part)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func studioVideoAmount(v float64) string {
	return decimal.NewFromFloat(v).StringFixed(UsageBillingMonetaryScale)
}

func (c *StudioVideoReserveCommand) Fingerprint() string {
	if c.Binding != nil {
		return studioVideoFingerprint("account-video-reserve-v1", c.ChildID, c.Binding.Hash())
	}
	return studioVideoFingerprint(c.ChildID, fmt.Sprint(c.UserID), fmt.Sprint(c.APIKeyID), fmt.Sprint(c.GroupID), c.QuoteID, c.CapabilityVersion, c.RequestHash, studioVideoAmount(c.HoldAmount), "USD")
}

func (c *StudioVideoCaptureCommand) Fingerprint() string {
	if c.Binding != nil {
		return studioVideoFingerprint("account-video-capture-v1", c.ChildID, c.Binding.Hash(), c.SupplierTaskID, c.EvidenceHash, c.ResultHash)
	}
	return studioVideoFingerprint(c.ChildID, fmt.Sprint(c.UserID), studioVideoAmount(c.ActualAmount), c.SupplierTaskID, c.EvidenceHash)
}

func (c *StudioVideoReleaseCommand) Fingerprint() string {
	if c.Binding != nil {
		return studioVideoFingerprint("account-video-release-v1", c.ChildID, c.Binding.Hash(), c.Reason, c.EvidenceHash)
	}
	return studioVideoFingerprint(c.ChildID, fmt.Sprint(c.UserID), c.Reason, c.EvidenceHash)
}
