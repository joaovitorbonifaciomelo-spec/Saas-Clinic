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

### Nunca `GRANT ALL` para `service_role` — privilégios por lista positiva

**Regra permanente:** nenhuma tabela da aplicação concede `grant all` a `service_role`. Os privilégios são concedidos por lista positiva explícita:

```sql
grant select, insert, update, delete on public.<tabela> to service_role;
```

`ALL` não é um conjunto abstrato de "o que for preciso": ele expande para os sete privilégios que a tabela suporta. As migrations 0006, 0013 e 0015 usaram `grant all`, e o resultado foi `service_role` com **TRUNCATE, REFERENCES e TRIGGER** nas onze tabelas — nenhum deles pedido por linha alguma do projeto. As 0016 e 0017 revogaram os três e reafirmaram os quatro de DML.

#### `service_role` bypassa RLS. Isso não é motivo para conceder os outros três.

Bypassar RLS significa **enxergar todas as linhas de todos os tenants**. Não significa poder apagar tudo sem rastro. São poderes de natureza diferente:

| | RLS | Trigger de linha | FK |
|---|---|---|---|
| `DELETE` | filtra | dispara | respeita |
| `TRUNCATE` | **não cobre** | **não dispara** | ignora (com `CASCADE`) |

`TRUNCATE` é o único verbo capaz de esvaziar o banco inteiro numa instrução sem deixar rastro nos eventos de auditoria. Quem já tem BYPASSRLS não precisa dele — e concedê-lo "porque é papel administrativo mesmo" troca um poder de leitura por um poder de destruição, que não é a mesma coisa.

**`REFERENCES`** permitiria apontar FK nova para as tabelas, fora do desenho tenant-first (as FKs compostas são criadas pelo dono, na migration). **`TRIGGER`** permitiria anexar gatilho — e os triggers destas tabelas *são* a regra de negócio: carimbo de autoria, versão, transição de status, imutabilidade de `clinic_id`.

#### Testes administrativos usam DML explícito e cleanup controlado

O teardown nunca trunca. Ele apaga `clinics` com `DELETE` e deixa a cascata levar membros, pacientes, agendamentos, conversas, mensagens e eventos:

```ts
await admin.from('clinics').delete().in('id', criados.clinics)
```

Isso importa por dois motivos além do privilégio. O `DELETE` **passa pelas FKs**, então uma cascata mal desenhada aparece como erro em vez de sumir silenciosamente; e ele atinge **exatamente os IDs criados por aquela execução**, nunca um padrão de nome ou um `LIKE`.

#### Há uma razão estrutural por trás, e ela não enfraquece a regra

`service_role` só é usada através de `createClient(url, serviceRoleKey)` — ou seja, PostgREST, que expõe DML e RPC. Não existe caminho por onde ela emita `TRUNCATE`, `CREATE TRIGGER` ou `ALTER TABLE`. Os três privilégios estavam concedidos e inalcançáveis ao mesmo tempo.

Isso é argumento para removê-los, não para relaxar: um privilégio que ninguém usa é exatamente o que passa despercebido quando o caminho de acesso muda. No dia em que algum script abrir conexão SQL direta com essa chave, os três estariam lá esperando.

#### Onde isso é verificado

`pnpm verify:privileges` afirma a matriz célula a célula nas onze tabelas, lendo `has_table_privilege` do banco real — não repetindo a intenção do arquivo de migration. **Não há exceção por tabela.** Se alguma um dia precisar de outro privilégio, a matriz vira um mapa por tabela com o motivo escrito ao lado; nunca um caso especial silencioso dentro do laço.

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

## 6.1 Atendimento: o modo manual NÃO envia nada

**Regra permanente.** `POST /api/conversations/:id/messages` **registra** uma mensagem
que aconteceu fora do sistema. Ele não envia, não entrega e não aciona provedor
nenhum.

O endpoint, o método do serviço e o tipo de entrada usam **register**, nunca
**send**:

| Camada | Nome |
|---|---|
| Rota | `POST /conversations/:id/messages` |
| Controller | `registerMessage` |
| Serviço | `registerManualMessage` |
| Schema | `registerManualMessageSchema` |
| Tipo | `RegisterManualMessageInput` / `RegisterManualMessageResult` |

A escolha do nome não é preciosismo. Uma atendente que lê "enviar" acredita que
o paciente recebeu a mensagem; se ela registrou uma conversa de telefone e a
tela disser "enviada", a clínica passa a acreditar que respondeu alguém que
nunca foi respondido. O banco reforça o mesmo fato por CHECK:
`messages_manual_has_no_delivery` exige `delivery_status IS NULL` quando o canal é
manual — não existe estado de entrega para inventar.

**A UI precisa dizer isso na tela**, com a frase já aprovada: *"Modo manual —
mensagens registradas aqui não são enviadas nem recebidas pelo WhatsApp."* Não
em tooltip, não em documentação: na tela.

### Autoria e registro são campos diferentes

| Direção | Quem **disse** (`author`) | Quem **registrou** (`recordedBy`) |
|---|---|---|
| `inbound` | ninguém do lado da clínica → `null` | o usuário autenticado |
| `outbound` | o usuário autenticado | o usuário autenticado |

A API **não monta esses snapshots**. Quem carimba é o trigger
`stamp_message_defaults`, a partir de `auth.uid()`. O cliente não tem por onde
informar autoria: os campos não existem no schema de entrada, e a função do
banco não tem parâmetro para eles. São duas barreiras independentes.

### Criação manual: 201 e 200, nunca 409

```
POST /api/conversations
  telefone novo       -> 201  { created: true,  conversation }
  telefone já usado   -> 200  { created: false, conversation }
```

Telefone que já tem thread **não é erro**. A atendente quer falar com aquela
pessoa; devolver 409 obrigaria a tela a tratar uma falha para fazer exatamente o
que o usuário pediu. Ela recebe a conversa existente e abre. O status distingue
os casos para quem lê HTTP; o campo `created` distingue para quem programa a
tela.

### `occurredAt`: passado sim, futuro não

O passado é legítimo — o modo manual existe para registrar o que já aconteceu.
O futuro não: a fila ordena por `last_message_at`, o banco o atualiza com
`greatest()`, e um instante à frente prende a conversa no topo **sem que
nenhuma mensagem real posterior desfaça**. A API aceita até
`OCCURRED_AT_FUTURE_TOLERANCE_MS` (5 min) de folga, apenas para relógio de
cliente adiantado.

> A mesma regra vale no banco desde a migration 0018 — ver §6.2. A validação
> aqui existe para o erro 400 amigável, não como barreira.

---

## 6.15 Atendimento: controle e concorrência

### A API não implementa concorrência

Não existe `SELECT version` seguido de `UPDATE` em lugar nenhum. Essa sequência
tem uma janela entre a leitura e a escrita, e é exatamente nela que duas
atendentes assumem a mesma conversa. O filtro por versão está **dentro do
próprio UPDATE**, na função do banco:

```sql
update public.conversations
   set assigned_to = auth.uid()
 where id = p_conversation_id
   and version = p_expected_version
   and assigned_to is null
```

Uma operação, uma linha afetada ou nenhuma. Não há como as duas vencerem.

### Contrato uniforme

| Rota | RPC | Sucesso |
|---|---|---|
| `POST /conversations/:id/assign` | `conversation_assign` | 200 |
| `POST /conversations/:id/transfer` | `conversation_transfer` | 200 |
| `POST /conversations/:id/release` | `conversation_release` | 200 |
| `PATCH /conversations/:id/status` | `conversation_set_status` | 200 |
| `POST /conversations/:id/patient` | `conversation_link_patient` | 200 |
| `DELETE /conversations/:id/patient` | `conversation_unlink_patient` | 200 |

Todas exigem `expectedVersion`, todas são schema **strict** (campo desconhecido
é 400), e nenhuma aceita `clinicId` no corpo.

