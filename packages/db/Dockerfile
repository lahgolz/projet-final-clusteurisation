FROM node:22.23.1-alpine3.24 AS base

ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /workspace

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --prod --filter @microshop/db

FROM deps AS runtime
ENV NODE_ENV=production
COPY packages/db packages/db
WORKDIR /workspace/packages/db
USER node
ENTRYPOINT ["pnpm", "run"]
CMD ["migrate:up"]
