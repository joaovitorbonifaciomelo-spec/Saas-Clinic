# Plano final consolidado — migrations do Atendimento Core v0.1

> **Nada executado.** Nenhuma migration rodada, nenhum código escrito.
> Domínio fechado em [`atendimento.md`](./atendimento.md) — 19 decisões, nenhuma
> em aberto. Este é o SQL para a **última revisão antes do `db:push`**.

---

## 1. Nomes e ordem

Três arquivos, mesma divisão da agenda. Todos **puramente aditivos**: nenhuma
tabela existente é alterada, nenhuma coluna some, nenhum dado é migrado.

```
supabase/migrations/
  20260828100000_atendimento_schema.sql
  20260828100100_atendimento_rls.sql
  20260828100200_atendimento_grants.sql
```

A ordem importa: policies precisam das tabelas; grants precisam de ambos. É a
mesma sequência que a fundação e a agenda seguiram.

---

## 2. Enums

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

  -- Todos os valores ja entram, mesmo sem uso na v0.1: acrescentar valor a enum
  -- depois e barato, mas ter a coluna com o tipo certo desde o comeco evita uma
  -- migration de alteracao de tipo quando o provedor chegar.
  if not exists (select 1 from pg_type where typname = 'message_delivery_status') then
    create type public.message_delivery_status as enum
      ('pending', 'sent', 'delivered', 'read', 'failed');
  end if;

  if not exists (select 1 from pg_type where typname = 'conversation_event_type') then
    create type public.conversation_event_type as enum (
      'conversation_created',
      'assigned',
      'transferred',
      'released',
      'patient_linked',
      'patient_unlinked',
      'status_changed',
      'appointment_created'
    );
  end if;
end
$$;
```

**`provider` NÃO é enum, é `text`.** Ele é metadado operacional, não domínio com
comportamento: `channel` decide identidade e regra, `provider` só registra quem
entregou. Como `text`, acrescentar um adaptador não exige migration nenhuma — a
lista de valores válidos vive em `packages/shared` e na validação da API, onde
ela pode mudar junto com o código do adaptador.

---

## 3. `conversations`

```sql
create table if not exists public.conversations (
  id                     uuid primary key default gen_random_uuid(),
  clinic_id              uuid not null references public.clinics (id) on delete cascade,

  -- ---------- identidade ----------
  channel                public.conversation_channel not null,
  provider               text
                           check (provider is null
                                  or char_length(btrim(provider)) between 2 and 40),
  provider_contact_id    text
                           check (provider_contact_id is null
                                  or char_length(btrim(provider_contact_id)) between 1 and 128),
  contact_phone_e164     text
                           check (contact_phone_e164 is null
                                  or contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  contact_name_snapshot  text
                           check (contact_name_snapshot is null
                                  or char_length(btrim(contact_name_snapshot)) between 1 and 120),

  patient_id             uuid,

  -- ---------- trabalho ----------
  status                 public.conversation_status not null default 'open',
  assigned_to            uuid,

  -- ---------- atividade (sem contador; decisao 4) ----------
  last_message_at        timestamptz,
  last_inbound_at        timestamptz,
  last_outbound_at       timestamptz,

  version                integer not null default 1 check (version > 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint conversations_clinic_id_id_key unique (clinic_id, id),

  -- Decisao 16: manual nao tem infraestrutura de entrega; canal externo tem.
  constraint conversations_channel_provider_check check (
    (channel =  'manual' and provider is null and provider_contact_id is null)
    or
    (channel <> 'manual' and provider is not null)
  ),

  constraint conversations_patient_fk
    foreign key (clinic_id, patient_id)
    references public.patients (clinic_id, id)
    on delete set null (patient_id),

  constraint conversations_assignee_fk
    foreign key (clinic_id, assigned_to)
    references public.clinic_members (clinic_id, user_id)
    on delete set null (assigned_to)
);
```

### 3.1 A armadilha do `SET NULL` composto

`on delete set null` **sem lista de colunas anula TODAS as colunas da FK**,
inclusive `clinic_id`. Como `clinic_id` é `not null`, remover um membership
falharia com violação de not-null e **bloquearia a remoção do funcionário** — o
oposto do que a decisão 6 pede.

`on delete set null (assigned_to)` restringe a anulação à coluna certa. Existe
desde o **PostgreSQL 15**; o projeto roda **PG 17**
(`supabase/config.toml`, `major_version = 17`). Vale o mesmo para `patient_id`.

### 3.2 Identidade da thread — decisão 17 aplicada

> A identidade canônica é o **telefone**. `provider_contact_id` pode mudar
> quando o fornecedor muda; o número não. Ele fica como identidade operacional
> da integração, fora da chave sempre que houver telefone.

```sql
-- 1) IDENTIDADE CANONICA: telefone normalizado, sempre que existir.
--    Independe de provider e de provider_contact_id — e por isso que trocar
--    de fornecedor nao cria thread nova.
create unique index if not exists conversations_phone_identity_key
  on public.conversations (clinic_id, channel, contact_phone_e164)
  where contact_phone_e164 is not null;

-- 2) FALLBACK OPERACIONAL: so quando NAO ha telefone.
--    O predicado `contact_phone_e164 is null` e o que torna os dois indices
--    mutuamente exclusivos: nenhuma linha e governada pelas duas regras.
create unique index if not exists conversations_provider_identity_key
  on public.conversations (clinic_id, channel, provider_contact_id)
  where contact_phone_e164 is null and provider_contact_id is not null;