`outcome` → HTTP, para as seis: `ok` → **200**, `conflict` → **409**,
`not_found` → **404**.

**Uma chamada por operação.** A RPC já devolve a conversa atualizada, então não
há GET depois. Medido: assign 158ms, transfer 166ms, release 167ms, status
168ms, link 159ms, unlink 163ms — todas dominadas pelo `auth.getUser()` por
requisição, não pela escrita.

### `assign` não aceita usuário

"Assumir" é sempre atribuir a si mesmo, e quem decide quem é "si mesmo" é o
`auth.uid()` dentro da RPC. Aceitar um `userId` aqui transformaria a operação em
"atribuir a qualquer um" — que é outra coisa, chama-se transferência, e tem
regra própria.

### Por que `DELETE` leva a versão na query

Corpo em `DELETE` não atravessa proxies de forma confiável. A garantia de
concorrência não pode depender de uma parte da requisição que alguém no caminho
pode descartar, então `expectedVersion` vai na query string. Continua
obrigatória — só muda o transporte.

### O 409

```json
{
  "statusCode": 409,
  "error": "conversation_conflict",
  "message": "Este atendimento foi alterado por outra pessoa.",
  "conversation": { "...": "estado atual" }
}
```

O estado atual vai junto para a tela dizer *"Maria assumiu esta conversa"* em vez
de *"erro ao salvar"*, sem recarregar e sem uma segunda requisição.

**`conflict` cobre dois casos, e está certo que o cliente veja os dois igual:**
a versão ficou velha, **ou** a pré-condição da operação não vale mais (assumir
algo que já tem dono, liberar algo que já está na fila). Nos dois, alguém chegou
antes.

**Nunca sai daqui:** SQL, nome de constraint, versão de outra entidade, dado de
outro tenant. E `conversation` só aparece porque quem recebeu 409 já podia ler
aquela conversa — `conversation_conflict` revalida o membership antes de devolver
estado, então **quem perdeu o acesso durante a corrida recebe 404, não um 409
com o conteúdo**.

### Comportamento real que vale registrar

- **Status igual ao atual é no-op de verdade:** o trigger de versão só
  incrementa quando algo relevante muda, e a RPC só grava evento quando
  `status is distinct from` o anterior. Resultado: **sem evento e sem incremento
  de versão** — `updated_at` muda, o resto não. A API não fabrica nenhum dos dois.
- **Transição inválida** sobe do trigger como `INVALID_STATUS_TRANSITION`
  (errcode 22023) e vira **400**. A máquina de estados vive só no banco; o zod
  apenas recusa valores fora do enum.
- **Vincular paciente NÃO substitui um vínculo existente** — ver §6.16.
- **Destinatário ou paciente inválido** vira 400 com mensagem genérica —
  *"Responsavel invalido para esta clinica."* / *"Paciente invalido para esta
  clinica."* Não existe, é de outro tenant e não é elegível respondem igual:
  distinguir já seria revelar a existência da conta.

### Diretório da equipe: `GET /clinics/members`

Ficou em `/clinics`, e não num recurso novo `/clinic-members`, porque a equipe é
da **clínica** — o Atendimento é só o primeiro consumidor. Qual clínica vem do
header que o guard já validou. O `ClinicMembershipGuard` entra só nessa rota; as
outras duas do controller respondem sobre o próprio usuário.

Devolve `userId`, `displayName`, `role`. Serve para exibir o responsável atual e
montar o seletor de transferência — **é leitura, não autorização**. Quem pode
receber uma transferência continua sendo decidido pela FK composta dentro de
`conversation_transfer`.

---

## 6.16 Vincular paciente: trocar exige duas ações (migration 0020)

**Regra do domínio:** trocar o vínculo só acontece com ação explícita. Não há
substituição silenciosa.

| Estado atual | Pedido | Resultado |
|---|---|---|
| sem paciente | vincular X | **200** — vincula, `version +1`, evento `patient_linked` |
| paciente X | vincular X | **200** — no-op: mesma conversa, **sem** `version +1`, **sem** evento |
| paciente X | vincular Y | **409 `conversation_patient_already_linked`** — nada muda |

