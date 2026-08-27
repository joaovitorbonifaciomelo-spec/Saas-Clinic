-- =============================================================================
-- 0012 - Schema do Atendimento
--
-- Puramente ADITIVA: nenhuma tabela existente e alterada, nenhuma coluna some,
-- nenhum dado e migrado. O rollback correspondente esta em
-- supabase/rollback/20260828_atendimento_down.sql
--
-- Tres tabelas:
--   conversations       - a thread, com identidade externa, estado e responsavel
--   messages            - cada mensagem, entrando ou saindo
--   conversation_events - log IMUTAVEL de quem fez o que
--
-- Nao existe tabela Contact nesta versao (decisao 1) nem tabela de vinculo com
-- agendamento (decisao 12). A proveniencia de agendamento vive no log.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
do $$
begin
  -- CANAL entra na identidade da thread; PROVEDOR nao (decisao 16). Por isso
  -- canal e enum de dominio e provider e text: trocar Evolution por Meta Cloud
  -- nao pode criar uma thread nova para cada paciente, e acrescentar um
  -- adaptador nao deve exigir migration.
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

  -- Um tipo por OPERACAO que a pessoa executa, nao por valor resultante.
  -- Nao existem 'resolved' nem 'reopened': sao a mesma operacao (transicao de
  -- status pelo mesmo endpoint) e 'status_changed' com {from,to} representa
  -- integralmente. Ja assigned/transferred/released sao tres operacoes
  -- diferentes, com tres endpoints e tres frases diferentes na tela.
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

-- -----------------------------------------------------------------------------
-- conversations
-- -----------------------------------------------------------------------------
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
  -- E.164 exigido: a identidade da thread e internacional. Sem o prefixo do
  -- pais, dois numeros de paises diferentes colidiriam. A normalizacao acontece
  -- na borda; aqui so validamos o resultado.
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

  -- ---------- atividade ----------
  -- Sem unread_count (decisao 4): contador que sobe e desce em dois caminhos
  -- diferentes sempre diverge. Estes tres campos sao fatos, e deles derivam
  -- "precisa de resposta" e a ordenacao da fila.
  last_message_at        timestamptz,
  last_inbound_at        timestamptz,
  last_outbound_at       timestamptz,

  version                integer not null default 1 check (version > 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint conversations_clinic_id_id_key unique (clinic_id, id),

  -- Decisao 16 no banco: manual nao tem infraestrutura de entrega; canal
  -- externo obrigatoriamente tem, e nao pode ser so espaco em branco (o btrim
  -- do check da coluna cuida do vazio).
  constraint conversations_channel_provider_check check (
    (channel =  'manual' and provider is null and provider_contact_id is null)
    or
    (channel <> 'manual' and provider is not null and char_length(btrim(provider)) >= 2)
  ),

  -- FKs tenant-first. Verificacao de FK IGNORA RLS: uma FK simples para
  -- patients(id) aceitaria um paciente de outra clinica sem violar policy
  -- nenhuma. A forma composta torna a referencia cross-tenant impossivel na
  -- estrutura, inclusive para service_role.
  --
  -- `set null (patient_id)` e NAO `set null`: sem a lista de colunas, o
  -- PostgreSQL anula TODAS as colunas da FK, inclusive clinic_id — que e
  -- not null. O delete falharia com violacao de not-null e BLOQUEARIA a
  -- remocao do paciente. A sintaxe com lista existe desde o PG 15; este
  -- projeto roda PG 17.
  constraint conversations_patient_fk
    foreign key (clinic_id, patient_id)
    references public.patients (clinic_id, id)
    on delete set null (patient_id),

  -- Mesmo raciocinio, e e o que torna atribuicao cross-tenant impossivel:
  -- clinic_members ja tem unique (clinic_id, user_id). Removido o membership,
  -- a conversa volta sozinha para a fila — a pessoa saiu, o trabalho nao pode
  -- ficar preso a ela — e a remocao NAO e bloqueada.
  constraint conversations_assignee_fk
    foreign key (clinic_id, assigned_to)
    references public.clinic_members (clinic_id, user_id)
    on delete set null (assigned_to)
);

