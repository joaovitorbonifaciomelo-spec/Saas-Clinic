-- =============================================================================
-- 0014 - Privilegios de tabela do Atendimento
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
-- TRUNCATE nao entra em nenhuma linha abaixo: RLS nao o cobre, e quem o tiver
-- apaga os dados de todos os tenants sem violar policy nenhuma. REFERENCES
-- tambem nao: as FKs compostas sao criadas pelo dono na 0012. DELETE nao entra
-- em lugar nenhum.
-- =============================================================================

revoke all on public.conversations       from public, anon, authenticated;
revoke all on public.messages            from public, anon, authenticated;
revoke all on public.conversation_events from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- conversations: SELECT e INSERT. **SEM UPDATE.**
--
-- Este e o ponto que muda em relacao a primeira versao desta migration.
--
-- Com UPDATE concedido, o filtro `and version = :n` seria protocolo da
-- aplicacao: nada obrigaria um cliente autenticado a usa-lo, e a concorrencia
-- otimista viraria convencao voluntaria — exatamente o que uma corrida entre
-- dois atendentes explora. Bastaria um `.update({ assigned_to })` sem o filtro
-- para dois atendentes acreditarem que assumiram a mesma conversa.
--
-- Sem UPDATE, a unica porta para mudar estado sao as funcoes de controle da
-- 0012, e nelas a versao esperada e PARAMETRO OBRIGATORIO. A garantia deixa de
-- depender de disciplina de quem escreve o cliente.
--
-- INSERT continua direto: criar conversa nao tem versao anterior para
-- conflitar, o RLS protege o tenant, as FKs compostas protegem as referencias e
-- o evento `conversation_created` e emitido por trigger.
-- -----------------------------------------------------------------------------
grant select, insert on public.conversations to authenticated;

-- -----------------------------------------------------------------------------
-- messages: SELECT e INSERT.
--
-- Mensagem e acrescimo, nao substitui estado — nao ha o que versionar. Canal e
-- autoria sao carimbados por trigger, entao o cliente nao escolhe nenhum dos
-- dois. Sem UPDATE: `delivery_status` ganha policy propria quando houver
-- provedor, e ate la nada muda depois de gravado.
-- -----------------------------------------------------------------------------
grant select, insert on public.messages to authenticated;

-- -----------------------------------------------------------------------------
-- conversation_events: SELECT SOMENTE.
--
-- Segundo ponto que muda. Antes `authenticated` tinha INSERT, e o trigger de
-- carimbo garantia apenas que o AUTOR era verdadeiro — nada impedia um membro
-- de fabricar um `transferred` ou um `status_changed` que nunca aconteceu. Um
-- log em que se pode escrever a mao nao e log de auditoria; e um mural.
--
-- Agora o log so e escrito por caminhos controlados, todos SECURITY DEFINER na
-- 0012 e portanto rodando como dono da tabela:
--
--   conversation_created  -> trigger em conversations
--   status_changed        -> conversation_set_status, e a reabertura automatica
--   assigned/transferred/
--   released              -> conversation_assign / _transfer / _release
--   patient_linked/
--   patient_unlinked      -> conversation_link_patient / _unlink_patient
--   appointment_created   -> conversation_log_appointment
--
-- Em nenhum deles o cliente escolhe event_type ou metadata: os dois sao
-- construidos dentro da funcao, a partir do que realmente mudou.
-- -----------------------------------------------------------------------------
grant select on public.conversation_events to authenticated;