Trocar de paciente é: `DELETE /patient` e depois `POST /patient`. Duas ações, dois
eventos — `patient_unlinked` seguido de `patient_linked`.

### Por que não substituir

O vínculo diz **de quem é o atendimento**. Trocar por engano move a conversa
inteira para o prontuário de outra pessoa, e o log não registra que alguém
desfez o vínculo anterior — porque ninguém desfez. A auditoria fica tecnicamente
completa e praticamente enganosa: dois `patient_linked` com ids diferentes só
significam "trocou" para quem já sabe.

**Não criamos `patient_changed` nem unlink implícito.** Seriam duas operações
escondidas dentro de uma — exatamente o que a regra remove.

### Dois 409 diferentes, de propósito

| `error` | Significa | O que a tela deve oferecer |
|---|---|---|
| `conversation_conflict` | a versão ficou velha | recarregar e tentar de novo |
| `conversation_patient_already_linked` | já há outro paciente | desvincular antes |

Compartilhar o mesmo código obrigaria a UI a oferecer a saída errada para um dos
dois casos.

### Precedência: versão stale vence a regra de vínculo

A ordem das verificações dentro da RPC é deliberada — versão **antes** do estado
do vínculo:

> A e B leem a versão 5, com o paciente X vinculado. A desvincula, e a conversa
> vai para a versão 6 sem paciente. B tenta vincular Y com a versão 5.

Se a regra de vínculo viesse primeiro, B receberia *"já vinculado"* — uma
resposta sobre um estado que **não existe mais**, e a instrução de desvincular
seria inútil (já está desvinculado). Verificando a versão antes, B recebe
`conversation_conflict` com o estado atual e decide de novo, informado.

Isso também impede que a regra nova reabra last-write-wins: o filtro
`version = expected` continua **dentro do UPDATE**, e não só na checagem — entre
o `select` e o `update` outra transação pode ter vencido a corrida.

### O banco é a autoridade

A regra vive na RPC `conversation_link_patient`, não na API nem num botão
escondido. Chamada direta à função — fora do HTTP, por qualquer `authenticated` —
recebe o mesmo `already_linked`. A API apenas traduz o outcome para 409.

E a resposta **não diz nada sobre o paciente solicitado**: se existe, se é de
outra clínica, se o id está errado. Isso seria informação sobre um cadastro que
quem chamou pode não poder enxergar. A FK composta tenant-first segue barrando
paciente de outro tenant, estruturalmente.

---

## 6.2 Atendimento: o que foi fechado e o que segue aberto

### ✅ FECHADO — `occurred_at` no futuro (migrations 0018/0019)

**Era:** `authenticated` chamava `conversation_add_manual_message` direto, fora da
API, com `occurred_at` arbitrário. Verificado contra o Dev: ano 2999 aceito,
`last_message_at` em 2999, conversa presa no topo da fila — e como o trigger de
atividade usa `greatest()`, que nunca reduz, nenhuma mensagem real posterior
corrigia.

**Regra, agora no banco:**

| `occurred_at` | Resultado |
|---|---|
| omitido | `now()` do servidor |
| passado | aceito — é para isso que o modo manual existe |
| até `now() + 5 min` | aceito, para relógio de cliente adiantado |
| acima de `now() + 5 min` | **recusado** |

**Onde vive.** Trigger `BEFORE INSERT` em `messages`
(`a_messages_reject_future_occurred_at`), que roda em **todo** caminho de
inserção — a RPC de hoje, o adaptador de provedor de amanhã, o script
administrativo. O predicado `message_occurred_at_ok` é a fonte única, usada
pelo trigger e pela RPC, para os dois não divergirem.

