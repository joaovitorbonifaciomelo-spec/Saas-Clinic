# SaaS Clínicas — Fundação v0.1

Fundação técnica de um SaaS multi-clínica. Esta versão existe para provar três coisas antes de qualquer módulo de produto: que a stack compila e roda, que a autenticação funciona ponta a ponta, e que **o isolamento entre clínicas é garantido pelo banco de dados**.

WhatsApp, agenda, atendimento, confirmações, financeiro e prontuário estão **fora do escopo** desta fase.

---

## Stack e versões escolhidas

Nenhuma versão foi fixada por preferência. Cada uma é o `latest` estável que é mutuamente compatível com as demais e com Node 24.

| Pacote                | Versão                       | Por quê                                                                                                                                                 |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                  | ≥ 20.9 (testado em 24.17)    | exigência do Next 16 e do NestJS 11                                                                                                                     |
| pnpm                  | 11.24.0                      | pinado em `packageManager`                                                                                                                              |
| **TypeScript**        | **6.0.3**                    | **não é o `latest`.** O `latest` é 7.0.2, mas `typescript-eslint@8.68.0` declara `typescript >=4.8.4 <6.1.0`. 6.0.3 é o mais novo que satisfaz o linter |
| Next.js               | 16.3.3                       | App Router                                                                                                                                              |
| React                 | 19.2.8                       | exigido pelo Next 16                                                                                                                                    |
| NestJS                | 11.2.3                       | core, common, platform-express                                                                                                                          |
| @supabase/supabase-js | 2.112.4                      |                                                                                                                                                         |
| @supabase/ssr         | 0.12.5                       | exige `supabase-js ^2.112.4`                                                                                                                            |
| zod                   | 4.4.3                        | validação compartilhada web ↔ api                                                                                                                       |
| ESLint                | 10.9.1 + `@eslint/js` 10.0.1 | flat config                                                                                                                                             |
| Vitest                | 4.1.11                       | runner único do monorepo                                                                                                                                |
| Supabase CLI          | 2.115.0                      | via devDependency, sem instalação global                                                                                                                |

`moduleResolution` é `Node16` e não `node10` porque o TS 6 marcou `node10` como depreciado com erro.

---

## Estrutura

```
apps/
  web/          Next.js — autenticação, onboarding, dashboard, pacientes
  api/          NestJS — REST /me /clinics /patients
packages/
  shared/       schemas zod + tipos de contrato (fonte única web ↔ api)
  config/       presets de TypeScript, ESLint e Prettier
supabase/
  migrations/   SQL versionado
  tests/        teste de isolamento entre clínicas
scripts/        verificador da fronteira de segredos
docker/         Dockerfiles e compose (NÃO testados — ver Limitações)
docs/           architecture.md
```

---

## Pré-requisitos

- Node ≥ 20.9
- pnpm 11 (`npm install -g pnpm` ou `corepack enable pnpm`)
- Um projeto Supabase (o local via Docker não é necessário)

---

## Configuração

As variáveis são separadas em **três escopos** com fronteira física entre eles. Isso não é organização cosmética: se a `service_role` entrar na API ou no frontend, o RLS deixa de ser garantia, porque essa chave passa por cima dele.

```bash
pnpm install

cp apps/web/.env.example  apps/web/.env.local
cp apps/api/.env.example  apps/api/.env
cp .env.test.example      .env.test
```

| Arquivo               | Escopo                     | Contém                                                                             |
| --------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `apps/web/.env.local` | público (vai ao navegador) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL` |
| `apps/api/.env`       | servidor de aplicação      | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `API_PORT`, `WEB_ORIGIN`                      |
| `.env.test`           | **administrativo/testes**  | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`                                     |

Onde encontrar cada valor no painel do Supabase:

- `SUPABASE_URL` — Settings → API → Project URL
- `ANON_KEY` — Settings → API → anon / publishable key
- `SERVICE_ROLE_KEY` — Settings → API → service_role / secret key
- `SUPABASE_DB_URL` — Settings → Database → Connection string

A `anon key` é pública por design: sozinha ela não abre nada, quem decide o que ela enxerga é o RLS. A `service_role` **bypassa o RLS** e só aparece em `.env.test`.

Verificação automatizada dessa fronteira:

```bash
pnpm check:secrets
```

