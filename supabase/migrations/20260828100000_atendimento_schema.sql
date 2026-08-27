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
  -- AUTOR: quem DISSE. Nulo em inbound, porque quem disse foi o paciente.
  author_user_id       uuid references auth.users (id) on delete set null,
  author_name_snapshot text
                         check (author_name_snapshot is null
                                or char_length(btrim(author_name_snapshot)) between 1 and 120),

  -- QUEM REGISTROU: quem da equipe digitou este fato no sistema.
  --
  -- Sao coisas diferentes, e sem a segunda o registro manual perde rastro: numa
  -- mensagem inbound o autor e o paciente, entao sem recorded_by nao ha como
  -- saber quem da clinica afirmou que aquilo foi dito. Fica nulo quando nao ha
  -- pessoa por tras — o webhook do futuro registra sozinho.
  recorded_by_user_id       uuid references auth.users (id) on delete set null,
  recorded_by_name_snapshot text
                              check (recorded_by_name_snapshot is null
                                     or char_length(btrim(recorded_by_name_snapshot))
                                        between 1 and 120),

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

  -- Modo manual nao entrega nada: nao ha provedor para dizer 'sent' ou 'read'.
  -- Sem esta trava, uma mensagem registrada a mao poderia exibir confirmacao de
  -- leitura que ninguem nunca produziu — a mentira mais facil de acreditar,
  -- porque a tela ficaria igualzinha a de uma entrega real.
  constraint messages_manual_has_no_delivery
    check (channel <> 'manual' or delivery_status is null),

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
--
-- SECURITY DEFINER porque `authenticated` deixou de ter UPDATE em conversations
-- (ver migration de grants): a atividade e efeito da mensagem, nao uma escrita
-- que o cliente escolhe fazer. A linha so chega aqui depois de o RLS de
-- messages ter autorizado a insercao, e o filtro por clinic_id continua
-- explicito.
-- =============================================================================
create or replace function public.on_message_inserted()
returns trigger
language plpgsql
security definer
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
    -- Marca local a transacao: a reabertura nao tem autor humano, mesmo quando
    -- quem inseriu a mensagem estava autenticado. Desligada logo em seguida
    -- para nao contaminar outros eventos da mesma transacao.
    perform set_config('app.system_actor', 'on', true);

    insert into public.conversation_events
      (clinic_id, conversation_id, event_type, metadata)
    values
      (new.clinic_id, new.conversation_id, 'status_changed',
       jsonb_build_object('from', 'resolved', 'to', 'open', 'reason', 'inbound_message'));

    perform set_config('app.system_actor', 'off', true);
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
create or replace function public.stamp_message_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_channel public.conversation_channel;
  v_name    text;
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

  /*
   * AUTORIA CARIMBADA, NUNCA ACEITA DO CLIENTE.
   *
   * O que o cliente mandou em author_user_id / author_name_snapshot e
   * descartado. Autoria historica forjavel nao e autoria: bastaria um membro
   * enviar o id de um colega para que uma mensagem constasse como dita por
   * outra pessoa — e o snapshot existe justamente para sobreviver a saida do
   * funcionario, ou seja, para ser lido como verdade muito depois.
   *
   * Mensagem que CHEGA nunca tem autor interno.
   * Saida sem usuario autenticado (futuro envio automatico) fica sem autor, em
   * vez de inventar um usuario falso.
   */
  if auth.uid() is not null then
    select sn.full_name into v_name
      from public.current_actor_snapshot(new.clinic_id) sn;
  end if;

  -- AUTOR: so existe quando a clinica falou E havia alguem autenticado.
  if new.direction = 'inbound' or auth.uid() is null then
    new.author_user_id       := null;
    new.author_name_snapshot := null;
  else
    new.author_user_id       := auth.uid();
    new.author_name_snapshot := v_name;
  end if;

  -- QUEM REGISTROU: vale para as duas direcoes. Nulo quando nao ha pessoa —
  -- e o caso do webhook, que nao deve inventar um usuario falso.
  new.recorded_by_user_id       := auth.uid();
  new.recorded_by_name_snapshot := case when auth.uid() is null then null else v_name end;

  return new;
end;
$$;