**Por que não um CHECK.** Um CHECK que chama `now()` não é imutável. O
PostgreSQL aceita criar, mas a constraint passa a valer sobre um valor que muda:
uma linha válida hoje seria inválida numa revalidação amanhã, e
`ALTER TABLE ... VALIDATE` ou um restore poderiam falhar sobre dados que sempre
estiveram corretos. Regra que depende do relógio pertence ao momento da escrita.

**Erro reconhecível, não SQL genérico.** A RPC devolve
`{outcome: 'invalid_occurred_at'}`, no mesmo formato de `not_manual` e
`invalid_body`, e a API mapeia para 400. Quem insere por fora da RPC recebe
`MESSAGE_OCCURRED_AT_IN_FUTURE` com errcode `22023`, que `mapPostgrestError` já
traduz para 400 — nunca um 500 genérico.

**Atomicidade.** Sendo `BEFORE INSERT`, nada chega a ser gravado: sem mensagem,
sem evento, `last_message_at` intocado, versão intocada. O harness afirma os
quatro.

> **Nota da 0019.** A 0018 criou o trigger sem `SECURITY DEFINER`, e trigger
> comum executa com os privilégios de quem disparou o INSERT. Como o predicado
> está revogado de todos os papéis (lista positiva), inserções fora de uma
> função definer falhavam com *permission denied for function
> message_occurred_at_ok* — recusa pelo motivo errado, que também barraria um
> `occurred_at` válido. Um teste que insere como `service_role` revelou. O
> trigger passou a ser `SECURITY DEFINER`: invariante de dados vale igual para
> todo caminho de escrita, e a resposta tem que ser sobre o dado, não sobre
> grants.

### ✅ FECHADO — nome do responsável (migration 0018)

**Era:** inferido do snapshot mais recente em `conversation_events`. Eventos são
registro histórico do que **aconteceu**, não read model do estado **atual**: quem
nunca agiu na clínica não tinha nome, e uma pessoa que trocasse o nome só
aparecia atualizada após a próxima ação dela.

**Agora:** `clinic_member_directory(p_clinic_id)` — `SECURITY DEFINER`, devolve
`user_id`, `display_name`, `role`. Três colunas porque a operação precisa de
três: identificar, exibir, e diferenciar papéis na UI.

**Não-disclosure.** `p_clinic_id` é dado do cliente e **não** vale como prova.
Quem decide é `is_clinic_member(p_clinic_id)`, que usa `auth.uid()`. Quem não é
membro recebe **conjunto vazio** — idêntico ao de uma clínica inexistente. Sem
exceção, sem mensagem diferente, portanto sem como distinguir "não é sua" de
"não existe".

**Por que não afrouxar `profiles`.** A policy `profiles_select_own` protege mais
que o nome. Abri-la para colegas exporia a linha inteira do perfil a todo membro
de qualquer clínica compartilhada, para sempre, em troca de um campo. A função
definer devolve exatamente as três colunas e nada mais.

**Grants:** `authenticated` tem EXECUTE. `PUBLIC` e `anon` não.

**Leitura/UX, não autorização.** Quem pode receber uma transferência continua
sendo decidido pela FK composta `(clinic_id, assigned_to) -> clinic_members`,
dentro de `conversation_transfer`. Se o diretório ficar desatualizado, o pior
caso é uma opção que o banco recusa — nunca uma transferência indevida aceita.

**`display_name` nulo.** `profiles.full_name` é NOT NULL e o trigger
`handle_new_user` cria o perfil junto do usuário, então o caso normal sempre tem
nome. O nulo cobre a linha de perfil ausente. O LEFT JOIN é deliberado: sumir com
o membro seria pior que exibi-lo sem nome — ele sumiria também do seletor de
transferência, e uma conversa atribuída a ele apareceria sem responsável. **Nulo
significa "nome indisponível", nunca "sem responsável"** — para isso existe
`assignedTo`, e `assignedToIsMe` nunca depende deste caminho.

**Custo:** uma chamada por requisição, mapeada em memória. Medido com 40
conversas e equipe de 6: `limit=5` → 228ms, `limit=40` → 231ms (**1,01x**), com
40/40 responsáveis resolvidos — todos transferidos para pessoas que nunca
agiram, exatamente onde o caminho por eventos falhava.

