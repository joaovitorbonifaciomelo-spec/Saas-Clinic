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

### Trigger de criação de perfil

A migration de schema instala um trigger em `auth.users`:

```sql
create or replace function public.clinic_saas_handle_new_user() ...
drop trigger if exists clinic_saas_on_auth_user_created on auth.users;
create trigger clinic_saas_on_auth_user_created after insert on auth.users ...
```

Os nomes levam o prefixo `clinic_saas_` deliberadamente. Os nomes canônicos — `handle_new_user` e `on_auth_user_created` — aparecem em praticamente todo tutorial oficial do Supabase, e portanto são os mais prováveis de já existirem num projeto. Um `create or replace function` sobre um nome desses substituiria a função alheia **sem erro e sem aviso**, e a quebra só apareceria no próximo cadastro.

O prefixo **não torna a colisão impossível** — qualquer nome pode colidir, e tanto o `drop trigger if exists` quanto o `create or replace` continuam substituindo silenciosamente um homônimo. O que ele faz é tornar a colisão _extremamente improvável_, por deixar de depender do nome mais disputado do ecossistema. Antes de aplicar num projeto que já tenha outra coisa rodando, verifique se esses dois nomes existem.

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

O teste monta o cenário, executa as asserções com o **JWT real de cada usuário** (portanto quem responde é o RLS) e limpa tudo ao final.

#### Trava de ambiente

O teste cria e remove usuários reais usando `service_role`. Por isso exige `SUPABASE_TEST_ENVIRONMENT` igual a `development` ou `staging`; ausente ou com qualquer outro valor, ele **recusa executar**. A ausência é tratada como recusa, não como default permissivo — uma variável herdada do shell apontando para produção não deve poder rodar isto por acidente.

#### Ciclo de vida dos recursos: sempre por ID

Cada execução gera um `test_run_id` (UUID v4). Os usuários criados carregam esse id no `user_metadata`, o que torna a origem rastreável pelo painel do Supabase.

O `TestResourceRegistry` registra cada recurso **imediatamente após criá-lo**, e persiste um manifesto em `supabase/tests/.runs/<test_run_id>.json` a cada registro — antes que o passo seguinte possa falhar. Isso fecha o vazamento em falha parcial: se a criação da clínica quebrar depois de o usuário já existir, o usuário está no manifesto e será removido.

A limpeza no `afterAll` apaga **somente os IDs daquela execução**, na ordem clínicas → usuários (necessária porque `clinics.created_by` é `SET NULL`, então apagar o usuário não apaga a clínica). Se algo restar, o manifesto é preservado e o comando de limpeza é impresso.

**Não existe varredura inicial do banco.** Uma versão anterior deste código procurava resíduo com `LIKE 'Clinica _ rlstest-%'` e apagava o que casasse. Isso é inaceitável: é uma heurística de nome executada com `service_role` (que ignora RLS) cuja exclusão cascateia para `patients`. Uma clínica legítima com nome parecido seria destruída junto com todos os seus pacientes. Foi removido.

Resíduo de execução interrompida é tratado explicitamente:

```bash
pnpm test:isolation:cleanup --list
pnpm test:isolation:cleanup <test_run_id>
```

O script só apaga IDs listados no manifesto. Antes de tocar em qualquer coisa, ele valida nesta ordem: (1) o argumento é **um** `test_run_id` em UUID v4 exato — `--all`, `*`, `.`, `..` e caminhos são recusados, e mais de um argumento é erro, porque **não existe modo "limpar todos"**; (2) `SUPABASE_TEST_ENVIRONMENT` é `development` ou `staging`; (3) o manifesto pertence ao mesmo projeto que o `.env.test` aponta — limpar IDs de um projeto com credenciais de outro apagaria as linhas erradas caso os UUIDs coincidissem.

A validação de UUID cumpre um segundo papel: sem ela, um argumento como `../../algo` escaparia do diretório de manifestos e faria o script obedecer a um arquivo arbitrário.

