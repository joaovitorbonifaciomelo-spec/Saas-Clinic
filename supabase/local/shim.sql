-- =============================================================================
-- Shim do Supabase para instancia Postgres EFEMERA
--
-- As migrations dependem de coisas que a plataforma do Supabase fornece e um
-- Postgres cru nao tem: o schema `auth`, a funcao `auth.uid()` e os papeis
-- `anon`, `authenticated` e `service_role`.
--
-- Este arquivo recria o MINIMO necessario para que a cadeia inteira de
-- migrations seja parseada e executada de verdade — nao para simular o
-- Supabase, e sim para que erro de sintaxe, constraint mal escrita e trigger
-- quebrado aparecam antes do banco remoto.
--
-- Nao vai para producao. Usado apenas por scripts/verify-migrations.mjs.
-- =============================================================================

-- Papeis. NOLOGIN porque ninguem se conecta como eles aqui; o que importa e
-- que `set role` e os grants funcionem como no destino.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Recorte de auth.users com o que as migrations referenciam.
create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

/*
 * auth.uid() lê a claim `sub` de `request.jwt.claims`, exatamente como o
 * Supabase faz. E o que permite exercitar RLS de verdade aqui: basta
 * `set local role authenticated` e `set local request.jwt.claims = '{"sub":...}'`
 * para o teste rodar como um usuario especifico.
 */
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

-- As migrations criam profiles com FK para auth.users e um trigger em
-- auth.users. O trigger `on_auth_user_created` da 0001 e criado sobre esta
-- tabela; por isso ela precisa existir ANTES da primeira migration.