create trigger messages_stamp_defaults
  before insert on public.messages
  for each row execute function public.stamp_message_defaults();

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
  /*
   * Evento do SISTEMA: sem usuario autenticado, ou marcado explicitamente.
   *
   * A marca existe por causa da reabertura automatica. Quando a atendente
   * registra uma mensagem que chegou, ela decidiu registrar a mensagem — nao
   * decidiu reabrir a conversa. Atribuir a ela o `status_changed` diria que ela
   * fez algo que nao fez.
   *
   * E, quando o webhook existir, o MESMO evento nascera sem usuario nenhum. Se
   * o caminho manual atribuisse a uma pessoa e o automatico nao, "quem mudou
   * este status?" teria duas respostas para o mesmo tipo de evento.
   *
   * Quem registrou a mensagem continua rastreavel: ela tem autor proprio.
   */
  if auth.uid() is null
     or coalesce(current_setting('app.system_actor', true), '') = 'on' then
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

-- =============================================================================
-- IDENTIDADE IMUTAVEL
--
-- `channel` participa da identidade da thread; trocar o canal de uma conversa
-- existente seria dizer que ela sempre foi outra coisa, e os indices de
-- identidade passariam a governar linhas que nunca foram verificadas sob a
-- regra nova.
--
-- Para o fallback SEM telefone, `provider` + `provider_contact_id` SAO a
-- identidade — trocar um deles em silencio significaria afirmar que dois
-- contatos de provedores diferentes sao a mesma pessoa, que e exatamente o que
-- a decisao 17 recusou. Com telefone presente, `provider` volta a ser metadado
-- operacional e pode mudar numa troca Evolution -> Meta.
--
-- Preencher `provider_contact_id` que era nulo E permitido: enriquecer o que
-- nao se sabia nao e trocar de identidade.
-- =============================================================================
create or replace function public.enforce_conversation_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.channel is distinct from old.channel then
    raise exception 'IDENTITY_IMMUTABLE: canal da conversa nao pode mudar.'
      using errcode = '22023';
  end if;

  -- valor -> outro valor, ou valor -> nulo: nao. nulo -> valor: sim.
  if old.provider_contact_id is not null
     and new.provider_contact_id is distinct from old.provider_contact_id then
    raise exception 'IDENTITY_IMMUTABLE: provider_contact_id ja definido nao pode mudar.'
      using errcode = '22023';
  end if;

  -- Sem telefone, o provedor faz parte da chave de identidade.
  if old.contact_phone_e164 is null
     and old.provider_contact_id is not null
     and new.provider is distinct from old.provider then
    raise exception
      'IDENTITY_IMMUTABLE: sem telefone, o provedor faz parte da identidade e nao pode mudar.'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger conversations_enforce_identity
  before update on public.conversations
  for each row execute function public.enforce_conversation_identity();

-- =============================================================================
-- Evento de criacao, automatico
--
-- SECURITY DEFINER porque `authenticated` nao tem INSERT em
-- conversation_events (ver grants): o log e escrito por caminhos controlados,
-- nunca pelo cliente.
-- =============================================================================
create or replace function public.on_conversation_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  /*
   * Paciente ja vinculado na criacao entra no metadata da CRIACAO.
   *
   * E deliberado NAO emitir um patient_linked separado: nao houve operacao de
   * vinculo, houve uma conversa que ja nasceu sabendo de quem era. Fabricar o
   * evento diria que alguem executou uma acao que ninguem executou, e o log
   * passaria a descrever um passado que nao aconteceu.
   *
   * Vinculo POSTERIOR continua gerando patient_linked pela funcao propria.
   */
  insert into public.conversation_events
    (clinic_id, conversation_id, event_type, metadata)
  values
    (new.clinic_id, new.id, 'conversation_created',
     case when new.patient_id is null
          then jsonb_build_object('channel', new.channel)
          else jsonb_build_object('channel', new.channel, 'patient_id', new.patient_id)
     end);
  return null;
end;
$$;

create trigger conversations_after_insert
  after insert on public.conversations
  for each row execute function public.on_conversation_created();

