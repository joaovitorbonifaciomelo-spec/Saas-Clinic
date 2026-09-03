-- =============================================================================
-- `task_assign` passa a receber o destinatario explicitamente
--
-- O QUE ESTAVA INCOMPLETO
--
-- A assinatura anterior era `task_assign(p_task_id uuid, p_expected_version
-- integer)` e atribuia a `auth.uid()` — o destinatario era IMPLICITO. Isso
-- confundia duas coisas diferentes: quem EXECUTA a acao e quem RECEBE a
-- pendencia.
--
-- A consequencia pratica aparecia na tela: dar uma pendencia da fila geral a
-- uma colega exigia assumir e depois transferir. Duas mutacoes, duas versoes,
-- dois eventos — e um historico que descreve uma sequencia que nao aconteceu
-- ("Maria assumiu, Maria transferiu para Ana" quando Maria so atribuiu a Ana).
--
-- Uma intencao humana passa a produzir uma mutacao, um bump de versao e um
-- evento `assigned`.
--
-- POR QUE DROP E NAO `CREATE OR REPLACE`
--
-- Acrescentar parametro NAO substitui a funcao: o PostgreSQL identifica funcao
-- por nome + tipos dos argumentos, entao `create or replace` com tres
-- parametros criaria uma SEGUNDA `task_assign`, e as duas ficariam publicas.
-- A antiga continuaria executavel por `authenticated`, com a semantica velha,
-- e ninguem perceberia — inclusive porque o cliente novo nunca a chamaria.
--
-- Por isso: revogar EXECUTE da assinatura antiga, remove-la explicitamente, e
-- so entao criar a nova. A ordem importa; dropar sem revogar deixaria a ACL
-- orfa se o drop falhasse no meio.
-- =============================================================================

revoke execute on function public.task_assign(uuid, integer)
  from public, anon, authenticated;

drop function if exists public.task_assign(uuid, integer);

create or replace function public.task_assign(
  p_task_id          uuid,
  p_expected_version integer,
  p_assignee_id      uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tasks%rowtype;
  v_new public.tasks%rowtype;
begin
  -- 1. Existencia + membership de QUEM EXECUTA.
  select * into v_old from public.tasks where id = p_task_id;
  if not found or not public.is_clinic_member(v_old.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- 2. Versao, ANTES de qualquer regra de dominio. Quem opera sobre estado
  --    obsoleto precisa saber disso antes de ser ensinado sobre o estado atual.
  if v_old.version <> p_expected_version then
    return public.task_conflict(p_task_id);
  end if;

  -- 3. Estado de dominio: terminal congelada.
  if v_old.status <> 'open' then
    return public.task_invalid_state(v_old, 'terminal');
  end if;

  /*
   * Atribuir e SO para pendencia sem dono.
   *
   * Atribuir uma pendencia que ja tem responsavel nao vira transferencia
   * implicita: seriam duas decisoes diferentes com a mesma aparencia, e a
   * segunda tiraria o trabalho de alguem sem que essa pessoa aparecesse em
   * lugar nenhum. Quem quer tirar de outro usa `task_transfer`, que registra
   * `from` e `to`.
   */
  if v_old.assigned_to is not null then
    return public.task_invalid_state(v_old, 'already_assigned');
  end if;

  /*
   * 5. Validade do destinatario — no BANCO, e nao so na API.
   *
   * A FK composta (clinic_id, assigned_to) ja tornaria impossivel apontar para
   * fora da clinica, mas falharia com erro de integridade. Aqui a recusa e a
   * resposta normal do contrato.
   *
   * `not_found` e o mesmo outcome de pendencia inexistente, de proposito: dizer
   * "esse usuario existe, mas nao e daqui" revelaria a existencia de uma conta
   * em outra clinica a quem so tem um uuid na mao.
   */
  if not exists (
    select 1 from public.clinic_members m
     where m.clinic_id = v_old.clinic_id and m.user_id = p_assignee_id
  ) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  /*
   * 6. UPDATE atomico. A versao volta a aparecer na clausula, e nao e
   * redundante com a checagem do passo 2: ela fecha a janela entre a leitura e
   * a escrita, que e exatamente onde duas pessoas atribuiriam a mesma pendencia
   * a destinatarios diferentes.
   *
   * `assigned_to is null` e a segunda trava: mesmo que a versao coincidisse por
   * outro caminho, duas atribuicoes nunca recebem sucesso.
   */
  update public.tasks
     set assigned_to = p_assignee_id
   where id = p_task_id
     and version = p_expected_version
     and assigned_to is null
  returning * into v_new;

  if not found then
    return public.task_conflict(p_task_id);
  end if;

  /*
   * ATOR e DESTINATARIO sao pessoas diferentes, e o evento registra as duas.
   *
   * O ator sai de `auth.uid()`, carimbado pelo trigger `stamp_task_event_actor`
   * — o cliente nao escolhe quem agiu. O destinatario vai na metadata, com o
   * nome resolvido pelo servidor via `task_member_snapshot`; `displayName`
   * vindo do cliente permitiria escrever qualquer nome no historico.
   */
  insert into public.task_events (clinic_id, task_id, event_type, metadata)
  values (v_new.clinic_id, v_new.id, 'assigned',
          jsonb_build_object('to', public.task_member_snapshot(v_new.clinic_id, p_assignee_id)));

  return jsonb_build_object('outcome', 'ok', 'task', public.task_row_json(v_new));
end;
$$;

-- =============================================================================
-- `task_transfer`: mesma ORDEM de precedencia da nova `task_assign`
--
-- A versao anterior validava o destinatario ANTES de conferir se havia
-- responsavel atual. O efeito externo aparecia num caso so — transferir uma
-- pendencia sem dono para um destinatario invalido devolvia `not_found` em vez
-- de `not_assigned` —, e a mensagem util ali e a segunda: quem tenta isso
-- precisa saber que a operacao certa e atribuir, nao que o destino esta errado.
--
-- Assinatura INALTERADA: `create or replace` substitui de fato, e nenhum
-- overload nasce.
-- =============================================================================

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

  /*
   * Transferir exige responsavel atual.
   *
   * Transferir de ninguem para alguem NAO vira atribuir implicito: sao decisoes
   * diferentes — uma tira trabalho de uma pessoa, a outra tira da fila comum —
   * e confundi-las produziria historico que descreve o ato errado.
   */
  if v_old.assigned_to is null then
    return public.task_invalid_state(v_old, 'not_assigned');
  end if;

  if not exists (
    select 1 from public.clinic_members m
     where m.clinic_id = v_old.clinic_id and m.user_id = p_to_user_id
  ) then
    return jsonb_build_object('outcome', 'not_found');
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

-- =============================================================================
-- EXECUTE
--
-- O default do PostgreSQL concede EXECUTE a PUBLIC em toda funcao nova.
-- Depender dele e o erro que deixa uma funcao de escrita aberta a `anon` sem
-- que ninguem tenha decidido isso.
-- =============================================================================

revoke execute on function public.task_assign(uuid, integer, uuid) from public, anon;
grant  execute on function public.task_assign(uuid, integer, uuid) to authenticated;

revoke execute on function public.task_transfer(uuid, integer, uuid) from public, anon;
grant  execute on function public.task_transfer(uuid, integer, uuid) to authenticated;

comment on function public.task_assign(uuid, integer, uuid) is
  'Atribui uma pendencia da fila geral a um membro EXPLICITO da clinica. '
  'auth.uid() e quem executa; p_assignee_id e quem recebe.';
