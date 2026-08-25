-- =============================================================================
-- 0005 - clinic_id imutavel em patients
--
-- O WITH CHECK da policy de UPDATE ja impede mover um paciente para uma clinica
-- da qual o usuario NAO participa. Este trigger cobre o caso restante: um
-- usuario que participa de DUAS clinicas passaria no WITH CHECK e conseguiria
-- migrar o paciente entre elas por acidente (ou de proposito) numa requisicao
-- manual. Aqui o vinculo com o tenant vira imutavel para qualquer chamador,
-- inclusive service_role.
-- =============================================================================

create or replace function public.prevent_clinic_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.clinic_id is distinct from old.clinic_id then
    raise exception 'CLINIC_ID_IMMUTABLE: nao e permitido mover um registro entre clinicas.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists patients_prevent_clinic_id_change on public.patients;
create trigger patients_prevent_clinic_id_change
  before update on public.patients
  for each row execute function public.prevent_clinic_id_change();
