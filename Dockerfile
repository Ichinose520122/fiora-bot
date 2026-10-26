# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@11.25.0 --ignore-scripts \
    && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="Fiora Bot - 大肥鱼" \
      org.opencontainers.image.source="https://github.com/Ichinose520122/fiora-bot" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Fiora bot adapted from K0nd1us/QQ-agent 0.4"
ARG INSTALL_FFMPEG=false
RUN if [ "$INSTALL_FFMPEG" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
ENV NODE_ENV=production \
    QQ_AGENT_DATA_DIR=/app/data \
    QQ_AGENT_HOST=0.0.0.0 \
    QQ_AGENT_PORT=3220 \
    TZ=Asia/Shanghai
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json LICENSE NOTICE.md ./
COPY --chown=node:node src ./src
COPY --chown=node:node ui ./ui
COPY --chown=node:node assets ./assets
COPY --chown=node:node plugins ./plugins
COPY --chown=node:node skills ./skills
COPY --chown=node:node config ./config
COPY --chown=node:node scripts/start.mjs scripts/healthcheck.mjs ./scripts/
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3220
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]
STOPSIGNAL SIGTERM
CMD ["node", "scripts/start.mjs"]
