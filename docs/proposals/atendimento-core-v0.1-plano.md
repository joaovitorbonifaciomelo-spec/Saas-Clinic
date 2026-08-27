# Plano de implementação — Atendimento Core v0.1

> **Nada executado.** Nenhuma migration rodada, nenhum código escrito.
> Domínio decidido em [`atendimento.md`](./atendimento.md); aqui está o **como e
> em que ordem**, para aprovação final antes de qualquer linha.

---

## 1. Migrations propostas

Três arquivos, mesma divisão da agenda (schema / rls / grants). Todos
**puramente aditivos**: nenhuma tabela existente é alterada, o que dá a este
módulo a melhor história de rollback do projeto (§19).

```
supabase/migrations/
  20260828100000_atendimento_schema.sql
  20260828100100_atendimento_rls.sql
  20260828100200_atendimento_grants.sql
```

### 1.1 `atendimento_schema.sql`

#### Enums

```sql
do $$
begin
  if not exists (select 1 from pg_type where typname = 'conversation_channel') then
    create type public.conversation_channel as enum ('manual', 'whatsapp');
  end if;
  if not exists (select 1 from pg_type where typname = 'conversation_status') then
    create type public.conversation_status as enum ('open', 'waiting_patient', 'resolved');
  end if;
  if not exists (select 1 from pg_type where typname = 'message_direction') then
    create type public.message_direction as enum ('inbound', 'outbound');
  end if;
  if not exists (select 1 from pg_type where typname = 'message_delivery_status') then
    create type public.message_delivery_status as enum ('pending', 'sent', 'delivered', 'read', 'failed');
  end if;
  if not exists (select 1 from pg_type where typname = 'conversation_event_type') then
    create type public.conversation_event_type as enum (
      'conversation_created',
      'assigned',
      'transferred',
      'released',
      'patient_linked',
      'patient_unlinked',
      'status_changed'
      -- 'appointment_created' entra aqui SE a alternativa da §12 da proposta
      -- for aceita. Acrescentar valor a enum e aditivo e nao trava a tabela.
    );
  end if;
end
$$;
```

`message_delivery_status` já entra com todos os valores, mesmo sem uso na v0.1:
acrescentar valor a enum depois é barato, mas ter a coluna com o tipo certo
desde o começo evita uma migration de alteração de tipo quando o provedor
chegar.

#### `conversations`

```sql
create table if not exists public.conversations (
  id                     uuid primary key default gen_random_uuid(),
  clinic_id              uuid not null references public.clinics (id) on delete cascade,

  -- identidade da thread
  channel                public.conversation_channel not null,
  provider               text
                           check (provider is null or char_length(provider) between 2 and 40),
  provider_contact_id    text
                           check (provider_contact_id is null
                                  or char_length(provider_contact_id) between 1 and 128),
  contact_phone_e164     text
                           check (contact_phone_e164 is null
                                  or contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  contact_name_snapshot  text
                           check (contact_name_snapshot is null
                                  or char_length(btrim(contact_name_snapshot)) between 1 and 120),

  patient_id             uuid,

  status                 public.conversation_status not null default 'open',
  assigned_to            uuid,

  -- atividade (sem contador; ver secao 4 da proposta)
  last_message_at        timestamptz,
  last_inbound_at        timestamptz,
  last_outbound_at       timestamptz,

  version                integer not null default 1 check (version > 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint conversations_clinic_id_id_key unique (clinic_id, id),

  -- canal manual nao tem provedor; canal com provedor exige nome do adaptador
  constraint conversations_manual_has_no_provider
    check ((channel = 'manual' and provider is null and provider_contact_id is null)
           or channel <> 'manual'),

  constraint conversations_patient_fk
    foreign key (clinic_id, patient_id)
    references public.patients (clinic_id, id) on delete set null (patient_id),

  constraint conversations_assignee_fk
    foreign key (clinic_id, assigned_to)
    references public.clinic_members (clinic_id, user_id) on delete set null (assigned_to)
);
```

