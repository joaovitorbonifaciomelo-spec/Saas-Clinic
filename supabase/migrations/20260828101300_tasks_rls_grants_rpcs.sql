-- =============================================================================
-- Pendencias Core v0.1 — RLS, grants e operacoes controladas
--
-- Duas camadas dizem a mesma coisa sobre escrita: nao ha policy de INSERT/
-- UPDATE/DELETE, e `authenticated` nao recebe o privilegio. A redundancia e
-- deliberada — a plataforma do Supabase reconcilia default privileges, e um
-- grant devolvido por engano nao pode virar brecha porque nao ha policy
-- permissiva esperando por ele.
--
-- ORDEM DE AVALIACAO, IGUAL EM TODAS AS OPERACOES
--
--   1. existencia + membership  -> not_found
--   2. expected_version         -> conflict
--   3. regra de dominio         -> invalid_state | no-op | executa
--
-- A ordem nao e estetica. Uma tarefa concluida na versao 7 que recebe um
-- update_details com versao 6 responde `conflict`, e nao `invalid_state`:
-- quem esta operando sobre estado obsoleto precisa saber disso ANTES de ser
-- ensinado sobre o estado atual — senao corrige a regra errada e tenta de novo
-- com a mesma versao velha.
--
-- ATOMICIDADE
--
-- Cada RPC e uma transacao unica: o UPDATE da tarefa e o INSERT do evento
-- nascem e morrem juntos. Se o evento falhar (uma constraint de metadata, por
-- exemplo), a tarefa nao muda. Se a tarefa nao mudar, o evento nao nasce. E
-- no-op nao produz nem um nem outro.
-- =============================================================================

alter table public.tasks       enable row level security;
alter table public.task_events enable row level security;

-- ------------------------------------------------------------------- leitura
drop policy if exists tasks_select_member on public.tasks;
create policy tasks_select_member
  on public.tasks
  for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

drop policy if exists task_events_select_member on public.task_events;
create policy task_events_select_member
  on public.task_events
  for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

-- ------------------------------------------------------------------- escrita
-- SEM policy de insert, update ou delete. A ausencia e a defesa; ver cabecalho.
-- Os drops existem para tornar a ausencia explicita e reexecutavel.
drop policy if exists tasks_insert_member       on public.tasks;
drop policy if exists tasks_update_member       on public.tasks;
drop policy if exists tasks_delete_member       on public.tasks;
drop policy if exists task_events_insert_member on public.task_events;
drop policy if exists task_events_update_member on public.task_events;
drop policy if exists task_events_delete_member on public.task_events;

-- =============================================================================
-- Grants
--
-- NUNCA `grant all`: ele expande para os sete privilegios, e TRUNCATE nao passa
-- por RLS nem dispara trigger de linha. Lista positiva, sempre.
--
-- `revoke all ... from public, anon, authenticated` primeiro porque a tabela
-- nasce do `db push` com um papel de login SEM default privileges — ja mordeu
-- duas vezes neste projeto (0006 e 0014). Zerar e conceder o necessario e a
-- unica ordem que produz o mesmo resultado em qualquer ambiente.
-- =============================================================================

revoke all on public.tasks       from public, anon, authenticated;
revoke all on public.task_events from public, anon, authenticated;

grant select on public.tasks       to authenticated;
grant select on public.task_events to authenticated;

-- service_role: DML minimo explicito. Sem truncate, references ou trigger.
revoke truncate, references, trigger on public.tasks       from service_role;
revoke truncate, references, trigger on public.task_events from service_role;
grant select, insert, update, delete on public.tasks       to service_role;
grant select, insert, update, delete on public.task_events to service_role;

-- =============================================================================
-- Helpers de retorno
-- =============================================================================

