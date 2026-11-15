#!/bin/sh
set -eu

: "${OPENLEEK_FINANCIAL_REDIS_PASSWORD:=openleek-financial-redis-password}"
: "${OPENLEEK_SOCIAL_REDIS_PASSWORD:=openleek-social-redis-password}"
: "${OPENLEEK_REDIS_ADMIN_PASSWORD:=openleek-redis-admin-password}"

for password in "$OPENLEEK_FINANCIAL_REDIS_PASSWORD" "$OPENLEEK_SOCIAL_REDIS_PASSWORD" "$OPENLEEK_REDIS_ADMIN_PASSWORD"; do
  case "$password" in
    *[!A-Za-z0-9_-]*) echo "Redis ACL passwords must be URL-safe" >&2; exit 1 ;;
  esac
done

umask 077
acl_file=/tmp/openleek-users.acl
{
  echo 'user default on nopass -@all +ping'
  echo "user admin on >${OPENLEEK_REDIS_ADMIN_PASSWORD} ~* &* +@all"
  echo "user financial on >${OPENLEEK_FINANCIAL_REDIS_PASSWORD} ~financial-market:* -@all +ping +auth +select +xadd +xgroup +xreadgroup +xack +xautoclaim +xpending +xdel +del"
  echo "user social on >${OPENLEEK_SOCIAL_REDIS_PASSWORD} ~social:* -@all +ping +auth +select +xadd +xgroup +xreadgroup +xack +xautoclaim +xpending +xdel +del"
} > "$acl_file"

exec redis-server --appendonly yes --aclfile "$acl_file"