> ### A armadilha do `SET NULL` em FK composta
>
> `on delete set null` **sem lista de colunas anula TODAS as colunas da FK**,
> incluindo `clinic_id`. Como `clinic_id` é `not null`, remover um membership
> falharia com violação de not-null — e **bloquearia a remoção do funcionário**,
> exatamente o oposto do pedido na decisão 6.
>
> A forma `on delete set null (assigned_to)` restringe a anulação à coluna certa.
> Ela existe desde o **PostgreSQL 15**; o projeto roda **PG 17**
> (`supabase/config.toml`, `major_version = 17`), então está disponível.
>
> Sem essa sintaxe, a alternativa seria um trigger `before delete` em
> `clinic_members` zerando `assigned_to` — mais código para o mesmo efeito.
> Vale o mesmo raciocínio para `patient_id`.

#### Identidade da thread — três índices, não uma constraint

```sql
-- 1) Provedor com identidade propria: uma thread por wa_id.
create unique index if not exists conversations_provider_identity_key
  on public.conversations (clinic_id, channel, provider_contact_id)
  where provider_contact_id is not null;

-- 2) Sem identidade de provedor, mas com telefone: uma thread por numero.
--    O `provider_contact_id is null` e ESSENCIAL: sem ele, um contato que tem
--    wa_id E telefone seria governado por duas regras ao mesmo tempo, e a
--    segunda recusaria threads que a primeira ja considera distintas.
create unique index if not exists conversations_phone_identity_key
  on public.conversations (clinic_id, channel, contact_phone_e164)
  where provider_contact_id is null and contact_phone_e164 is not null;

-- 3) Sem identidade nenhuma (manual, atendimento presencial): nao ha unicidade.
--    Cada conversa e propria, por construcao. Nao existe indice para este caso,
--    e isso e deliberado — nao inventamos identidade artificial.
```

#### Índices de consulta

```sql
create index if not exists conversations_queue_idx
  on public.conversations (clinic_id, status, last_message_at desc nulls last);

create index if not exists conversations_mine_idx
  on public.conversations (clinic_id, assigned_to, last_message_at desc nulls last)
  where assigned_to is not null;

create index if not exists conversations_patient_idx
  on public.conversations (clinic_id, patient_id)
  where patient_id is not null;
```

#### `messages`

```sql
create table if not exists public.messages (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            uuid not null references public.clinics (id) on delete cascade,
  conversation_id      uuid not null,

  direction            public.message_direction not null,
  body                 text not null check (char_length(btrim(body)) between 1 and 4096),
  occurred_at          timestamptz not null default now(),

  author_user_id       uuid references auth.users (id) on delete set null,
  author_name_snapshot text
                         check (author_name_snapshot is null
                                or char_length(btrim(author_name_snapshot)) between 1 and 120),

  provider             text,
  provider_message_id  text,
  delivery_status      public.message_delivery_status,

  created_at           timestamptz not null default now(),

  constraint messages_clinic_id_id_key unique (clinic_id, id),

  constraint messages_conversation_fk
    foreign key (clinic_id, conversation_id)
    references public.conversations (clinic_id, id) on delete cascade,

  -- inbound nao tem autor interno; outbound do provedor tambem nao tera
  constraint messages_inbound_has_no_author
    check (direction = 'outbound' or author_user_id is null),

  -- delivery_status so faz sentido saindo
  constraint messages_delivery_only_outbound
    check (delivery_status is null or direction = 'outbound')
);

create index if not exists messages_thread_idx
  on public.messages (clinic_id, conversation_id, occurred_at, id);
```

#### Idempotência (decisão 8)

```sql
create unique index if not exists messages_provider_dedup_key
  on public.messages (clinic_id, provider, provider_message_id)
  where provider_message_id is not null;
```

Índice **parcial**, e não constraint sobre colunas nullable. Dois motivos:

- **Mensagem manual não tem `provider_message_id`** e precisa poder repetir à
  vontade — duas anotações idênticas da mesma ligação são dois fatos.
- **Não usar fallback artificial.** `coalesce(provider_message_id, id::text)`
  tornaria o índice inútil (nunca colide) e ainda daria falsa sensação de
  proteção. O índice parcial diz exatamente o que quer dizer: *quando existe id
  do provedor, ele é único na clínica*.

#### `conversation_events`

```sql
create table if not exists public.conversation_events (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            uuid not null references public.clinics (id) on delete cascade,
  conversation_id      uuid not null,

  event_type           public.conversation_event_type not null,

  actor_user_id        uuid references auth.users (id) on delete set null,
  actor_name_snapshot  text,
  actor_role_snapshot  public.clinic_role,

  metadata             jsonb not null default '{}'::jsonb
                         check (jsonb_typeof(metadata) = 'object'
                                and pg_column_size(metadata) <= 2048),

  created_at           timestamptz not null default now(),

  constraint conversation_events_clinic_id_id_key unique (clinic_id, id),
  constraint conversation_events_conversation_fk
    foreign key (clinic_id, conversation_id)
    references public.conversations (clinic_id, id) on delete cascade
);

create index if not exists conversation_events_history_idx
  on public.conversation_events (clinic_id, conversation_id, created_at, id);
```

