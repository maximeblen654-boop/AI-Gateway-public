package service

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const imageReceiptStoreBudget int64 = 512 << 20
const imageReceiptResultReserve int64 = 32 << 20

// Called under imageReceiptMu. Pending tasks reserve room before paid dispatch.
func imageReceiptStorePreflight(extra ...int64) error {
	if err := os.MkdirAll(imageReceiptRoot(), 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(imageReceiptRoot())
	if err != nil {
		return err
	}
	var used int64
	for _, e := range entries {
		p := filepath.Join(imageReceiptRoot(), e.Name())
		if filepath.Ext(e.Name()) == ".result" || filepath.Ext(e.Name()) == ".upstream" {
			if filepath.Ext(e.Name()) == ".upstream" {
				if r, err := readImageReceipt(strings.TrimSuffix(p, ".upstream")); err == nil && r.ResultHash != "" && r.BillingState == "billed" {
					if err = os.Remove(p); err != nil && !os.IsNotExist(err) {
						return err
					}
					continue
				}
			}
			if r, err := readImageReceipt(strings.TrimSuffix(p, ".result")); err == nil && !r.ResultExpiresAt.IsZero() && !time.Now().Before(r.ResultExpiresAt) && r.BillingState == "billed" {
				if err = os.Remove(p); err != nil && !os.IsNotExist(err) {
					return err
				}
				continue
			}
			info, err := e.Info()
			if err != nil {
				return err
			}
			used += info.Size()
		}
		if filepath.Ext(e.Name()) == ".json" {
			info, statErr := e.Info()
			if statErr != nil {
				return statErr
			}
			used += info.Size()
			r, err := readImageReceipt(p)
			if err != nil {
				return err
			}
			if r.ResultHash == "" && (r.Protocol == "durable-async-v1" || r.Protocol == "legacy-sync-local-v1" || r.Protocol == image2ProReceiptProtocol) && r.Status != "failed" && r.Status != "expired" {
				used += imageReceiptResultReserve
				if r.Protocol == image2ProReceiptProtocol && r.UpstreamResponseHash == "" {
					used += imageReceiptResultReserve
				}
			}
		}
	}
	requested := imageReceiptResultReserve
	for _, n := range extra {
		requested += n
	}
	if used+requested > imageReceiptStoreBudget {
		return errors.New("image result capacity unavailable")
	}
	f, err := os.CreateTemp(imageReceiptRoot(), ".write-check-")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(f.Name()) }()
	_, err = f.Write([]byte{0})
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func persistImageReceiptResult(path string, r *imageReceiptRecord, data []byte) error {
	if r.ResultHash != "" {
		_, err := loadImageReceiptResult(path, r)
		return err
	}
	// Existing synchronous records get the same storage-before-charge guarantee.
	if r.Protocol != "durable-async-v1" && r.Protocol != "legacy-sync-local-v1" && r.Protocol != image2ProReceiptProtocol {
		if err := imageReceiptStorePreflight(); err != nil {
			return err
		}
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".result-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }()
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	ce := f.Close()
	if err == nil {
		err = ce
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path+".result"); err != nil {
		return err
	}
	r.ResultHash = imageReceiptFingerprint(string(data))
	r.ResultExpiresAt = time.Now().UTC().Add(72 * time.Hour)
	// Journal fsync also fsyncs the containing directory, including result rename.
	return saveImageReceipt(path, r)
}

func loadImageReceiptResult(path string, r *imageReceiptRecord) ([]byte, error) {
	if r.ResultExpiresAt.IsZero() || !time.Now().Before(r.ResultExpiresAt) {
		return nil, errors.New("result expired")
	}
	info, err := os.Stat(path + ".result")
	if err != nil || info.Size() > imageReceiptResultReserve {
		return nil, errors.New("result unavailable")
	}
	b, err := os.ReadFile(path + ".result")
	if err != nil {
		return nil, err
	}
	if imageReceiptFingerprint(string(b)) != r.ResultHash {
		return nil, errors.New("result checksum mismatch")
	}
	if err := validateReceiptImageResultCount(b, imageReceiptExpectedCount(r)); err != nil {
		return nil, err
	}
	return b, nil
}
