# Arquitetura — Fundação v0.1

## 1. Estrutura do projeto

Monorepo pnpm, sem microserviços e sem orquestrador de build (`turbo` seria peso sem ganho neste tamanho).

```
apps/web       Next.js 16 (App Router). Autenticação, telas, server actions.
apps/api       NestJS 11. REST: /api/me, /api/clinics, /api/patients, /api/health.
packages/shared  Schemas zod + tipos de contrato. Compilado para CommonJS.
packages/config  Presets de TypeScript, ESLint, Prettier.
supabase/        Migrations versionadas + teste de isolamento.
scripts/         Verificador da fronteira de segredos.
```

`packages/shared` é a fonte única dos contratos. O mesmo schema zod valida o formulário no servidor do Next e o corpo da requisição no NestJS — o que elimina a classe de bug em que frontend e backend discordam sobre o que é válido.

---

## 2. Autenticação

Supabase Auth com sessão em cookies, via `@supabase/ssr` 0.12.5.

**A implementação segue o contrato da versão instalada, não uma lembrança de versão anterior.** Concretamente:

- Usa `getAll`/`setAll`. As variantes `get`/`set`/`remove` estão marcadas como depreciadas nos tipos da 0.12.5, e a própria documentação da biblioteca avisa que implementá-las mal causa "logout aleatório, término precoce de sessão e erros de parse de JSON".
- **Não forçamos `httpOnly` nos cookies de sessão.** A biblioteca gerencia esses cookies e precisa lê-los; sobrescrever as flags quebraria o refresh silenciosamente. O cookie que é nosso — `active_clinic_id` — esse sim é `httpOnly`.
- No middleware, a mesma `response` usada no `setAll` é a retornada. Criar uma resposta nova no final descartaria os cookies renovados.

Fluxo:

1. Server actions (`signUpAction`, `signInAction`, `signOutAction`) chamam o Supabase **no servidor**; os cookies de sessão são escritos ali.
2. O middleware roda em toda navegação, renova a sessão e redireciona anônimo para `/login`.
3. Páginas internas são Server Components: obtêm o access token do cookie e chamam a API NestJS com `Authorization: Bearer`.

O access token nunca transita por componente cliente — quem fala com a API é o servidor do Next.

> Nota de versão: o Next 16 exibe o middleware como "Proxy" na saída do build. O arquivo `middleware.ts` na raiz do app continua sendo a convenção válida nesta versão.

---

## 3. Modelo multi-tenant

O tenant é a **clínica**. Quatro tabelas:

| Tabela           | Papel                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `profiles`       | dado de aplicação do usuário, 1:1 com `auth.users`                        |
| `clinics`        | o tenant                                                                  |
| `clinic_members` | ponte usuário ↔ clínica, com papel (`admin`, `attendant`, `professional`) |
| `patients`       | primeiro dado de negócio; existe nesta fase para **provar** o isolamento  |

`clinic_members` tem `unique (clinic_id, user_id)`, então um usuário participar de várias clínicas já é suportado pelo schema — sem migration futura.

### Comportamento na exclusão de usuário

Definido explicitamente, não presumido:

| FK                                       | Regra                        | Consequência                         |
| ---------------------------------------- | ---------------------------- | ------------------------------------ |
| `profiles.id → auth.users.id`            | `CASCADE`                    | perfil some com a conta              |
| `clinic_members.user_id → auth.users.id` | `CASCADE`                    | membership some; a clínica permanece |
| `clinics.created_by → auth.users.id`     | `SET NULL` (coluna nullable) | **a clínica sobrevive ao criador**   |
| `patients.clinic_id → clinics.id`        | `CASCADE`                    | pacientes seguem a clínica           |
| `clinic_members.clinic_id → clinics.id`  | `CASCADE`                    | memberships seguem a clínica         |

A escolha de `SET NULL` em `created_by` é deliberada: a clínica pertence à organização, não a quem clicou em "criar". Um `CASCADE` ali apagaria a clínica inteira e todos os pacientes ao remover um usuário; um `RESTRICT` impediria remover o usuário para sempre.

**Consequência prática:** apagar o usuário **não** apaga a clínica nem os pacientes. Por isso o teardown do teste de isolamento apaga as clínicas primeiro (o que cascateia pacientes e memberships) e só então os usuários. A ordem inversa acumularia clínicas órfãs a cada execução.

---

## 4. Como funciona o clinic membership

Nesta fase, membership só nasce de um jeito: **criando uma clínica**.

`public.create_clinic_with_owner(p_name text)` é `SECURITY DEFINER` e, na mesma transação:

