# =============================================================================
# Imagem da API NestJS
#
# O build acontece no GitHub Actions, nunca na VPS: aquela maquina tem 1 vCPU e
# roda a automacao de WhatsApp de uma cliente real. Um build local competiria
# com ela pelo unico nucleo.
#
# Quatro stages para que a imagem final NAO carregue devDependencies:
#   manifests  - so os package.json, camada estavel de cache
#   build      - com devDependencies (nest, typescript), gera os dist
#   prod-deps  - arvore de dependencias SO de producao
#   runtime    - prod-deps + dist compilados, nada mais
# =============================================================================
FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# -----------------------------------------------------------------------------
# manifests — os quatro package.json do workspace.
# apps/web entra apenas com o manifesto: o lockfile descreve o workspace inteiro
# e o --frozen-lockfile recusa se um membro estiver ausente.
# -----------------------------------------------------------------------------
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
COPY apps/api/package.json        apps/api/
COPY apps/web/package.json        apps/web/

# -----------------------------------------------------------------------------
# build — precisa de devDependencies. Nada daqui vai para o runtime alem do dist.
# -----------------------------------------------------------------------------
FROM manifests AS build
RUN pnpm install --frozen-lockfile
COPY packages/ packages/
COPY apps/api/ apps/api/
# O script do api ja compila @clinicas/shared antes do nest build.
RUN pnpm --filter @clinicas/api build

# -----------------------------------------------------------------------------
# prod-deps — arvore separada, so producao.
#
# Os dois projetos sao listados EXPLICITAMENTE, sem o sufixo `...`.
# `@clinicas/api...` pareceria mais elegante, mas a travessia tambem arrasta
# `@clinicas/config` — que e devDependency da api e, ainda assim, declara
# @eslint/js e typescript-eslint como dependencias de PRODUCAO dele. O
# resultado seria a toolchain de lint inteira dentro da imagem de runtime.
# -----------------------------------------------------------------------------
FROM manifests AS prod-deps
RUN pnpm install --prod --frozen-lockfile \
      --filter @clinicas/api \
      --filter @clinicas/shared

# -----------------------------------------------------------------------------
# runtime — dependencias de producao + artefatos compilados.
# -----------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules                 ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/apps/api/node_modules        ./apps/api/node_modules

COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist         ./packages/shared/dist
COPY --from=build /app/apps/api/package.json        ./apps/api/
COPY --from=build /app/apps/api/dist                ./apps/api/dist

# Menor privilegio: a porta e 3333 (>1024), entao root e desnecessario.
# O usuario `node` ja existe na imagem oficial.
USER node
WORKDIR /app/apps/api
EXPOSE 3333
CMD ["node", "dist/main.js"]
