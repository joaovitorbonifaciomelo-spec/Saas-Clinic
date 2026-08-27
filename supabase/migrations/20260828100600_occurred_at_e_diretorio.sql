-- =============================================================================
-- 0018 - occurred_at no futuro barrado pelo BANCO + diretorio da equipe
--
-- Duas pendencias arquiteturais, ambas com a mesma causa de fundo: uma regra
-- que so existia na API nao e uma regra do sistema. `authenticated` tem EXECUTE
-- nas funcoes de controle e pode chama-las direto, sem passar por HTTP.
-- =============================================================================


-- =============================================================================
-- PARTE 1 - occurred_at nao pode estar no futuro
--
-- COMPORTAMENTO ANTERIOR, verificado contra o Dev: chamando
-- `conversation_add_manual_message` direto com p_occurred_at = '2999-01-01', a
-- mensagem era aceita, `last_message_at` ia para 2999 e a conversa ficava no
-- topo da fila. Como o trigger de atividade usa `greatest()`, que nunca reduz,
-- NENHUMA mensagem real posterior corrigia o valor.
--
-- POR QUE NAO UM CHECK: um CHECK que chama `now()` nao e imutavel. O PostgreSQL
-- aceita criar, mas a constraint passa a valer sobre um valor que muda — uma
-- linha valida hoje seria invalida numa revalidacao amanha, e `ALTER TABLE ...
-- VALIDATE CONSTRAINT` ou um pg_dump/restore poderiam falhar sobre dados que
-- sempre estiveram corretos. Regra que depende do relogio pertence ao momento
-- da escrita, e o lugar disso e o trigger.
--
-- ONDE A REGRA VIVE: no trigger BEFORE INSERT, que roda em TODO caminho de
-- insercao — a RPC de hoje, o adaptador de provedor de amanha, o script
-- administrativo. A validacao na RPC e na API existe para dar erro amigavel,
-- nao para ser a barreira.
-- =============================================================================

/**
 * Tolerancia unica, para os tres lugares que precisam da regra nao divergirem.
 *
 * Os 5 minutos existem para o relogio do CLIENTE estar adiantado, nao para
 * conceder margem de manobra: um registro manual descreve algo que ja
 * aconteceu.
 */
