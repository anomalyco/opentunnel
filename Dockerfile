# syntax=docker/dockerfile:1
# The hosted service: crates/opentunnel-server and the website it serves. See fly.toml and docs/server.md.

FROM oven/bun:1.4.2 AS website
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json index.html vite.config.ts ./
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bunx vite build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p opentunnel-server \
    && cp target/release/opentunnel-server /usr/local/bin/opentunnel-server

FROM gcr.io/distroless/cc-debian12
COPY --from=server /usr/local/bin/opentunnel-server /usr/local/bin/opentunnel-server
COPY --from=website /src/dist/website /app/website
ENV WEBSITE_DIR=/app/website \
    TLS_LISTEN=[::]:8443 \
    HTTP_LISTEN=[::]:8080
EXPOSE 8443 8080
ENTRYPOINT ["/usr/local/bin/opentunnel-server"]
