-- =============================================================================
-- 0014 - Privilegios do Atendimento
--
-- revoke-then-grant, como a 0007 estabeleceu e a agenda repetiu.
--
-- POR QUE COMECAR REVOGANDO EM TABELAS RECEM-CRIADAS: a plataforma do Supabase
-- reconcilia default privileges concedendo ALL em tabelas do schema public, e
-- GRANT e aditivo — conceder SELECT nao remove um TRUNCATE que ja esteja la.
-- Foi assim que `authenticated` acabou com TRUNCATE nas tabelas da fundacao.
-- Comecar por REVOKE ALL torna esta migration autoritativa e idempotente.
--
-- PUBLIC entra no revoke porque e herdado por todo papel.
--
-- =============================================================================
-- A REGRA DESTE MODULO: `authenticated` LE. NAO ESCREVE.
--
-- Nenhuma das tres tabelas recebe INSERT, UPDATE ou DELETE. Toda escrita passa
-- por funcao controlada, e cada uma delas existe por um motivo que um GRANT nao
-- consegue expressar:
--
--   criar conversa   - o cliente escolheria status, assigned_to, version e os
--                      timestamps de atividade. Uma conversa poderia nascer
--                      resolvida, ja atribuida e com atividade no futuro.
--   criar mensagem   - o cliente escolheria clinic_id, canal, autoria e status
--                      de entrega. Uma mensagem manual poderia exibir "lida".
--   mudar estado     - o filtro por versao seria voluntario, e dois atendentes
--                      assumiriam a mesma conversa sem perceber.
--   gravar evento    - um membro fabricaria historico que nunca aconteceu.
--
-- TRUNCATE nao entra em nenhuma linha: RLS nao o cobre, e quem o tiver apaga os
-- dados de todos os tenants sem violar policy. REFERENCES tambem nao: as FKs
-- compostas sao criadas pelo dono na 0012.
-- =============================================================================

revoke all on public.conversations       from public, anon, authenticated;
revoke all on public.messages            from public, anon, authenticated;
revoke all on public.conversation_events from public, anon, authenticated;

grant select on public.conversations       to authenticated;
grant select on public.messages            to authenticated;
grant select on public.conversation_events to authenticated;

-- -----------------------------------------------------------------------------
-- Funcoes expostas
--
-- Declaradas aqui alem da 0012 para que ESTE arquivo seja a resposta completa a
-- "o que authenticated pode fazer no Atendimento?" — sem precisar cruzar dois
-- arquivos para ter certeza.
--
-- O default do PostgreSQL concede EXECUTE a PUBLIC em toda funcao nova; por
-- isso cada revoke abaixo e explicito, e nao herdado.
-- -----------------------------------------------------------------------------

-- Criacao
revoke execute on function public.conversation_create_manual(uuid, text, text, uuid)
  from public, anon;
grant  execute on function public.conversation_create_manual(uuid, text, text, uuid)
  to authenticated;

revoke execute on function
  public.conversation_add_manual_message(uuid, public.message_direction, text, timestamptz)
  from public, anon;
grant  execute on function
  public.conversation_add_manual_message(uuid, public.message_direction, text, timestamptz)
  to authenticated;

-- Controle: todas exigem a versao esperada.
revoke execute on function public.conversation_assign(uuid, integer)         from public, anon;
grant  execute on function public.conversation_assign(uuid, integer)         to authenticated;

revoke execute on function public.conversation_transfer(uuid, integer, uuid) from public, anon;
grant  execute on function public.conversation_transfer(uuid, integer, uuid) to authenticated;

revoke execute on function public.conversation_release(uuid, integer)        from public, anon;
grant  execute on function public.conversation_release(uuid, integer)        to authenticated;

revoke execute on function
  public.conversation_set_status(uuid, integer, public.conversation_status) from public, anon;
grant  execute on function
  public.conversation_set_status(uuid, integer, public.conversation_status) to authenticated;

revoke execute on function public.conversation_link_patient(uuid, integer, uuid)
  from public, anon;
grant  execute on function public.conversation_link_patient(uuid, integer, uuid)
  to authenticated;

revoke execute on function public.conversation_unlink_patient(uuid, integer) from public, anon;
grant  execute on function public.conversation_unlink_patient(uuid, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- NAO expostas
--
-- conversation_log_appointment: prova que o agendamento e desta clinica, mas
-- nao prova que ele NASCEU desta conversa. Exposta, qualquer membro afirmaria
-- proveniencia depois do fato — e log auditavel construido sobre afirmacao do
-- cliente nao audita nada. Volta quando a API criar o agendamento e registrar a
-- proveniencia no mesmo caminho.
--
-- conversation_row_json / message_row_json / conversation_conflict: auxiliares
-- internas das funcoes acima. Nao ha motivo para o cliente chama-las.
-- -----------------------------------------------------------------------------
revoke execute on function public.conversation_log_appointment(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.conversation_row_json(public.conversations)
  from public, anon, authenticated;
revoke execute on function public.message_row_json(public.messages)
  from public, anon, authenticated;
revoke execute on function public.conversation_conflict(uuid)
  from public, anon, authenticated;