O princípio: **deixar resíduo de teste é preferível a qualquer query de limpeza capaz de alcançar dado legítimo.**

### Portão de confirmação do `db:push`

Aplicar migration no projeto errado é irreversível na prática, e o erro é banal — dois projetos abertos, um `link` antigo esquecido. Por isso `pnpm db:push` passa por `scripts/db-push.mjs`, que imprime o alvo (project ref linkado, host, ambiente declarado, lista de migrations) **antes** de qualquer ação e aborta se: não houver projeto linkado; o ambiente declarado não for `development`/`staging`; o ref linkado divergir do `.env.test`; o `.env.test` ainda tiver placeholders; ou a confirmação não bater com o project ref.

A confirmação é interativa (digitar o ref) quando há TTY, e `--confirm <ref>` quando não há — nunca um `-y` que aceite qualquer coisa.

O script lê apenas `SUPABASE_TEST_ENVIRONMENT` e `SUPABASE_URL`, e imprime somente identificadores públicos. Não conhece `SUPABASE_SERVICE_ROLE_KEY` nem `SUPABASE_DB_URL`, então não tem como vazá-los.

Cobertura das asserções:

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

---

## 9. Configuração do Supabase Auth (produção)

O link de confirmação de e-mail **não é montado pelo nosso código**. Não há
`emailRedirectTo` em nenhum lugar de `apps/web` — auditado. O destino vem
inteiramente do painel do Supabase, e por isso precisa estar correto lá.

| Campo         | Valor                                   |
| ------------- | --------------------------------------- |
| Site URL      | `https://saas-clinic-web.vercel.app`    |
| Redirect URLs | `https://saas-clinic-web.vercel.app/**` |

**Sintoma quando está errado:** o e-mail de confirmação do primeiro cadastro
aponta para `http://localhost:3000`. O usuário clica, não chega a lugar nenhum,
e parece bug da aplicação. Foi o que aconteceu no primeiro teste real.

Como o valor mora no painel e não no repositório, ele **não é coberto por
nenhum teste automatizado** — se o projeto Supabase for recriado ou trocado,
esta configuração precisa ser refeita à mão. É o único ponto do fluxo de auth
com essa propriedade.

### O que o código garante

- Nenhuma referência a `localhost` em `apps/web`.
- `WEB_ORIGIN` na API **não tem default em produção**: se a variável faltar com
  `NODE_ENV=production`, o boot falha em vez de cair silenciosamente em
  `http://localhost:3000` e recusar o frontend real no CORS.
- Sessão expirada redireciona para `/login` em vez de estourar `ApiError` numa
  rota protegida.

---

## 10. Clínica ativa: `active_clinic_id` é **hint**, nunca autorização

O cookie `active_clinic_id` guarda o UUID da última clínica ativa do usuário.
Ele existe por **um único motivo, que é desempenho**: sem ele, toda tela
precisava esperar `/api/me` terminar só para descobrir qual `clinic_id` mandar
no cabeçalho das chamadas seguintes — duas idas e voltas em série pelo Funnel
em cada navegação.

### O que ele é e o que ele não é

| | |
|---|---|
| **É** | Um palpite sobre qual clínica o usuário estava usando. |
| **Não é** | Prova de vínculo, credencial, ou entrada em qualquer decisão de acesso. |

A autorização continua exatamente onde estava, em três camadas independentes, e
**nenhuma delas lê este cookie**:

1. **JWT do usuário** em toda chamada à API.
2. **`ClinicMembershipGuard`** na API, que confere o vínculo no servidor.
3. **RLS no PostgreSQL**, que é a barreira real: uma linha de outra clínica
   simplesmente não existe para aquela sessão.

### Como o palpite é usado

`loadForActiveClinic` (em `apps/web/src/app/session.ts`) dispara a busca de
dados com o palpite **em paralelo** com `getActiveSession()`, e só aproveita o
resultado se a clínica validada pelo servidor for exatamente a do palpite.

São duas travas, e a segunda existe para o caso de a primeira falhar:

