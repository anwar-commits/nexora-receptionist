# DOC-RECEPTIONIST: API + web app in one image (used by render.yaml).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @dr/contracts --filter @dr/db --filter @dr/api --filter @dr/web build \
 && pnpm --filter @dr/api deploy --prod --legacy /out/api \
 && cp -r apps/web/dist /out/web \
 && cp -r packages/db/migrations /out/api/node_modules/@dr/db/migrations 2>/dev/null || true

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_OPTIONS=--enable-source-maps
COPY --from=build /out/api ./
COPY --from=build /out/web ./web
COPY infra/render/start.sh ./start.sh
RUN chmod +x start.sh && mkdir -p /data/recordings
EXPOSE 4000
CMD ["./start.sh"]