### ⚠️ ABERTO — idempotência de POST manual

**Decisão registrada: a v0.1 aceita o risco.**

Não há deduplicação por conteúdo, e isso é deliberado: "Olá" registrado duas
vezes pode ser um fato real — a pessoa ligou duas vezes. Deduplicar por conteúdo
apagaria informação verdadeira.

O risco é retry ou duplo clique: se a rede cair depois de o banco gravar e antes
de a resposta chegar, o cliente reenvia e a mensagem entra duas vezes.

**Por que é aceitável agora:** nada é enviado externamente, a duplicidade é
visível na thread e corrigível por quem registrou, e o conteúdo não serve como
chave.

**O frontend deve bloquear duplo clique enquanto o POST estiver pendente. Isso
reduz o caso comum, mas NÃO é garantia de idempotência** — não cobre retry de
rede nem duas abas.

> **Reavaliação OBRIGATÓRIA antes de qualquer provider real.** Com canal externo,
> uma duplicata custa uma mensagem entregue ao paciente, e o cálculo muda por
> completo. A solução é `client_message_id` enviado pelo cliente e **persistido**
> com índice único por clínica — o mesmo formato do `messages_provider_dedup_key`
> que já existe para provedores. Exige migration. Não há meio-termo honesto: um
> `Idempotency-Key` guardado em memória do processo não sobrevive a restart nem
> funciona com mais de uma instância.

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

---

## 13. Incidente: senha de fixture commitada durante o diagnóstico

Registrado aqui porque o valor de um incidente está no que ele ensina, e o que
ele ensinou não estava em nenhuma das quatro regras de segredo existentes.

### O que aconteceu

A rodada de diagnóstico do caminho Vercel → Funnel criou uma conta sintética no
projeto de **desenvolvimento** para exercitar o fluxo autenticado ponta a ponta.
O instrumento gravava um manifesto em `.diag/manifesto.json` com os IDs criados
— para poder apagar exatamente aqueles recursos depois, e não por padrão de
nome. O manifesto guardava também a senha da conta, porque o próprio
instrumento precisava logar de novo entre as fases.

Um `git add -A` levou esse arquivo junto no commit `7ae9627`. Ele foi removido
em `fb89da5`, mas removido não é o mesmo que nunca ter existido: o valor
permanece nos objetos daqueles dois commits.

### Extensão real, verificada e não presumida

| Pergunta | Resposta |
|---|---|
| A senha era reutilizada? | Não. Casava com `^Senha-Diag-[0-9a-f]{8}!$`, derivada do `runId` daquela execução — gerada, usada uma vez, nunca digitada por pessoa nem repetida em outro lugar. |
| Havia `service_role`, DB URL ou anon key no manifesto? | Não. Só IDs e a senha da conta sintética. |
| Havia dado de paciente? | Não. Tudo sintético. |
| A conta ainda existe? | Não. Apagada. O projeto Dev tem hoje **um** usuário: a conta real do operador. Zero contas `diag-*`. |
| Algum arquivo rastreado ainda contém o valor? | Não. |
| Atingiu piloto ou produção? | Não. O diagnóstico inteiro rodou contra o projeto de desenvolvimento. |

`.diag/` passou a ser ignorado (`.gitignore:38`). O diff líquido do diagnóstico
contra o commit anterior é **apenas o `.gitignore`** — o instrumento não deixou
rastro em código de aplicação.

### O histórico não foi reescrito, e isso é uma decisão

Purgar o histórico reescreveria SHAs de commits já publicados. O ganho seria
apagar uma senha de uso único, de uma conta que não existe mais, de um projeto
de desenvolvimento. Não compensa o custo. **Se o repositório tornar-se público
ou receber colaboradores externos, essa conta já não existe — mas a decisão
deve ser reavaliada nesse momento**, não presumida como permanente.

### A correção: regra 5 do `check:secrets`

