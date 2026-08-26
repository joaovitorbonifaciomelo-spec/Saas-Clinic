-- =============================================================================
-- 0011 - Privilegios de tabela da Agenda
--
-- revoke-then-grant, como a 0007 estabeleceu.
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
-- REFERENCES tambem nao: as FKs compostas sao criadas pelo dono na 0009, entao
-- `authenticated` nao precisa desse privilegio. Nenhuma excecao ao gate.
-- =============================================================================

revoke all on public.professionals             from public, anon, authenticated;
revoke all on public.services                  from public, anon, authenticated;
revoke all on public.professional_availability from public, anon, authenticated;
revoke all on public.appointments              from public, anon, authenticated;

-- professionals: sem DELETE — desativa via `active`.
grant select, insert, update on public.professionals to authenticated;

-- services: sem DELETE — desativa via `active`.
grant select, insert, update on public.services to authenticated;

-- professional_availability: configuracao operacional, pode ser removida.
grant select, insert, update, delete on public.professional_availability to authenticated;

-- appointments: sem DELETE — cancela via status.
grant select, insert, update on public.appointments to authenticated;

-- `anon` nao recebe nada acima.

-- service_role: acesso administrativo (bypassa RLS por design; existe apenas no
-- contexto de testes, nunca em apps/web ou apps/api).
grant all on public.professionals             to service_role;
grant all on public.services                  to service_role;
grant all on public.professional_availability to service_role;
grant all on public.appointments              to service_role;