O `check` de tamanho em `metadata` é a trava concreta contra o que a decisão 9
proíbe: payload bruto de provider não cabe em 2 KB, então a regra deixa de
depender de disciplina e passa a depender do banco.

**Sem `updated_at`**: a tabela não tem UPDATE (§6 e §7).

---

## 2. Triggers e funções

### 2.1 Convenções já existentes, aplicadas às três tabelas

| Trigger | Onde | Para quê |
|---|---|---|
| `set_updated_at` | `conversations` | Já existe no projeto |
| `prevent_clinic_id_change` | as três | Já existe no projeto |

### 2.2 `enforce_conversation_status_transition`

Espelha o padrão de `appointments`, com a diferença de que **nenhum estado é
terminal**:

```
open            -> waiting_patient, resolved
waiting_patient -> open, resolved
resolved        -> open
```

`resolved -> waiting_patient` fica de fora: reabrir devolve à fila da clínica,
e só de lá a conversa pode voltar a esperar o paciente. Um passo, não dois.

Regra no banco, não só na API, para que nenhum caminho de escrita produza
histórico impossível. **Espelhada em `packages/shared`.**

### 2.3 `bump_conversation_version` — e o cuidado que ela exige

```sql
create or replace function public.bump_conversation_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- SO colunas de controle contam. Chegada de mensagem mexe apenas nos
  -- timestamps de atividade, e nao pode invalidar uma operacao humana em voo:
  -- a atendente clicou "assumir" com a versao 4 na mao; se uma mensagem chegasse
  -- nesse intervalo e bumpasse a versao, o clique dela falharia com 409 sem que
  -- nada relevante tivesse mudado. Isso treinaria a equipe a ignorar o aviso de
  -- conflito, que e justamente o aviso que precisa ser levado a serio.
  if new.status              is distinct from old.status
     or new.assigned_to      is distinct from old.assigned_to
     or new.patient_id       is distinct from old.patient_id
     or new.contact_phone_e164 is distinct from old.contact_phone_e164
  then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;
```

### 2.4 `on_message_inserted` — atividade e reabertura automática

`after insert on messages`, uma função que:

1. atualiza `last_message_at`, e `last_inbound_at` **ou** `last_outbound_at`
   conforme a direção;
2. se `direction = 'inbound'` e `status = 'resolved'`, **reabre** para `open` e
   grava um `conversation_events` de `status_changed` com
   `actor_user_id = null` e `metadata = {"from":"resolved","to":"open","reason":"inbound_message"}`.

No banco, e não na aplicação, porque quando o webhook existir ele será outro
caminho de escrita — e a reabertura não pode depender de qual código chamou.

> **Consequência aceita:** essa reabertura muda `status`, então **bumpa a
> versão** (2.3). Está correto: a conversa mudou de estado de verdade, e uma
> operação humana baseada no estado anterior deve mesmo receber 409.

### 2.5 `stamp_conversation_event_actor`

`before insert on conversation_events`: **o cliente nunca informa quem é o
autor**. A função sobrescreve `actor_user_id := auth.uid()` e busca
`actor_name_snapshot` / `actor_role_snapshot` via helper `security definer`
que lê `profiles` e `clinic_members`.

Quando `auth.uid()` é nulo (trigger de reabertura automática), os três campos
ficam nulos e o evento é legitimamente “do sistema”.

Custo: um lookup por evento. Eventos são unidades — poucas por conversa — e um
log de auditoria com autor forjável não vale nada. Correção acima de
micro-otimização.

### 2.6 Sem RPC

Não proponho nenhuma. Todas as operações são UPDATE condicional simples (§12),
que o cliente `supabase-js` da API executa direto. RPC só se justificaria para
transação multi-tabela; a única candidata seria “muda estado + grava evento”,
e ela cabe numa transação da API sem função no banco.

---

## 3. RLS

Mesma forma da fundação: **ausência de policy é negação total**.

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `conversations` | membro | membro | membro | **nenhuma** |
| `messages` | membro | membro | **nenhuma** | **nenhuma** |
| `conversation_events` | membro | membro | **nenhuma** | **nenhuma** |

