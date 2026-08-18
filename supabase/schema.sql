-- HR Mailer — Supabase schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL → New query).

-- Needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- One row per connected Gmail account. Holds the long-lived refresh token
-- used to send mail on the user's behalf.
create table if not exists gmail_accounts (
  email         text primary key,
  name          text,
  refresh_token text not null,
  updated_at    timestamptz not null default now()
);

-- One row per "send batch" the user triggers.
create table if not exists campaigns (
  id               uuid primary key default gen_random_uuid(),
  user_email       text not null,
  subject_template text not null,
  body_template    text not null,
  resume_path      text,
  resume_name      text,
  created_at       timestamptz not null default now()
);

-- Scheduling support: campaigns can be stored now and sent later by the
-- cron processor. Existing rows (sent immediately) default to 'sent'.
-- Safe to re-run on an existing database.
alter table campaigns add column if not exists status       text not null default 'sent';
  -- 'scheduled' | 'sending' | 'sent' | 'canceled' | 'failed'
alter table campaigns add column if not exists scheduled_at timestamptz;
alter table campaigns add column if not exists recipients   jsonb;
alter table campaigns add column if not exists delay_ms     int;
alter table campaigns add column if not exists resume_mime  text;
alter table campaigns add column if not exists error        text;

create index if not exists campaigns_due_idx
  on campaigns (status, scheduled_at);

-- One row per individual email attempt.
create table if not exists sends (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  user_email  text not null,
  to_email    text not null,
  company     text,
  role        text,
  subject     text not null,
  status      text not null default 'pending', -- pending | sent | failed
  error       text,
  message_id  text,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists sends_user_created_idx
  on sends (user_email, created_at desc);

-- All access happens server-side with the service-role key, which bypasses
-- RLS. Enabling RLS with no policies keeps these tables locked to the
-- anon/public key as a safety measure.
alter table gmail_accounts enable row level security;
alter table campaigns      enable row level security;
alter table sends          enable row level security;