-- -----------------------------------------------------------------------------
-- Identidade da thread (decisao 17)
--
-- A identidade canonica e o TELEFONE. provider_contact_id pode mudar quando o
-- fornecedor muda; o numero nao. Ele fica como identidade operacional da
-- integracao, fora da chave sempre que houver telefone.
--
-- Os dois indices tem predicados MUTUAMENTE EXCLUSIVOS: nenhuma linha e
-- governada pelas duas regras ao mesmo tempo.
-- -----------------------------------------------------------------------------

-- 1) Telefone normalizado, sempre que existir. Independe de provider — e por
--    isso que trocar de fornecedor preserva a conversa.
create unique index if not exists conversations_phone_identity_key
  on public.conversations (clinic_id, channel, contact_phone_e164)
  where contact_phone_e164 is not null;

-- 2) Sem telefone, o id do provedor serve — mas SEMPRE dentro do namespace do
--    provedor que o emitiu. Um provider_contact_id da Evolution nao pode ser
--    presumido equivalente ao mesmo texto vindo da Meta Cloud: sem telefone nao
--    ha identidade estavel suficiente para fundir contatos de provedores
--    diferentes, e criar outra thread e preferivel a fundir pessoas erradas.
create unique index if not exists conversations_provider_identity_key
  on public.conversations (clinic_id, channel, provider, provider_contact_id)
  where contact_phone_e164 is null and provider_contact_id is not null;

-- 3) Sem identidade nenhuma (manual presencial, sem telefone): NAO existe
--    indice, e isso e deliberado. Nao inventamos identidade artificial; cada
--    conversa e propria, por construcao.

-- -----------------------------------------------------------------------------
-- Indices de consulta
--
-- `id desc` na cauda nao e enfeite: o cursor da fila e (last_message_at, id), e
-- sem o id no indice a paginacao faria um sort extra a cada pagina.
-- -----------------------------------------------------------------------------
create index if not exists conversations_queue_idx
  on public.conversations (clinic_id, status, last_message_at desc nulls last, id desc);

create index if not exists conversations_mine_idx
  on public.conversations (clinic_id, assigned_to, last_message_at desc nulls last, id desc)
  where assigned_to is not null;

create index if not exists conversations_patient_idx
  on public.conversations (clinic_id, patient_id)
  where patient_id is not null;

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
create table if not exists public.messages (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            uuid not null references public.clinics (id) on delete cascade,
  conversation_id      uuid not null,

  -- Canal repetido aqui de proposito: a chave de idempotencia precisa dele, e
  -- ler messages sem tocar em conversations e o caminho quente da thread.
  channel              public.conversation_channel not null,

  direction            public.message_direction not null,
  body                 text not null check (char_length(btrim(body)) between 1 and 4096),

  -- Quando aconteceu NO CANAL, nao quando gravamos. Sao coisas diferentes assim
  -- que houver webhook com atraso ou reprocessamento.
  occurred_at          timestamptz not null default now(),

  -- Decisao 7: autoria sobrevive a saida do funcionario. O id vira null quando
  -- a conta e removida, mas o nome permanece pelo snapshot, e nada e reatribuido.
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

  -- Mensagem que chega nao tem autor interno.
  constraint messages_inbound_has_no_author
    check (direction = 'outbound' or author_user_id is null),

  -- Status de entrega so faz sentido saindo.
  constraint messages_delivery_only_outbound
    check (delivery_status is null or direction = 'outbound'),

  -- Mesma regra de canal x provedor das conversas.
  constraint messages_channel_provider_check check (
    (channel =  'manual' and provider is null and provider_message_id is null)
    or
    (channel <> 'manual' and provider is not null and char_length(btrim(provider)) >= 2)
  )
);

create index if not exists messages_thread_idx
  on public.messages (clinic_id, conversation_id, occurred_at, id);

