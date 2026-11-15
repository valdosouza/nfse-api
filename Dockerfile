# nfse-api — imagem de produção (DEPLOY.E1.P1.T2, 2026-11-15). Node 20, `npm ci`, build; roda `node dist` (D-F222), nunca tsx nem watch.
# Variáveis e segredos FORA do repositório e FORA da imagem: o `.env`, a chave pública do JWT, a FISCAL_MASTER_KEYS e o arquivo fiscal
# entram pelo ambiente da SaveInCloud (variáveis e volume) — veja o `.dockerignore`.
#
#   docker build --build-arg BUILD_COMMIT=$(git rev-parse HEAD) -t nfse-api:$(git rev-parse --short HEAD) .
#   docker run --env-file /caminho/fora/do/repo/.env -v /dados/nfse-api:/dados -p 3002:3002 nfse-api:<commit>
#   (antes de trocar a que roda: docker run --rm --env-file … -v … nfse-api:<commit> npm run predeploy:check)

# ---- build: dependências completas (o tsc é de dev) + compilação + selo do dist ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/write-build-info.mjs ./scripts/
COPY src ./src
# sem git na imagem: o selo do dist recebe o commit pelo argumento (scripts/write-build-info.mjs)
ARG BUILD_COMMIT=
ENV BUILD_COMMIT=$BUILD_COMMIT
RUN npm run build

# ---- execução: só dependências de produção, o dist, as migrations da família e o contrato ----
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# as migrations da família são lidas do disco a partir do dist (src/migrations/index.ts)
COPY src/migrations/sql ./src/migrations/sql
COPY openapi ./openapi
USER node
EXPOSE 3002
CMD ["node", "dist/server.js"]
