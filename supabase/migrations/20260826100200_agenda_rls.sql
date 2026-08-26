-- =============================================================================
-- 0010 - RLS das tabelas da Agenda
--
-- Mesma forma da fundacao: ausencia de policy e negacao total, e os helpers
-- is_clinic_member / has_clinic_role sao SECURITY DEFINER para nao reentrar nas
-- proprias policies.
--
-- Ausencias deliberadas nesta migration:
--   * professionals e services sem DELETE -> desativa via `active`; apagar
--     quebraria historico de agendamento (as FKs sao ON DELETE RESTRICT).
--   * appointments sem DELETE -> cancela via status; consulta cancelada precisa
--     continuar existindo e auditavel.
-- =============================================================================

alter table public.professionals              enable row level security;
alter table public.services                   enable row level security;
alter table public.professional_availability  enable row level security;
alter table public.appointments               enable row level security;

revoke all on public.professionals             from anon;
revoke all on public.services                  from anon;
revoke all on public.professional_availability from anon;
revoke all on public.appointments              from anon;

-- -----------------------------------------------------------------------------
-- professionals
-- -----------------------------------------------------------------------------
drop policy if exists professionals_select_member on public.professionals;
create policy professionals_select_member
  on public.professionals for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

drop policy if exists professionals_insert_member on public.professionals;
create policy professionals_insert_member
  on public.professionals for insert
  to authenticated
  with check (public.is_clinic_member(clinic_id));

drop policy if exists professionals_update_member on public.professionals;
create policy professionals_update_member
  on public.professionals for update
  to authenticated
  using (public.is_clinic_member(clinic_id))
  with check (public.is_clinic_member(clinic_id));

-- -----------------------------------------------------------------------------
-- services
-- -----------------------------------------------------------------------------
drop policy if exists services_select_member on public.services;
create policy services_select_member
  on public.services for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

drop policy if exists services_insert_member on public.services;
create policy services_insert_member
  on public.services for insert
  to authenticated
  with check (public.is_clinic_member(clinic_id));

drop policy if exists services_update_member on public.services;
create policy services_update_member
  on public.services for update
  to authenticated
  using (public.is_clinic_member(clinic_id))
  with check (public.is_clinic_member(clinic_id));

-- -----------------------------------------------------------------------------
-- professional_availability
-- Configuracao operacional: pode ser removida. DELETE fica com admin.
-- -----------------------------------------------------------------------------
drop policy if exists availability_select_member on public.professional_availability;
create policy availability_select_member
  on public.professional_availability for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

drop policy if exists availability_insert_member on public.professional_availability;
create policy availability_insert_member
  on public.professional_availability for insert
  to authenticated
  with check (public.is_clinic_member(clinic_id));

drop policy if exists availability_update_member on public.professional_availability;
create policy availability_update_member
  on public.professional_availability for update
  to authenticated
  using (public.is_clinic_member(clinic_id))
  with check (public.is_clinic_member(clinic_id));

drop policy if exists availability_delete_admin on public.professional_availability;
create policy availability_delete_admin
  on public.professional_availability for delete
  to authenticated
  using (public.has_clinic_role(clinic_id, array['admin']::public.clinic_role[]));

-- -----------------------------------------------------------------------------
-- appointments
-- USING filtra o que ja existe; WITH CHECK valida o resultado da escrita.
-- Os dois sao necessarios: so USING deixaria mover a linha para outro tenant.
-- -----------------------------------------------------------------------------
drop policy if exists appointments_select_member on public.appointments;
create policy appointments_select_member
  on public.appointments for select
  to authenticated
  using (public.is_clinic_member(clinic_id));

drop policy if exists appointments_insert_member on public.appointments;
create policy appointments_insert_member
  on public.appointments for insert
  to authenticated
  with check (public.is_clinic_member(clinic_id));

drop policy if exists appointments_update_member on public.appointments;
create policy appointments_update_member
  on public.appointments for update
  to authenticated
  using (public.is_clinic_member(clinic_id))
  with check (public.is_clinic_member(clinic_id));