-- =============================================================================
-- OPERACOES DE CONTROLE
--
-- Por que funcoes e nao UPDATE direto:
--
-- Com `grant update on conversations to authenticated`, o filtro por versao
-- seria protocolo da aplicacao — nada obrigaria um cliente a usa-lo, e a
-- concorrencia otimista viraria convencao voluntaria. Aqui ela vira a UNICA
-- porta: `authenticated` perdeu UPDATE, e a versao esperada e parametro
-- obrigatorio.
--
-- A troca que isso implica, dita com todas as letras: no caminho de ESCRITA de
-- controle, a barreira deixa de ser o RLS e passa a ser a checagem explicita de
-- `is_clinic_member` dentro de cada funcao. Leitura continua sob RLS, os grants
-- continuam minimos, e as FKs compostas continuam tornando referencia
-- cross-tenant impossivel. E o mesmo padrao que `create_clinic_with_owner` ja
-- usa desde a fundacao.
--
-- Contrato de retorno (jsonb), igual para as seis:
--   { "outcome": "ok",        "conversation": {...} }
--   { "outcome": "conflict",  "conversation": {...} }  <- estado ATUAL relido
--   { "outcome": "not_found" }                         <- inexistente OU outro tenant
--
-- `not_found` cobre os dois casos com a MESMA resposta, de proposito: distinguir
-- revelaria a existencia de conversa alheia. O mapeamento para HTTP e da API.
-- =============================================================================

/** Serializacao unica, para que as seis funcoes devolvam exatamente a mesma forma. */
create or replace function public.conversation_row_json(c public.conversations)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'clinicId', c.clinic_id,
    'channel', c.channel,
    'provider', c.provider,
    'providerContactId', c.provider_contact_id,
    'contactPhoneE164', c.contact_phone_e164,
    'contactNameSnapshot', c.contact_name_snapshot,
    'patientId', c.patient_id,
    'status', c.status,
    'assignedTo', c.assigned_to,
    'lastMessageAt', c.last_message_at,
    'lastInboundAt', c.last_inbound_at,
    'lastOutboundAt', c.last_outbound_at,
    'version', c.version,
    'createdAt', c.created_at,
    'updatedAt', c.updated_at
  );
$$;

/**
 * Resposta de conflito com o estado ATUAL.
 *
 * Rele a linha em vez de devolver a que foi lida no inicio: entre a leitura e o
 * UPDATE outra transacao pode ter commitado, e devolver a versao velha faria a
 * tela mostrar como "atual" justamente o estado que ja nao vale.
 */