Todas com `using (public.is_clinic_member(clinic_id))` e, nas de escrita,
`with check (public.is_clinic_member(clinic_id))`.

Três ausências deliberadas:

- **`conversations` sem DELETE.** Conversa não se apaga: resolve.
- **`messages` sem UPDATE nem DELETE.** Mensagem é fato consumado. Quando o
  provedor chegar, `delivery_status` vai precisar de uma policy de UPDATE
  restrita a essa coluna — **migration futura, decisão futura**.
- **`conversation_events` sem UPDATE nem DELETE.** É o que torna “imutável” uma
  propriedade do banco e não uma promessa da aplicação.

---

## 4. Grants

`revoke-then-grant`, como a 0007 estabeleceu e a agenda repetiu.

```sql
revoke all on public.conversations        from public, anon, authenticated;
revoke all on public.messages             from public, anon, authenticated;
revoke all on public.conversation_events  from public, anon, authenticated;

grant select, insert, update on public.conversations       to authenticated;
grant select, insert         on public.messages            to authenticated;
grant select, insert         on public.conversation_events to authenticated;
```

**Sem `TRUNCATE`** — RLS não cobre TRUNCATE, e quem o tiver apaga os dados de
todos os tenants sem violar policy nenhuma. **Sem `REFERENCES`** — as FKs
compostas são criadas pelo dono na migration. **Sem `DELETE` em lugar nenhum.**

---

## 5. Tipos compartilhados (`packages/shared`)

Novo `src/conversation.ts`, exportado no barrel:

- `ConversationChannel`, `ConversationStatus`, `MessageDirection`,
  `ConversationEventType`
- `CONVERSATION_STATUS_LABELS` e `CONVERSATION_EVENT_LABELS` em pt-BR
- **`CONVERSATION_STATUS_TRANSITIONS`** — espelho literal do trigger 2.2, como
  `APPOINTMENT_STATUS_TRANSITIONS` já faz
- Schemas zod: `createConversationSchema`, `addMessageSchema`,
  `assignConversationSchema`, `transferConversationSchema`,
  `changeStatusSchema`, `linkPatientSchema`
- Helper puro `needsReply(conversation)` — testável sem banco, e é o único lugar
  onde a regra de “precisa de resposta” existe

---

## 6. Endpoints REST

Todos sob `AuthGuard` + `ClinicMembershipGuard`. **Nenhum aceita `clinicId` no
corpo** — ele vem do header validado no servidor.

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| `GET` | `/api/conversations` | — | Lista paginada |
| `GET` | `/api/conversations/counts` | — | Contadores das abas |
| `GET` | `/api/conversations/:id` | — | Conversa + paciente |
| `POST` | `/api/conversations` | `CreateConversationInput` | 201 |
| `GET` | `/api/conversations/:id/messages` | — | Paginado, cronológico |
| `POST` | `/api/conversations/:id/messages` | `AddMessageInput` | 201 |
| `GET` | `/api/conversations/:id/events` | — | Histórico |
| `POST` | `/api/conversations/:id/assign` | `{ version }` | 200 ou **409** |
| `POST` | `/api/conversations/:id/transfer` | `{ version, toUserId }` | 200 ou **409** |
| `POST` | `/api/conversations/:id/release` | `{ version }` | 200 ou **409** |
| `PATCH` | `/api/conversations/:id/status` | `{ version, status }` | 200 ou **409** |
| `POST` | `/api/conversations/:id/patient` | `{ version, patientId }` | 200 ou **409** |
| `DELETE` | `/api/conversations/:id/patient` | `{ version }` | 200 ou **409** |

**`GET /api/conversations` é paginado desde o primeiro dia** — a fila cresce sem
teto, diferente de profissionais e serviços. Cursor por
`(last_message_at desc, id desc)`, não `offset`: a fila reordena a cada mensagem
e offset devolveria itens repetidos ou pulados.

**`/counts` numa chamada só.** Sem ele, desenhar seis abas custaria seis
consultas — e a §11 do `architecture.md` já mostra o preço de uma ida e volta a
mais nesta infraestrutura.

**404 idêntico** para “não existe” e “é de outro tenant”, sem `Location` e sem
consulta extra que crie diferença de tempo. Regra que já vale no projeto.

---

## 7. DTOs

