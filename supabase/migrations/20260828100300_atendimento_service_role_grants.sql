-- =============================================================================
-- 0015 - service_role nas tabelas do Atendimento
--
-- POR QUE ESTA MIGRATION EXISTE SEPARADA: a 0014 fechou a superficie de escrita
-- de `authenticated` e, ao fazer isso, nao concedeu nada a `service_role`. As
-- tres tabelas nasceram sem privilegio para ele.
--
-- A causa e a mesma que a 0006 ja documentou: `supabase db push` conecta com um
-- login role dedicado de migration, que NAO carrega os ALTER DEFAULT PRIVILEGES
-- do papel `postgres`. Tabela criada por esse caminho nasce sem grant para
-- ninguem — inclusive para o service_role. Quem cria a tabela pelo SQL Editor do
-- painel nunca ve esse sintoma, e por isso ele reaparece a cada modulo novo.
--
-- Foi o `pnpm verify:privileges` contra o Dev, logo apos o push, que apontou.
--
-- ISTO NAO AFROUXA NADA. `service_role` bypassa RLS por design e existe apenas
-- no .env.test — nunca no codigo da API, nunca no frontend, nunca na VPS. Sem
-- estes grants o que quebra e o uso administrativo: o teardown dos testes de
-- isolamento nao consegue limpar, e a bateria contra o banco real nao roda.
--
-- A regra da 0014 continua valendo integralmente: `authenticated` LE e NAO
-- ESCREVE. Nada aqui toca em authenticated, anon ou PUBLIC.
--
-- TRUNCATE segue fora de authenticated (RLS nao cobre TRUNCATE). `grant all`
-- para service_role e o mesmo tratamento que as outras 8 tabelas ja recebem.
-- =============================================================================

grant all on public.conversations       to service_role;
grant all on public.messages            to service_role;
grant all on public.conversation_events to service_role;
