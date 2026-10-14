package service

import "errors"

// Only allowlisted stage codes cross the HTTP boundary. Never serialize the
// underlying error: DB/transport errors may contain credentials or routes.
type StudioQuoteError struct {
	Stage string
	Cause error
}

func (e *StudioQuoteError) Error() string { return "studio quote rejected: " + e.Stage }
func (e *StudioQuoteError) Unwrap() error { return e.Cause }
func QuoteFailure(stage string, err error) error {
	if err == nil {
		return nil
	}
	return &StudioQuoteError{stage, err}
}
func QuoteFailureStage(err error) string {
	var q *StudioQuoteError
	if errors.As(err, &q) {
		switch q.Stage {
		case "billing_eligibility", "published_offer", "price", "account", "account_admission", "execution", "account_cost", "quote_store":
			return q.Stage
		}
	}
	return "binding"
}