-- 3) SEM IDENTIDADE: nao existe indice, e isso e deliberado.
--    Atendimento presencial sem telefone nao recebe identidade inventada;
--    cada conversa e propria, por construcao.
```

**O que mudou em relação à versão anterior do plano:** a prioridade estava
invertida (id do provedor primeiro), e o predicado de exclusão estava no índice
do telefone. Agora o telefone manda e a exclusão vive no índice do provedor.

**A consequência que assumo como custo, não como descuido:** uma conversa que
nasceu só com `provider_contact_id` e **depois** descobre o telefone pode colidir
com uma thread já existente daquele número. O banco recusa com `23505`, a API
responde com mensagem clara, e **fusão de threads fica explicitamente fora da
v0.1**. Mitigação: capturar e normalizar o telefone o mais cedo possível, para
que o caminho “só id do provedor” seja a exceção.

### 3.3 Índices de consulta

```sql
create index if not exists conversations_queue_idx
  on public.conversations (clinic_id, status, last_message_at desc nulls last, id desc);

create index if not exists conversations_mine_idx
  on public.conversations (clinic_id, assigned_to, last_message_at desc nulls last, id desc)
  where assigned_to is not null;

create index if not exists conversations_patient_idx
  on public.conversations (clinic_id, patient_id)
  where patient_id is not null;
```

O `id desc` na cauda dos dois primeiros não é enfeite: o cursor da fila é
`(last_message_at, id)`, e sem o `id` no índice a paginação faria um sort extra
a cada página.

---

## 4. `messages`

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

  provider             text
                         check (provider is null
                                or char_length(btrim(provider)) between 2 and 40),
  provider_message_id  text
                         check (provider_message_id is null
                                or char_length(btrim(provider_message_id)) between 1 and 200),
  delivery_status      public.message_delivery_status,

  created_at           timestamptz not null default now(),

  constraint messages_clinic_id_id_key unique (clinic_id, id),

  constraint messages_conversation_fk
    foreign key (clinic_id, conversation_id)
    references public.conversations (clinic_id, id) on delete cascade,

  -- inbound nao tem autor interno
  constraint messages_inbound_has_no_author
    check (direction = 'outbound' or author_user_id is null),

  -- delivery_status so faz sentido saindo
  constraint messages_delivery_only_outbound
    check (delivery_status is null or direction = 'outbound')
);

create index if not exists messages_thread_idx
  on public.messages (clinic_id, conversation_id, occurred_at, id);
```