-- -----------------------------------------------------------------------------
-- Idempotencia (decisao 8)
--
-- Indice PARCIAL, e nao constraint sobre colunas nullable, por dois motivos:
--
--   * Mensagem manual precisa poder repetir. Duas anotacoes identicas da mesma
--     ligacao sao dois fatos, nao duplicata.
--   * Sem fallback artificial: coalesce(provider_message_id, id::text) tornaria
--     o indice inutil (nunca colidiria) e daria falsa sensacao de protecao.
--
-- `channel` entra na chave porque o mesmo id de provedor em canais diferentes
-- nao e a mesma mensagem.
-- -----------------------------------------------------------------------------
create unique index if not exists messages_provider_dedup_key
  on public.messages (clinic_id, channel, provider, provider_message_id)
  where provider_message_id is not null;

-- -----------------------------------------------------------------------------
-- conversation_events
--
-- IMUTAVEL: sem updated_at, sem policy de UPDATE, sem policy de DELETE e sem
-- grant de nenhum dos dois. E o que responde "quem encerrou isso e quando".
-- -----------------------------------------------------------------------------
create table if not exists public.conversation_events (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            uuid not null references public.clinics (id) on delete cascade,
  conversation_id      uuid not null,

  event_type           public.conversation_event_type not null,

  -- Decisao 7: membership serve para autorizacao e atribuicao; NAO e requisito
  -- para manter historico. Removido o usuario, o evento continua legivel.
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

  -- Teto geral: payload bruto de webhook nao cabe em 2 KB. Tira a regra
  -- "metadata pequeno e controlado" do campo da disciplina e coloca no campo do
  -- banco.
  -- octet_length(metadata::text) e nao pg_column_size(): expressao de CHECK
  -- precisa ser imutavel, e o cast jsonb->text mais octet_length sao imutaveis
  -- com certeza, enquanto pg_column_size depende de detalhe de armazenamento.
  constraint conversation_events_metadata_size check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 2048
  ),

  -- Decisao 18: metadata de appointment_created e ESTRITO — somente
  -- appointment_id, e em formato de UUID.
  --
  -- `metadata - 'appointment_id' = '{}'` prova que nao ha nenhuma outra chave.
  -- Check constraint nao aceita subconsulta, entao nao da para contar chaves
  -- com jsonb_object_keys; a subtracao resolve sem subconsulta.
  constraint conversation_events_appointment_metadata check (
    event_type <> 'appointment_created'
    or (
      metadata ? 'appointment_id'
      and metadata - 'appointment_id' = '{}'::jsonb
      and metadata->>'appointment_id' ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    )
  )
);

create index if not exists conversation_events_history_idx
  on public.conversation_events (clinic_id, conversation_id, created_at, id);

-- =============================================================================
-- Triggers de convencao (ja existentes no projeto)
-- =============================================================================
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create trigger conversations_prevent_clinic_id_change
  before update on public.conversations
  for each row execute function public.prevent_clinic_id_change();

create trigger messages_prevent_clinic_id_change
  before update on public.messages
  for each row execute function public.prevent_clinic_id_change();

create trigger conversation_events_prevent_clinic_id_change
  before update on public.conversation_events
  for each row execute function public.prevent_clinic_id_change();

-- =============================================================================
-- Transicoes de status
--
--   open            -> waiting_patient, resolved
--   waiting_patient -> open, resolved
--   resolved        -> open
--
-- NENHUM estado e terminal — diferenca deliberada em relacao a appointments,
-- onde completed/no_show/cancelled sao finais. Um agendamento realizado nao
-- volta atras; uma conversa sempre pode receber outra mensagem, e travar
-- 'resolved' perderia mensagem, o pior defeito numa caixa de entrada.
--
-- 'resolved -> waiting_patient' fica de fora: reabrir devolve a fila da clinica,
-- e so de la a conversa volta a esperar o paciente. Um passo, nao dois.
--
-- No banco e nao so na API: assim a regra vale para qualquer caminho de escrita.
-- Espelhado em packages/shared/src/conversation.ts.
-- =============================================================================
create or replace function public.enforce_conversation_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed public.conversation_status[];
begin
  -- Status inalterado nao e transicao. Um `set status = status` vindo de patch
  -- generico nao pode ser recusado como transicao invalida.
  if new.status is not distinct from old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'open'            then array['waiting_patient', 'resolved']
    when 'waiting_patient' then array['open', 'resolved']
    when 'resolved'        then array['open']
    else array[]::text[]
  end::public.conversation_status[];

  if not (new.status = any (v_allowed)) then
    raise exception 'INVALID_STATUS_TRANSITION: % -> % nao e permitido.', old.status, new.status
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger conversations_enforce_status_transition
  before update of status on public.conversations
  for each row execute function public.enforce_conversation_status_transition();

