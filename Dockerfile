FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm build && pnpm --filter @kommentarwache/server deploy --prod /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
