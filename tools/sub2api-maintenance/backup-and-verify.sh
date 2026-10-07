#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL backup and isolated restore verification for Sub2API.
# Connection settings follow the standard PGHOST/PGPORT/PGUSER/PGPASSWORD vars.

source_db=${SOURCE_DATABASE:-sub2api}
restore_db=${RESTORE_DATABASE:-}
backup_dir=${BACKUP_DIR:-}
config_paths=${SUB2API_CONFIG_PATHS:-}

if [[ -z "$restore_db" || -z "$backup_dir" ]]; then
  echo "RESTORE_DATABASE and BACKUP_DIR are required" >&2
  exit 2
fi
if [[ ! "$source_db" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || [[ ! "$restore_db" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "database names may contain only letters, digits, and underscores" >&2
  exit 2
fi
if [[ "$source_db" == "$restore_db" ]]; then
  echo "RESTORE_DATABASE must differ from SOURCE_DATABASE" >&2
  exit 2
fi

umask 077
mkdir -p "$backup_dir/config"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump_path="$backup_dir/sub2api-$stamp.dump"
manifest_path="$backup_dir/sub2api-$stamp.manifest"

if psql -X -Atqc "SELECT 1 FROM pg_database WHERE datname = '$restore_db'" postgres | grep -qx 1; then
  echo "restore target already exists; refusing to overwrite: $restore_db" >&2
  exit 3
fi

pg_dump --format=custom --no-owner --no-privileges --file="$dump_path" "$source_db"
sha256sum "$dump_path" > "$manifest_path"

if [[ -n "$config_paths" ]]; then
  IFS=':' read -r -a paths <<< "$config_paths"
  for config_path in "${paths[@]}"; do
    [[ -f "$config_path" ]] || { echo "config path not found: $config_path" >&2; exit 4; }
    cp -- "$config_path" "$backup_dir/config/$(basename "$config_path")"
  done
fi

createdb "$restore_db"
restore_ok=false
cleanup_failed_restore() {
  if [[ "$restore_ok" != true ]]; then
    dropdb --if-exists "$restore_db" >/dev/null 2>&1 || true
  fi
}
trap cleanup_failed_restore EXIT
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$restore_db" "$dump_path"

tables=(users api_keys groups accounts schema_migrations)
declare -A order_columns=(
  [users]=id
  [api_keys]=id
  [groups]=id
  [accounts]=id
  [schema_migrations]=filename
)
printf 'table\tsource_count\trestored_count\tdigest_match\n'
for table in "${tables[@]}"; do
  order_column=${order_columns[$table]}
  source_count=$(psql -X -Atqc "SELECT count(*) FROM $table" "$source_db")
  restored_count=$(psql -X -Atqc "SELECT count(*) FROM $table" "$restore_db")
  source_digest=$(psql -X -Atqc "SELECT md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY $order_column), '')) FROM $table t" "$source_db")
  restored_digest=$(psql -X -Atqc "SELECT md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY $order_column), '')) FROM $table t" "$restore_db")
  match=false
  [[ "$source_count" == "$restored_count" && "$source_digest" == "$restored_digest" ]] && match=true
  printf '%s\t%s\t%s\t%s\n' "$table" "$source_count" "$restored_count" "$match"
  [[ "$match" == true ]] || { echo "restore verification failed for $table" >&2; exit 5; }
done

psql -X -AtF $'\t' -c \
  "SELECT g.name, g.platform, g.status, g.model_allowlist::text,
          a.name, a.platform, a.type, a.status,
          a.credentials->>'base_url', a.credentials->'model_mapping'
   FROM groups g
   JOIN account_groups ag ON ag.group_id = g.id
   JOIN accounts a ON a.id = ag.account_id
   WHERE g.name LIKE 'GPT-5.6 Sol %'
   ORDER BY g.name, a.name" "$restore_db"

restore_ok=true
trap - EXIT
echo "BACKUP_PATH=$dump_path"
echo "MANIFEST_PATH=$manifest_path"
echo "RESTORE_DATABASE=$restore_db"
echo "RESTORE_VERIFIED=true"
