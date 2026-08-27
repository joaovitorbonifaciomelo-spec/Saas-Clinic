-- =============================================================================
-- 0017 - service_role no minimo explicito nas 8 tabelas da fundacao e da agenda
--
-- Uniformiza o que a 0016 ja fez nas tres do Atendimento. As migrations 0006 e
-- 0013 usaram `grant all` para service_role, e `all` em tabela nao e um conjunto
-- abstrato: expande para os sete privilegios que a tabela suporta. Consultado o
-- Dev, service_role tinha TRUNCATE, REFERENCES e TRIGGER nas oito.
--
-- ADITIVA: as 0006 e 0013 ja estao aplicadas no remoto e nao sao editadas.
-- Historico local e banco continuam dizendo a mesma coisa.
--
-- -----------------------------------------------------------------------------
-- POR QUE NENHUM DOS TRES E NECESSARIO
--
-- Levantado no repositorio inteiro antes de revogar, e nao por suposicao:
--
--   1. Nenhum `truncate` e executado em lugar nenhum. Todas as ocorrencias da
--      palavra sao comentario, revoke ou checagem de que o privilegio NAO
--      existe. O teardown dos testes apaga `clinics` com DELETE e deixa a
--      cascata levar o resto.
--   2. Todo DDL de trigger e de constraint vive em migration ou no arquivo de
--      rollback, executados pelo migration role / postgres via SUPABASE_DB_URL.
--      Nunca por service_role.
--   3. Nenhum teste ou script afirma que service_role possui algum dos tres.
--
-- E ha uma razao estrutural acima dessas tres: service_role so e usado atraves
-- de `createClient(url, serviceRoleKey)`, ou seja, PostgREST. PostgREST expoe
-- DML e RPC — nao existe caminho por onde ele emita TRUNCATE, CREATE TRIGGER ou
-- ALTER TABLE. Os privilegios estavam concedidos e inalcancaveis ao mesmo tempo.
--
-- Isso e argumento para remove-los, nao para relaxar: um privilegio que ninguem
-- usa e exatamente o que passa despercebido quando o caminho de acesso muda.
-- No dia em que algo abrir uma conexao SQL direta com essa chave, os tres
-- estariam la esperando.
--
-- -----------------------------------------------------------------------------
-- SERVICE_ROLE BYPASSA RLS — E ISSO NAO MUDA O CALCULO
--
-- Bypassar RLS significa enxergar todas as linhas de todos os tenants. Nao
-- significa poder apagar tudo sem rastro: DELETE dispara trigger e respeita FK;
-- TRUNCATE nao faz nem uma coisa nem outra. Sao poderes de natureza diferente, e
-- ter o primeiro nunca foi motivo para conceder o segundo.
--
-- -----------------------------------------------------------------------------
-- REVOKE por privilegio NOMEADO, nao `revoke all`: `revoke all` derrubaria junto
-- os quatro que ficam, e o resultado passaria a depender da ordem das linhas.
-- =============================================================================

revoke truncate, references, trigger on public.profiles                  from service_role;
revoke truncate, references, trigger on public.clinics                   from service_role;
revoke truncate, references, trigger on public.clinic_members            from service_role;
revoke truncate, references, trigger on public.patients                  from service_role;
revoke truncate, references, trigger on public.professionals             from service_role;
revoke truncate, references, trigger on public.services                  from service_role;
revoke truncate, references, trigger on public.professional_availability from service_role;
revoke truncate, references, trigger on public.appointments              from service_role;

-- Reafirmados explicitamente, para que este arquivo responda sozinho "o que
-- service_role pode fazer nestas tabelas?" sem precisar cruzar com a 0006/0013.
grant select, insert, update, delete on public.profiles                  to service_role;
grant select, insert, update, delete on public.clinics                   to service_role;
grant select, insert, update, delete on public.clinic_members            to service_role;
grant select, insert, update, delete on public.patients                  to service_role;
grant select, insert, update, delete on public.professionals             to service_role;
grant select, insert, update, delete on public.services                  to service_role;
grant select, insert, update, delete on public.professional_availability to service_role;
grant select, insert, update, delete on public.appointments              to service_role;
