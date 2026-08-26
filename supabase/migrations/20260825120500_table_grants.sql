-- =============================================================================
-- 0006 - Privilegios de tabela (GRANT)
--
-- POR QUE ESTA MIGRATION EXISTE
--
-- RLS e GRANT sao DUAS CAMADAS INDEPENDENTES:
--   * GRANT decide se o papel pode tocar na TABELA;
--   * RLS decide quais LINHAS ele enxerga depois de passar pelo GRANT.
-- Sem GRANT, o Postgres recusa em "permission denied for table" antes mesmo de
-- consultar qualquer policy. Policy perfeita em tabela sem privilegio nao serve
-- para nada.
--
-- Quando se cria a tabela pelo SQL Editor do painel, a conexao e do papel
-- `postgres`, cujo ALTER DEFAULT PRIVILEGES ja concede acesso a anon,
-- authenticated e service_role automaticamente. O `supabase db push` conecta com
-- um login role dedicado de migration, que NAO carrega esses default privileges.
-- Resultado: as tabelas nasceram sem nenhum grant, e ate o service_role levou
-- "permission denied".
--
-- Sintoma que confirmou o diagnostico: create_clinic_with_owner FUNCIONOU (e
-- SECURITY DEFINER, roda como o dono da funcao e ignora o grant do chamador),
-- enquanto o INSERT direto em patients falhou.
--
-- OS GRANTS ABAIXO ESPELHAM EXATAMENTE A MATRIZ DE POLICIES DA 0003.
-- Isso deixa as duas camadas coerentes e adiciona defesa em profundidade: mesmo
-- que uma policy de escrita seja adicionada por engano no futuro, o privilegio
-- de tabela correspondente nao existe.
-- =============================================================================

grant usage on schema public to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- profiles: SELECT e UPDATE do proprio registro (o RLS restringe a linha).
-- Sem INSERT: quem cria e o trigger clinic_saas_handle_new_user (SECURITY DEFINER).
-- Sem DELETE: o perfil segue o ciclo de vida de auth.users.
-- -----------------------------------------------------------------------------
grant select, update on public.profiles to authenticated;

-- -----------------------------------------------------------------------------
-- clinics: SELECT e UPDATE (o RLS restringe a membro / admin).
-- Sem INSERT: clinica so nasce pela RPC create_clinic_with_owner.
-- Sem DELETE: excluir clinica nao esta no escopo da v0.1.
-- -----------------------------------------------------------------------------
grant select, update on public.clinics to authenticated;

-- -----------------------------------------------------------------------------
-- clinic_members: SOMENTE SELECT.
-- Agora o desenho somente-leitura vale nas duas camadas: nao ha policy de escrita
-- E nao ha privilegio de escrita. Ninguem se auto-adiciona nem se promove.
-- -----------------------------------------------------------------------------
grant select on public.clinic_members to authenticated;

-- -----------------------------------------------------------------------------
-- patients: CRUD completo no nivel de tabela; o RLS confina tudo a clinica ativa.
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on public.patients to authenticated;

-- -----------------------------------------------------------------------------
-- service_role: acesso administrativo. Bypassa o RLS por design — e por isso que
-- ela nunca aparece em apps/web nem em apps/api, so no contexto de testes.
-- -----------------------------------------------------------------------------
grant all on public.profiles       to service_role;
grant all on public.clinics        to service_role;
grant all on public.clinic_members to service_role;
grant all on public.patients       to service_role;

-- -----------------------------------------------------------------------------
-- anon permanece sem absolutamente nada. Reafirmado aqui para que este arquivo
-- descreva sozinho o estado final de privilegios, sem depender da leitura da 0003.
-- -----------------------------------------------------------------------------
revoke all on public.profiles       from anon;
revoke all on public.clinics        from anon;
revoke all on public.clinic_members from anon;
revoke all on public.patients       from anon;
