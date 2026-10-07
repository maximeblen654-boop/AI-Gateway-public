package repository

import (
	"context"
	"database/sql"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// The existing usage-log insert and billing dedup share the same transaction.
// Replace only numeric parameters, so no float round-trip enters the ledger.
func insertQuotedImageUsage(ctx context.Context, tx *sql.Tx, cmd *service.UsageBillingCommand) error {
	receipt := cmd.QuotedImage
	if err := receipt.Quote.Accounting.Validate(receipt.Quote); err != nil {
		return err
	}
	log := service.QuotedImageUsageLog(receipt)
	prepared := prepareUsageLogInsert(log)
	prepared.args[25] = receipt.Quote.Binding.Offer.SalePrice.Amount
	prepared.args[26] = receipt.Quote.Binding.Offer.SalePrice.Amount
	prepared.args[27] = "1"
	prepared.args[28] = receipt.Quote.Accounting.AccountRateMultiplier
	prepared.args[57] = receipt.Quote.Accounting.BaseAmount
	repo := newUsageLogRepositoryWithSQL(nil, tx)
	_, err := repo.createSinglePrepared(ctx, tx, log, prepared)
	return err
}