### 4.1 Idempotência — índice parcial, não constraint

```sql
create unique index if not exists messages_provider_dedup_key
  on public.messages (clinic_id, provider, provider_message_id)
  where provider_message_id is not null;
```

- **Mensagem manual precisa poder repetir.** Duas anotações idênticas da mesma
  ligação são dois fatos, não duplicata.
- **Sem fallback artificial.** `coalesce(provider_message_id, id::text)` tornaria
  o índice inútil — nunca colidiria — e daria falsa sensação de proteção.

O índice parcial diz exatamente o que quer dizer: *quando existe id do provedor,
ele é único dentro da clínica.*

**Sem `updated_at` e sem UPDATE.** Mensagem é fato consumado. A única coluna que
mudará depois é `delivery_status`, e ela ganha policy própria na migration do
provedor — não agora.

---

## 5. `conversation_events`

```sql
create table if not exists public.conversation_events (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            uuid not null references public.clinics (id) on delete cascade,
  conversation_id      uuid not null,

  event_type           public.conversation_event_type not null,

  -- Decisao 7: historico sobrevive a saida do funcionario.
  actor_user_id        uuid references auth.users (id) on delete set null,
  actor_name_snapshot  text
                         check (actor_name_snapshot is null
                                or char_length(btrim(actor_name_snapshot)) between 1 and 120),
  actor_role_snapshot  public.clinic_role,

  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),

  constraint conversation_events_clinic_id_id_key unique (clinic_id, id),

  constraint conversation_events_conversation_fk
    foreign key (clinic_id, conversation_id)
    references public.conversations (clinic_id, id) on delete cascade,

  -- Teto geral: payload bruto de webhook nao cabe em 2 KB. Tira a regra do
  -- campo da disciplina e coloca no campo do banco.
  constraint conversation_events_metadata_size check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 2048
  ),

  -- Decisao 18: metadata de appointment_created e ESTRITO.
  -- `metadata - 'appointment_id' = '{}'` prova que nao ha nenhuma outra chave,
  -- sem precisar de subconsulta (check constraint nao aceita subconsulta).
  constraint conversation_events_appointment_metadata check (
    event_type <> 'appointment_created'
    or (
      metadata ? 'appointment_id'
      and metadata - 'appointment_id' = '{}'::jsonb
      and metadata->>'appointment_id' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
  )
);

create index if not exists conversation_events_history_idx
  on public.conversation_events (clinic_id, conversation_id, created_at, id);
```

**Sem `updated_at`**: a tabela não tem UPDATE (§7 e §8).

---

## 6. Triggers e funções

### 6.1 Convenções já existentes

| Trigger | Onde | Origem |
|---|---|---|
| `set_updated_at` | `conversations` | Fundação |
| `prevent_clinic_id_change` | as três | Fundação |

### 6.2 `enforce_conversation_status_transition`

```
open            -> waiting_patient, resolved
waiting_patient -> open, resolved
resolved        -> open
```

`resolved -> waiting_patient` fica de fora: reabrir devolve à fila da clínica, e
só de lá a conversa volta a esperar o paciente. Um passo, não dois.

Mesmo formato do trigger de `appointments`, incluindo o guarda de
`new.status is not distinct from old.status` para que um `set status = status`
vindo de patch genérico não seja recusado. **Espelhado em `packages/shared`.**

### 6.3 `bump_conversation_version` — seletivo