create or replace function public.conversation_conflict(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.conversations%rowtype;
begin
  select * into v from public.conversations where id = p_conversation_id;

  /*
   * Revalida o vinculo, e nao so a existencia.
   *
   * Quem chama ja verificou antes do UPDATE, mas entre aquela verificacao e
   * esta releitura o membership pode ter sido revogado por outra transacao. A
   * janela e estreita e provavelmente nunca aconteceria — e e exatamente por
   * isso que ninguem notaria se acontecesse, devolvendo o estado de uma
   * conversa a quem acabou de perder o acesso a ela.
   */
  if not found or not public.is_clinic_member(v.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return jsonb_build_object('outcome', 'conflict',
                            'conversation', public.conversation_row_json(v));
end;
$$;

-- ---------------------------------------------------------------- assumir
create or replace function public.conversation_assign(
  p_conversation_id  uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.conversations%rowtype;
  v_new public.conversations%rowtype;
begin
  select * into v_old from public.conversations where id = p_conversation_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- `assigned_to is null` alem da versao: duas pessoas nunca recebem sucesso no
  -- mesmo assign, mesmo que a versao coincida por outro caminho.
  update public.conversations
     set assigned_to = auth.uid()
   where id = p_conversation_id
     and version = p_expected_version
     and assigned_to is null
  returning * into v_new;

  if not found then
    return public.conversation_conflict(p_conversation_id);
  end if;

  insert into public.conversation_events
    (clinic_id, conversation_id, event_type, metadata)
  values
    (v_new.clinic_id, v_new.id, 'assigned',
     jsonb_build_object('to_user_id', auth.uid()));

  return jsonb_build_object('outcome', 'ok',
                            'conversation', public.conversation_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- transferir
create or replace function public.conversation_transfer(
  p_conversation_id  uuid,
  p_expected_version integer,
  p_to_user_id       uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.conversations%rowtype;
  v_new public.conversations%rowtype;
begin
  select * into v_old from public.conversations where id = p_conversation_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Transferir exige que ja houvesse dono: "de X para Y" nunca pode virar
  -- "de qualquer um para Y". Sem dono, a operacao correta e assumir.
  update public.conversations
     set assigned_to = p_to_user_id
   where id = p_conversation_id
     and version = p_expected_version
     and assigned_to is not null
  returning * into v_new;

  if not found then
    return public.conversation_conflict(p_conversation_id);
  end if;

  -- p_to_user_id ser membro NAO e checado aqui: a FK composta
  -- (clinic_id, assigned_to) -> clinic_members ja torna isso impossivel, e
  -- duplicar a regra criaria dois lugares para ela divergir.
  insert into public.conversation_events
    (clinic_id, conversation_id, event_type, metadata)
  values
    (v_new.clinic_id, v_new.id, 'transferred',
     jsonb_build_object('from_user_id', v_old.assigned_to, 'to_user_id', p_to_user_id));

  return jsonb_build_object('outcome', 'ok',
                            'conversation', public.conversation_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- devolver
create or replace function public.conversation_release(
  p_conversation_id  uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.conversations%rowtype;
  v_new public.conversations%rowtype;
begin
  select * into v_old from public.conversations where id = p_conversation_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  update public.conversations
     set assigned_to = null
   where id = p_conversation_id
     and version = p_expected_version
     and assigned_to is not null
  returning * into v_new;

  if not found then
    return public.conversation_conflict(p_conversation_id);
  end if;

  insert into public.conversation_events
    (clinic_id, conversation_id, event_type, metadata)
  values
    (v_new.clinic_id, v_new.id, 'released',
     jsonb_build_object('from_user_id', v_old.assigned_to));

  return jsonb_build_object('outcome', 'ok',
                            'conversation', public.conversation_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- status
create or replace function public.conversation_set_status(
  p_conversation_id  uuid,
  p_expected_version integer,
  p_status           public.conversation_status
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.conversations%rowtype;
  v_new public.conversations%rowtype;
begin
  select * into v_old from public.conversations where id = p_conversation_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Transicao invalida sobe como excecao do trigger (22023) e aborta a
  -- transacao inteira, evento incluso. E o comportamento certo: nao pode existir
  -- evento de uma mudanca que nao aconteceu.
  update public.conversations
     set status = p_status
   where id = p_conversation_id
     and version = p_expected_version
  returning * into v_new;

  if not found then
    return public.conversation_conflict(p_conversation_id);
  end if;

  -- Status igual ao anterior nao gera evento: o log registra o que mudou.
  if v_new.status is distinct from v_old.status then
    insert into public.conversation_events
      (clinic_id, conversation_id, event_type, metadata)
    values
      (v_new.clinic_id, v_new.id, 'status_changed',
       jsonb_build_object('from', v_old.status, 'to', v_new.status));
  end if;

  return jsonb_build_object('outcome', 'ok',
                            'conversation', public.conversation_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- paciente
create or replace function public.conversation_link_patient(
  p_conversation_id  uuid,
  p_expected_version integer,
  p_patient_id       uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.conversations%rowtype;
  v_new public.conversations%rowtype;
begin
  select * into v_old from public.conversations where id = p_conversation_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Paciente de outra clinica e recusado pela FK composta (23503), nao por
  -- checagem aqui.
  update public.conversations
     set patient_id = p_patient_id
   where id = p_conversation_id
     and version = p_expected_version
  returning * into v_new;

  if not found then
    return public.conversation_conflict(p_conversation_id);
  end if;

  insert into public.conversation_events
    (clinic_id, conversation_id, event_type, metadata)
  values
    (v_new.clinic_id, v_new.id, 'patient_linked',
     jsonb_build_object('patient_id', p_patient_id));

  return jsonb_build_object('outcome', 'ok',
                            'conversation', public.conversation_row_json(v_new));
end;
$$;

create or replace function public.conversation_unlink_patient(
  p_conversation_id  uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.conversations%rowtype;
  v_new public.conversations%rowtype;
begin
  select * into v_old from public.conversations where id = p_conversation_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  update public.conversations
     set patient_id = null
   where id = p_conversation_id
     and version = p_expected_version
     and patient_id is not null
  returning * into v_new;

  if not found then
    return public.conversation_conflict(p_conversation_id);
  end if;

  insert into public.conversation_events
    (clinic_id, conversation_id, event_type, metadata)
  values
    (v_new.clinic_id, v_new.id, 'patient_unlinked',
     jsonb_build_object('patient_id', v_old.patient_id));

  return jsonb_build_object('outcome', 'ok',
                            'conversation', public.conversation_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- agendamento
--
-- Nao leva versao: registrar proveniencia nao muda o estado da conversa. O
-- trigger `conversation_events_validate_appointment` continua exigindo que o
-- agendamento seja da MESMA clinica, com comparacao explicita de clinic_id.
create or replace function public.conversation_log_appointment(
  p_conversation_id uuid,
  p_appointment_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.conversations%rowtype;
begin
  select * into v from public.conversations where id = p_conversation_id;
  if not found or not public.is_clinic_member(v.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  insert into public.conversation_events
    (clinic_id, conversation_id, event_type, metadata)
  values
    (v.clinic_id, v.id, 'appointment_created',
     jsonb_build_object('appointment_id', p_appointment_id));

  return jsonb_build_object('outcome', 'ok',
                            'conversation', public.conversation_row_json(v));
end;
$$;

-- -----------------------------------------------------------------------------
-- Privilegios das funcoes de controle.
--
-- Declarados aqui e nao herdados do default do PostgreSQL, que concede EXECUTE
-- a PUBLIC — o mesmo cuidado que a 0004 tomou com create_clinic_with_owner.
-- -----------------------------------------------------------------------------
revoke execute on function public.conversation_row_json(public.conversations) from public, anon;
revoke execute on function public.conversation_conflict(uuid)                 from public, anon;
revoke execute on function public.conversation_assign(uuid, integer)          from public, anon;
revoke execute on function public.conversation_transfer(uuid, integer, uuid)  from public, anon;
revoke execute on function public.conversation_release(uuid, integer)         from public, anon;
revoke execute on function public.conversation_set_status(uuid, integer, public.conversation_status)
  from public, anon;
revoke execute on function public.conversation_link_patient(uuid, integer, uuid) from public, anon;
revoke execute on function public.conversation_unlink_patient(uuid, integer)     from public, anon;
revoke execute on function public.conversation_log_appointment(uuid, uuid)       from public, anon;

grant execute on function public.conversation_assign(uuid, integer)         to authenticated;
grant execute on function public.conversation_transfer(uuid, integer, uuid) to authenticated;
grant execute on function public.conversation_release(uuid, integer)        to authenticated;
grant execute on function public.conversation_set_status(uuid, integer, public.conversation_status)
  to authenticated;
grant execute on function public.conversation_link_patient(uuid, integer, uuid) to authenticated;
grant execute on function public.conversation_unlink_patient(uuid, integer)     to authenticated;
-- conversation_log_appointment NAO e exposta na v0.1.
--
-- Ela prova TENANT (o agendamento e desta clinica), mas nao prova PROVENIENCIA
-- (que ele nasceu desta conversa). Exposta, qualquer membro poderia afirmar
-- depois que um agendamento qualquer veio de uma conversa qualquer — e um log
-- auditavel construido sobre afirmacao do cliente nao audita nada.
--
-- Fica pronta, com o event_type e a validacao tenant-first no lugar. Quando a
-- API implementar "novo agendamento a partir desta conversa", a proveniencia
-- sera registrada JUNTO da criacao real do agendamento, num caminho unico.
revoke execute on function public.conversation_log_appointment(uuid, uuid) from authenticated;

-- conversation_conflict e conversation_row_json sao auxiliares internas: nao
-- ha motivo para o cliente chama-las diretamente.

-- =============================================================================
-- CRIACAO CONTROLADA
--
-- Por que INSERT direto saiu de `conversations` e de `messages`:
--
-- Com INSERT concedido, o cliente escolhia campos que sao invariantes do
-- dominio, nao dados de entrada — status, assigned_to, version, os timestamps
-- de atividade. Nenhum deles vaza tenant, mas todos pulam as regras: uma
-- conversa podia nascer `resolved`, ja atribuida a alguem, com version 7 e com
-- last_inbound_at no futuro. O log registraria uma criacao que nao corresponde
-- ao que o sistema considera uma criacao.
--
-- Aqui o cliente informa so o que e informacao: com quem a clinica falou, e a
-- que paciente isso pertence. O resto o banco decide.
-- =============================================================================

create or replace function public.conversation_create_manual(
  p_clinic_id             uuid,
  p_contact_phone_e164    text default null,
  p_contact_name_snapshot text default null,
  p_patient_id            uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new      public.conversations%rowtype;
  v_existente public.conversations%rowtype;
begin
  -- SECURITY DEFINER nao passa por RLS: o vinculo e conferido aqui, explicito.
  if not public.is_clinic_member(p_clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  begin
    insert into public.conversations (
      clinic_id,
      channel,                -- sempre manual: esta funcao nao cria outra coisa
      provider,               -- manual nao tem infraestrutura de entrega
      provider_contact_id,
      contact_phone_e164,
      contact_name_snapshot,
      patient_id,
      status,                 -- toda conversa nasce na fila
      assigned_to             -- e sem dono
      -- version, created_at e updated_at ficam com o DEFAULT da tabela:
      -- 1 e now(). Nao sao parametro porque nao sao informacao de ninguem.
    ) values (
      p_clinic_id,
      'manual',
      null,
      null,
      nullif(btrim(coalesce(p_contact_phone_e164, '')), ''),
      nullif(btrim(coalesce(p_contact_name_snapshot, '')), ''),
      p_patient_id,
      'open',
      null
    )
    returning * into v_new;
  exception
    when unique_violation then
      /*
       * Ja existe thread para este telefone neste canal.
       *
       * Devolver o erro cru obrigaria todo chamador a saber o que 23505
       * significa aqui e a ir buscar a conversa existente. Como a identidade e
       * justamente "uma thread por telefone", achar a existente E a resposta
       * certa — a recepcao quer abrir a conversa daquela pessoa, nao criar
       * outra.
       */
      select * into v_existente
        from public.conversations
       where clinic_id = p_clinic_id
         and channel = 'manual'
         and contact_phone_e164 = nullif(btrim(coalesce(p_contact_phone_e164, '')), '');

      if not found then
        raise; -- colisao por outro motivo: nao mascarar
      end if;

      return jsonb_build_object('outcome', 'exists',
                                'conversation', public.conversation_row_json(v_existente));
  end;

  return jsonb_build_object('outcome', 'ok',
                            'conversation', public.conversation_row_json(v_new));
end;
$$;

-- =============================================================================
-- Mensagem manual
--
-- `clinic_id` NAO e parametro: e derivado da conversa. Aceita-lo abriria a
-- possibilidade de gravar a mensagem numa clinica e apontar para a conversa de
-- outra — a FK composta recusaria, mas o certo e o dado nao existir para ser
-- recusado.
-- =============================================================================

create or replace function public.message_row_json(m public.messages)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id,
    'clinicId', m.clinic_id,
    'conversationId', m.conversation_id,
    'channel', m.channel,
    'direction', m.direction,
    'body', m.body,
    'occurredAt', m.occurred_at,
    'authorUserId', m.author_user_id,
    'authorName', m.author_name_snapshot,
    'recordedByUserId', m.recorded_by_user_id,
    'recordedByName', m.recorded_by_name_snapshot,
    'deliveryStatus', m.delivery_status,
    'createdAt', m.created_at
  );
$$;

create or replace function public.conversation_add_manual_message(
  p_conversation_id uuid,
  p_direction       public.message_direction,
  p_body            text,
  p_occurred_at     timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_msg  public.messages%rowtype;
  v_body text;
begin
  select * into v_conv from public.conversations where id = p_conversation_id;
  if not found or not public.is_clinic_member(v_conv.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  /*
   * Registro manual so entra em conversa manual.
   *
   * Numa thread de WhatsApp, gravar uma mensagem "a mao" produziria uma linha
   * indistinguivel das que o provedor entregou — e ninguem depois saberia dizer
   * se aquilo foi realmente dito no canal ou se alguem digitou. Quando houver
   * provedor, mensagem daquele canal entra pelo adaptador dele.
   */
  if v_conv.channel <> 'manual' then
    return jsonb_build_object('outcome', 'not_manual');
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    return jsonb_build_object('outcome', 'invalid_body');
  end if;

  insert into public.messages (
    clinic_id,               -- derivado da conversa, nunca do cliente
    conversation_id,
    channel,                 -- o trigger recarimba a partir da conversa
    direction,
    body,
    occurred_at              -- omitido = agora, no relogio do servidor
    -- author_*, recorded_by_* e delivery_status ficam de fora: os dois
    -- primeiros sao carimbados por trigger e o terceiro nao existe em manual.
  ) values (
    v_conv.clinic_id,
    v_conv.id,
    'manual',
    p_direction,
    v_body,
    coalesce(p_occurred_at, now())
  )
  returning * into v_msg;

  return jsonb_build_object('outcome', 'ok',
                            'message', public.message_row_json(v_msg));
end;
$$;

revoke execute on function public.message_row_json(public.messages) from public, anon;
revoke execute on function public.conversation_create_manual(uuid, text, text, uuid)
  from public, anon;
revoke execute on function
  public.conversation_add_manual_message(uuid, public.message_direction, text, timestamptz)
  from public, anon;

grant execute on function public.conversation_create_manual(uuid, text, text, uuid)
  to authenticated;
grant execute on function
  public.conversation_add_manual_message(uuid, public.message_direction, text, timestamptz)
  to authenticated;
