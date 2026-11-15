# Stable workspace runtime for the personal OpenLeek instance. Application
# source and pnpm dependencies are mounted by Compose, so ordinary edits never
# invalidate this image or run an install inside Docker.
FROM node:22-bookworm-slim

RUN npm install --global corepack@0.35.0 \
  && corepack enable \
  && mkdir -p /var/lib/openleek/runs \
  && chown -R node:node /var/lib/openleek

WORKDIR /app
ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
USER node
EXPOSE 3000
