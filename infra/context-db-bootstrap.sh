#!/bin/sh
# Create the isolated bounded-context databases and their only owner roles.

set -eu

: "${POSTGRES_USER:=openleek_admin}"
: "${POSTGRES_PASSWORD:=openleek-admin-password}"
: "${POSTGRES_HOST:=127.0.0.1}"
: "${POSTGRES_PORT:=5432}"
: "${OPENLEEK_EXPERIMENT_DB_PASSWORD:=openleek-experiment-password}"
: "${OPENLEEK_AGENT_EXECUTION_DB_PASSWORD:=openleek-agent-execution-password}"
: "${OPENLEEK_SOCIAL_ENVIRONMENT_DB_PASSWORD:=openleek-social-environment-password}"
: "${OPENLEEK_FINANCIAL_MARKET_DB_PASSWORD:=openleek-financial-market-password}"
: "${OPENLEEK_LLM_CONFIGURATION_DB_PASSWORD:=openleek-llm-configuration-password}"
: "${OPENLEEK_HINDSIGHT_DB_PASSWORD:=openleek-hindsight-password}"
: "${OPENLEEK_CONTEXT_REGISTRY_DB_PASSWORD:=openleek-context-registry-password}"
: "${OPENLEEK_CONTEXT_GATEWAY_DB_PASSWORD:=openleek-context-gateway-password}"
: "${OPENLEEK_NEWS_CONTEXT_DB_PASSWORD:=openleek-news-context-password}"

export PGPASSWORD="$POSTGRES_PASSWORD"
psql_base="psql --host=$POSTGRES_HOST --port=$POSTGRES_PORT --username=$POSTGRES_USER --no-password --set=ON_ERROR_STOP=1 --dbname=postgres"

configure_context() {
  role_name="$1"
  database_name="$2"
  password="$3"

  # shellcheck disable=SC2086
  $psql_base \
    --set=role_name="$role_name" \
    --set=database_name="$database_name" \
    --set=role_password="$password" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
  :'role_name'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')
\gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'role_name', :'role_password')
\gexec
SELECT format(
  'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
  :'role_name'
)
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database_name', :'role_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database_name')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'database_name', :'role_name')
\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database_name')
\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM %I', :'database_name', :'role_name')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'role_name')
\gexec
SQL
}

configure_context \
  openleek_experiment_owner \
  openleek_experiment \
  "$OPENLEEK_EXPERIMENT_DB_PASSWORD"
configure_context \
  openleek_agent_execution_owner \
  openleek_agent_execution \
  "$OPENLEEK_AGENT_EXECUTION_DB_PASSWORD"
configure_context \
  openleek_social_environment_owner \
  openleek_social_environment \
  "$OPENLEEK_SOCIAL_ENVIRONMENT_DB_PASSWORD"
configure_context \
  openleek_financial_market_owner \
  openleek_financial_market \
  "$OPENLEEK_FINANCIAL_MARKET_DB_PASSWORD"
configure_context \
  openleek_llm_configuration_owner \
  openleek_llm_configuration \
  "$OPENLEEK_LLM_CONFIGURATION_DB_PASSWORD"
configure_context \
  openleek_hindsight_owner \
  openleek_hindsight \
  "$OPENLEEK_HINDSIGHT_DB_PASSWORD"
configure_context openleek_context_registry_owner openleek_context_registry "$OPENLEEK_CONTEXT_REGISTRY_DB_PASSWORD"
configure_context openleek_context_gateway_owner openleek_context_gateway "$OPENLEEK_CONTEXT_GATEWAY_DB_PASSWORD"
configure_context openleek_news_context_owner openleek_news_context "$OPENLEEK_NEWS_CONTEXT_DB_PASSWORD"

# pgvector is installed by the admin before the isolated Hindsight owner runs
# its own application migrations.
$psql_base --dbname=openleek_hindsight <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
GRANT CREATE ON DATABASE openleek_hindsight TO openleek_hindsight_owner;
GRANT TEMPORARY ON DATABASE openleek_hindsight TO openleek_hindsight_owner;
SQL

# This is intentionally explicit rather than relying on the databases being
# fresh. Re-running the bootstrap removes any accidental cross-Context grants.
# The owner retains its own CONNECT privilege; no Context owner receives one
# for another Context database.
$psql_base <<'SQL'
DO $$
DECLARE
  owner_role text;
  target_role text;
  database_name text;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY[
    'openleek_experiment_owner',
    'openleek_agent_execution_owner',
    'openleek_social_environment_owner',
    'openleek_financial_market_owner',
    'openleek_llm_configuration_owner',
    'openleek_hindsight_owner',
    'openleek_context_registry_owner',
    'openleek_context_gateway_owner',
    'openleek_news_context_owner'
  ] LOOP
    FOREACH target_role IN ARRAY ARRAY[
      'openleek_experiment_owner',
      'openleek_agent_execution_owner',
      'openleek_social_environment_owner',
      'openleek_financial_market_owner',
      'openleek_llm_configuration_owner',
      'openleek_hindsight_owner',
      'openleek_context_registry_owner',
      'openleek_context_gateway_owner',
      'openleek_news_context_owner'
    ] LOOP
      IF owner_role <> target_role THEN
        SELECT datname INTO database_name
        FROM pg_database
        WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = target_role);
        IF database_name IS NOT NULL THEN
          EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', database_name, owner_role);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;
SQL