1. A chamada especulativa leva o JWT do próprio usuário. Palpite apontando para
   outra clínica é negado pelo guard, e o RLS não devolveria linha nenhuma de
   qualquer forma.
2. Mesmo que a camada 1 falhasse, o resultado especulativo só é usado quando
   `palpite === clínica validada`. Cookie adulterado é descartado antes de
   virar tela.

Cookie ausente, malformado, obsoleto ou apontando para clínica sem vínculo caem
todos no mesmo lugar: o caminho normal, com a clínica que `/api/me` confirmou.

### Formato e escrita

Só o UUID. `httpOnly`, `SameSite=Lax`, `Secure` em produção, `Path=/`, 30 dias.
Escrito apenas em Server Action (`signInAction` e `createClinicAction`), porque
o Next proíbe escrever cookie durante render — e com razão: tornaria a resposta
dependente de efeito colateral. Removido no logout.

**Timezone não entra no cookie.** Ele continua vindo de `/api/me`, que é a
fonte confiável. Guardá-lo economizaria uma ida e volta em `/agenda` e
`/dashboard`, mas ao custo de poder mostrar o dia errado da agenda — troca
recusada.

### Consequência: quantas ondas cada rota faz

| Rota | Ondas | Por quê |
|---|---:|---|
| `/agenda/services` | 1 | `me` ∥ `services` |
| `/agenda/professionals` | 1 | `me` ∥ `professionals` ∥ `availability` |
| `/patients` com `?p=` | 1 | `me` ∥ `patients` ∥ `appointments` |
| `/patients` sem `?p=` | 2 | Precisa da lista para saber quem é o primeiro |
| `/dashboard` | 2 | O intervalo de datas depende do timezone, que só `/api/me` traz |
| `/agenda` | 2 | Idem |

---

## 11. Desempenho: o que foi medido

Todas as medições abaixo foram feitas **em produção**, com Playwright e CDP,
contra a infraestrutura real.

### Custo de rede: o Funnel é o principal componente temporário

O Tailscale Funnel é a exposição temporária da API enquanto não há domínio
próprio. Medido isoladamente, com 60 amostras sequenciais:

```
min 239 | p25 243 | mediana 249 | p75 254 | p90 263 | p95 445 | max 1262 ms
```

Da Vercel (região `gru1`, São Paulo) o RTT quente é menor, ~200 ms. Numa
navegação de 2 ondas, isso são ~400 ms de rede antes de qualquer render — a
maior parcela isolada do tempo de tela.

### A bimodalidade tinha causa: estabelecimento de conexão TLS

As navegações se dividiam em dois grupos, ~700-900 ms e ~1,5-1,9 s. A suspeita
inicial era cold start da Vercel. **Não era**: todas as amostras trazem
`cold=0` com contadores de invocação altos, e o mesmo padrão aparece num
servidor local já quente.

O que a instrumentação mostrou é que, num render lento, **todas** as chamadas
são lentas juntas — inclusive `/api/me`:

```
/agenda  render=416   me=194  patients=216  professionals=217
                      appointments=217  services=218  availability=218
/agenda  render=1221  me=595  professionals=567  patients=592
                      availability=610  services=615  appointments=624
```

Experimento isolado, 6 requisições paralelas ao mesmo host num processo novo:

```
pool vazio : 908  904  895  866  898  866 ms
pool quente: 250  256  250  257  250  854 ms   <- 5 reusadas, 1 conexão nova
pool quente: 248  259  260  252  261  255 ms
```

**Cada conexão TLS nova ao Funnel custa ~640 ms da máquina local e ~380 ms da
Vercel.** Cada instância da função tem seu próprio pool de conexões; quando o
pool não sobrevive ao congelamento entre invocações, todas as chamadas daquele
render pagam handshake. É isso, e não cold start, que produz a segunda moda.

### Correções aplicadas (só frontend)

- Toolbar da agenda e seleção de paciente com `useOptimistic` +
  `useTransition`: o clique deixou de ficar morto por 1,4-1,6 s.
  Feedback visual passou a 47-64 ms em todos os fluxos.