1. exige `auth.uid()` não-nulo;
2. valida o nome (`trim`, 2–120 caracteres — mesma regra do `CHECK` da coluna e do schema zod);
3. insere a clínica com `created_by = auth.uid()` — **sempre da sessão, nunca de parâmetro**;
4. insere o membership `admin`.

Ou nasce tudo, ou nada nasce: nunca uma clínica sem dono.

A função tem `REVOKE EXECUTE ... FROM PUBLIC, anon` e `GRANT EXECUTE ... TO authenticated` declarados no SQL. Isso não é redundante: o default do Postgres é conceder `EXECUTE` a `PUBLIC`, então sem o revoke explícito a RPC ficaria acessível a mais gente do que se espera.

---

## 5. Como o RLS protege os dados

RLS habilitado em todas as quatro tabelas. **Com RLS ativo, ausência de policy é negação total** — e duas ausências aqui são o coração do desenho.

| Tabela           | SELECT                        | INSERT                | UPDATE                          | DELETE      |
| ---------------- | ----------------------------- | --------------------- | ------------------------------- | ----------- |
| `profiles`       | próprio                       | — (trigger)           | próprio                         | —           |
| `clinics`        | `is_clinic_member(id)`        | **nenhuma**           | admin                           | —           |
| `clinic_members` | `is_clinic_member(clinic_id)` | **nenhuma**           | **nenhuma**                     | **nenhuma** |
| `patients`       | membro                        | membro (`WITH CHECK`) | membro (`USING` + `WITH CHECK`) | admin       |

- **`clinics` sem INSERT:** o navegador não cria clínica arbitrária. Só a RPC cria.
- **`clinic_members` somente leitura:** nenhum cliente autenticado se auto-adiciona a uma clínica, se promove a admin ou remove outro membro — nem com token válido e requisição manual via `curl`. Convites voltam a ter policies de escrita quando a feature entrar no escopo.

Além disso, `REVOKE ALL ... FROM anon` em todas as tabelas: o RLS já negaria, mas remover o privilégio é uma segunda barreira independente.

### A armadilha da recursão

As policies usam duas funções `SECURITY DEFINER STABLE`:

```sql
public.is_clinic_member(p_clinic_id uuid) → boolean
public.has_clinic_role(p_clinic_id uuid, p_roles clinic_role[]) → boolean
```

Elas não existem por elegância. Uma policy em `clinic_members` que consulta `clinic_members` reentra na própria policy e o Postgres aborta com `infinite recursion detected in policy`. Uma função `SECURITY DEFINER` roda como o dono, fora do RLS, e quebra o ciclo. É exatamente aqui que implementações ingênuas de multi-tenant falham.

`STABLE` permite ao planner avaliar uma vez por query em vez de por linha. `set search_path = ''` evita sequestro de resolução de nome por um schema no path.

### Por que `clinic_id` não pode ser trocado

Duas defesas, cobrindo casos diferentes:

1. O `WITH CHECK` da policy de UPDATE impede mover um paciente para uma clínica da qual o usuário **não** participa.
2. O trigger `prevent_clinic_id_change` cobre o resto: um usuário que participa de **duas** clínicas passaria no `WITH CHECK` e conseguiria migrar o paciente entre elas. O trigger torna o vínculo com o tenant imutável para qualquer chamador — inclusive `service_role`.

Sem a segunda, a primeira dá uma falsa sensação de completude.

---

## 6. Decisões arquiteturais

### A API nunca usa `service_role`

`apps/api` conhece apenas `SUPABASE_URL` e `SUPABASE_ANON_KEY`. Cada requisição instancia um client Supabase carregando o `Authorization` do usuário, então **toda query chega ao Postgres como o papel `authenticated` daquele usuário** e o RLS decide o que ela enxerga.

A API não filtra por `clinic_id` "na mão" torcendo para não esquecer um `WHERE`: o banco recusa. E como não existe client `service_role` no código, não existe a categoria de bug "esqueci que este client bypassa RLS".

A `service_role` vive só em `.env.test`, usada pelo teste de isolamento para montar e desmontar o cenário — nunca numa asserção.

### `X-Clinic-Id` é dado hostil

O header vem do navegador. O `ClinicMembershipGuard` valida a forma (UUID) e prova a permissão com um `SELECT` em `clinic_members` que já passa pelo RLS. Se o usuário não for membro, a linha não existe para ele e a requisição morre ali.

Mesmo que esse guard fosse removido por engano, o RLS nas tabelas de dados negaria de novo. São duas barreiras **independentes**, não a mesma repetida.

No frontend, o cookie `active_clinic_id` é apenas uma preferência: `resolveActiveClinicId()` o descarta se não constar nas memberships vindas do servidor.

### Ausência tratada por endpoint, sem regra global

