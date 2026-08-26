# Deploy da API — VPS (development/piloto)

Infraestrutura **temporaria**. Tailscale Funnel, sem dominio proprio, sem Nginx.
Nao trate como arquitetura final de producao.

## Imagem

Buildada no GitHub Actions e publicada no GHCR. **Nunca buildar na VPS**: ela
tem 1 vCPU e roda a automacao de WhatsApp de uma cliente real.

O deploy usa **sempre uma tag por commit SHA**. `latest` existe no GHCR por
conveniencia, mas um deploy que aponta para um ponteiro movel nao e
reproduzivel nem tem rollback confiavel.

## Arquivos na VPS

```
/opt/clinic-saas/
  docker-compose.yml     <- copia de docker/clinic-saas.compose.yml
  .env                   <- modo 600, NUNCA versionado
  .env.previous-tag      <- tag anterior, para rollback
```

## .env (modo 600)

```
NODE_ENV=production
API_PORT=3333
SUPABASE_URL=https://<projeto>.supabase.co
SUPABASE_ANON_KEY=<anon/publishable key>
WEB_ORIGIN=https://saas-clinic-web.vercel.app
IMAGE_TAG=sha-<commit-sha-completo>
```

**Ausentes por construcao:** `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` e a
senha do banco. A API usa anon key + JWT do usuario; o RLS e a barreira real.
`.env.test` nunca vai para a VPS.

## Atualizar para uma nova versao

```bash
cd /opt/clinic-saas

# 1. Registra a tag atual ANTES de trocar — e o rollback.
grep '^IMAGE_TAG=' .env > .env.previous-tag

# 2. Aponta para a nova tag (SHA completo do commit).
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=sha-<novo-sha>|" .env

# 3. Puxa e sobe.
docker compose pull
docker compose up -d

# 4. Valida.
curl -s http://127.0.0.1:3333/api/health
docker compose ps
```

## Rollback

```bash
cd /opt/clinic-saas
cp .env.previous-tag /tmp/prev && \
  sed -i "s|^IMAGE_TAG=.*|$(cat /tmp/prev)|" .env
docker compose up -d
curl -s http://127.0.0.1:3333/api/health
```

Como a tag anterior e um SHA imutavel, o rollback devolve exatamente o binario
que estava rodando — nao "o que `latest` apontava naquele dia".

## Verificacao obrigatoria apos qualquer deploy

A automacao da cliente compartilha esta VPS. Depois de subir ou reverter:

```bash
pm2 list                                       # bot-longatti online, restarts inalterados
docker ps --format '{{.Names}} {{.Status}}'    # evolution/postgres/redis Up
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080
free -h
```

Se o contador de restarts do `bot-longatti` subir, reverter imediatamente.
