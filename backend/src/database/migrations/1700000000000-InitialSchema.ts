import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline schema migration — creates all tables from scratch.
 * Required for fresh deployments (e.g. AWS RDS) where the DB has no prior schema.
 * All statements use IF NOT EXISTS so re-running is safe.
 * No FK constraints: TypeORM handles joins in application code.
 */
export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enums ────────────────────────────────────────────────────────────────

    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "provider_type_enum" AS ENUM ('openphone','twilio','telegram'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "integration_status_enum" AS ENUM ('active','inactive','error'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "channel_type_enum" AS ENUM ('sms','whatsapp','telegram','voice'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sender_status_enum" AS ENUM ('active','inactive','pending','error'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sender_mode_enum" AS ENUM ('shared','dedicated','openphone'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "message_direction_enum" AS ENUM ('in','out'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "message_status_enum" AS ENUM ('pending','sent','delivered','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "call_direction_enum" AS ENUM ('in','out'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "call_status_enum" AS ENUM ('completed','missed','voicemail','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "identity_status_enum" AS ENUM ('active','inactive','unverified'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "tenant_status_enum" AS ENUM ('active','inactive','suspended'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "phone_number_provider_enum" AS ENUM ('twilio','openphone','whatsapp'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "phone_number_allocation_status_enum" AS ENUM ('active','inactive','pending'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "phone_number_order_type_enum" AS ENUM ('purchase','release'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "phone_number_order_status_enum" AS ENUM ('pending','provisioning','active','releasing','released','failed','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "pricing_type_enum" AS ENUM ('fixed_markup','percentage_markup','fixed_price'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sms_direction_enum" AS ENUM ('OUTBOUND','INBOUND'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sms_status_enum" AS ENUM ('queued','sent','delivered','undelivered','failed','received'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "phone_number_type_enum" AS ENUM ('BOT','DEDICATED'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "webhook_subscription_status_enum" AS ENUM ('active','inactive','paused'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "call_connect_mode_enum" AS ENUM ('AGENT_FIRST','PARALLEL'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "agent_strategy_enum" AS ENUM ('OWNER','ROUND_ROBIN','ON_DUTY'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "caller_id_strategy_enum" AS ENUM ('BOT_NUMBER','BUSINESS_NUMBER'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "agent_voicemail_mode_enum" AS ENUM ('TTS','SPEAK'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "session_status_enum" AS ENUM ('CREATED','CALLING_AGENT','AGENT_ANSWERED','AGENT_ACCEPTED','CALLING_LEAD','LEAD_ANSWERED','BRIDGED','ENDED','FAILED','CANCELED'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "call_connect_provider_enum" AS ENUM ('TWILIO'); EXCEPTION WHEN duplicate_object THEN null; END $$`);

    // ── Tables ────────────────────────────────────────────────────────────────

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "workspaces" (
      "id"         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "name"       varchar NOT NULL,
      "webhook_id" varchar NOT NULL UNIQUE,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "tenants" (
      "id"             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id"   varchar NOT NULL,
      "external_id"    varchar NOT NULL,
      "name"           varchar NOT NULL,
      "status"         "tenant_status_enum" NOT NULL DEFAULT 'active',
      "webhook_url"    text,
      "webhook_secret" text,
      "metadata"       jsonb,
      "created_at"     timestamptz NOT NULL DEFAULT now(),
      "updated_at"     timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenants_workspace_external" ON "tenants" ("workspace_id","external_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tenants_workspace_id" ON "tenants" ("workspace_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "api_keys" (
      "id"           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id" varchar NOT NULL,
      "tenant_id"    uuid,
      "scope"        varchar(20) NOT NULL DEFAULT 'workspace',
      "key"          varchar NOT NULL UNIQUE,
      "name"         varchar NOT NULL,
      "last_used_at" timestamp,
      "active"       boolean NOT NULL DEFAULT true,
      "created_at"   timestamptz NOT NULL DEFAULT now(),
      "updated_at"   timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_api_keys_workspace_id" ON "api_keys" ("workspace_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_api_keys_tenant_id" ON "api_keys" ("tenant_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_api_keys_key" ON "api_keys" ("key")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "communication_integrations" (
      "id"                       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id"             varchar NOT NULL,
      "provider"                 "provider_type_enum" NOT NULL DEFAULT 'openphone',
      "credentials_encrypted"    text NOT NULL,
      "webhook_secret_encrypted" text,
      "external_workspace_id"    varchar,
      "status"                   "integration_status_enum" NOT NULL DEFAULT 'active',
      "metadata"                 jsonb,
      "created_at"               timestamptz NOT NULL DEFAULT now(),
      "updated_at"               timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_comm_integrations_workspace_provider" ON "communication_integrations" ("workspace_id","provider")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_comm_integrations_workspace_id" ON "communication_integrations" ("workspace_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "senders" (
      "id"           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id" varchar NOT NULL,
      "channel"      "channel_type_enum" NOT NULL,
      "address"      text NOT NULL,
      "provider"     text NOT NULL,
      "provider_ref" text,
      "status"       "sender_status_enum" NOT NULL DEFAULT 'active',
      "mode"         "sender_mode_enum" NOT NULL DEFAULT 'shared',
      "name"         text,
      "metadata"     jsonb,
      "created_at"   timestamptz NOT NULL DEFAULT now(),
      "updated_at"   timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_senders_workspace_channel_address" ON "senders" ("workspace_id","channel","address")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_senders_workspace_channel" ON "senders" ("workspace_id","channel")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_senders_workspace_id" ON "senders" ("workspace_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "communication_conversations" (
      "id"                        uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id"              varchar NOT NULL,
      "contact_id"                uuid,
      "external_id"               varchar NOT NULL,
      "provider"                  "provider_type_enum" NOT NULL DEFAULT 'openphone',
      "channel"                   "channel_type_enum" NOT NULL DEFAULT 'sms',
      "sender_id"                 uuid,
      "phone_number"              varchar NOT NULL,
      "participant_phone_number"  varchar,
      "participant_phone_numbers" jsonb,
      "metadata"                  jsonb,
      "created_at"                timestamptz NOT NULL DEFAULT now(),
      "updated_at"                timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_conversations_workspace_external" ON "communication_conversations" ("workspace_id","external_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_workspace_channel_provider" ON "communication_conversations" ("workspace_id","channel","provider")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_workspace_id" ON "communication_conversations" ("workspace_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_contact_id" ON "communication_conversations" ("contact_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "contact_identities" (
      "id"           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "contact_id"   varchar NOT NULL,
      "workspace_id" varchar NOT NULL,
      "channel"      "channel_type_enum" NOT NULL,
      "identity"     text NOT NULL,
      "display"      text,
      "status"       "identity_status_enum" NOT NULL DEFAULT 'active',
      "verified_at"  timestamptz,
      "opt_in_at"    timestamptz,
      "metadata"     jsonb,
      "created_at"   timestamptz NOT NULL DEFAULT now(),
      "updated_at"   timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_contact_identities_contact_channel_identity" ON "contact_identities" ("contact_id","channel","identity")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contact_identities_contact_channel" ON "contact_identities" ("contact_id","channel")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contact_identities_workspace_channel_identity" ON "contact_identities" ("workspace_id","channel","identity")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contact_identities_contact_id" ON "contact_identities" ("contact_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contact_identities_workspace_id" ON "contact_identities" ("workspace_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "communication_messages" (
      "id"                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "conversation_id"     varchar NOT NULL,
      "direction"           "message_direction_enum" NOT NULL,
      "channel"             "channel_type_enum" NOT NULL DEFAULT 'sms',
      "body"                text NOT NULL,
      "from_number"         varchar NOT NULL,
      "to_number"           varchar NOT NULL,
      "provider_message_id" varchar,
      "status"              "message_status_enum" NOT NULL DEFAULT 'pending',
      "sent_by_user_id"     varchar,
      "from_identity_id"    uuid,
      "to_identity_id"      uuid,
      "template_id"         text,
      "template_name"       text,
      "metadata"            jsonb,
      "created_at"          timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_conversation_id" ON "communication_messages" ("conversation_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_provider_message_id" ON "communication_messages" ("provider_message_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_sent_by_user_id" ON "communication_messages" ("sent_by_user_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "communication_calls" (
      "id"                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "conversation_id"      varchar NOT NULL,
      "direction"            "call_direction_enum" NOT NULL,
      "duration"             int NOT NULL DEFAULT 0,
      "recording_url"        varchar,
      "voicemail_url"        varchar,
      "from_number"          varchar NOT NULL,
      "to_number"            varchar NOT NULL,
      "provider_call_id"     varchar,
      "status"               "call_status_enum" NOT NULL DEFAULT 'completed',
      "initiated_by_user_id" varchar,
      "metadata"             jsonb,
      "transcript"           text,
      "transcript_status"    varchar,
      "local_recording_path" varchar,
      "local_voicemail_path" varchar,
      "created_at"           timestamptz NOT NULL DEFAULT now(),
      "started_at"           timestamptz,
      "ended_at"             timestamptz
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_calls_conversation_id" ON "communication_calls" ("conversation_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_calls_provider_call_id" ON "communication_calls" ("provider_call_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_calls_initiated_by_user_id" ON "communication_calls" ("initiated_by_user_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "tenant_integrations" (
      "id"                       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id"             varchar NOT NULL,
      "tenant_id"                varchar NOT NULL,
      "provider"                 varchar(50) NOT NULL,
      "credentials_encrypted"    text NOT NULL,
      "webhook_secret_encrypted" text,
      "status"                   varchar(50) NOT NULL DEFAULT 'active',
      "phone_number"             varchar,
      "phone_number_sid"         varchar,
      "friendly_name"            varchar,
      "metadata"                 jsonb,
      "created_at"               timestamptz NOT NULL DEFAULT now(),
      "updated_at"               timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenant_integrations_workspace_tenant_provider" ON "tenant_integrations" ("workspace_id","tenant_id","provider")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tenant_integrations_workspace_id" ON "tenant_integrations" ("workspace_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tenant_integrations_tenant_id" ON "tenant_integrations" ("tenant_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "tenant_phone_numbers" (
      "id"                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id"           varchar NOT NULL,
      "tenant_id"              varchar NOT NULL,
      "phone_number"           varchar NOT NULL,
      "friendly_name"          varchar,
      "provider"               "phone_number_provider_enum" NOT NULL,
      "provider_id"            varchar,
      "channel"                "channel_type_enum" NOT NULL DEFAULT 'sms',
      "status"                 "phone_number_allocation_status_enum" NOT NULL DEFAULT 'active',
      "is_default"             boolean NOT NULL DEFAULT false,
      "metadata"               jsonb,
      "provisioned_via_callio" boolean NOT NULL DEFAULT false,
      "order_id"               varchar,
      "monthly_cost"           decimal(10,2),
      "provisioned_at"         timestamptz,
      "messaging_service_sid"  varchar,
      "a2p_campaign_id"        varchar,
      "a2p_status"             varchar,
      "a2p_attached_at"        timestamptz,
      "created_at"             timestamptz NOT NULL DEFAULT now(),
      "updated_at"             timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenant_phone_numbers_workspace_phone" ON "tenant_phone_numbers" ("workspace_id","phone_number")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tenant_phone_numbers_workspace_id" ON "tenant_phone_numbers" ("workspace_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tenant_phone_numbers_tenant_id" ON "tenant_phone_numbers" ("tenant_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "phone_number_pricing" (
      "id"                        uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id"              varchar NOT NULL,
      "pricing_type"              "pricing_type_enum" NOT NULL DEFAULT 'fixed_markup',
      "monthly_base_price"        decimal(10,2),
      "monthly_markup_amount"     decimal(10,2) NOT NULL DEFAULT 0,
      "monthly_markup_percentage" decimal(5,2) NOT NULL DEFAULT 0,
      "setup_fee"                 decimal(10,2) NOT NULL DEFAULT 0,
      "allow_tenant_purchase"     boolean NOT NULL DEFAULT false,
      "allow_tenant_release"      boolean NOT NULL DEFAULT false,
      "country_pricing"           jsonb,
      "messaging_service_sid"     varchar,
      "created_at"                timestamptz NOT NULL DEFAULT now(),
      "updated_at"                timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_phone_number_pricing_workspace_id" ON "phone_number_pricing" ("workspace_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "phone_number_orders" (
      "id"                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id"           varchar NOT NULL,
      "tenant_id"              varchar,
      "phone_number"           varchar,
      "phone_number_sid"       varchar,
      "order_type"             "phone_number_order_type_enum" NOT NULL,
      "status"                 "phone_number_order_status_enum" NOT NULL DEFAULT 'pending',
      "twilio_cost"            decimal(10,4) NOT NULL DEFAULT 0,
      "markup_amount"          decimal(10,4) NOT NULL DEFAULT 0,
      "total_price"            decimal(10,4) NOT NULL DEFAULT 0,
      "search_country"         varchar,
      "search_area_code"       varchar,
      "ordered_by"             varchar,
      "tenant_phone_number_id" varchar,
      "metadata"               jsonb,
      "created_at"             timestamptz NOT NULL DEFAULT now(),
      "updated_at"             timestamptz NOT NULL DEFAULT now(),
      "completed_at"           timestamptz
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_phone_number_orders_workspace_created" ON "phone_number_orders" ("workspace_id","created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_phone_number_orders_tenant_id" ON "phone_number_orders" ("tenant_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_phone_number_orders_workspace_id" ON "phone_number_orders" ("workspace_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "phone_number_assignments" (
      "id"          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "business_id" varchar NOT NULL,
      "number_e164" text NOT NULL,
      "type"        "phone_number_type_enum" NOT NULL,
      "region"      text,
      "active"      boolean NOT NULL DEFAULT true,
      "created_at"  timestamptz NOT NULL DEFAULT now(),
      "updated_at"  timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_phone_number_assignments_business_active" ON "phone_number_assignments" ("business_id","active")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_phone_number_assignments_business_id" ON "phone_number_assignments" ("business_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_phone_number_assignments_number_e164" ON "phone_number_assignments" ("number_e164")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sms_messages" (
      "id"            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "business_id"   varchar NOT NULL,
      "lead_id"       text,
      "direction"     "sms_direction_enum" NOT NULL,
      "from_number"   text NOT NULL,
      "to_number"     text NOT NULL,
      "body"          text NOT NULL,
      "status"        "sms_status_enum" NOT NULL DEFAULT 'queued',
      "provider_sid"  text,
      "error_code"    text,
      "price"         decimal(10,5),
      "automation_id" text,
      "source"        text,
      "created_at"    timestamptz NOT NULL DEFAULT now(),
      "updated_at"    timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sms_messages_business_created" ON "sms_messages" ("business_id","created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sms_messages_business_id" ON "sms_messages" ("business_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sms_messages_provider_sid" ON "sms_messages" ("provider_sid")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "webhook_events" (
      "id"           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "provider"     text NOT NULL,
      "external_id"  text NOT NULL,
      "event_type"   text,
      "workspace_id" uuid,
      "processed_at" timestamptz NOT NULL DEFAULT now(),
      "payload"      jsonb
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_webhook_events_provider_external" ON "webhook_events" ("provider","external_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_webhook_events_processed_at" ON "webhook_events" ("processed_at")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
      "id"              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "workspace_id"    varchar NOT NULL,
      "tenant_id"       varchar,
      "name"            text NOT NULL,
      "webhook_url"     text NOT NULL,
      "secret"          text,
      "events"          text NOT NULL,
      "status"          "webhook_subscription_status_enum" NOT NULL DEFAULT 'active',
      "failure_count"   int NOT NULL DEFAULT 0,
      "last_success_at" timestamp,
      "last_failure_at" timestamp,
      "last_error"      text,
      "metadata"        jsonb,
      "created_at"      timestamptz NOT NULL DEFAULT now(),
      "updated_at"      timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_webhook_subscriptions_workspace_status" ON "webhook_subscriptions" ("workspace_id","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_webhook_subscriptions_workspace_id" ON "webhook_subscriptions" ("workspace_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_webhook_subscriptions_tenant_id" ON "webhook_subscriptions" ("tenant_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "call_connect_settings" (
      "business_id"                  varchar PRIMARY KEY,
      "enabled"                      boolean NOT NULL DEFAULT false,
      "mode"                         "call_connect_mode_enum" NOT NULL DEFAULT 'AGENT_FIRST',
      "ring_timeout_seconds"         int NOT NULL DEFAULT 60,
      "agent_accept_digits"          varchar NOT NULL DEFAULT '1',
      "max_agent_attempts"           int NOT NULL DEFAULT 2,
      "agent_strategy"               "agent_strategy_enum" NOT NULL DEFAULT 'OWNER',
      "lead_retry_policy"            jsonb,
      "quiet_hours"                  jsonb,
      "caller_id_strategy"           "caller_id_strategy_enum" NOT NULL DEFAULT 'BOT_NUMBER',
      "bot_number_e164"              varchar,
      "business_number_e164"         varchar,
      "agent_phone_e164"             varchar,
      "agent_whisper_message"        text,
      "lead_greeting_message"        text,
      "lead_voicemail_enabled"       boolean NOT NULL DEFAULT false,
      "lead_voicemail_message"       text,
      "lead_voicemail_recording_url" text,
      "agent_voicemail_mode"         "agent_voicemail_mode_enum" NOT NULL DEFAULT 'TTS',
      "created_at"                   timestamptz NOT NULL DEFAULT now(),
      "updated_at"                   timestamptz NOT NULL DEFAULT now()
    )`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "call_connect_sessions" (
      "id"                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "business_id"             varchar NOT NULL,
      "tenant_id"               varchar,
      "lead_id"                 varchar NOT NULL,
      "lead_phone_e164"         varchar NOT NULL,
      "lead_summary"            text,
      "agent_id"                varchar,
      "agent_phone_e164"        varchar,
      "mode"                    "call_connect_mode_enum" NOT NULL,
      "status"                  "session_status_enum" NOT NULL DEFAULT 'CREATED',
      "provider"                "call_connect_provider_enum" NOT NULL DEFAULT 'TWILIO',
      "from_number_e164"        varchar NOT NULL,
      "agent_call_sid"          varchar,
      "lead_call_sid"           varchar,
      "conference_name"         varchar,
      "attempt"                 int NOT NULL DEFAULT 1,
      "failure_reason"          text,
      "recording_url"           varchar,
      "agent_whisper_message"   text,
      "lead_greeting_message"   text,
      "lead_voicemail_message"  text,
      "sigcore_conversation_id" uuid,
      "timeline"                jsonb NOT NULL DEFAULT '[]',
      "created_at"              timestamptz NOT NULL DEFAULT now(),
      "updated_at"              timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_call_connect_sessions_business_lead" ON "call_connect_sessions" ("business_id","lead_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_call_connect_sessions_business_id" ON "call_connect_sessions" ("business_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_call_connect_sessions_agent_call_sid" ON "call_connect_sessions" ("agent_call_sid")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_call_connect_sessions_lead_call_sid" ON "call_connect_sessions" ("lead_call_sid")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "call_connect_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "call_connect_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_subscriptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sms_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "phone_number_assignments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "phone_number_orders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "phone_number_pricing"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_phone_numbers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_integrations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "communication_calls"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "communication_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "contact_identities"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "communication_conversations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "senders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "communication_integrations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenants"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workspaces"`);
  }
}
