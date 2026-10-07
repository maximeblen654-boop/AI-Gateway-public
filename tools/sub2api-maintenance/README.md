# Sub2API maintenance

`backup-and-verify.sh` creates a PostgreSQL custom-format dump, copies explicitly
listed runtime configuration files with owner-only permissions, restores into a new
database, and compares counts plus full-row digests for users, API keys, product
groups, upstream accounts, and schema migrations. It refuses to overwrite an existing
database or restore into the source database.

Example (run as a PostgreSQL role allowed to create databases):

```bash
SOURCE_DATABASE=sub2api \
RESTORE_DATABASE=sub2api_restore_20260919 \
BACKUP_DIR=/secure/local/sub2api-backups/20260919 \
SUB2API_CONFIG_PATHS=/opt/sub2api/config.yaml:/opt/sub2api/.env \
./tools/sub2api-maintenance/backup-and-verify.sh
```

The backup contains credentials because upstream account secrets live in PostgreSQL
and runtime configuration contains database/JWT secrets. Keep the directory encrypted,
private, and outside Git. Redis is intentionally excluded: it contains rebuildable
caches, concurrency leases, sticky/session routing state, rate-limit windows, cooldowns,
temporary unschedulable flags, idempotency/runtime locks, and invalidation signals; the
durable source of truth is PostgreSQL plus runtime configuration.