```ts
CreateConversationInput = {
  channel: 'manual'                    // v0.1 aceita SO manual
  contactPhoneE164?: string            // E.164 validado no zod
  contactName?: string
  patientId?: string
  firstMessage?: { direction, body, occurredAt? }
}

AddMessageInput = {
  direction: 'inbound' | 'outbound'
  body: string                         // 1..4096
  occurredAt?: string                  // default: agora
}

ConversationListItem = {
  id, channel, status, assignedTo, assignedToName,
  patientId, patientName, contactName, contactPhoneE164,
  lastMessageAt, lastMessagePreview, needsReply, version
}
```

`lastMessagePreview` é derivado no servidor (a lista precisa dele, e trazer a
última mensagem inteira de cada conversa seria N+1 disfarçado de conveniência).

`assignedToName` e `patientName` vêm de join, **não** de coluna
desnormalizada — nome muda, e a fila não pode mostrar um nome antigo.

---

## 8. Protocolo de concorrência otimista

Uma única forma, para as seis operações de controle:

```
1. A tela leu a conversa com version = N.
2. A operação envia { version: N, ...campos }.
3. A API executa UPDATE ... WHERE clinic_id = :c AND id = :id AND version = :N
   RETURNING *
4. 1 linha  -> 200 com o novo estado (version já incrementada pelo trigger)
   0 linhas -> 409
```

O 409 devolve **o estado atual completo**, no mesmo formato do 200:

```json
{
  "error": "CONVERSATION_VERSION_CONFLICT",
  "current": { "id": "…", "version": 7, "status": "open",
               "assignedTo": "…", "assignedToName": "Ana Souza" }
}
```

Assim a tela consegue dizer **“Ana assumiu esta conversa às 14:29”** em vez de
“erro ao salvar”, e a pessoa decide o que fazer com informação na mão.

### Assumir tem uma trava a mais

```sql
update conversations
   set assigned_to = :eu
 where clinic_id = :c and id = :id and version = :n
   and assigned_to is null          -- <<<
returning *;
```

A condição `assigned_to is null` é redundante com a versão no caso comum, mas
cobre o caso em que a versão coincide por outro caminho. **Duas pessoas nunca
recebem 200 no mesmo `assign`** — é o requisito literal da decisão 10.

Transferir usa `and assigned_to = :de_quem_eu_vi`, pelo mesmo motivo: transferir
“de X para Y” nunca pode virar “de qualquer um para Y”.

### O que NÃO participa da versão

`POST /messages` não envia nem checa versão. Mensagem é acréscimo, nunca
substitui estado — e, pela regra 2.3, não bumpa versão a menos que dispare a
reabertura automática, quando o bump é o comportamento certo.

---

## 9. Eventos gravados por operação

| Operação | Evento | Metadata |
|---|---|---|
| `POST /conversations` | `conversation_created` | `{channel}` |
| `assign` | `assigned` | `{to_user_id}` |
| `transfer` | `transferred` | `{from_user_id, to_user_id}` |
| `release` | `released` | `{from_user_id}` |
| `PATCH /status` | `status_changed` | `{from, to}` |
| reabertura automática | `status_changed` | `{from, to, reason:"inbound_message"}`, actor nulo |
| `POST /patient` | `patient_linked` | `{patient_id}` |
| `DELETE /patient` | `patient_unlinked` | `{patient_id}` |

Cada operação grava conversa + evento **na mesma transação**. Estado sem
histórico correspondente é um bug que não pode existir — e o custo é uma
transação, não uma fila.

---

## 10. Fixtures e testes

### Unitários (`pnpm test`, sem banco)

- Transições válidas e inválidas contra `CONVERSATION_STATUS_TRANSITIONS`
- `needsReply` nas quatro combinações de `last_inbound_at`/`last_outbound_at`,
  incluindo ambos nulos e inbound sem outbound
- Zod: E.164 aceito/recusado, `body` vazio e acima de 4096, `direction` inválida
- Rótulos pt-BR cobrindo todos os valores dos enums (teste de exaustividade que
  quebra quando alguém adiciona um estado e esquece o rótulo)

### Integração e isolamento (`pnpm test:isolation`)

Cenário: clínica A com 2 usuários (A1 e A2), clínica B com 1; conversas em cada
uma; um paciente por clínica.

---

## 11. Testes cross-tenant

