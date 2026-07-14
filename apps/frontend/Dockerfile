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
COPY apps/frontend apps/frontend
RUN pnpm --filter @microshop/frontend run build

FROM nginxinc/nginx-unprivileged:1.29.8-alpine3.23 AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/frontend/dist /usr/share/nginx/html
EXPOSE 8080
