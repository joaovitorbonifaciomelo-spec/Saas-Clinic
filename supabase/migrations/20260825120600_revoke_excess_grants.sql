-- =============================================================================
-- 0007 - Remove privilegios em excesso de `authenticated`
--
-- O QUE FOI ENCONTRADO
--
-- A introspeccao pos-0006 mostrou que `authenticated` tinha, nas quatro tabelas,
-- alem do planejado: TRUNCATE, TRIGGER e REFERENCES.
--
-- POR QUE ISSO E GRAVE: **TRUNCATE NAO E FILTRADO POR RLS.**
-- Policies de RLS cobrem SELECT/INSERT/UPDATE/DELETE. TRUNCATE nao passa por
-- policy nenhuma — basta ter o privilegio. Um usuario autenticado da Clinica A
-- poderia executar `truncate public.patients` e apagar os pacientes de TODAS as
-- clinicas, furando o isolamento inteiro apesar de todas as 9 policies estarem
-- corretas. TRIGGER permitiria anexar gatilhos a tabelas compartilhadas.
--
-- DE ONDE VEIO: a plataforma do Supabase reconcilia privilegios padrao em tabelas
-- do schema public, concedendo ALL a anon, authenticated e service_role. A 0006
-- so fazia GRANT — e **GRANT e aditivo**: conceder SELECT nao remove o TRUNCATE
-- que ja estava la. `anon` ficou limpo apenas porque a 0006 terminava com um
-- REVOKE ALL explicito para ele.
--
-- LICAO APLICADA AQUI: para IMPOR uma matriz de privilegios, e preciso
-- REVOKE ALL e so entao GRANT do que se quer. Este arquivo faz isso, e portanto
-- e idempotente e autoritativo: rodar de novo reconverge para o mesmo estado,
-- independente do que mais tenha concedido algo no meio do caminho.
--
-- NOTA OPERACIONAL: se uma migration futura criar tabelas em `public`, a
-- plataforma pode voltar a conceder ALL nelas. Toda migration que criar tabela
-- deve terminar reafirmando o bloco revoke-then-grant correspondente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Zera e reconstroi exatamente a matriz. A ordem importa: revoke primeiro.
--
-- PUBLIC entra no revoke junto de anon e authenticated. PUBLIC e o papel
-- implicito que TODO papel herda: um privilegio concedido a PUBLIC alcanca
-- anon e authenticated mesmo que os dois estejam explicitamente limpos, e nao
-- apareceria numa inspecao que olhasse so para os papeis nomeados. Revogar aqui
-- torna a matriz autoritativa de verdade, e nao apenas aparentemente.
-- -----------------------------------------------------------------------------
revoke all on public.profiles       from public, anon, authenticated;
revoke all on public.clinics        from public, anon, authenticated;
revoke all on public.clinic_members from public, anon, authenticated;
revoke all on public.patients       from public, anon, authenticated;

-- profiles: le e edita o proprio registro (o RLS restringe a linha).
grant select, update on public.profiles to authenticated;

-- clinics: le como membro, edita como admin (o RLS restringe).
grant select, update on public.clinics to authenticated;

-- clinic_members: SOMENTE leitura, nas duas camadas.
grant select on public.clinic_members to authenticated;

-- patients: CRUD; o RLS confina a clinica ativa.
-- Note que DELETE esta aqui mas TRUNCATE nao: DELETE passa por policy, TRUNCATE nao.
grant select, insert, update, delete on public.patients to authenticated;

-- `anon` permanece sem absolutamente nada — nao recebe nenhum grant acima.

-- service_role continua com acesso administrativo (bypassa RLS por design,
-- e por isso nunca aparece em apps/web nem em apps/api).
grant all on public.profiles       to service_role;
grant all on public.clinics        to service_role;
grant all on public.clinic_members to service_role;
grant all on public.patients       to service_role;

-- -----------------------------------------------------------------------------
-- Schema public: CREATE nao deve existir para PUBLIC, anon nem authenticated —
-- criar objetos ali seria escapar de todo o modelo de isolamento. USAGE e
-- necessario e permanece. Reafirmado aqui para que o estado seja garantido pela
-- migration, e nao apenas herdado do default do projeto.
-- -----------------------------------------------------------------------------
revoke create on schema public from public, anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
