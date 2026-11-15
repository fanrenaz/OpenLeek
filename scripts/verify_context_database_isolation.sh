#!/usr/bin/env bash
# Exercise the live four-Context database privilege matrix through Compose.
# It deliberately uses the admin socket inside the isolated Postgres service,
# never a developer's database or a host-published port.

set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
compose=(docker compose -f "$root_dir/infra/docker-compose.contexts.yml")

read -r -d '' query <<'SQL' || true
WITH contexts(role_name, database_name) AS (
  VALUES
    ('openleek_experiment_owner', 'openleek_experiment'),
    ('openleek_agent_execution_owner', 'openleek_agent_execution'),
    ('openleek_social_environment_owner', 'openleek_social_environment'),
    ('openleek_financial_market_owner', 'openleek_financial_market')
), matrix AS (
  SELECT
    requester.role_name,
    target.database_name,
    has_database_privilege(requester.role_name, target.database_name, 'CONNECT') AS can_connect,
    (SELECT rolsuper FROM pg_roles WHERE rolname = requester.role_name) AS is_superuser,
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = requester.database_name) = requester.role_name AS owns_database
  FROM contexts AS requester
  CROSS JOIN contexts AS target
)
SELECT role_name || '|' || database_name || '|' || can_connect || '|' || is_superuser || '|' || owns_database
FROM matrix
ORDER BY role_name, database_name;

SELECT 'DATABASES|' || string_agg(datname, ',' ORDER BY datname)
FROM pg_database
WHERE datname LIKE 'openleek_%';
SQL

result=$("${compose[@]}" exec -T postgres \
  psql --username=openleek_admin --dbname=postgres --no-align --tuples-only \
  --set=ON_ERROR_STOP=1 --command "$query")

expected_databases="openleek_agent_execution,openleek_experiment,openleek_financial_market,openleek_social_environment"
while IFS='|' read -r role database can_connect is_superuser owns_database; do
  if [[ "$role" == "DATABASES" ]]; then
    [[ "$database" == "$expected_databases" ]] || {
      echo "unexpected OpenLeek databases: $database" >&2
      exit 1
    }
    continue
  fi
  [[ "$is_superuser" == "false" && "$owns_database" == "true" ]] || {
    echo "$role is not a non-superuser owner of its database" >&2
    exit 1
  }
  owner_database=${role%_owner}
  if [[ "$database" == "$owner_database" ]]; then
    [[ "$can_connect" == "true" ]] || {
      echo "$role cannot connect to its own database" >&2
      exit 1
    }
  else
    [[ "$can_connect" == "false" ]] || {
      echo "$role can unexpectedly connect to $database" >&2
      exit 1
    }
  fi
done <<< "$result"

echo "four Context database owners are dynamically isolated"
