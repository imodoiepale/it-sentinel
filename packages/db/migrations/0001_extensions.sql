-- Extensions this schema depends on. Verified present on the target org:
-- pg_partman (partitioned telemetry, replaces the TimescaleDB hypertable we
-- don't have), pg_cron (staleness sweep + rollups), pgmq (store-and-forward
-- command queue), vector (RAG over knowledge), pgaudit (beneath audit_log),
-- pgcrypto, pg_trgm (voice branch-name resolution).
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm;
create extension if not exists vector;
create extension if not exists pgaudit;
create schema if not exists partman;
create extension if not exists pg_partman with schema partman;
create extension if not exists pg_cron;
create extension if not exists pgmq;
-- supabase_vault ships pre-installed on Supabase projects; no explicit create needed.
