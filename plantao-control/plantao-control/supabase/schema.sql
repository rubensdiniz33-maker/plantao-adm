-- Plantão ADM — esquema do Supabase (já aplicado ao projeto "plantao-adm"). Tabelas sem acesso direto; tudo passa por funções com código do hospital.
create table public.workspaces (id uuid primary key default gen_random_uuid(), name text not null, code_hash text not null unique, created_at timestamptz not null default now());
create table public.shifts (workspace_id uuid not null references public.workspaces(id) on delete cascade, id text not null, data jsonb not null, updated_at timestamptz not null default now(), primary key (workspace_id, id));
create index shifts_recent_idx on public.shifts (workspace_id, updated_at desc);
alter table public.workspaces enable row level security;
alter table public.shifts enable row level security;
revoke all on public.workspaces, public.shifts from anon, authenticated;
-- Funções: _plantao_ws (valida o código), plantao_check, plantao_push (último a gravar vence, por updatedAt), plantao_recent.
-- Novo código: insert into public.workspaces (name, code_hash) values ('Nome', encode(sha256(convert_to(upper('HC-XXXXXXXX'), 'utf8')), 'hex'));
-- Trocar o código: update public.workspaces set code_hash = encode(sha256(convert_to(upper('NOVO-CODIGO'), 'utf8')), 'hex') where name = '...';