1. A lista conversas → só as de A.
2. A busca conversa de B por id → **404 idêntico** ao de um UUID inexistente:
   mesmo status, mesmo corpo, sem `Location`. Asserção compara as duas respostas.
3. A tenta `assign` em conversa de B → 404 (nunca 403, que confirmaria existência).
4. A lê mensagens de conversa de B → 404, corpo sem nenhum campo de B.
5. A insere mensagem com `conversation_id` de B → `42501`.
6. A tenta mover conversa para a clínica B → recusado por `with check` + trigger.
7. A tenta vincular `patient_id` de B → recusado pela FK composta.
8. A tenta `assigned_to` de um usuário só da clínica B → recusado pela FK composta.
9. Cliente anônimo → nada, nas três tabelas.
10. **`X-Clinic-Id` forjado** de B com JWT de A, em `GET /conversations`,
    `POST /conversations` e `GET /conversations/:id` → negado, e a asserção
    verifica que **nenhum campo de dado de B aparece no corpo**. Status sozinho
    não basta.
11. `X-Clinic-Id` de clínica inexistente → mesma negação.

## 12. Testes com `service_role`

O ponto destes é provar o que **RLS sozinho não garante**, porque verificação de
FK ignora RLS:

12. `service_role` insere conversa com `patient_id` de outra clínica → `23503`.
13. `service_role` insere conversa com `assigned_to` de membro de outra clínica → `23503`.
14. `service_role` insere mensagem com `conversation_id` de outra clínica → `23503`.
15. `service_role` insere evento com `conversation_id` de outra clínica → `23503`.
16. `service_role` tenta UPDATE em `conversation_events` → permitido no banco
    (service_role ignora RLS), mas **`authenticated` recebe negação** — o teste
    afirma a fronteira exata em vez de fingir que service_role é barrado.

### Concorrência

17. Dois `assign` disparados em paralelo na mesma conversa → **exatamente um
    200 e um 409**. Executado N vezes para não passar por sorte de escalonamento.
18. `transfer` com responsável desatualizado → 409, sem sobrescrever.
19. `PATCH status` com versão velha → 409, e o corpo traz o estado atual.
20. Mensagem chegando entre a leitura e a operação **não** provoca 409 (prova a
    regra 2.3 de bump seletivo).

### Ciclo de vida

21. `resolved` + mensagem inbound → volta a `open` e grava `status_changed` com
    actor nulo e `reason`.
22. Remover membership de quem tinha conversa atribuída → conversa volta à fila
    (`assigned_to` nulo), **a remoção não é bloqueada**, e os eventos antigos
    continuam legíveis com `actor_name_snapshot` preservado.
23. Duas conversas manuais sem telefone na mesma clínica → ambas criadas
    (ausência de identidade não é colisão).
24. Duas conversas manuais com o **mesmo** telefone → a segunda é recusada, e a
    API responde reaproveitando a existente em vez de erro cru.

---

## 13. Plano de frontend

Rota `/atendimento`, dentro do route group `(app)`. Sidebar ganha o item entre
**Pacientes** e a seção Gestão — é operação, não gestão.

| Arquivo | Papel |
|---|---|
| `(app)/atendimento/page.tsx` | Server component; busca fila + conversa selecionada |
| `(app)/atendimento/loading.tsx` | Esqueleto no padrão atual |
| `conversation-list.tsx` | Client; filtros, busca, seleção otimista |
| `conversation-thread.tsx` | Client; mensagens, eventos discretos, composer manual |
| `conversation-context.tsx` | Server; paciente, próxima consulta, histórico |
| `conversation-actions.tsx` | Client; assumir/transferir/liberar/resolver com `version` |

**Padrões já estabelecidos que se aplicam aqui sem exceção:**

- Conversa selecionada em **query string** (`?c=<id>`), como Pacientes faz com
  `?p=` — URL compartilhável, shell preservado
- **`useOptimistic` + `useTransition`** na seleção e nas ações: o clique não pode
  ficar morto, como já corrigido na agenda
- **Uma onda de rede**: `loadForActiveClinic` com o palpite de clínica, fila e
  conversa em paralelo
- Contadores das abas **reais**, vindos de `/counts` — nunca número inventado
- Estados vazios **compactos**, no padrão de “Tudo em dia”
- Composer com rótulo explícito **“registro manual”**; nada que sugira envio real

---

## 14. Ordem dos commits

Cada passo é verificável sozinho e deixa a árvore verde.