create or replace function public.message_occurred_at_ok(p_occurred_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_occurred_at is null
      or p_occurred_at <= now() + interval '5 minutes';
$$;

comment on function public.message_occurred_at_ok(timestamptz) is
  'Verdadeiro quando o instante nao esta no futuro alem da tolerancia de relogio.';


/**
 * Recusa antes de gravar qualquer coisa.
 *
 * Roda como BEFORE INSERT, entao o INSERT nao acontece, o trigger AFTER de
 * atividade nao roda, `last_message_at` nao se move, nenhum evento nasce e a
 * versao da conversa fica onde estava. A transacao inteira e desfeita.
 *
 * O nome comeca com "a_" para ordenar ANTES de `messages_stamp_defaults`:
 * triggers BEFORE disparam em ordem alfabetica, e nao ha motivo para carimbar
 * autoria de uma linha que vai ser recusada.
 */
create or replace function public.reject_future_occurred_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.message_occurred_at_ok(new.occurred_at) then
    /*
     * Prefixo reconhecivel e errcode que a API ja traduz para 400.
     * 22023 = invalid_parameter_value; `mapPostgrestError` o mapeia para
     * BadRequest, entao mesmo quem chegar por um caminho novo recebe uma
     * resposta tratada em vez de 500 generico.
     */
    raise exception 'MESSAGE_OCCURRED_AT_IN_FUTURE: occurred_at nao pode estar no futuro.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists a_messages_reject_future_occurred_at on public.messages;
create trigger a_messages_reject_future_occurred_at
  before insert on public.messages
  for each row
  execute function public.reject_future_occurred_at();


/**
 * A RPC passa a recusar ANTES de inserir, devolvendo outcome no mesmo formato
 * dos demais (`not_manual`, `invalid_body`).
 *
 * O trigger continua sendo a autoridade. Esta verificacao existe para que o
 * caminho normal produza uma resposta estruturada em vez de uma excecao — a
 * API mapeia outcome para 400 sem precisar interpretar texto de erro do
 * Postgres.
 */
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

  -- Inexistente e de outro tenant saem iguais, de proposito.
  if not found or not public.is_clinic_member(v_conv.clinic_id) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_conv.channel <> 'manual' then
    return jsonb_build_object('outcome', 'not_manual');
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    return jsonb_build_object('outcome', 'invalid_body');
  end if;

  if not public.message_occurred_at_ok(p_occurred_at) then
    return jsonb_build_object('outcome', 'invalid_occurred_at');
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


-- =============================================================================
-- PARTE 2 - diretorio da equipe da clinica
--
-- POR QUE EXISTE: ate aqui, o nome do responsavel por uma conversa era inferido
-- do snapshot mais recente em `conversation_events`. Funcionava, mas eventos
-- sao registro historico do que ACONTECEU, nao read model do estado ATUAL —
-- quem nunca agiu na clinica nao tinha nome, e um nome trocado so aparecia
-- depois da proxima acao da pessoa.
--
-- POR QUE NAO AFROUXAR `profiles`: a policy `profiles_select_own` e
-- `id = auth.uid()`, e ela protege mais do que o nome. Abri-la para colegas
-- exporia a linha inteira do perfil a todo membro de qualquer clinica
-- compartilhada, para sempre, em troca de um campo. Uma funcao SECURITY DEFINER
-- devolve exatamente as tres colunas necessarias e nada mais.
-- =============================================================================

/**
 * Equipe da clinica, para leitura e UX. NAO e autorizacao.
 *
 * Quem pode receber uma transferencia continua sendo decidido pela FK composta
 * (clinic_id, assigned_to) -> clinic_members, dentro de
 * `conversation_transfer`. Este diretorio serve para a tela mostrar nomes e
 * montar um seletor; se ele ficasse desatualizado, o pior caso e uma opcao que
 * o banco recusa — nunca uma transferencia indevida aceita.
 *
 * SEGURANCA
 *
 * `p_clinic_id` e dado do cliente e NAO e tratado como prova. A condicao
 * `is_clinic_member(p_clinic_id)` usa `auth.uid()` e decide tudo: quem nao e
 * membro recebe CONJUNTO VAZIO, exatamente como receberia para uma clinica
 * inexistente. Nao ha excecao, nao ha mensagem diferente, e portanto nao ha
 * como distinguir "nao e sua" de "nao existe".
 *
 * Sendo `security definer`, ela le `profiles` por dentro — mas so depois que a
 * condicao de membership ja limitou as linhas.
 *
 * O QUE NAO SAI DAQUI: e-mail, metadados de auth, `created_at`, id de outras
 * clinicas. Sao tres colunas porque a operacao precisa de tres: identificar
 * (user_id), exibir (display_name) e diferenciar papeis na UI (role).
 *
 * LEFT JOIN, e nao JOIN: um membro sem linha em `profiles` continua aparecendo,
 * com `display_name` nulo. Some-lo do diretorio seria pior que exibi-lo sem
 * nome — ele sumiria tambem do seletor de transferencia, e uma conversa
 * atribuida a ele apareceria sem responsavel.
 *
 * QUANDO `display_name` E NULO NA PRATICA: `profiles.full_name` e NOT NULL, e o
 * trigger `handle_new_user` cria o perfil junto do usuario. Ou seja, o caso
 * normal SEMPRE tem nome. O nulo cobre a linha de perfil ausente — perfil
 * apagado a mao, ou membership criada por um caminho administrativo antes do
 * perfil existir. E raro de proposito; o ponto e nao perder o membro quando
 * acontecer. O cliente deve tratar nulo como "nome indisponivel", nunca como
 * "sem responsavel" — para isso existe `assigned_to`.
 */
create or replace function public.clinic_member_directory(p_clinic_id uuid)
returns table (
  user_id      uuid,
  display_name text,
  role         public.clinic_role
)
language sql
security definer
stable
set search_path = ''
as $$
  select m.user_id, p.full_name, m.role
    from public.clinic_members m
    left join public.profiles p on p.id = m.user_id
   where m.clinic_id = p_clinic_id
     and public.is_clinic_member(p_clinic_id)
   order by p.full_name nulls last, m.user_id;
$$;

comment on function public.clinic_member_directory(uuid) is
  'Equipe da clinica para leitura/UX. Conjunto vazio para quem nao e membro.';

-- O default do PostgreSQL concede EXECUTE a PUBLIC em toda funcao nova; por
-- isso o revoke e explicito, e nao herdado.
revoke execute on function public.message_occurred_at_ok(timestamptz)
  from public, anon, authenticated;
revoke execute on function public.reject_future_occurred_at()
  from public, anon, authenticated;

revoke execute on function public.clinic_member_directory(uuid) from public, anon;
grant  execute on function public.clinic_member_directory(uuid) to authenticated;