```sql
create or replace function public.bump_conversation_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- SO colunas de controle contam.
  --
  -- A atendente clicou "assumir" com a versao 4 na mao. Se uma mensagem
  -- chegasse nesse intervalo e bumpasse a versao, o clique falharia com 409 sem
  -- que nada relevante tivesse mudado — e a equipe aprenderia que o aviso de
  -- conflito aparece a toa, passando a ignorar justamente o aviso que precisa
  -- ser levado a serio.
  if new.status              is distinct from old.status
     or new.assigned_to        is distinct from old.assigned_to
     or new.patient_id         is distinct from old.patient_id
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

A exceção prova a regra: quando uma mensagem *inbound* reabre uma conversa
`resolved`, o status muda de verdade — e aí o bump é o comportamento certo.

### 6.4 `on_message_inserted`

`after insert on messages`:

1. atualiza `last_message_at` e `last_inbound_at` **ou** `last_outbound_at`,
   conforme a direção;
2. se `direction = 'inbound'` e `status = 'resolved'`, **reabre** para `open` e
   grava `conversation_events` de `status_changed` com `actor_user_id` nulo e
   `metadata = {"from":"resolved","to":"open","reason":"inbound_message"}`.

No banco, e não na aplicação, porque quando o webhook existir ele será outro
caminho de escrita — e a reabertura não pode depender de qual código chamou.

### 6.5 `stamp_conversation_event_actor`

`before insert on conversation_events`: **o cliente nunca informa quem é o
autor**. A função sobrescreve `actor_user_id := auth.uid()` e carimba
`actor_name_snapshot` / `actor_role_snapshot` via helper `security definer` que
lê `profiles` e `clinic_members`.

Com `auth.uid()` nulo (reabertura automática), os três ficam nulos e o evento é
legitimamente “do sistema”. Custo: um lookup por evento — e um log de auditoria
com autor forjável não vale nada.

### 6.6 `validate_appointment_event` — a proteção que jsonb não tem

```sql
create or replace function public.validate_conversation_event_appointment()
returns trigger language plpgsql as $$
begin
  if new.event_type = 'appointment_created' then
    -- Roda com os direitos do INVOCADOR, entao o RLS de appointments se aplica.
    -- Um agendamento de outra clinica simplesmente nao existe para esta sessao.
    perform 1
       from public.appointments a
      where a.clinic_id = new.clinic_id
        and a.id = (new.metadata->>'appointment_id')::uuid;

    if not found then
      raise exception 'APPOINTMENT_NOT_IN_CLINIC: agendamento inexistente nesta clinica.'
        using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;
```

> **Por que este trigger existe.** `appointment_id` mora dentro de um `jsonb`, e
> **jsonb não recebe FK**. Toda a proteção tenant-first que as FKs compostas dão
> às colunas simplesmente não alcança ali dentro. Sem este trigger, plantar no
> log a referência a um agendamento de outra clínica seria possível.
>
> Não vazaria dado — o leitor resolve o id por uma rota protegida por RLS e
> receberia 404 —, mas um log de auditoria que aceita referência falsa deixa de
> ser auditoria. Aqui a checagem passa a ser do banco, e não “a API precisa
> lembrar”.

**Sem RPC.** Todas as operações são UPDATE condicional simples (§10). A única
candidata a RPC — “muda estado + grava evento” — cabe numa transação da API.

---

## 7. RLS

Ausência de policy é negação total, como na fundação.

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `conversations` | membro | membro | membro | **nenhuma** |
| `messages` | membro | membro | **nenhuma** | **nenhuma** |
| `conversation_events` | membro | membro | **nenhuma** | **nenhuma** |

```sql
alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;
alter table public.conversation_events enable row level security;

-- conversations
create policy conversations_select_member on public.conversations
  for select to authenticated using (public.is_clinic_member(clinic_id));
create policy conversations_insert_member on public.conversations
  for insert to authenticated with check (public.is_clinic_member(clinic_id));
create policy conversations_update_member on public.conversations
  for update to authenticated
  using (public.is_clinic_member(clinic_id))
  with check (public.is_clinic_member(clinic_id));

-- messages (sem update, sem delete)
create policy messages_select_member on public.messages
  for select to authenticated using (public.is_clinic_member(clinic_id));
create policy messages_insert_member on public.messages
  for insert to authenticated with check (public.is_clinic_member(clinic_id));