- `/agenda/professionals` deixou de fazer uma chamada de disponibilidade por
  profissional (1+N em série) e passou a usar
  `GET /api/professionals/availability`.
- `/patients` deixou de esperar a lista quando o paciente já vem em `?p=`.
- `getAccessToken` memoizado por requisição com `cache()` do React.
- `prefetch={false}` nos links para rotas `force-dynamic`, que o Next
  renderizava inteiras no servidor sem ninguém ter pedido.

### Otimizações deliberadamente adiadas

Registradas aqui para reavaliação **durante o piloto**, com dado real de uso.
Nenhuma foi implementada:

| Item | Ganho estimado | Por que foi adiado |
|---|---|---|
| Reúso de conexão ao Funnel (HTTP/2 no undici, agente keep-alive) | Elimina o segundo modo inteiro (~380-640 ms) | Mudança de runtime; é hoje o maior lever isolado |
| Endpoint agregado (`/api/bootstrap/*`) | 1 requisição = 1 conexão = zero handshake extra | Mudança de API; duplica superfície a manter |
| Timezone disponível cedo | Levaria `/agenda` e `/dashboard` de 2 ondas para 1 (~200 ms) | Exige decisão sobre onde guardá-lo com segurança |
| Verificação local de JWT via JWKS | ~50-100 ms por requisição | Perde detecção imediata de revogação dentro do TTL |

### Instrumentação: desligada por padrão

Existem duas saídas de diagnóstico, e **ambas só aparecem quando o cookie
`perf_debug=1` está presente**. Usuário comum nunca recebe nenhuma delas:

- `Server-Timing: proxyauth;dur=…` no proxy — duração do `auth.getUser()` e
  contador de invocações da instância.
- `<meta name="x-perf" content="…">` no render — duração de cada chamada à API.

**Só sai duração.** Os nomes das marcas são fixos, escritos no código, e
identificadores de recurso viram `:id` antes de serem registrados. Nenhum
token, cookie, id de usuário, clínica ou paciente atravessa essa saída.

---

## 12. Como rodar cada bateria de testes

| Comando | O que cobre | Depende de |
|---|---|---|
| `pnpm test` | Unitários de `packages/shared` e `apps/api` | Nada |
| `pnpm test:isolation` | Isolamento entre clínicas e comportamento da agenda | Banco + **API acessível** |
| `pnpm test:hint` | Segurança do cookie `active_clinic_id` | Banco + API + **app Next no ar** |

### `API_URL` é obrigatório para a bateria completa

Os testes de integração falam com a API por HTTP. `API_URL` aponta para ela e
tem default `http://localhost:3333`. **Sem uma API acessível nesse endereço,
dois arquivos falham no portão de "API precisa estar no ar" e 33 asserções
ficam `skipped`** — o que é fácil confundir com sucesso.

Contra a API já publicada:

```bash
API_URL=https://<host-da-api> pnpm test:isolation
```

Contra uma API local:

```bash
pnpm --filter @clinicas/api dev     # noutro terminal
pnpm test:isolation
```

### `pnpm test:hint`

Precisa também do app Next servindo, porque exercita cookie de verdade num
navegador de verdade — é a única forma honesta de testar que um cookie
adulterado não vaza dados de outro tenant.

```bash
# terminal 1
pnpm --filter @clinicas/web build && pnpm --filter @clinicas/web start

# terminal 2
API_URL=https://<host-da-api> WEB_URL=http://localhost:3000 pnpm test:hint
```

`WEB_URL` tem default `http://localhost:3100`. Se o app não responder, a suíte
**falha alto** em vez de passar em silêncio: teste de segurança que se
auto-desliga é pior que teste nenhum.

O que ela cobre: escrita no login, remoção no logout, onboarding populando o
cookie, cookie correto, ausência de cookie, cinco formatos inválidos, cookie
apontando para a clínica de outro usuário, clínica inexistente, nome da clínica
no shell vindo do validado e não do cookie, e sessão expirada ainda indo para
`/login`.
