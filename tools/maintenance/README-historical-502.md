# Authorized historical HTTP 502 finalization

This is an offline maintenance operation for exactly the three IDs in `execute_historical_image_502.py`. It is not an endpoint, automatic retry, runtime deployment, or supplier refund assertion. Source runtime remains 4f10be20.

The pure transform is exercised by the real Go Store/Recover/Dispatch/Settle guards and BFF history/recover/dispatch tests. A partial commit after the unit envelope is recoverable by the existing Core. A stale unknown recovery has no result and cannot settle; after reading the new unit envelope it can only produce the same no-charge finality. The permanent original claims are never modified.

The driver defaults to a read-only plan. Production apply requires sealed current file fingerprints, archived native HTTP evidence, exact owner/quote/claims, zero native usage/dedup and holds, unchanged business tables, the fixed 4f10 process identities and no incomplete dispatcher. All three original dispatches predate the current Core process. The deploy lock excludes cooperating maintainers; briefly pausing the three application containers provides actual process exclusion during CAS writes. This does not restart processes or change managed paid-control state. PostgreSQL/Redis remain untouched.

Backups and write intent are fsynced before mutation. Each task commits unit envelope, parent receipt, then BFF view; all writes preserve file permissions/ownership and use fsync+rename with immediate SHA recheck. On failure, do not restore unknown over a committed no-charge envelope. Preserve the intent and inspect/complete only the authorized target. Never erase the old evidence, claim or backup. An in-flight BFF GET that began before the pause can return a stale view; a subsequent original-task GET converges through the already-tested terminal Core response without generation or settlement.

The historical upstream body/hash and upstream request ID were not saved. `response_hash` is empty and no upstream ID is fabricated. External audit links the verified Core request ID and native502 archive; the public message is the existing fixed safe failure message.

Before executing, review the current source and production evidence; do not rerun an old operation directory. New IDs require new explicit authorization. Keep the backup private (original journals contain user input and quote identifiers). Publish only redacted hashes and results.

The initial whole-accounts snapshot drifted before any apply. Two read-only samples identified unrelated Accounts 16/26 extra+updated_at updates (existing native upstream billing probe metadata). Account77 had not changed. The operation therefore freezes and compares the entire accounts table immediately before/after its writes, while separately requiring every Account77 field and all other protected business tables to match the sealed preflight. No probe settings are changed or probes invoked.