-- conversation_events (sem update, sem delete)
create policy conversation_events_select_member on public.conversation_events
  for select to authenticated using (public.is_clinic_member(clinic_id));
create policy conversation_events_insert_member on public.conversation_events
  for insert to authenticated with check (public.is_clinic_member(clinic_id));
```

Três ausências deliberadas: conversa não se apaga (resolve); mensagem é fato
consumado; e o log é imutável **por propriedade do banco**, não por promessa da
aplicação.

---

## 8. Grants

`revoke-then-grant`, como a 0007 estabeleceu.

```sql
revoke all on public.conversations       from public, anon, authenticated;
revoke all on public.messages            from public, anon, authenticated;
revoke all on public.conversation_events from public, anon, authenticated;

grant select, insert, update on public.conversations       to authenticated;
grant select, insert         on public.messages            to authenticated;
grant select, insert         on public.conversation_events to authenticated;
```

- **Sem `TRUNCATE`** — RLS não o cobre, e quem o tiver apaga os dados de todos
  os tenants sem violar policy nenhuma.
- **Sem `REFERENCES`** — as FKs compostas são criadas pelo dono na migration.
- **Sem `DELETE` em lugar nenhum.**
- Começar por `revoke` porque a plataforma do Supabase reconcilia default
  privileges concedendo `ALL` no schema `public`, e `GRANT` é aditivo.

---

## 9. State machine

| De | Para | Quem dispara |
|---|---|---|
| `open` | `waiting_patient` | atendente |
| `open` | `resolved` | atendente |
| `waiting_patient` | `open` | atendente **ou** mensagem inbound |
| `waiting_patient` | `resolved` | atendente |
| `resolved` | `open` | atendente **ou** mensagem inbound |

Nenhum estado é terminal. Regra no banco (6.2) **e** espelhada em
`packages/shared` como `CONVERSATION_STATUS_TRANSITIONS`, do mesmo jeito que
`APPOINTMENT_STATUS_TRANSITIONS` já faz.

---

## 10. Protocolo de `version` / 409

```
1. A tela leu a conversa com version = N
2. A operação envia { version: N, ...campos }
3. UPDATE ... WHERE clinic_id = :c AND id = :id AND version = :N RETURNING *
4. 1 linha  -> 200 com o novo estado (version ja incrementada pelo trigger)
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

Assim a tela diz **“Ana assumiu esta conversa às 14:29”** em vez de “erro ao
salvar”, e a pessoa decide com informação na mão.

### Travas adicionais

```sql
-- assumir: alem da versao, exige que ninguem tenha assumido
... and version = :n and assigned_to is null

-- transferir: exige que o responsavel seja quem eu vi
... and version = :n and assigned_to = :de_quem_eu_vi
```

**Duas pessoas nunca recebem 200 no mesmo `assign`** — requisito literal da
decisão 10. `POST /messages` não envia nem checa versão: mensagem é acréscimo,
nunca substitui estado.

---

## 11. Estratégia de audit / eventos

Cada operação grava conversa + evento **na mesma transação**. Estado sem
histórico correspondente é um bug que não pode existir.

| Operação | `event_type` | `metadata` |
|---|---|---|
| `POST /conversations` | `conversation_created` | `{channel}` |
| `assign` | `assigned` | `{to_user_id}` |
| `transfer` | `transferred` | `{from_user_id, to_user_id}` |
| `release` | `released` | `{from_user_id}` |
| `PATCH /status` | `status_changed` | `{from, to}` |
| reabertura automática | `status_changed` | `{from, to, reason:"inbound_message"}`, actor nulo |
| `POST /patient` | `patient_linked` | `{patient_id}` |
| `DELETE /patient` | `patient_unlinked` | `{patient_id}` |
| agendamento criado a partir da conversa | `appointment_created` | `{appointment_id}` — **só após sucesso** |

**Um `event_type` por operação humana significativa.** `resolved` e `reopened`
não existem como tipos: são a mesma operação — transição de status pelo mesmo
endpoint — e `status_changed` com `{from, to}` representa integralmente.
`assigned`/`transferred`/`released` ficam separados porque são três operações,
três endpoints e três frases diferentes na tela.