-- =============================================================================
-- Concorrencia otimista: bump SELETIVO
--
-- So colunas de CONTROLE contam.
--
-- A atendente clicou "assumir" com a versao 4 na mao. Se uma mensagem chegasse
-- nesse intervalo e bumpasse a versao, o clique falharia com 409 sem que nada
-- relevante tivesse mudado — e a equipe aprenderia que o aviso de conflito
-- aparece a toa, passando a ignorar justamente o aviso que precisa ser levado a
-- serio.
--
-- IS DISTINCT FROM (e nao <>) para que no-op com NULL tambem nao bumpe.
--
-- A excecao prova a regra: quando uma mensagem inbound reabre uma conversa
-- resolvida, o status muda de verdade e o bump e o comportamento certo.
-- =============================================================================
create or replace function public.bump_conversation_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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

-- Depois do enforce (ordem alfabetica do nome define a ordem de execucao entre
-- triggers BEFORE do mesmo evento; 'z_' garante que a versao so sobe depois de
-- a transicao ter sido aceita).
create trigger z_conversations_bump_version
  before update on public.conversations
  for each row execute function public.bump_conversation_version();

-- =============================================================================
-- Atividade e reabertura automatica
--
-- No banco e nao na aplicacao: quando o webhook existir ele sera outro caminho
-- de escrita, e a reabertura nao pode depender de qual codigo chamou. Uma
-- resposta chegando num domingo nao pode ficar invisivel ate alguem abrir a
-- conversa encerrada.
-- =============================================================================
create or replace function public.on_message_inserted()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status_anterior public.conversation_status;
begin
  select c.status into v_status_anterior
    from public.conversations c
   where c.clinic_id = new.clinic_id and c.id = new.conversation_id
     for update;

  -- greatest() ignora NULL no PostgreSQL, entao a primeira mensagem preenche
  -- sozinha. E greatest e nao atribuicao direta porque webhook atrasado ou
  -- reprocessamento nao podem fazer a atividade da conversa ANDAR PARA TRAS.
  update public.conversations
     set last_message_at  = greatest(last_message_at, new.occurred_at),
         last_inbound_at  = case when new.direction = 'inbound'
                                 then greatest(last_inbound_at, new.occurred_at)
                                 else last_inbound_at end,
         last_outbound_at = case when new.direction = 'outbound'
                                 then greatest(last_outbound_at, new.occurred_at)
                                 else last_outbound_at end,
         status           = case when new.direction = 'inbound' and status = 'resolved'
                                 then 'open'::public.conversation_status
                                 else status end
   where clinic_id = new.clinic_id and id = new.conversation_id;

  -- Evento do sistema: actor nulo, motivo declarado. Os campos de autoria ficam
  -- nulos porque nao ha pessoa por tras — e isso e informacao, nao ausencia.
  if new.direction = 'inbound' and v_status_anterior = 'resolved' then
    insert into public.conversation_events
      (clinic_id, conversation_id, event_type, metadata)
    values
      (new.clinic_id, new.conversation_id, 'status_changed',
       jsonb_build_object('from', 'resolved', 'to', 'open', 'reason', 'inbound_message'));
  end if;

  return null;
end;
$$;

create trigger messages_after_insert
  after insert on public.messages
  for each row execute function public.on_message_inserted();

