-- =============================================================================
-- 0020 - vincular paciente nao substitui um vinculo existente
--
-- ADITIVA. As migrations anteriores ja estao aplicadas e nao sao editadas.
--
-- O QUE MUDA: `conversation_link_patient` substituia o paciente atual em
-- silencio quando a versao batia. Uma conversa ligada ao paciente A recebia um
-- link para B e passava a apontar para B, sem nenhuma acao de desvincular. O
-- historico ficava com dois `patient_linked` de ids diferentes — reconstruivel,
-- mas so para quem soubesse que o segundo significa "trocou".
--
-- POR QUE ISSO E PROBLEMA DE VERDADE: o vinculo diz de QUEM e o atendimento.
-- Trocar por engano move a conversa inteira para o prontuario de outra pessoa,
-- e o log nao registra que alguem desfez o vinculo anterior — porque ninguem
-- desfez. A auditoria fica tecnicamente completa e praticamente enganosa.
--
-- Trocar passa a exigir DUAS acoes explicitas: desvincular e vincular. Cada uma
-- gera o proprio evento, e o historico passa a dizer o que de fato aconteceu.
--
-- NAO criamos `patient_changed` nem unlink implicito: seriam duas operacoes
-- escondidas dentro de uma, que e exatamente o que estamos removendo.
-- =============================================================================

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

  /*
   * VERSAO STALE TEM PRECEDENCIA sobre a regra de vinculo, e a ordem aqui e
   * deliberada.
   *
   * Cenario: A e B leem a versao 5, com paciente X vinculado. A desvincula e a
   * conversa vai para a versao 6, sem paciente. B tenta vincular Y com a versao
   * 5. Se a regra de vinculo viesse primeiro, B receberia "ja vinculado" — uma
   * resposta sobre um estado que nao existe mais. Verificando a versao antes, B
   * recebe conflito com o estado atual e decide de novo, informado.
   */
  if v_old.version <> p_expected_version then
    return public.conversation_conflict(p_conversation_id);
  end if;

  /*
   * CASO B - mesmo paciente. Nao ha o que fazer, e nada e gravado: sem UPDATE,
   * portanto sem incremento de versao e sem evento. Repetir a mesma operacao
   * nao e erro, e tambem nao e um fato novo para a auditoria.
   *
   * `is not distinct from` cobre o caso dos dois nulos sem tratamento especial.
   */
  if v_old.patient_id is not distinct from p_patient_id then
    return jsonb_build_object('outcome', 'ok',
                              'conversation', public.conversation_row_json(v_old));
  end if;

  /*
   * CASO C - ja existe OUTRO paciente. Recusa, sem tocar em nada.
   *
   * A conversa devolvida e a atual, que quem chamou ja podia ler — nao ha
   * informacao nova. E, principalmente, NAO dizemos nada sobre o paciente
   * solicitado: se ele existe, se e de outra clinica, se foi digitado errado.
   * Isso sairia como informacao sobre um cadastro que o chamador pode nao
   * poder enxergar.
   */
  if v_old.patient_id is not null then
    return jsonb_build_object('outcome', 'already_linked',
                              'conversation', public.conversation_row_json(v_old));
  end if;

  /*
   * CASO A - sem paciente. Vincula.
   *
   * O filtro por versao continua DENTRO do UPDATE, e nao apenas na checagem
   * acima: entre o `select` e o `update` outra transacao pode ter vencido a
   * corrida. Sem este filtro, a nova regra reabriria exatamente o
   * last-write-wins que o bloco anterior fechou.
   *
   * Paciente de outra clinica e recusado pela FK composta (23503), nao por
   * checagem aqui — a barreira estrutural nao depende desta funcao estar certa.
   */
  update public.conversations
     set patient_id = p_patient_id
   where id = p_conversation_id
     and version = p_expected_version
     and patient_id is null
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

comment on function public.conversation_link_patient(uuid, integer, uuid) is
  'Vincula paciente. NAO substitui vinculo existente: trocar exige desvincular antes.';