---

## 12. Testes de banco e segurança

Executados **antes** da API (§13), porque rodam contra o banco e não contra ela.

### Cross-tenant (11)

1. A lista conversas → só as de A.
2. A busca conversa de B por id → **404 idêntico** ao de UUID inexistente:
   mesmo status, mesmo corpo, sem `Location`. Asserção compara as duas.
3. `assign` em conversa de B → 404, nunca 403.
4. Ler mensagens de conversa de B → 404, corpo sem campo nenhum de B.
5. INSERT de mensagem com `conversation_id` de B → `42501`.
6. Mover conversa para a clínica B → recusado por `with check` + trigger.
7. `patient_id` de B → recusado pela FK composta.
8. `assigned_to` de membro só de B → recusado pela FK composta.
9. Cliente anônimo → nada, nas três tabelas.
10. `X-Clinic-Id` forjado de B com JWT de A → negado, e a asserção verifica que
    **nenhum campo de dado de B aparece no corpo**.
11. `X-Clinic-Id` de clínica inexistente → mesma negação.

### Com `service_role` (5)

Provam o que **RLS sozinho não garante**, porque verificação de FK ignora RLS:

12. Conversa com `patient_id` de outra clínica → `23503`.
13. Conversa com `assigned_to` de membro de outra clínica → `23503`.
14. Mensagem com `conversation_id` de outra clínica → `23503`.
15. Evento com `conversation_id` de outra clínica → `23503`.
16. UPDATE em `conversation_events`: permitido para `service_role` (ignora RLS)
    e **negado para `authenticated`**. O teste afirma a fronteira exata em vez
    de fingir que `service_role` é barrado.

### Identidade da thread (5)

17. Duas conversas manuais **sem telefone** na mesma clínica → ambas criadas.
18. Duas conversas manuais com o **mesmo** telefone → segunda recusada
    (`23505`); a API reaproveita a existente em vez de devolver erro cru.
19. Mesmo telefone em **clínicas diferentes** → ambas criadas.
20. Mesmo telefone em **canais diferentes** → ambas criadas.
21. Conversa só com `provider_contact_id` recebe telefone que já existe em outra
    thread → `23505`, e a API responde explicando que a fusão não é automática.

### Concorrência (4)

22. Dois `assign` em paralelo → **exatamente um 200 e um 409**, repetido N vezes
    para não passar por sorte de escalonamento.
23. `transfer` com responsável desatualizado → 409, sem sobrescrever.
24. `PATCH status` com versão velha → 409 com o estado atual.
25. **Mensagem chegando entre a leitura e a operação NÃO provoca 409** — prova
    do bump seletivo (6.3).

### Ciclo de vida e autoria (5)

26. `resolved` + inbound → volta a `open`, com evento de actor nulo e `reason`.
27. Remover membership de quem tinha conversa atribuída → conversa volta à fila,
    **a remoção não é bloqueada**, e os eventos antigos continuam legíveis com
    `actor_name_snapshot` preservado.
28. `actor_user_id` enviado pelo cliente é **ignorado**: o trigger sobrescreve
    com `auth.uid()`.
29. `appointment_created` com `appointment_id` de outra clínica → recusado pelo
    trigger 6.6 com `23503`.
30. `appointment_created` com chave extra no metadata, ou sem `appointment_id`,
    ou com UUID malformado → recusado pelo check.

### Idempotência (2)

31. Mesma mensagem de provedor entregue duas vezes → uma linha, e a segunda não
    altera `last_message_at`.
32. Duas mensagens **manuais** com corpo idêntico → **ambas gravadas**.

---

## 13. Ordem dos commits