As quatro regras existentes procuravam `service_role`, `SUPABASE_DB_URL`,
prefixo `NEXT_PUBLIC_` e arquivos `.env` rastreados. Nenhuma delas olhava para
"senha em manifesto de fixture" — a categoria que efetivamente vazou.

A regra 5 lê **apenas JSON rastreado pelo git**, procura **apenas nomes de
chave inequivocamente credenciais** (`senha`, `password`, `accessToken`,
`access_token`, `refreshToken`, `refresh_token`, `serviceRoleKey`,
`service_role_key`), e só reclama quando o valor é texto não vazio. Percorre
objetos e arrays aninhados, porque o próximo manifesto pode aninhar o que este
deixou no topo.

Duas escolhas de escopo, ambas deliberadas:

- **`token` sozinho não entra na lista.** É nome de campo de token CSRF, de
  design token, de tokenizador. Um detector que grita à toa é um detector que a
  equipe aprende a ignorar, e aí ele deixa de proteger contra o caso real.
- **A falha reporta o caminho da chave, nunca o valor.** Um verificador de
  segredos que imprime o segredo no log de CI apenas troca o lugar do
  vazamento.

Verificada por mutação: recriando um manifesto com a mesma forma do que vazou,
a checagem falha com `contas.0.senha` e sai com código 1; sem ele, passa.

---

## 14. Caminho público da API: por que sair do Tailscale Funnel

### O sintoma e a causa provada

Toda página autenticada respondia 500 em produção. A causa não era a Agenda, nem
a sessão, nem o Supabase: `getaddrinfo ENOTFOUND srv1779541.taild2349f.ts.net`
a partir das funções da Vercel na região `iad1`, falhando em 2–55 ms — rápido
demais para ser timeout de rede, que é a assinatura de falha de resolução.

Os controles descartam as explicações alternativas, um a um:

| Controle | Resultado | Descarta |
|---|---|---|
| `example.com` | 200 em 23 ms | "a função não tem saída de rede" |
| `tailscale.com` | 200 em 84 ms | "a Vercel bloqueia a Tailscale" |
| apex do tailnet `taild2349f.ts.net` | ENOTFOUND | "é o subdomínio específico" |
| IP literal | ECONNRESET no TLS, 20 ms | "o caminho de rede está fechado" — não está |
| DoH de **dentro da mesma função** | resolve normalmente | "o nome não existe" — existe |
| Resolvedores públicos (Google, Cloudflare, Quad9, OpenDNS) | todos resolvem, TTL 300 s | "a zona está quebrada" |
| Concorrência 1/2/5/10 | idêntico local e na Vercel | "é limite de conexões" |

O nome é resolvível pelo mundo e não pelo resolvedor da Vercel. Isso é
infraestrutura de terceiro que não está sob nosso controle e para a qual não
existe correção do nosso lado — só contorno.

### Por que a falha derrubava a página inteira

`requireActiveSession()` chama `fetchMe()`, que chama `apiFetch`, que é `fetch`
sem timeout. Falha de rede lança `TypeError`, não `ApiError`; o `catch` trata
apenas `ApiError` 401 e **relança o resto de propósito**. Esse comportamento
está correto e não foi alterado: mascarar indisponibilidade da API devolvendo
agenda vazia transformaria um incidente visível em dado errado silencioso, que
é o modo de falha pior.

### A decisão

Publicar a API pelo Fly.io, região `gru`, com a **mesma imagem** que já roda na
VPS, fixada por SHA. `fly.toml` está versionado na raiz e não contém segredo
algum: `SUPABASE_URL` e `SUPABASE_ANON_KEY` entram por `fly secrets set`, e
`service_role` e senha do banco continuam não existindo no runtime da API.

Sem `auto_stop_machines`: cold start de máquina suspensa aparece na recepção da
clínica como "o sistema travou".

### Rollback

A migração é paralela. A VPS e o Funnel continuam de pé, intocados. O valor
anterior de `API_URL`, registrado antes de qualquer troca:

