-- Customer amounts are USD NUMERIC(20,8); supplier CNY costs do not enter this ledger.
CREATE TABLE IF NOT EXISTS studio_video_orders (
    child_id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    api_key_id BIGINT NOT NULL,
    group_id BIGINT NOT NULL,
    quote_id TEXT NOT NULL,
    capability_version TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    hold_fingerprint TEXT NOT NULL,
    hold_amount NUMERIC(20,8) NOT NULL CHECK (hold_amount > 0),
    currency TEXT NOT NULL CHECK (currency = 'USD'),
    state TEXT NOT NULL CHECK (state IN ('HELD', 'CAPTURED', 'RELEASED')),
    actual_amount NUMERIC(20,8) CHECK (actual_amount >= 0),
    final_fingerprint TEXT,
    supplier_task_id TEXT,
    release_reason TEXT,
    hold_balance NUMERIC(20,8) NOT NULL,
    hold_frozen_balance NUMERIC(20,8) NOT NULL,
    final_balance NUMERIC(20,8),
    final_frozen_balance NUMERIC(20,8),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalized_at TIMESTAMPTZ,
    CONSTRAINT studio_video_orders_final_consistency CHECK (
        (state = 'HELD' AND actual_amount IS NULL AND final_fingerprint IS NULL AND finalized_at IS NULL)
        OR (state = 'CAPTURED' AND actual_amount IS NOT NULL AND final_fingerprint IS NOT NULL AND finalized_at IS NOT NULL)
        OR (state = 'RELEASED' AND actual_amount IS NULL AND final_fingerprint IS NOT NULL AND finalized_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS studio_video_orders_user_created_idx ON studio_video_orders (user_id, created_at DESC);
