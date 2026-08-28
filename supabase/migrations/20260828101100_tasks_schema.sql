-- =============================================================================
-- Pendencias Core v0.1 — tabela `tasks`
--
-- Uma pendencia e uma ACAO INTERNA que alguem da clinica precisa executar. Ela
-- pode nascer de um paciente, de uma conversa ou de um agendamento — e pode nao
-- nascer de nenhum: "confirmar com a Dra. Ana se atende no feriado" e uma
-- pendencia geral da clinica, legitima, e sem contexto.
--
-- Por isso NAO existe CHECK exigindo contexto. Forcar contexto empurraria essas
-- tarefas de volta para o papel ou faria alguem inventar um paciente ficticio,
-- que polui a base de pacientes e e pior.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type public.task_status as enum ('open', 'completed', 'cancelled');
  end if;
end
$$;

create table if not exists public.tasks (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references public.clinics (id) on delete cascade,

  title            text not null
                     check (char_length(btrim(title)) between 3 and 200),
  description      text
                     check (description is null or char_length(description) <= 2000),

  status           public.task_status not null default 'open',

  -- ESTADO ATUAL, nao autoria. Muda ao longo da vida da tarefa.
  assigned_to      uuid,

  -- Intencao, nao fato consumado: prazo no passado e legitimo (registrar algo
  -- que ja deveria ter sido feito). Por isso, ao contrario de
  -- messages.occurred_at, nao ha trava de futuro nem de passado.
  due_at           timestamptz,

  -- CONTEXTO — os tres opcionais e IMUTAVEIS apos a criacao.
  -- Contexto responde "sobre o que esta acao nasceu". Reescreve-lo depois
  -- mudaria o significado historico da tarefa. Contexto errado se resolve
  -- cancelando e criando outra. Ver o trigger de imutabilidade adiante.
  patient_id       uuid,
  conversation_id  uuid,
  appointment_id   uuid,

  -- AUTORIA HISTORICA. Ver o bloco "autoria" logo abaixo.
  created_by       uuid references auth.users (id) on delete set null,
  completed_by     uuid references auth.users (id) on delete set null,
  completed_at     timestamptz,
  cancelled_by     uuid references auth.users (id) on delete set null,
  cancelled_at     timestamptz,

  version          integer not null default 1 check (version > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint tasks_clinic_id_id_key unique (clinic_id, id),

  -- ---------------------------------------------------------------- contexto
  -- Tenant-first, sempre. A verificacao de FK ignora RLS: uma FK simples
  -- aceitaria o registro de outra clinica, e nenhuma policy impediria.
  --
  -- `on delete set null (coluna)` COM LISTA DE COLUNAS. Sem a lista, o Postgres
  -- anula TODAS as colunas da FK — inclusive clinic_id, que e not null. A
  -- remocao falharia com violacao de not-null e bloquearia justamente o que se
  -- queria permitir. Disponivel desde o PG 15; o projeto roda PG 17.
  constraint tasks_patient_fk
    foreign key (clinic_id, patient_id)
    references public.patients (clinic_id, id)
    on delete set null (patient_id),

  constraint tasks_conversation_fk
    foreign key (clinic_id, conversation_id)
    references public.conversations (clinic_id, id)
    on delete set null (conversation_id),

  constraint tasks_appointment_fk
    foreign key (clinic_id, appointment_id)
    references public.appointments (clinic_id, id)
    on delete set null (appointment_id),

  -- ------------------------------------------------------------- responsavel
  -- Tirar alguem da clinica nao pode travar a remocao nem apagar a tarefa: ela
  -- volta para a fila geral, onde qualquer membro pode assumi-la.
  constraint tasks_assignee_fk
    foreign key (clinic_id, assigned_to)
    references public.clinic_members (clinic_id, user_id)
    on delete set null (assigned_to),

  -- ------------------------------------------------------- invariantes de estado
  --
  -- Note o que estas travas NAO fazem: nenhuma exige que uma coluna `_by` seja
  -- NOT NULL. Isso e deliberado e e o ponto mais delicado do arquivo.
  --
  -- `completed_by` referencia auth.users com ON DELETE SET NULL. Se um CHECK
  -- dissesse "status = 'completed' => completed_by is not null", apagar a conta
  -- de quem concluiu uma tarefa dispararia o SET NULL, que violaria o CHECK, e
  -- a DELETE FALHARIA. Autoria historica passaria a bloquear a remocao de uma
  -- pessoa — exatamente o que nao pode acontecer.
  --
  -- O invariante real e sobre o INSTANTE, que ninguem anula: uma tarefa
  -- concluida tem `completed_at`. Quem concluiu e melhor-esforco, e sobrevive
  -- em task_events.actor_name_snapshot mesmo quando a conta some.
  --
  -- Mesmo raciocinio de messages_inbound_has_no_author no Atendimento: aquele
  -- CHECK so exige NULL, nunca NOT NULL, e por isso nenhum SET NULL o quebra.
  constraint tasks_completed_at_iff_completed
    check ((status = 'completed') = (completed_at is not null)),
  constraint tasks_cancelled_at_iff_cancelled
    check ((status = 'cancelled') = (cancelled_at is not null)),

  -- Sem estado hibrido: fora do estado correspondente, o autor tem de ser nulo.
  -- So exige NULL, entao e seguro sob SET NULL.
  constraint tasks_completed_by_only_when_completed
    check (status = 'completed' or completed_by is null),
  constraint tasks_cancelled_by_only_when_cancelled
    check (status = 'cancelled' or cancelled_by is null)
);

-- =============================================================================
-- Indices
--
-- Dois, e so dois. Cada um serve consulta que a v0.1 realmente faz.
-- =============================================================================

-- Fila principal. Atrasadas, Hoje, Proximas e Sem prazo sao todas recortes do
-- MESMO range sobre este indice — `nulls last` coloca "sem prazo" no fim, que e
-- a ordem que a tela quer.
create index if not exists tasks_clinic_status_due_idx
  on public.tasks (clinic_id, status, due_at asc nulls last, id);

-- "Minhas". Parcial porque a fila geral (assigned_to is null) nao se beneficia
-- dele, e indexar esses nulos so custaria espaco. Mesmo desenho do indice de
-- conversas atribuidas.
create index if not exists tasks_clinic_assignee_idx
  on public.tasks (clinic_id, assigned_to, status, due_at asc nulls last)
  where assigned_to is not null;

-- NAO EXISTEM AQUI, e a ausencia e decisao: indices por patient_id,
-- conversation_id e appointment_id. As consultas que os justificariam
-- ("pendencias deste paciente", "desta conversa", "deste agendamento") sao das
-- INTEGRACOES, que estao fora da v0.1 — nenhuma tela desta versao filtra por
-- contexto. Criar indice para consulta que ninguem faz e custo de escrita sem
-- retorno de leitura, e acrescenta-los depois e aditivo.

comment on table public.tasks is
  'Pendencias: acoes internas da clinica. Contexto (paciente/conversa/'
  'agendamento) e opcional e imutavel. Escrita somente por RPC controlada.';

-- =============================================================================
-- Triggers
-- =============================================================================

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- tenant fixo
create or replace function public.prevent_task_clinic_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.clinic_id is distinct from old.clinic_id then
    raise exception 'CLINIC_IMMUTABLE: uma pendencia nao muda de clinica.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger tasks_prevent_clinic_change
  before update on public.tasks
  for each row execute function public.prevent_task_clinic_change();

-- ------------------------------------------------------------ contexto imutavel
create or replace function public.enforce_task_context_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  /*
   * "valor -> outro valor" e "nulo -> valor": nao.
   * "valor -> nulo": SIM, e a excecao e obrigatoria.
   *
   * O caminho `valor -> nulo` e como o ON DELETE SET NULL das FKs de contexto
   * chega ate aqui. Acoes referenciais no Postgres sao executadas por triggers
   * internos que fazem UPDATE na tabela referenciante, e esse UPDATE dispara os
   * triggers de usuario. Se a imutabilidade fosse cega, apagar um paciente
   * falharia com CONTEXT_IMMUTABLE — e a regra de historico teria virado uma
   * trava contra a exclusao de dados de paciente.
   *
   * `nulo -> valor` fica barrado porque acrescentar contexto depois e tao
   * reescrita de historico quanto troca-lo: a tarefa passaria a alegar que
   * nasceu de algo que nao a originou.
   */
  if old.patient_id is not null
     and new.patient_id is not null
     and new.patient_id is distinct from old.patient_id then
    raise exception 'CONTEXT_IMMUTABLE: paciente da pendencia nao pode mudar.'
      using errcode = '22023';
  end if;
  if old.patient_id is null and new.patient_id is not null then
    raise exception 'CONTEXT_IMMUTABLE: paciente nao pode ser acrescentado depois.'
      using errcode = '22023';
  end if;

  if old.conversation_id is not null
     and new.conversation_id is not null
     and new.conversation_id is distinct from old.conversation_id then
    raise exception 'CONTEXT_IMMUTABLE: conversa da pendencia nao pode mudar.'
      using errcode = '22023';
  end if;
  if old.conversation_id is null and new.conversation_id is not null then
    raise exception 'CONTEXT_IMMUTABLE: conversa nao pode ser acrescentada depois.'
      using errcode = '22023';
  end if;

  if old.appointment_id is not null
     and new.appointment_id is not null
     and new.appointment_id is distinct from old.appointment_id then
    raise exception 'CONTEXT_IMMUTABLE: agendamento da pendencia nao pode mudar.'
      using errcode = '22023';
  end if;
  if old.appointment_id is null and new.appointment_id is not null then
    raise exception 'CONTEXT_IMMUTABLE: agendamento nao pode ser acrescentado depois.'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger tasks_enforce_context_immutable
  before update on public.tasks
  for each row execute function public.enforce_task_context_immutable();

-- ------------------------------------------------------------- transicoes
create or replace function public.enforce_task_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- Recusa explicita dos atalhos entre terminais: quem errou reabre primeiro, e
  -- o caminho fica legivel no historico.
  if not (
       (old.status = 'open'      and new.status in ('completed', 'cancelled'))
    or (old.status = 'completed' and new.status = 'open')
    or (old.status = 'cancelled' and new.status = 'open')
  ) then
    raise exception 'INVALID_TRANSITION: % nao pode ir direto para %.',
      old.status, new.status using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger tasks_enforce_status_transition
  before update on public.tasks
  for each row execute function public.enforce_task_status_transition();

-- ------------------------------------------------------------------- versao
create or replace function public.bump_task_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  /*
   * SELETIVO. So conta como alteracao concorrente o que muda o compromisso:
   * texto, responsavel, prazo e estado.
   *
   * O que NAO bumpa, e por que:
   *
   *  - `updated_at` sozinho: nao e mudanca, e efeito de mudanca.
   *  - contexto virando nulo por ON DELETE SET NULL: ninguem "editou" a tarefa;
   *    bumpar ai faria toda tela aberta receber 409 por causa da exclusao de um
   *    paciente que nada tem a ver com o que a pessoa estava fazendo.
   *  - insercao em task_events: e outra tabela, e nao ha trigger cruzado. Um
   *    evento e consequencia da operacao, nao uma segunda alteracao dela.
   */
  if new.title           is distinct from old.title
     or new.description  is distinct from old.description
     or new.assigned_to  is distinct from old.assigned_to
     or new.due_at       is distinct from old.due_at
     or new.status       is distinct from old.status
  then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

create trigger tasks_bump_version
  before update on public.tasks
  for each row execute function public.bump_task_version();