-- =============================================================================
-- Canal da mensagem: carimbado a partir da conversa, nunca aceito do cliente
--
-- messages.channel entra na chave de idempotencia
-- (clinic_id, channel, provider, provider_message_id). Se o cliente pudesse
-- informar um canal diferente do da conversa, duas entregas da MESMA mensagem
-- com canais divergentes escapariam da deduplicacao — e a chave deixaria de
-- significar o que promete.
--
-- Um CHECK nao resolve: constraint nao enxerga outra tabela. Carimbar e melhor
-- que validar: em vez de recusar o pedido errado, o pedido errado deixa de ser
-- possivel.
-- =============================================================================
create or replace function public.stamp_message_channel()
returns trigger
language plpgsql
set search_path = ''
as $
declare
  v_channel public.conversation_channel;
begin
  select c.channel into v_channel
    from public.conversations c
   where c.clinic_id = new.clinic_id and c.id = new.conversation_id;

  -- Ausente aqui significa conversa de outra clinica ou inexistente; a FK
  -- composta ja recusaria, mas falhar cedo da mensagem melhor que erro de FK.
  if v_channel is null then
    raise exception 'CONVERSATION_NOT_IN_CLINIC: conversa inexistente nesta clinica.'
      using errcode = '23503';
  end if;

  new.channel := v_channel;
  return new;
end;
$;

create trigger messages_stamp_channel
  before insert on public.messages
  for each row execute function public.stamp_message_channel();

-- =============================================================================
-- Autoria dos eventos: carimbada, nunca informada
--
-- O cliente NAO escolhe quem e o autor. Um log de auditoria com autor forjavel
-- nao vale nada.
--
-- SECURITY DEFINER porque precisa ler profiles e clinic_members do usuario
-- atual independentemente das policies de leitura daquelas tabelas; devolve
-- apenas nome e papel de quem esta autenticado, nunca de terceiros.
-- =============================================================================
create or replace function public.current_actor_snapshot(p_clinic_id uuid)
returns table (full_name text, role public.clinic_role)
language sql
security definer
stable
set search_path = ''
as $$
  select p.full_name, m.role
    from public.profiles p
    left join public.clinic_members m
      on m.user_id = p.id and m.clinic_id = p_clinic_id
   where p.id = auth.uid();
$$;

revoke execute on function public.current_actor_snapshot(uuid) from public, anon;
grant execute on function public.current_actor_snapshot(uuid) to authenticated;

create or replace function public.stamp_conversation_event_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_name text;
  v_role public.clinic_role;
begin
  if auth.uid() is null then
    -- Evento do sistema (reabertura automatica). Os tres campos ficam nulos.
    new.actor_user_id       := null;
    new.actor_name_snapshot := null;
    new.actor_role_snapshot := null;
    return new;
  end if;

  select s.full_name, s.role into v_name, v_role
    from public.current_actor_snapshot(new.clinic_id) s;

  new.actor_user_id       := auth.uid();
  new.actor_name_snapshot := v_name;
  new.actor_role_snapshot := v_role;
  return new;
end;
$$;

create trigger conversation_events_stamp_actor
  before insert on public.conversation_events
  for each row execute function public.stamp_conversation_event_actor();

-- =============================================================================
-- appointment_created: a protecao que jsonb nao tem
--
-- appointment_id mora dentro de um jsonb, e JSONB NAO RECEBE FK. Toda a
-- protecao tenant-first que as FKs compostas dao as colunas simplesmente nao
-- alcanca ali dentro.
--
-- A correcao NAO depende de RLS: a comparacao explicita de clinic_id e o que
-- garante. SECURITY DEFINER de proposito, para que a checagem valha tambem sob
-- service_role — que ignora RLS e, sem isso, poderia plantar no log a
-- referencia a um agendamento de outra clinica. RLS continua como defesa
-- adicional no caminho do usuario autenticado.
--
-- A funcao devolve apenas sim/nao; nao expoe nenhum dado do agendamento.
-- =============================================================================
create or replace function public.validate_conversation_event_appointment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event_type = 'appointment_created' then
    if not exists (
      select 1
        from public.appointments a
       where a.clinic_id = new.clinic_id
         and a.id = (new.metadata->>'appointment_id')::uuid
    ) then
      raise exception
        'APPOINTMENT_NOT_IN_CLINIC: agendamento inexistente nesta clinica.'
        using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

create trigger conversation_events_validate_appointment
  before insert on public.conversation_events
  for each row execute function public.validate_conversation_event_appointment();
