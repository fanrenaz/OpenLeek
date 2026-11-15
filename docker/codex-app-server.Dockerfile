FROM node:22-bookworm-slim

# Keep the image protocol-compatible with the host's proven app-server CLI.
# Sandbox joins the Node group only for the single per-run bind mount prepared
# by Agent Execution. It never receives Docker-control connectivity.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends bubblewrap ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "@openai/codex@0.146.0" \
  && useradd --uid 10001 --gid node --create-home --home-dir /home/sandbox --shell /usr/sbin/nologin sandbox \
  && install -d -o sandbox -g node -m 0770 /var/lib/codex /var/lib/openleek/runs

COPY infra/codex-sandbox/app-server-entrypoint.sh /usr/local/bin/openleek-codex-app-server
COPY infra/codex-sandbox/app-server-health.mjs /usr/local/lib/openleek/app-server-health.mjs
COPY infra/codex-sandbox/auth-broker.mjs /usr/local/lib/openleek/auth-broker.mjs
COPY infra/codex-sandbox/requirements.toml /etc/codex/requirements.toml
COPY infra/codex-sandbox/user-prompt-submit.mjs /opt/openleek/codex-hooks/user-prompt-submit.mjs
COPY infra/codex-sandbox/pre-tool-use.mjs /opt/openleek/codex-hooks/pre-tool-use.mjs
RUN chmod 0555 /usr/local/bin/openleek-codex-app-server /usr/local/lib/openleek/auth-broker.mjs /opt/openleek/codex-hooks/user-prompt-submit.mjs /opt/openleek/codex-hooks/pre-tool-use.mjs \
  && chmod 0444 /etc/codex/requirements.toml

ENV CODEX_HOME=/var/lib/codex \
    OPENLEEK_SANDBOX_APP_SERVER_PORT=4500 \
    OPENLEEK_SANDBOX_HEALTH_PORT=4501
WORKDIR /var/lib/openleek/runs
USER sandbox:node
EXPOSE 4500 4501
HEALTHCHECK --interval=5s --timeout=3s --retries=20 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4501/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/openleek-codex-app-server"]
