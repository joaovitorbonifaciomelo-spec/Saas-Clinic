-- =============================================================================
-- Pendencias Core v0.1 — `task_events`, append-only
--
-- POR QUE ESTA TABELA EXISTE, e nao e simetria com o Atendimento:
--
-- 1. REABRIR EXIGE. Reabrir limpa completed_at/completed_by, senao a linha
--    passa a mentir. Sem eventos, o fato de a tarefa JA TER SIDO concluida
--    simplesmente deixa de existir. Permitir reabrir e nao ter eventos sao
--    escolhas incompativeis.
-- 2. As perguntas que uma clinica faz de verdade nao sao "quem criou" — sao
--    "quem mudou o prazo disto?" e "por que isto saiu comigo?". Colunas de
--    estado atual nao respondem nenhuma das duas.
-- 3. O padrao ja existe e ja foi revisado em conversation_events.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_event_type') then
    create type public.task_event_type as enum (
      'created',
      'details_changed',
      'assigned',
      'transferred',
      'released',
      'due_changed',
      'completed',
      'reopened',
      'cancelled'
    );
  end if;
end
$$;

create table if not exists public.task_events (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            uuid not null references public.clinics (id) on delete cascade,
  task_id              uuid not null,

  event_type           public.task_event_type not null,

  -- AUTORIA HISTORICA, no mesmo desenho da decisao 7 do Atendimento.
  --
  -- FK SIMPLES para auth.users, e nao composta para clinic_members. A diferenca
  -- e o ponto: membership e autorizacao e atribuicao; nao e requisito para
  -- manter historico. Remover alguem de clinic_members nao toca em auth.users,
  -- entao o evento sobrevive intacto a saida do funcionario — nem bloqueia a
  -- remocao, nem apaga a tarefa, nem perde o registro.
  --
  -- Quando a CONTA e apagada, o id vira nulo e o nome permanece no snapshot.
  -- Nenhum CHECK exige estas colunas NOT NULL: um CHECK assim faria o SET NULL
  -- falhar e a exclusao da conta seria bloqueada por um evento de auditoria.
  actor_user_id        uuid references auth.users (id) on delete set null,
  actor_name_snapshot  text
                         check (actor_name_snapshot is null
                                or char_length(btrim(actor_name_snapshot)) between 1 and 120),
  -- Mantido porque um dia respondera "essa pessoa tinha autoridade para isso na
  -- epoca?" — pergunta que so e respondivel se o papel for capturado desde o
  -- inicio, ja que papeis mudam. Custa nada: current_actor_snapshot ja o devolve.
  actor_role_snapshot  public.clinic_role,

  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),

  constraint task_events_clinic_id_id_key unique (clinic_id, id),

  constraint task_events_task_fk
    foreign key (clinic_id, task_id)
    references public.tasks (clinic_id, id) on delete cascade,

  -- Teto geral. octet_length(metadata::text) e nao pg_column_size(): expressao
  -- de CHECK precisa ser imutavel, e o cast jsonb->text com octet_length e
  -- imutavel com certeza, enquanto pg_column_size depende de armazenamento.
  constraint task_events_metadata_size check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 2048
  ),

  -- Formato ESTRITO por tipo. A subtracao de chaves prova que nao ha nenhuma
  -- outra: CHECK nao aceita subconsulta, entao nao da para contar chaves com
  -- jsonb_object_keys.
  --
  -- created/completed/cancelled/reopened: metadata vazia.
  --   `reopened` nao carrega from_status porque o evento terminal anterior no
  --   log ja diz de onde veio; repetir criaria uma segunda fonte de verdade
  --   capaz de discordar da primeira.
  --   `created` nao carrega os ids de contexto: eles sao imutaveis e vivem na
  --   tarefa. A copia so teria efeito se o paciente fosse apagado — e guardar o
  --   uuid de um paciente apagado nao devolve nome nenhum, apenas preserva o
  --   vestigio de uma associacao que o administrador pediu para apagar.
  constraint task_events_empty_metadata check (
    event_type not in ('created', 'completed', 'cancelled', 'reopened')
    or metadata = '{}'::jsonb
  ),

  -- details_changed: SOMENTE nomes de campo, nunca o texto.
  -- description vai a 2000 caracteres e o teto sao 2048 bytes: guardar old/new
  -- estouraria a constraint numa unica edicao de descricao longa, e a falha
  -- apareceria longe da causa.
  --
  -- Enumeracao das tres formas canonicas em vez de "todo elemento pertence ao
  -- conjunto". CHECK nao aceita subconsulta, entao jsonb_array_elements_text
  -- esta fora; e `<@` deixaria passar `["title","title"]`, que nao e um conjunto
  -- de campos, e sim um bug de quem montou. A enumeracao tambem fixa a ORDEM,
  -- o que torna dois eventos equivalentes literalmente iguais.
  constraint task_events_details_metadata check (
    event_type <> 'details_changed'
    or metadata in (
         '{"fields": ["title"]}'::jsonb,
         '{"fields": ["description"]}'::jsonb,
         '{"fields": ["title", "description"]}'::jsonb
       )
  ),

  -- due_changed: exatamente `from` e `to`, cada um string ISO ou null.
  -- `?` enxerga chave com valor null, entao ausencia e nulo nao se confundem.
  constraint task_events_due_metadata check (
    event_type <> 'due_changed'
    or (
      metadata ? 'from' and metadata ? 'to'
      and metadata - 'from' - 'to' = '{}'::jsonb
      and jsonb_typeof(metadata -> 'from') in ('string', 'null')
      and jsonb_typeof(metadata -> 'to')   in ('string', 'null')
    )
  ),

  -- Snapshot de responsavel: exatamente {userId, displayName}. Sem `role` — o
  -- papel do ATOR ja esta em actor_role_snapshot, e o papel de quem recebeu a
  -- tarefa nao responde pergunta historica nenhuma.
  constraint task_events_assigned_metadata check (
    event_type <> 'assigned'
    or (
      metadata ? 'to'
      and metadata - 'to' = '{}'::jsonb
      and (metadata -> 'to') ? 'userId'
      and (metadata -> 'to') - 'userId' - 'displayName' = '{}'::jsonb
    )
  ),

  -- `from` nulo e legitimo: transferir de ninguem (fila geral) para alguem e
  -- uma transferencia de verdade, e inventar um `from` seria pior.
  constraint task_events_transferred_metadata check (
    event_type <> 'transferred'
    or (
      metadata ? 'from' and metadata ? 'to'
      and metadata - 'from' - 'to' = '{}'::jsonb
      and jsonb_typeof(metadata -> 'from') in ('object', 'null')
      and (metadata -> 'to') ? 'userId'
      and (metadata -> 'to') - 'userId' - 'displayName' = '{}'::jsonb
    )
  ),

  constraint task_events_released_metadata check (
    event_type <> 'released'
    or (
      metadata ? 'from'
      and metadata - 'from' = '{}'::jsonb
      and (metadata -> 'from') ? 'userId'
      and (metadata -> 'from') - 'userId' - 'displayName' = '{}'::jsonb
    )
  )
);

create index if not exists task_events_task_idx
  on public.task_events (clinic_id, task_id, created_at, id);

comment on table public.task_events is
  'Historico append-only das pendencias. Cliente nunca insere: sem policy de '
  'INSERT e sem grant. Escrito apenas pelas RPCs security definer.';

-- =============================================================================
-- Carimbo do ator
--
-- O ator NUNCA vem do cliente. Vem de auth.uid() e de current_actor_snapshot,
-- a mesma funcao que o Atendimento usa. Um evento com autor escolhido por quem
-- age nao e auditoria, e alegacao.
-- =============================================================================

create or replace function public.stamp_task_event_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_role public.clinic_role;
begin
  if auth.uid() is null then
    new.actor_user_id       := null;
    new.actor_name_snapshot := null;
    new.actor_role_snapshot := null;
    return new;
  end if;

  select s.full_name, s.role
    into v_name, v_role
    from public.current_actor_snapshot(new.clinic_id) as s;

  new.actor_user_id       := auth.uid();
  new.actor_name_snapshot := v_name;
  new.actor_role_snapshot := v_role;
  return new;
end;
$$;

create trigger task_events_stamp_actor
  before insert on public.task_events
  for each row execute function public.stamp_task_event_actor();
