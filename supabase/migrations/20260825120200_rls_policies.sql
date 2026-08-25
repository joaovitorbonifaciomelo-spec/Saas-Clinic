-- =============================================================================
-- 0003 - Row Level Security
--
-- Regra mental para ler este arquivo: com RLS habilitado, AUSENCIA DE POLICY E
-- NEGACAO TOTAL. Duas ausencias aqui sao deliberadas e centrais ao desenho:
--   * clinics sem INSERT  -> clinica so nasce pela RPC create_clinic_with_owner
--   * clinic_members somente leitura -> ninguem se auto-adiciona nem se promove
-- =============================================================================

alter table public.profiles       enable row level security;
alter table public.clinics        enable row level security;
alter table public.clinic_members enable row level security;
alter table public.patients       enable row level security;

-- O papel anonimo nao tem nada a fazer nestas tabelas. RLS ja negaria, mas
-- remover o privilegio e uma segunda barreira independente.
revoke all on public.profiles       from anon;
revoke all on public.clinics        from anon;
revoke all on public.clinic_members from anon;
revoke all on public.patients       from anon;

-- -----------------------------------------------------------------------------
-- profiles: cada um enxerga e edita apenas o proprio perfil.
-- Sem policy de INSERT: quem cria e o trigger handle_new_user (SECURITY DEFINER).
-- Sem policy de DELETE: o perfil segue o ciclo de vida de auth.users.
-- -----------------------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- clinics
-- -----------------------------------------------------------------------------
drop policy if exists clinics_select_member on public.clinics;
create policy clinics_select_member
  on public.clinics for select
  to authenticated
  using (public.is_clinic_member(id));

drop policy if exists clinics_update_admin on public.clinics;
create policy clinics_update_admin
  on public.clinics for update
  to authenticated
  using (public.has_clinic_role(id, array['admin']::public.clinic_role[]))
  with check (public.has_clinic_role(id, array['admin']::public.clinic_role[]));

-- INSERT: nenhuma policy. Ver 0004 (create_clinic_with_owner).
-- DELETE: nenhuma policy. Excluir clinica nao esta no escopo da v0.1.

-- -----------------------------------------------------------------------------
-- clinic_members - SOMENTE LEITURA na v0.1
--
-- Convite e gestao de equipe estao fora do escopo. Sem policies de escrita,
-- nenhum cliente autenticado consegue se adicionar a uma clinica, se promover a
-- admin ou remover outro membro — nem com token valido e requisicao manual.
-- O unico caminho de escrita e a RPC create_clinic_with_owner, que passa por ser
-- SECURITY DEFINER. Quando convites entrarem no escopo, as policies voltam junto.
-- -----------------------------------------------------------------------------
drop policy if exists clinic_members_select_same_clinic on public.clinic_members;
create policy clinic_members_select_same_clinic
  on public.clinic_members for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

-- -----------------------------------------------------------------------------
-- patients: o teste real do isolamento.
-- USING filtra o que ja existe; WITH CHECK valida o resultado da escrita.
-- Os dois sao necessarios: so USING deixaria mover uma linha para outro tenant.
-- -----------------------------------------------------------------------------
drop policy if exists patients_select_member on public.patients;
create policy patients_select_member
  on public.patients for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

drop policy if exists patients_insert_member on public.patients;
create policy patients_insert_member
  on public.patients for insert
  to authenticated
  with check (public.is_clinic_member(clinic_id));

drop policy if exists patients_update_member on public.patients;
create policy patients_update_member
  on public.patients for update
  to authenticated
  using (public.is_clinic_member(clinic_id))
  with check (public.is_clinic_member(clinic_id));

drop policy if exists patients_delete_admin on public.patients;
create policy patients_delete_admin
  on public.patients for delete
  to authenticated
  using (public.has_clinic_role(clinic_id, array['admin']::public.clinic_role[]));
