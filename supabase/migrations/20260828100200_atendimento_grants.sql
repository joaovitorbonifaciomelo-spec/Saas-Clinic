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
-- PUBLIC entra no revoke porque e herdado por todo papel: um grant ali alcanca
-- anon e authenticated mesmo com os dois aparentemente limpos.
--
-- TRUNCATE nao entra em nenhuma linha abaixo. RLS cobre SELECT/INSERT/UPDATE/
-- DELETE e NAO cobre TRUNCATE — um usuario com esse privilegio apagaria os dados
-- de todos os tenants sem violar policy nenhuma.
--
-- REFERENCES tambem nao: as FKs compostas sao criadas pelo dono na 0012, entao
-- `authenticated` nao precisa desse privilegio.
--
-- DELETE nao entra em nenhuma das tres. Conversa resolve, nao apaga; mensagem e
-- fato consumado; o log e imutavel.
-- =============================================================================

revoke all on public.conversations       from public, anon, authenticated;
revoke all on public.messages            from public, anon, authenticated;
revoke all on public.conversation_events from public, anon, authenticated;

-- conversations: UPDATE e necessario para status, responsavel e vinculo.
grant select, insert, update on public.conversations to authenticated;

-- messages: sem UPDATE. delivery_status ganha policy propria quando houver
-- provedor; ate la, nada muda depois de gravado.
grant select, insert on public.messages to authenticated;

-- conversation_events: append-only, no privilegio e na policy.
grant select, insert on public.conversation_events to authenticated;