```
https://srv1779541.taild2349f.ts.net
```

Se o Fly falhar depois da troca, reverte-se **somente a variável de ambiente da
Vercel** para esse valor. Nada na VPS é modificado.

### Dimensionamento e custo (aprovado)

Uma Machine `shared-cpu-1x` / 512 MB em `gru`, sempre ligada, sem volume.
Máquina sempre de pé sai do free tier — custa alguns dólares por mês, e isso
foi aprovado explicitamente em troca de duas coisas: margem de memória (Node em
256 MB fica no limite, e o primeiro sintoma de falta seria OOM em produção, não
lentidão) e ausência de cold start (numa recepção de clínica, cold start se lê
como "o sistema travou").

Qualquer cobrança além dessa configuração é motivo para parar e reportar, não
para ajustar por conta própria.

### Como o token do Fly chega até aqui

O shell das ferramentas é não-login e não-interativo, com `BASH_ENV` vazio e sem
`~/.bashrc`: ele **não lê perfil nenhum**, apenas herda o ambiente do processo
que o criou. Consequência prática: `setx FLY_API_TOKEN ...` ou uma variável
definida em outra janela não chegam a uma sessão já em andamento.

O caminho limpo é `flyctl auth login` no terminal do operador: o flyctl grava a
credencial no próprio `~/.fly/config.yml`, fora do repositório, e as invocações
seguintes a leem sozinhas. Sem variável de ambiente, sem token em arquivo
versionado, sem token impresso em log.

---

## 15. Dívida técnica: como o contexto de Pendências distingue FK de UPDATE

Registrado aqui porque é uma decisão que funciona hoje e que **precisa ser
reavaliada quando uma condição específica mudar** — e condição que só vive na
cabeça de alguém não sobrevive a seis meses.

### O problema

`tasks.patient_id`, `conversation_id` e `appointment_id` são **imutáveis**:
contexto responde "sobre o que esta ação nasceu", e reescrevê-lo depois mudaria
o significado histórico da pendência.

Mas as três colunas têm `on delete set null (coluna)`. Ações referenciais no
PostgreSQL são executadas por triggers internos que fazem **UPDATE** na tabela
referenciante, e esse UPDATE dispara os triggers de usuário. Uma imutabilidade
cega faria `delete from patients` falhar com `CONTEXT_IMMUTABLE` — a regra de
histórico viraria trava contra apagar dado pessoal.

Permitir `valor → nulo` para qualquer origem resolveria isso e abriria outra
porta: qualquer UPDATE privilegiado poderia zerar contextos parecendo ação de
FK.

### A solução, e o seu limite

`enforce_task_context_immutable` aceita `valor → nulo` **apenas quando
`pg_trigger_depth() >= 2`**. Medido contra o PostgreSQL antes de ser adotado:

| origem do UPDATE | `pg_trigger_depth()` |
|---|---|
| direto (RPC, `service_role`, dono da tabela) | 1 |
| ação referencial `ON DELETE SET NULL` | 2 |

> **O limite, dito com clareza: a checagem prova "estou aninhado dentro de outro
> trigger", não "sou exatamente uma ação de integridade referencial".**

### Quando isto precisa ser reavaliado

**Se algum dia um trigger passar a atualizar `tasks` a partir de outra tabela**,
esse caminho herdará a permissão de anular contexto sem ser uma FK. Hoje não
existe nenhum: os dois únicos caminhos de escrita são as RPCs (profundidade 1) e
as ações referenciais.

O que segura a regra enquanto isso: `authenticated` não tem UPDATE em `tasks`,
então esta não é a primeira linha de defesa — ela protege contra `service_role`
e contra o dono da tabela, que passam por cima do RLS.

Dois testes guardam os dois lados, e quebram juntos se a distinção parar de
funcionar: *"ZERAR o contexto por escrita privilegiada é recusado"* e *"apagar o
paciente NÃO bloqueia"* (`supabase/tests/tasks-contexto.test.ts`), mais os
equivalentes no harness PGlite.