create or replace function public.task_row_json(t public.tasks)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',              t.id,
    'clinicId',        t.clinic_id,
    'title',           t.title,
    'description',     t.description,
    'status',          t.status,
    'assignedTo',      t.assigned_to,
    'dueAt',           t.due_at,
    'patientId',       t.patient_id,
    'conversationId',  t.conversation_id,
    'appointmentId',   t.appointment_id,
    'createdBy',       t.created_by,
    'completedBy',     t.completed_by,
    'completedAt',     t.completed_at,
    'cancelledBy',     t.cancelled_by,
    'cancelledAt',     t.cancelled_at,
    'version',         t.version,
    'createdAt',       t.created_at,
    'updatedAt',       t.updated_at
  );
$$;

/*
 * Conflito devolve o ESTADO ATUAL para a tela poder se reconciliar sem uma
 * segunda ida ao servidor. Rele a linha em vez de reaproveitar a que foi lida
 * no inicio: entre a leitura e o UPDATE outra transacao pode ter commitado.
 *
 * So devolve se quem perguntou ainda for membro da clinica. Sem essa
 * verificacao, um 409 viraria canal de vazamento: bastaria chutar um uuid e ler
 * o corpo do conflito. Se a membership acabou, a resposta e `not_found`, igual
 * a de um id inexistente.
 */
