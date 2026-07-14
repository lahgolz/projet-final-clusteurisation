FROM node:22.23.1-alpine3.24 AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY services/catalogue/package.json services/catalogue/package.json
COPY services/orders/package.json services/orders/package.json
COPY apps/frontend/package.json apps/frontend/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/catalogue services/catalogue
RUN pnpm --filter @microshop/shared run build
RUN pnpm --filter @microshop/catalogue run build

RUN pnpm --filter @microshop/catalogue deploy --prod --legacy /prod/catalogue

FROM node:22.23.1-alpine3.24 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod/catalogue ./
USER node
EXPOSE 4001
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
