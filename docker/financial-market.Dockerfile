# Financial uses the same mounted TypeScript workspace as the other Next
# services, but keeps its compiled Rust matcher inside the stable tool image.
FROM rust:1.88-bookworm AS napi-builder
WORKDIR /src/crates/matching-engine
COPY crates/matching-engine ./
RUN cargo build --release -p openleek-matching-engine-napi \
  && mkdir -p /out \
  && cp target/release/libopenleek_matching_engine_napi.so /out/openleek_matching_engine.node

FROM node:22-bookworm-slim
RUN npm install --global corepack@0.35.0 \
  && corepack enable

WORKDIR /app
ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    OPENLEEK_MATCHING_ENGINE_NAPI_MODULE=/app/native/openleek_matching_engine.node
COPY --from=napi-builder /out/openleek_matching_engine.node ./native/openleek_matching_engine.node
USER node
EXPOSE 3000