Não existe interceptor genérico "resultado vazio → 404". Uma regra assim mascara bug de query como recurso inexistente e mente sobre o que aconteceu.

Em vez disso, cada handler de recurso individual usa `.maybeSingle()` e decide o que fazer com `null`. E o resultado para "não existe" e para "existe, mas é de outro tenant" é **idêntico**: mesmo 404, mesmo corpo. `PATCH` em recurso de outro tenant afeta zero linhas e também retorna 404 — nunca 403, porque um 403 confirmaria que o registro existe.

O filtro de erro traduz apenas códigos do Postgres (`42501` → 403, `23505` → 409, `23514`/`23503`/`22023` → 400, resto → 500 genérico) sem repassar a mensagem crua, que carrega nome de tabela, policy e constraint.

### Separação de segredos em três escopos

| Escopo                | Variáveis                                                     | Arquivo               |
| --------------------- | ------------------------------------------------------------- | --------------------- |
| público               | `NEXT_PUBLIC_*`                                               | `apps/web/.env.local` |
| servidor de aplicação | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `WEB_ORIGIN`, `API_PORT` | `apps/api/.env`       |
| administrativo        | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`                | `.env.test`           |

`pnpm check:secrets` verifica mecanicamente que as variáveis administrativas não aparecem em `apps/web` nem em `apps/api`, que nenhum segredo usa prefixo `NEXT_PUBLIC_`, que os `.env.example` só têm placeholders e que nenhum `.env` está rastreado no git.

### TypeScript 6.0.3 e não 7.0.2

O `latest` do TypeScript é 7.0.2, mas `typescript-eslint@8.68.0` declara suporte a `typescript >=4.8.4 <6.1.0`. Escolher o `latest` do TS custaria o linter type-aware estável. 6.0.3 é o mais novo que satisfaz os dois. Revisitar quando o typescript-eslint publicar suporte estável ao TS 7.

---

## 7. Como testar o isolamento entre clínicas

### Automatizado

```bash
pnpm --filter @clinicas/api dev     # em outro terminal, para incluir os testes HTTP
pnpm test:isolation
```

O teste monta o cenário, executa as asserções com o **JWT real de cada usuário** (portanto quem responde é o RLS) e limpa tudo ao final. Cobertura:

1. **Leitura** — A lista só o Paciente A; pedir explicitamente o id do Paciente B retorna vazio; filtrar por `clinic_id` da Clínica B retorna vazio.
2. **Escrita cruzada** — A não altera, não exclui e não insere na Clínica B; a tentativa de INSERT falha com `42501`; mover o próprio paciente para a Clínica B falha.
3. **Clínicas e memberships** — A vê só a Clínica A e só o próprio membership; não vê o perfil de B; não renomeia a Clínica B.
4. **`clinic_members` somente leitura** — A não se adiciona à Clínica B, não altera o próprio papel, não remove o membership de B.
5. **Anônimo** — sem JWT, nenhuma tabela devolve dado; a RPC de criar clínica falha.
6. **Nível API** — o paciente de B devolve 404 **byte a byte idêntico** ao de um UUID inexistente; `X-Clinic-Id` forjado com a Clínica B é barrado com 403 **e o corpo é verificado para garantir que nenhum dado de B aparece** (checar só o status não bastaria); clínica inexistente é barrada igual; requisição sem token dá 401.

### Manual (os 10 critérios de aceite)

1. Criar usuário A em `/signup`.
2. Login automático após o cadastro.
3. Em `/onboarding`, criar "Clínica A".
4. `/dashboard` deve mostrar papel **admin**.
5. Área protegida acessível; deslogado redireciona para `/login`.
6. Em `/patients/new`, criar "Paciente A".
7. `/patients` lista apenas o Paciente A. **Anote o UUID dele na URL.**
8. Logout.
9. Repetir 1–7 com usuário B → "Clínica B" → "Paciente B".
10. Logado como B, acessar `/patients/<UUID-do-Paciente-A>` → **404**, idêntico a um UUID inventado. E a listagem de B nunca contém o Paciente A.

Para provar que a barreira é do banco e não da tela, repita o passo 10 com `curl`, usando o token de B e o id do paciente de A:

```bash
curl -i http://localhost:3333/api/patients/<UUID-do-Paciente-A> \
  -H "Authorization: Bearer <token-de-B>" \
  -H "X-Clinic-Id: <UUID-da-Clinica-B>"
```

E a tentativa de forjar o tenant:

```bash
curl -i http://localhost:3333/api/patients \
  -H "Authorization: Bearer <token-de-B>" \
  -H "X-Clinic-Id: <UUID-da-Clinica-A>"
```

O primeiro deve devolver 404; o segundo, 403 — e nenhum dos dois pode conter dado da outra clínica.