---

## Aplicar as migrations

```bash
pnpm supabase login
pnpm supabase link --project-ref SEU_PROJECT_REF
pnpm db:push
```

`db push` funciona contra um projeto hospedado **sem Docker**. Só `supabase start` e `db diff` exigem Docker.

Depois disso, em Authentication → Providers → Email, **desative "Confirm email"** para desenvolvimento. Com a confirmação ligada, o cadastro pela tela não cria sessão imediatamente.

> ⚠️ Esta migration **instala um trigger em `auth.users`**, chamado `clinic_saas_on_auth_user_created`, apoiado na função `public.clinic_saas_handle_new_user()`. Antes de aplicar num projeto que já tenha outra coisa rodando, confirme que esses dois nomes não existem — a migration usa `drop trigger if exists` e `create or replace function`, que substituiriam objetos homônimos sem erro nem aviso.

---

## Rodar

```bash
pnpm dev           # web em :3000 e api em :3333
```

Ou separadamente:

```bash
pnpm --filter @clinicas/api dev
pnpm --filter @clinicas/web dev
```

---

## Verificação

```bash
pnpm lint
pnpm typecheck
pnpm test            # unitários, não tocam o banco
pnpm check:secrets
```

### Teste de isolamento entre clínicas (critério de aceite)

Requer `.env.test` preenchido e migrations aplicadas. Suba a API antes para incluir também as asserções de nível HTTP (elas são puladas se a API estiver fora do ar):

```bash
pnpm --filter @clinicas/api dev     # em outro terminal
pnpm test:isolation
```

O teste monta sozinho o cenário Usuário A → Clínica A → Paciente A e Usuário B → Clínica B → Paciente B, verifica que nenhum lado enxerga nem altera o dado do outro — inclusive com requisição manual usando o ID alheio e com `X-Clinic-Id` forjado — e limpa tudo ao final. É reexecutável.

> ⚠️ **Somente `development` ou `staging`.** O teste cria e remove usuários reais com `service_role`. Ele exige `SUPABASE_TEST_ENVIRONMENT=development` (ou `staging`) no `.env.test` e **recusa executar** se a variável estiver ausente ou com outro valor. Nunca aponte para produção.

#### Limpeza de execução interrompida

Cada execução gera um `test_run_id` (UUID) e grava um manifesto em `supabase/tests/.runs/<test_run_id>.json` com os IDs exatos criados — antes que qualquer coisa possa falhar. Em condições normais o manifesto é apagado no fim.

Se o processo for interrompido, o resíduo é removido **explicitamente por ID**:

```bash
pnpm test:isolation:cleanup --list          # execuções com resíduo pendente
pnpm test:isolation:cleanup <test_run_id>   # remove só os IDs daquela execução
```

**Não existe varredura automática do banco.** Nada de `LIKE`, prefixo de nome ou `delete where name...`: se o manifesto não listar o recurso, nenhum script o toca. Deixar um resíduo de teste esquecido custa muito menos do que uma query de limpeza que alcance dado legítimo.

---

## Fluxo do usuário

1. `/signup` cria a conta; um trigger cria o `profile`.
2. `/login` autentica.
3. Sem nenhuma clínica, o usuário cai em `/onboarding`.
4. Ao informar o nome, a RPC `create_clinic_with_owner` cria a clínica e o torna **admin**, na mesma transação.
5. `/dashboard` mostra clínica, usuário, papel e logout.
6. `/patients` permite listar, adicionar, ver e editar pacientes — sempre da clínica ativa.

---

## Limitações conhecidas

- **Docker não foi testado.** Os arquivos em `docker/` foram escritos mas nunca construídos, porque não há Docker instalado na máquina de desenvolvimento. Trate-os como ponto de partida, não como algo verificado.
- `AuthGuard` valida o token via `auth.getUser()`, o que custa uma chamada de rede por requisição. Correto e simples; trocar por verificação local via JWKS quando virar gargalo.
- Não há troca de clínica ativa na interface: usa-se a primeira membership. O suporte a múltiplas clínicas já existe no schema.
- Convite e gestão de membros estão fora do escopo, e por isso `clinic_members` é **somente leitura** via RLS.

Detalhes de arquitetura e do modelo de segurança: [docs/architecture.md](docs/architecture.md).