| # | Commit | Gate |
|---|---|---|
| 1 | Tipos e schemas em `packages/shared` + testes unitários | `pnpm test` |
| 2 | Três migrations (**escritas, não aplicadas**) + revisão | leitura |
| 3 | `pnpm db:push` com portão de confirmação | `verify:privileges` |
| 4 | Testes de isolamento e cross-tenant **antes da API** | `test:isolation` |
| 5 | Módulo NestJS: leitura (`GET` fila, conversa, mensagens, eventos, counts) | `test:isolation` |
| 6 | Escrita: criar conversa, adicionar mensagem | `test:isolation` |
| 7 | Controle: assign / transfer / release / status / patient + concorrência | `test:isolation` |
| 8 | Frontend: fila e thread (leitura) | build + visual |
| 9 | Frontend: ações e composer manual | build + visual |
| 10 | Sidebar + polimento + capturas | todos os gates |

O passo 4 antes do 5 é deliberado: **os testes de isolamento rodam contra o
banco, não contra a API**. Escrever a API antes deles significaria descobrir um
furo de RLS depois de já ter código apoiado nele.

---

## 15. Estratégia de rollback

Este módulo tem a melhor situação possível: **as migrations são puramente
aditivas**. Nenhuma tabela existente é alterada, nenhuma coluna some, nenhum
dado é migrado.

| Camada | Como reverter | Perde |
|---|---|---|
| Frontend | `git revert` do commit; a Vercel republica | nada |
| API | Redeploy da imagem SHA anterior | nada |
| Banco | `drop table` das três + `drop type` dos cinco enums | só os dados de atendimento |

Escrevo o `down.sql` correspondente **junto** com a migration, mesmo o CLI não o
exigindo: se ele não existir no dia da decisão, será escrito às pressas.

**A janela de risco real não é o rollback, é a ordem.** A Vercel publica no
push; a imagem da VPS é atualizada à mão. Então existe um intervalo em que o
frontend novo conversa com a API velha. Mitigação já usada na agenda: a tela
**tolera 404 nas rotas novas** e mostra estado vazio em vez de quebrar.

---

## 16. Riscos

| # | Risco | Probabilidade | Mitigação |
|---|---|---|---|
| 1 | **`SET NULL` composto anulando `clinic_id`** e bloqueando remoção de membership | Alta se não tratado | `on delete set null (assigned_to)`, PG 15+. Teste 22 prova o comportamento. |
| 2 | Identidade da thread com regra ambígua entre wa_id e telefone | Média | Índices parciais mutuamente exclusivos (§1). Testes 23-24. |
| 3 | **Chegada de mensagem invalidando operação humana** e treinando a equipe a ignorar 409 | Alta se a versão bumpar em tudo | Bump seletivo (2.3). Teste 20. |
| 4 | `provider` na identidade partindo o histórico na troca de fornecedor | Média | `channel` na identidade, `provider` operacional. **Pende de decisão.** |
| 5 | Fila crescendo sem paginação | Certa com o tempo | Cursor desde o commit 5 |
| 6 | N+1 ao montar a lista (última mensagem por conversa) | Alta | `lastMessagePreview` resolvido no servidor |
| 7 | Autoria perdida ao remover funcionário | Alta sem snapshot | `actor_name_snapshot` gravado por trigger no momento do evento |
| 8 | Payload de provider inchando `metadata` | Média quando houver webhook | `check` de 2 KB no banco |
| 9 | Janela frontend novo × API velha | Certa, é o processo atual | Tolerância a 404 nas rotas novas |
| 10 | `manual` sendo lido como “WhatsApp funcionando” | **Alta — risco de produto** | Rótulo explícito na UI; composer não promete entrega; canal visível |

O risco 10 não é técnico e é o que mais me preocupa: uma clínica em piloto pode
achar que o WhatsApp está integrado porque a tela parece uma caixa de mensagens.
A UI precisa dizer o que é, em texto, na tela — não só na documentação.

---

## Duas decisões ainda abertas

1. **`channel` separado de `provider`** (§3 da proposta, risco 4). Recomendo
   separar: troca de fornecedor não pode partir o histórico de todo paciente.
2. **`appointment_created` como evento** (§12 da proposta). Recomendo aceitar:
   custa um INSERT e preserva desde o dia um o dado que responde “quantos
   agendamentos nasceram do atendimento?”.

Nenhuma migration será escrita antes destas duas respostas.
