#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
runtime_dir="${repo_dir}/.runtime/prebuilt"
release_id="${OPENLEEK_PREBUILT_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
release_dir="${runtime_dir}/releases/${release_id}"
mkdir -p "${runtime_dir}/releases"
build_dir="$(mktemp -d "${runtime_dir}/build.XXXXXX")"
release_stage="$(mktemp -d "${runtime_dir}/release.XXXXXX")"

cleanup() {
  rm -rf -- "${build_dir}" "${release_stage}"
}
trap cleanup EXIT

if [[ -e "${release_dir}" ]]; then
  printf 'Prebuilt release already exists: %s\n' "${release_dir}" >&2
  exit 2
fi

source_dir="${build_dir}/source"
mkdir -p "${source_dir}"
rsync -a \
  --exclude '/.git/' \
  --exclude '/.runtime/' \
  --exclude '/node_modules/' \
  --exclude '**/node_modules/' \
  --exclude '**/.next/' \
  --exclude '**/.next-*' \
  --exclude '/crates/*/target/' \
  --exclude '/infra/codex-home/' \
  --exclude '/reports/' \
  --exclude '/runs/' \
  "${repo_dir}/" "${source_dir}/"

ln -s "${repo_dir}/node_modules" "${source_dir}/node_modules"
for workspace in "${repo_dir}"/apps/* "${repo_dir}"/packages/*; do
  [[ -d "${workspace}/node_modules" ]] || continue
  relative="${workspace#${repo_dir}/}"
  mkdir -p "${source_dir}/${relative}"
  ln -s "${workspace}/node_modules" "${source_dir}/${relative}/node_modules"
done

apps=(
  context-registry
  context-gateway
  context-provisioner
  news-context
  llm-configuration
  agent-execution
  social-environment
  financial-market
  experiment
  console
)
packages=(
  @openleek/context-registry
  @openleek/context-gateway
  @openleek/context-provisioner
  @openleek/news-context
  @openleek/llm-configuration
  @openleek/agent-execution
  @openleek/social-environment
  @openleek/financial-market
  @openleek/experiment
  @openleek/console-next
)

for index in "${!apps[@]}"; do
  app="${apps[$index]}"
  package="${packages[$index]}"
  printf 'Building isolated prebuilt artifact for %s\n' "${app}"
  NEXT_TELEMETRY_DISABLED=1 \
    OPENLEEK_OUTPUT_FILE_TRACING_ROOT="${source_dir}" \
    pnpm --dir "${source_dir}" --filter "${package}" build

  standalone="${source_dir}/apps/${app}/.next/standalone"
  server="${standalone}/apps/${app}/server.js"
  if [[ ! -f "${server}" ]]; then
    printf 'Standalone server is missing for %s: %s\n' "${app}" "${server}" >&2
    exit 2
  fi

  destination="${release_stage}/${app}"
  mkdir -p "${destination}"
  cp -a "${standalone}/." "${destination}/"
  mkdir -p "${destination}/apps/${app}/.next"
  cp -a "${source_dir}/apps/${app}/.next/static" "${destination}/apps/${app}/.next/static"
  if [[ -d "${source_dir}/apps/${app}/public" ]]; then
    cp -a "${source_dir}/apps/${app}/public" "${destination}/apps/${app}/public"
  fi
done

mv "${release_stage}" "${release_dir}"
trap - EXIT
rm -rf -- "${build_dir}"

current="${runtime_dir}/current"
next_link="${runtime_dir}/current.next"
if [[ -e "${current}" && ! -L "${current}" ]]; then
  printf 'Refusing to replace non-symlink prebuilt selector: %s\n' "${current}" >&2
  exit 2
fi
rm -f -- "${next_link}"
ln -s "releases/${release_id}" "${next_link}"
mv -Tf "${next_link}" "${current}"

printf 'Published prebuilt release: %s\n' "${release_dir}"
