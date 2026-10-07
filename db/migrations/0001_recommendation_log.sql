-- ─────────────────────────────────────────────────────────────────────────────
-- KrishiSat — 0001_recommendation_log
--
-- The ONLY persisted dataset in the product (PRD F15, §11.9). Reference data —
-- climate baseline, hindcast, member roster, scenario catalogue — lives in
-- committed FILES, not in this database (§9.4, §26).
--
-- What this migration is responsible for:
--   * append-only  — UPDATE is blocked by trigger, so history cannot be edited
--   * hash-keyed   — canonical_input_hash is UNIQUE; the writer inserts if absent
--   * deny-all     — RLS enabled with ZERO policies (PRD §15.7, §29.4 #11)
--   * PII-free     — district-level only: no member, requester or IP column
--
-- Retention (180 days, §23.1) is enforced by the scheduled writer, which is the
-- ONE sanctioned DELETE path. That asymmetry is the reason DELETE is granted
-- below and UPDATE is not.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

create table if not exists public.recommendation_log (
    id                   uuid         primary key default gen_random_uuid(),

    district             text         not null
                                      check (district in ('jalna', 'bikaner', 'dewas', 'anantapur')),
    log_date             date         not null,
    season               text         not null
                                      check (season in ('kharif', 'rabi')),
    scenario_id          text         null,

    -- Decided values, copied from the engine output. Never recomputed here (§12.7).
    wsi                  numeric(5,2) not null
                                      check (wsi >= 0 and wsi <= 100),
    payout_tier          text         not null
                                      check (payout_tier in ('BELOW_THRESHOLD', 'PREVENTED_SOWING',
                                                             'TIER_1_MODERATE', 'TIER_2_SEVERE',
                                                             'TIER_3_CATASTROPHIC')),
    -- The five published amounts of §12.1 and nothing else: a sixth value means
    -- someone bypassed the locked table.
    payout_per_hectare   integer      not null
                                      check (payout_per_hectare in (0, 12500, 25000, 37500, 50000)),
    severity_level       text         not null
                                      check (severity_level in ('NORMAL', 'PREVENTED_SOWING',
                                                                'MODERATE_DEFICIT', 'SEVERE_DROUGHT',
                                                                'CATASTROPHIC_DROUGHT')),
    aggregate_quality    text         not null
                                      check (aggregate_quality in ('LIVE', 'PARTIAL', 'OFFLINE')),
    duration_mode        text         not null
                                      check (duration_mode in ('real', 'estimated')),

    -- The insert-if-absent key (§10.2 F10 digest), and the receipt it ties to.
    canonical_input_hash text         not null unique,
    receipt_id           text         not null,

    created_at           timestamptz  not null default now()
);

comment on table public.recommendation_log is
    'Append-only record of what KrishiSat recommended, keyed by canonical input hash (PRD F15, §11.9). District-level and PII-free. No UPDATE path exists; DELETE is reserved for the §23.1 retention pruner.';

-- ── Append-only, enforced ────────────────────────────────────────────────────
-- The application also has no update path, but "no update path in code" is a
-- promise; this is the guarantee. Even the table owner cannot rewrite history.
create or replace function public.krishisat_block_log_update()
returns trigger
language plpgsql
as $$
begin
    raise exception
        'recommendation_log is append-only: a correction is a new row, not an edit (PRD F15)'
        using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists recommendation_log_no_update on public.recommendation_log;
create trigger recommendation_log_no_update
    before update on public.recommendation_log
    for each row execute function public.krishisat_block_log_update();

-- ── Indexes for the §18.9 read path ──────────────────────────────────────────
-- Newest-first keyset paging, and the district filter.
create index if not exists recommendation_log_paging_idx
    on public.recommendation_log (created_at desc, id desc);

create index if not exists recommendation_log_district_date_idx
    on public.recommendation_log (district, log_date desc);

-- ── Access control ───────────────────────────────────────────────────────────
-- RLS with NO policies denies every request (Supabase documents this explicitly).
-- There are deliberately no `create policy` statements in this file: the app never
-- uses the anon key, so a policy would widen access for no purpose. Adding one is
-- a defect until justified, and requires a PRD version bump (§15.7).
alter table public.recommendation_log enable row level security;

-- Belt and braces: strip the default grants Supabase applies to the public schema,
-- then grant the minimum the server needs.
revoke all on public.recommendation_log from public;
revoke all on public.recommendation_log from anon, authenticated;

grant select, insert, delete on public.recommendation_log to service_role;
-- No UPDATE grant. History is immutable — the trigger above enforces it regardless.