| # | Commit | Gate |
|---|---|---|
| 1 | Tipos e schemas em `packages/shared` + unitários | `pnpm test` |
| 2 | Três migrations **escritas, não aplicadas** + `down.sql` | revisão |
| 3 | `pnpm db:push` com portão de confirmação | `verify:privileges` |
| 4 | **Testes de banco e segurança (§12), antes da API** | `test:isolation` |
| 5 | API: leitura (fila, conversa, mensagens, eventos, counts) | `test:isolation` |
| 6 | API: criar conversa, adicionar mensagem | `test:isolation` |
| 7 | API: assign/transfer/release/status/patient + concorrência | `test:isolation` |
| 8 | Frontend: fila e thread (leitura) | build |
| 9 | Frontend: ações, composer manual, **faixa de modo manual** | build |
| 10 | Sidebar, polimento, capturas | todos |

O passo 4 antes do 5 é deliberado: escrever a API antes significaria descobrir
um furo de RLS depois de já ter código apoiado nele.

---

## 14. Rollback

| Camada | Como reverter | Perde |
|---|---|---|
| Frontend | `git revert`; a Vercel republica | nada |
| API | Redeploy da imagem SHA anterior | nada |
| Banco | `drop table` das três + `drop type` dos cinco enums | só os dados de atendimento |

`down.sql` escrito **junto** com a migration, mesmo o CLI não exigindo: se não
existir no dia da decisão, será escrito às pressas.

**A janela de risco real não é o rollback, é a ordem.** A Vercel publica no
push; a imagem da VPS é atualizada à mão. Há um intervalo em que o frontend novo
conversa com a API velha — mitigado como na agenda: a tela tolera 404 nas rotas
novas e mostra estado vazio.

---

## 15. Riscos

| # | Risco | Prob. | Mitigação |
|---|---|---|---|
| 1 | `SET NULL` composto bloqueando remoção de membership | Alta | `set null (assigned_to)`, PG 17. Teste 27. |
| 2 | Identidade ambígua entre telefone e id do provedor | Média | Predicados mutuamente exclusivos (3.2). Testes 17-21. |
| 3 | Telefone descoberto depois colidindo com thread existente | Média | `23505` + mensagem clara; fusão fora da v0.1. Teste 21. |
| 4 | Mensagem invalidando operação humana e treinando a ignorar 409 | Alta | Bump seletivo (6.3). Teste 25. |
| 5 | Referência falsa a agendamento dentro do `jsonb` | Média | Trigger 6.6. Teste 29. |
| 6 | Fila crescendo sem paginação | Certa | Cursor `(last_message_at, id)` desde o commit 5 |
| 7 | N+1 ao montar a lista | Alta | `lastMessagePreview` resolvido no servidor |
| 8 | Autoria perdida ao remover funcionário | Alta | Snapshot gravado por trigger. Teste 27. |
| 9 | Payload de provider inchando `metadata` | Média | `check` de 2 KB + shape estrito |
| 10 | Janela frontend novo × API velha | Certa | Tolerância a 404 nas rotas novas |
| 11 | **`manual` lido como “WhatsApp funcionando”** | **Alta** | Faixa fixa de modo manual (§16), decisão 19 |

---

## 16. Requisito de UX que sai desta rodada

> **DECISÃO 19.** Enquanto não houver provedor real conectado, a tela mostra em
> texto visível e permanente:
>
> > **Modo manual** — mensagens registradas aqui não são enviadas nem recebidas
> > pelo WhatsApp.

Faixa fixa no topo da thread, **não tooltip, não documentação**. O botão do
composer diz **“Registrar mensagem”**, nunca “Enviar”. O canal aparece no
cabeçalho da conversa.

É a mitigação do risco 11 — o único risco de produto da lista, e o de maior
probabilidade: uma clínica em piloto olha uma caixa de mensagens e conclui que a
integração existe.

---

## Pronto para revisão

Nenhuma decisão em aberto. O próximo passo depende de aprovação: **commit 1**
(tipos em `packages/shared`) e **commit 2** (migrations escritas, não aplicadas),
com `db:push` só depois de uma segunda confirmação sua.