create or replace function public.task_conflict(p_task_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v public.tasks%rowtype;
begin
  select * into v from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  return jsonb_build_object('outcome', 'conflict', 'task', public.task_row_json(v));
end;
$$;

/*
 * A operacao nao cabe no estado atual da tarefa — e nao e conflito nem
 * inexistencia.
 *
 * Tres respostas distintas porque exigem tres reacoes distintas na tela:
 *   not_found     -> a tarefa nao e sua, ou nao existe. Saia dela.
 *   conflict      -> voce viu um estado velho. Recarregue e decida de novo.
 *   invalid_state -> voce viu o estado certo; a acao e que nao cabe nele.
 *
 * `reason` existe para a tela dizer a frase certa sem adivinhar a partir de um
 * codigo generico. A tarefa vem junto porque a membership ja foi conferida.
 */
create or replace function public.task_invalid_state(t public.tasks, p_reason text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'outcome', 'invalid_state',
    'reason',  p_reason,
    'task',    public.task_row_json(t)
  );
$$;

/** Snapshot minimo de um membro, para a metadata dos eventos de responsavel. */
create or replace function public.task_member_snapshot(p_clinic_id uuid, p_user_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select case
    when p_user_id is null then null
    else jsonb_build_object(
           'userId', p_user_id,
           'displayName', (select p.full_name from public.profiles p where p.id = p_user_id)
         )
  end;
$$;

/** Devolve a tarefa inalterada. No-op nao gasta versao e nao gera evento. */
create or replace function public.task_noop(t public.tasks)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(t));
$$;

-- =============================================================================
-- Operacoes controladas
-- =============================================================================

-- ------------------------------------------------------------------- criar
create or replace function public.task_create(
  p_clinic_id       uuid,
  p_title           text,
  p_description     text          default null,
  p_due_at          timestamptz   default null,
  p_assignee_id     uuid          default null,
  p_patient_id      uuid          default null,
  p_conversation_id uuid          default null,
  p_appointment_id  uuid          default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new          public.tasks%rowtype;
  v_conv_patient uuid;
  v_meta         jsonb := '{}'::jsonb;
begin
  /*
   * A clinica vem por parametro e e VALIDADA aqui, no mesmo desenho de
   * conversation_create_manual.
   *
   * Deduzi-la da membership do autor seria errado: o modelo permite pertencer a
   * varias clinicas (clinic_members e unique por par, nao por usuario), e uma
   * deducao escolheria uma arbitrariamente — a pendencia nasceria na clinica
   * errada sem ninguem perceber.
   *
   * O parametro nao e confianca no cliente: SECURITY DEFINER nao passa por RLS,
   * entao o vinculo e conferido explicitamente. Um id de outra clinica devolve
   * `not_found`, igual a um id inexistente — non-disclosure.
   */
  if not public.is_clinic_member(p_clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Responsavel inicial, quando houver, precisa ser membro DESTA clinica.
  if p_assignee_id is not null and not exists (
    select 1 from public.clinic_members m
     where m.clinic_id = p_clinic_id and m.user_id = p_assignee_id
  ) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Coerencia de contexto, verificada UMA VEZ e so aqui.
  --
  -- Conversa vinculada a paciente DIFERENTE: recusar — a tarefa estaria
  -- afirmando que nasceu de uma conversa sobre outra pessoa. Conversa sem
  -- paciente, ou com o mesmo: aceitar.
  --
  -- Nao existe verificacao continua depois disto. Uma constraint que
  -- perseguisse conversations.patient_id impediria desvincular um paciente
  -- enquanto houvesse pendencia aberta — transformaria uma decisao do
  -- Atendimento em refem deste modulo.
  if p_conversation_id is not null and p_patient_id is not null then
    select c.patient_id into v_conv_patient
      from public.conversations c
     where c.id = p_conversation_id and c.clinic_id = p_clinic_id;

    if v_conv_patient is not null and v_conv_patient <> p_patient_id then
      return jsonb_build_object('outcome', 'patient_mismatch');
    end if;
  end if;

  insert into public.tasks
    (clinic_id, title, description, due_at, assigned_to,
     patient_id, conversation_id, appointment_id, created_by)
  values
    (p_clinic_id, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''),
     p_due_at, p_assignee_id,
     p_patient_id, p_conversation_id, p_appointment_id, auth.uid())
  returning * into v_new;

  /*
   * UM evento para UMA operacao humana.
   *
   * Nascer atribuida nao e "criar e depois atribuir": e uma decisao so. Emitir
   * um `assigned` artificial aqui inventaria um segundo ato que ninguem
   * praticou, e o historico passaria a contar uma sequencia que nao aconteceu.
   *
   * O responsavel inicial vai na metadata do proprio `created` porque, sem
   * isso, ele desapareceria: se a pessoa for removida da clinica antes de
   * qualquer transferencia, o SET NULL zera `assigned_to` sem gerar evento e
   * nao sobra registro de quem era.
   */
  if p_assignee_id is not null then
    v_meta := jsonb_build_object(
      'assignedTo', public.task_member_snapshot(p_clinic_id, p_assignee_id));
  end if;

  insert into public.task_events (clinic_id, task_id, event_type, metadata)
  values (v_new.clinic_id, v_new.id, 'created', v_meta);

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- ------------------------------------------------------------ editar texto
create or replace function public.task_update_details(
  p_task_id          uuid,
  p_expected_version integer,
  p_title            text default null,
  p_description      text default null,
  p_set_description  boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old    public.tasks%rowtype;
  v_new    public.tasks%rowtype;
  v_fields text[] := '{}';
  v_desc   text;
begin
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  -- Terminal congelada: nao alteramos retroativamente o significado de uma
  -- pendencia ja encerrada. Reabrir primeiro e uma decisao explicita, e fica
  -- no historico.
  if v_old.status <> 'open' then
    return public.task_invalid_state(v_old, 'terminal');
  end if;

  -- `p_set_description` separa "nao mexer na descricao" de "apagar a
  -- descricao". Sem ele, null seria ambiguo entre as duas intencoes, e apagar
  -- uma descricao por engano e o tipo de perda que ninguem percebe na hora.
  v_desc := case when p_set_description
                 then nullif(btrim(coalesce(p_description, '')), '')
                 else v_old.description end;

  -- Cast explicito: sem ele, `text[] || 'literal'` e ambiguo entre
  -- `anyarray || anyelement` e `anyarray || anyarray`, e o Postgres escolhe a
  -- segunda — tentando ler "title" como literal de array e falhando com
  -- "malformed array literal", erro que nao parece ter nada a ver com a causa.
  if p_title is not null and btrim(p_title) is distinct from v_old.title then
    v_fields := v_fields || 'title'::text;
  end if;
  if v_desc is distinct from v_old.description then
    v_fields := v_fields || 'description'::text;
  end if;

  if array_length(v_fields, 1) is null then
    return public.task_noop(v_old);
  end if;

  update public.tasks
     set title       = coalesce(btrim(p_title), title),
         description = v_desc
   where id = p_task_id
     and version = p_expected_version
  returning * into v_new;

  -- A versao ja foi conferida acima; esta guarda cobre a corrida entre a
  -- conferencia e o UPDATE. Ler a versao e depois escrever SEM ela seria
  -- exatamente a corrida que o padrao existe para eliminar.
  if not found then
    return public.task_conflict(p_task_id);
  end if;

  insert into public.task_events (clinic_id, task_id, event_type, metadata)
  values (v_new.clinic_id, v_new.id, 'details_changed',
          jsonb_build_object('fields', to_jsonb(v_fields)));

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- ------------------------------------------------------------------ assumir
create or replace function public.task_assign(
  p_task_id          uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tasks%rowtype;
  v_new public.tasks%rowtype;
begin
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  if v_old.status <> 'open' then
    return public.task_invalid_state(v_old, 'terminal');
  end if;

  /*
   * Assumir e SO para tarefa sem dono.
   *
   * Assumir uma tarefa que ja tem responsavel nao vira transferencia implicita:
   * seriam duas decisoes diferentes com a mesma aparencia, e a segunda tiraria
   * o trabalho de alguem sem que essa pessoa aparecesse em lugar nenhum. Quem
   * quer tirar de outro usa `task_transfer`, que registra `from` e `to`.
   */
  if v_old.assigned_to is not null then
    return public.task_invalid_state(v_old, 'already_assigned');
  end if;

  update public.tasks
     set assigned_to = auth.uid()
   where id = p_task_id
     and version = p_expected_version
     and assigned_to is null
  returning * into v_new;

  if not found then
    return public.task_conflict(p_task_id);
  end if;

  insert into public.task_events (clinic_id, task_id, event_type, metadata)
  values (v_new.clinic_id, v_new.id, 'assigned',
          jsonb_build_object('to', public.task_member_snapshot(v_new.clinic_id, auth.uid())));

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- -------------------------------------------------------------- transferir
create or replace function public.task_transfer(
  p_task_id          uuid,
  p_expected_version integer,
  p_to_user_id       uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tasks%rowtype;
  v_new public.tasks%rowtype;
begin
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  if v_old.status <> 'open' then
    return public.task_invalid_state(v_old, 'terminal');
  end if;

  -- Destinatario precisa ser membro DESTA clinica. A FK composta ja garantiria,
  -- mas falharia com erro de integridade; aqui a recusa e resposta normal do
  -- contrato, e nao uma excecao que a API teria de traduzir.
  if not exists (
    select 1 from public.clinic_members m
     where m.clinic_id = v_old.clinic_id and m.user_id = p_to_user_id
  ) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  /*
   * Transferir exige responsavel atual.
   *
   * Transferir de ninguem para alguem NAO vira assumir implicito: sao decisoes
   * diferentes — uma tira trabalho de uma pessoa, a outra tira da fila comum —
   * e confundi-las produziria historico que descreve o ato errado.
   */
  if v_old.assigned_to is null then
    return public.task_invalid_state(v_old, 'not_assigned');
  end if;

  if v_old.assigned_to = p_to_user_id then
    return public.task_noop(v_old);
  end if;

  update public.tasks
     set assigned_to = p_to_user_id
   where id = p_task_id
     and version = p_expected_version
  returning * into v_new;

  if not found then
    return public.task_conflict(p_task_id);
  end if;

  insert into public.task_events (clinic_id, task_id, event_type, metadata)
  values (v_new.clinic_id, v_new.id, 'transferred',
          jsonb_build_object(
            'from', public.task_member_snapshot(v_new.clinic_id, v_old.assigned_to),
            'to',   public.task_member_snapshot(v_new.clinic_id, p_to_user_id)));

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- devolver
create or replace function public.task_release(
  p_task_id          uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tasks%rowtype;
  v_new public.tasks%rowtype;
begin
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  if v_old.status <> 'open' then
    return public.task_invalid_state(v_old, 'terminal');
  end if;

  -- Ja esta na fila geral: o mundo ja esta como o chamador quer. No-op, e nao
  -- erro — devolver o que ninguem tem e pedido atendido, nao pedido invalido.
  if v_old.assigned_to is null then
    return public.task_noop(v_old);
  end if;

  update public.tasks
     set assigned_to = null
   where id = p_task_id
     and version = p_expected_version
     and assigned_to is not null
  returning * into v_new;

  if not found then
    return public.task_conflict(p_task_id);
  end if;

  insert into public.task_events (clinic_id, task_id, event_type, metadata)
  values (v_new.clinic_id, v_new.id, 'released',
          jsonb_build_object('from', public.task_member_snapshot(v_new.clinic_id, v_old.assigned_to)));

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- ------------------------------------------------------------------- prazo
create or replace function public.task_set_due(
  p_task_id          uuid,
  p_expected_version integer,
  p_due_at           timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tasks%rowtype;
  v_new public.tasks%rowtype;
begin
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  if v_old.status <> 'open' then
    return public.task_invalid_state(v_old, 'terminal');
  end if;

  if v_old.due_at is not distinct from p_due_at then
    return public.task_noop(v_old);
  end if;

  update public.tasks
     set due_at = p_due_at
   where id = p_task_id
     and version = p_expected_version
  returning * into v_new;

  if not found then
    return public.task_conflict(p_task_id);
  end if;

  insert into public.task_events (clinic_id, task_id, event_type, metadata)
  values (v_new.clinic_id, v_new.id, 'due_changed',
          jsonb_build_object('from', to_jsonb(v_old.due_at), 'to', to_jsonb(p_due_at)));

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- concluir
create or replace function public.task_complete(
  p_task_id          uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tasks%rowtype;
  v_new public.tasks%rowtype;
begin
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  -- Ja concluida: o mundo ja esta como o chamador quer. No-op.
  if v_old.status = 'completed' then
    return public.task_noop(v_old);
  end if;

  -- Cancelada nao vira concluida direto. Reabrir e uma decisao, e ela aparece
  -- no historico; um atalho aqui apagaria essa decisao.
  if v_old.status = 'cancelled' then
    return public.task_invalid_state(v_old, 'invalid_transition');
  end if;

  update public.tasks
     set status       = 'completed',
         completed_at = now(),
         completed_by = auth.uid()
   where id = p_task_id
     and version = p_expected_version
     and status = 'open'
  returning * into v_new;

  if not found then
    return public.task_conflict(p_task_id);
  end if;

  insert into public.task_events (clinic_id, task_id, event_type)
  values (v_new.clinic_id, v_new.id, 'completed');

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- cancelar
create or replace function public.task_cancel(
  p_task_id          uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tasks%rowtype;
  v_new public.tasks%rowtype;
begin
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  if v_old.status = 'cancelled' then
    return public.task_noop(v_old);
  end if;

  if v_old.status = 'completed' then
    return public.task_invalid_state(v_old, 'invalid_transition');
  end if;

  update public.tasks
     set status       = 'cancelled',
         cancelled_at = now(),
         cancelled_by = auth.uid()
   where id = p_task_id
     and version = p_expected_version
     and status = 'open'
  returning * into v_new;

  if not found then
    return public.task_conflict(p_task_id);
  end if;

  insert into public.task_events (clinic_id, task_id, event_type)
  values (v_new.clinic_id, v_new.id, 'cancelled');

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- ---------------------------------------------------------------- reabrir
create or replace function public.task_reopen(
  p_task_id          uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tasks%rowtype;
  v_new public.tasks%rowtype;
begin
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  -- Ja aberta: no-op. Reabrir e a UNICA operacao que uma tarefa terminal
  -- aceita, e a unica que nao tem estado terminal proibido.
  if v_old.status = 'open' then
    return public.task_noop(v_old);
  end if;

  /*
   * Limpar as duas duplas de uma vez e correto, nao preguica: o CHECK exige que
   * a dupla do estado que a tarefa NAO tem esteja nula, e depois de reabrir ela
   * nao tem nenhum dos dois. Zerar ambas satisfaz o invariante venha de onde
   * vier.
   *
   * A informacao nao se perde: quem concluiu, quem cancelou e quando ficam em
   * task_events, e o evento `reopened` marca o ponto de virada. E por isso que
   * permitir reabrir exige ter eventos — sem eles, reabrir apagaria o fato.
   */
  update public.tasks
     set status       = 'open',
         completed_at = null,
         completed_by = null,
         cancelled_at = null,
         cancelled_by = null
   where id = p_task_id
     and version = p_expected_version
     and status in ('completed', 'cancelled')
  returning * into v_new;

  if not found then
    return public.task_conflict(p_task_id);
  end if;

  insert into public.task_events (clinic_id, task_id, event_type)
  values (v_new.clinic_id, v_new.id, 'reopened');

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- =============================================================================
-- EXECUTE
--
-- O default do Postgres concede EXECUTE a PUBLIC em toda funcao nova. Depender
-- desse default e o erro que deixa uma funcao de escrita aberta a anon sem que
-- ninguem tenha decidido isso. Revogar de PUBLIC, anon E authenticated, e
-- depois conceder apenas as nove aprovadas.
-- =============================================================================

revoke execute on function
  public.task_create(uuid, text, text, timestamptz, uuid, uuid, uuid, uuid)
  from public, anon;
grant  execute on function
  public.task_create(uuid, text, text, timestamptz, uuid, uuid, uuid, uuid)
  to authenticated;

revoke execute on function
  public.task_update_details(uuid, integer, text, text, boolean) from public, anon;
grant  execute on function
  public.task_update_details(uuid, integer, text, text, boolean) to authenticated;

revoke execute on function public.task_assign(uuid, integer)   from public, anon;
grant  execute on function public.task_assign(uuid, integer)   to authenticated;

revoke execute on function public.task_transfer(uuid, integer, uuid) from public, anon;
grant  execute on function public.task_transfer(uuid, integer, uuid) to authenticated;

revoke execute on function public.task_release(uuid, integer)  from public, anon;
grant  execute on function public.task_release(uuid, integer)  to authenticated;

revoke execute on function public.task_set_due(uuid, integer, timestamptz) from public, anon;
grant  execute on function public.task_set_due(uuid, integer, timestamptz) to authenticated;

revoke execute on function public.task_complete(uuid, integer) from public, anon;
grant  execute on function public.task_complete(uuid, integer) to authenticated;

revoke execute on function public.task_cancel(uuid, integer)   from public, anon;
grant  execute on function public.task_cancel(uuid, integer)   to authenticated;

revoke execute on function public.task_reopen(uuid, integer)   from public, anon;
grant  execute on function public.task_reopen(uuid, integer)   to authenticated;

-- Internas: nao sao API. `task_conflict`, `task_invalid_state`, `task_noop` e
-- `task_row_json` devolvem ESTADO — deixa-las abertas seria uma leitura lateral
-- que ignora o contrato de leitura. As de trigger nao fazem sentido chamadas a
-- mao. Todas revogadas tambem de `authenticated`.
revoke execute on function public.task_row_json(public.tasks)            from public, anon, authenticated;
revoke execute on function public.task_noop(public.tasks)                from public, anon, authenticated;
revoke execute on function public.task_invalid_state(public.tasks, text) from public, anon, authenticated;
revoke execute on function public.task_conflict(uuid)                    from public, anon, authenticated;
revoke execute on function public.task_member_snapshot(uuid, uuid)       from public, anon, authenticated;
revoke execute on function public.stamp_task_event_actor()               from public, anon, authenticated;
revoke execute on function public.prevent_task_clinic_change()           from public, anon, authenticated;
revoke execute on function public.enforce_task_context_immutable()       from public, anon, authenticated;
revoke execute on function public.enforce_task_status_transition()       from public, anon, authenticated;
revoke execute on function public.bump_task_version()                    from public, anon, authenticated;
