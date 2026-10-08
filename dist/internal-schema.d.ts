/**
 * Canonical catalog for Armadillo-owned storage.
 *
 * SQL migrations remain the physical source of truth. This catalog gives the
 * deployment adapters, administrative tools, documentation, and tests one typed
 * map back to the migration that introduced each table. Application schemas
 * can use schemaless JSON documents or adapter-backed physical tables.
 */
export interface InternalIndexDefinition {
    readonly name: string;
    readonly columns: readonly string[];
    /** Later lifecycle migrations may add an index to an existing table. */
    readonly migration?: `${number}_${string}.sql`;
}
export interface InternalTableDefinition {
    readonly table: string;
    readonly migration: `${number}_${string}.sql`;
    readonly purpose: string;
    readonly columns: readonly string[];
    readonly primaryKey: readonly string[];
    readonly indexes: readonly InternalIndexDefinition[];
}
export declare const INTERNAL_SCHEMA: {
    readonly users: {
        readonly table: "_armadillo_users";
        readonly migration: "0001_base.sql";
        readonly purpose: "Authenticated application identities and password credentials.";
        readonly columns: readonly ["app_id", "id", "email", "name", "password_hash", "password_salt", "password_iterations", "created_at", "updated_at", "password_enabled", "profile_photo_id", "profile"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [];
    };
    readonly sessions: {
        readonly table: "_armadillo_sessions";
        readonly migration: "0001_base.sql";
        readonly purpose: "Hashed bearer sessions with expiration and user ownership.";
        readonly columns: readonly ["app_id", "id", "token_hash", "user_id", "created_at", "expires_at", "auth_method"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_sessions_user";
            readonly columns: readonly ["app_id", "user_id"];
        }, {
            readonly name: "_armadillo_sessions_expiry";
            readonly columns: readonly ["expires_at"];
        }];
    };
    readonly objects: {
        readonly table: "_armadillo_objects";
        readonly migration: "0001_base.sql";
        readonly purpose: "JSON application documents. owner_id and group_id are the indexed access keys.";
        readonly columns: readonly ["app_id", "collection", "id", "owner_id", "data", "created_at", "updated_at", "group_id"];
        readonly primaryKey: readonly ["app_id", "collection", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_objects_owner";
            readonly columns: readonly ["app_id", "collection", "owner_id", "created_at"];
        }, {
            readonly name: "_armadillo_objects_group";
            readonly columns: readonly ["app_id", "collection", "group_id", "created_at"];
            readonly migration: "0011_group_projection.sql";
        }];
    };
    readonly files: {
        readonly table: "_armadillo_files";
        readonly migration: "0001_base.sql";
        readonly purpose: "Owner-scoped metadata for file bodies stored by the active adapter.";
        readonly columns: readonly ["app_id", "id", "owner_id", "storage_key", "name", "content_type", "size", "etag", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_files_owner";
            readonly columns: readonly ["app_id", "owner_id", "created_at"];
        }];
    };
    readonly groups: {
        readonly table: "_armadillo_groups";
        readonly migration: "0002_groups_events.sql";
        readonly purpose: "Application groups, including the trust boundary for privileged functions.";
        readonly columns: readonly ["app_id", "id", "name", "slug", "trusted", "created_by", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [];
    };
    readonly groupMembers: {
        readonly table: "_armadillo_group_members";
        readonly migration: "0002_groups_events.sql";
        readonly purpose: "User roles within application groups.";
        readonly columns: readonly ["app_id", "group_id", "user_id", "role", "created_at", "updated_at"];
        readonly primaryKey: readonly ["app_id", "group_id", "user_id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_group_members_user";
            readonly columns: readonly ["app_id", "user_id", "group_id"];
        }];
    };
    readonly events: {
        readonly table: "_armadillo_events";
        readonly migration: "0002_groups_events.sql";
        readonly purpose: "Group-visible application events with their authenticated actor.";
        readonly columns: readonly ["app_id", "id", "group_id", "type", "actor_id", "data", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_events_group_time";
            readonly columns: readonly ["app_id", "group_id", "created_at"];
        }];
    };
    readonly schemaState: {
        readonly table: "_armadillo_schema_state";
        readonly migration: "0003_schema_state.sql";
        readonly purpose: "The last application-schema snapshot accepted by the Armadillo CLI.";
        readonly columns: readonly ["app_id", "schema_json", "checksum", "applied_at"];
        readonly primaryKey: readonly ["app_id"];
        readonly indexes: readonly [];
    };
    readonly magicLinks: {
        readonly table: "_armadillo_magic_links";
        readonly migration: "0004_pre_publish_primitives.sql";
        readonly purpose: "Hashed, short-lived, single-use passwordless authentication challenges.";
        readonly columns: readonly ["app_id", "id", "token_hash", "user_id", "requested_email", "redirect_url", "created_at", "expires_at", "consumed_at", "consumed_by_session"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_magic_links_expiry";
            readonly columns: readonly ["expires_at"];
        }, {
            readonly name: "_armadillo_magic_links_user";
            readonly columns: readonly ["app_id", "user_id", "created_at"];
        }];
    };
    readonly vouchers: {
        readonly table: "_armadillo_vouchers";
        readonly migration: "0004_pre_publish_primitives.sql";
        readonly purpose: "Owner-scoped finite-capacity redeemable vouchers.";
        readonly columns: readonly ["app_id", "id", "owner_id", "name", "code_hash", "code_prefix", "capacity", "remaining", "expires_at", "created_at", "updated_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_vouchers_owner";
            readonly columns: readonly ["app_id", "owner_id", "created_at"];
        }, {
            readonly name: "_armadillo_vouchers_expiry";
            readonly columns: readonly ["expires_at"];
        }];
    };
    readonly voucherRedemptions: {
        readonly table: "_armadillo_voucher_redemptions";
        readonly migration: "0004_pre_publish_primitives.sql";
        readonly purpose: "Idempotent voucher-consumption ledger whose insert trigger decrements stock atomically.";
        readonly columns: readonly ["app_id", "id", "voucher_id", "idempotency_key", "consumed_by", "consumed_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_voucher_redemptions_voucher";
            readonly columns: readonly ["app_id", "voucher_id", "consumed_at"];
        }];
    };
    readonly apiKeys: {
        readonly table: "_armadillo_api_keys";
        readonly migration: "0004_pre_publish_primitives.sql";
        readonly purpose: "Hashed, individually revocable machine credentials with scopes, rotation, and audit metadata.";
        readonly columns: readonly ["app_id", "id", "owner_id", "name", "key_hash", "key_prefix", "scopes", "created_at", "expires_at", "last_used_at", "revoked_at", "description", "rotated_from", "grace_expires_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_api_keys_owner";
            readonly columns: readonly ["app_id", "owner_id", "created_at"];
        }, {
            readonly name: "_armadillo_api_keys_expiry";
            readonly columns: readonly ["expires_at"];
        }, {
            readonly name: "_armadillo_api_keys_grace_expiry";
            readonly columns: readonly ["grace_expires_at"];
            readonly migration: "0008_api_key_lifecycle.sql";
        }];
    };
    readonly apiKeyAudit: {
        readonly table: "_armadillo_api_key_audit";
        readonly migration: "0009_api_key_audit.sql";
        readonly purpose: "Named API-key lifecycle events without recording plaintext credentials.";
        readonly columns: readonly ["app_id", "id", "key_id", "actor_id", "event_type", "details", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_api_key_audit_key";
            readonly columns: readonly ["app_id", "key_id", "created_at"];
        }];
    };
    readonly bootstrap: {
        readonly table: "_armadillo_bootstrap";
        readonly migration: "0004_pre_publish_primitives.sql";
        readonly purpose: "Database-burned record that the application has an owner. The secret is stored only as a hash.";
        readonly columns: readonly ["app_id", "secret_hash", "user_id", "group_id", "used_at", "schema_version"];
        readonly primaryKey: readonly ["app_id"];
        readonly indexes: readonly [];
    };
    readonly rateLimits: {
        readonly table: "_armadillo_rate_limits";
        readonly migration: "0004_pre_publish_primitives.sql";
        readonly purpose: "Fixed-window abuse controls for authentication and mutation endpoints.";
        readonly columns: readonly ["key_hash", "count", "reset_at", "updated_at"];
        readonly primaryKey: readonly ["key_hash"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_rate_limits_expiry";
            readonly columns: readonly ["reset_at"];
        }];
    };
    readonly mailJobs: {
        readonly table: "_armadillo_mail_jobs";
        readonly migration: "0004_pre_publish_primitives.sql";
        readonly purpose: "Observable delivery state for queued mail without retaining recipient plaintext.";
        readonly columns: readonly ["app_id", "id", "kind", "recipient_hash", "status", "attempts", "last_error", "created_at", "updated_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_mail_jobs_status";
            readonly columns: readonly ["status", "updated_at"];
        }];
    };
    readonly fileUploads: {
        readonly table: "_armadillo_file_uploads";
        readonly migration: "0004_pre_publish_primitives.sql";
        readonly purpose: "Short-lived direct and multipart object-storage upload intents.";
        readonly columns: readonly ["app_id", "id", "owner_id", "storage_key", "name", "content_type", "expected_size", "kind", "r2_upload_id", "status", "created_at", "expires_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_file_uploads_owner";
            readonly columns: readonly ["app_id", "owner_id", "created_at"];
        }, {
            readonly name: "_armadillo_file_uploads_expiry";
            readonly columns: readonly ["expires_at"];
        }];
    };
    readonly fileLinks: {
        readonly table: "__armadillo_file_link";
        readonly migration: "0005_physical_schema_files.sql";
        readonly purpose: "Hidden record-to-file indirection for declared fields and arbitrary attachments.";
        readonly columns: readonly ["app_id", "collection", "object_id", "file_id", "owner_id", "relation", "field_name", "position", "created_at"];
        readonly primaryKey: readonly ["app_id", "collection", "object_id", "file_id", "relation", "field_name"];
        readonly indexes: readonly [{
            readonly name: "__armadillo_file_link_record";
            readonly columns: readonly ["app_id", "collection", "object_id", "relation", "position", "created_at"];
        }, {
            readonly name: "__armadillo_file_link_file";
            readonly columns: readonly ["app_id", "file_id"];
        }];
    };
    readonly collectorSubmissions: {
        readonly table: "_armadillo_collector_submissions";
        readonly migration: "0006_collectors.sql";
        readonly purpose: "Typed, expiring form submissions routed to an authorized team inbox.";
        readonly columns: readonly ["app_id", "id", "collector_id", "user_id", "group_id", "project_id", "data", "created_at", "expires_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_collector_submissions_inbox";
            readonly columns: readonly ["app_id", "collector_id", "group_id", "created_at"];
        }, {
            readonly name: "_armadillo_collector_submissions_expiry";
            readonly columns: readonly ["expires_at"];
        }];
    };
    readonly tickets: {
        readonly table: "_armadillo_tickets";
        readonly migration: "0006_collectors.sql";
        readonly purpose: "Team-governed, single-use tickets with optional holder and event links.";
        readonly columns: readonly ["app_id", "id", "owner_id", "team_id", "holder_id", "label", "event_id", "code_hash", "code_prefix", "metadata", "expires_at", "consumed_at", "consumed_by", "created_at", "updated_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_tickets_team";
            readonly columns: readonly ["app_id", "team_id", "created_at"];
        }, {
            readonly name: "_armadillo_tickets_holder";
            readonly columns: readonly ["app_id", "holder_id", "created_at"];
        }, {
            readonly name: "_armadillo_tickets_expiry";
            readonly columns: readonly ["expires_at"];
        }];
    };
    readonly ticketConsumptions: {
        readonly table: "_armadillo_ticket_consumptions";
        readonly migration: "0006_collectors.sql";
        readonly purpose: "Immutable, idempotent ledger for atomic ticket consumption.";
        readonly columns: readonly ["app_id", "id", "ticket_id", "idempotency_key", "consumed_by", "consumed_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_ticket_consumptions_actor";
            readonly columns: readonly ["app_id", "consumed_by", "consumed_at"];
        }];
    };
    readonly ticketTokens: {
        readonly table: "_armadillo_ticket_tokens";
        readonly migration: "0016_ticket_tokens.sql";
        readonly purpose: "Single-use inventory tokens for a tickets field. The raw token is never stored.";
        readonly columns: readonly ["app_id", "token_hash", "collection", "field", "record_id", "consumed_at", "consumed_by", "claim_id", "created_at"];
        readonly primaryKey: readonly ["app_id", "token_hash"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_ticket_tokens_record";
            readonly columns: readonly ["app_id", "collection", "field", "record_id"];
        }];
    };
    readonly realtimeConnections: {
        readonly table: "_armadillo_realtime_connections";
        readonly migration: "0007_realtime_webhooks.sql";
        readonly purpose: "Observable authenticated realtime connections and channel membership.";
        readonly columns: readonly ["app_id", "id", "user_id", "channels", "connected_at", "last_heartbeat"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_realtime_connections_user";
            readonly columns: readonly ["app_id", "user_id", "connected_at"];
        }, {
            readonly name: "_armadillo_realtime_connections_heartbeat";
            readonly columns: readonly ["last_heartbeat"];
        }];
    };
    readonly webhookJobs: {
        readonly table: "_armadillo_webhook_jobs";
        readonly migration: "0007_realtime_webhooks.sql";
        readonly purpose: "Signed, retryable outbound webhook work awaiting delivery.";
        readonly columns: readonly ["app_id", "id", "webhook_name", "url", "payload", "signature", "attempts", "max_attempts", "backoff", "initial_delay_ms", "next_retry_at", "last_status", "last_response", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_webhook_jobs_ready";
            readonly columns: readonly ["next_retry_at", "attempts"];
        }];
    };
    readonly webhookDeliveries: {
        readonly table: "_armadillo_webhook_deliveries";
        readonly migration: "0007_realtime_webhooks.sql";
        readonly purpose: "Immutable audit trail of webhook delivery attempts.";
        readonly columns: readonly ["app_id", "id", "job_id", "status", "response_status", "response_body", "delivered_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_webhook_deliveries_job";
            readonly columns: readonly ["app_id", "job_id", "delivered_at"];
        }];
    };
    readonly gdprConsents: {
        readonly table: "_armadillo_gdpr_consents";
        readonly migration: "0010_gdpr.sql";
        readonly purpose: "Consent ledger per purpose (granted/revoked, auditable).";
        readonly columns: readonly ["app_id", "id", "user_id", "purpose", "granted", "metadata", "ip_hash", "user_agent", "created_at", "updated_at", "expires_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_gdpr_consents_user";
            readonly columns: readonly ["app_id", "user_id", "updated_at"];
        }, {
            readonly name: "_armadillo_gdpr_consents_purpose";
            readonly columns: readonly ["app_id", "purpose"];
        }];
    };
    readonly gdprErasureLog: {
        readonly table: "_armadillo_gdpr_erasure_log";
        readonly migration: "0010_gdpr.sql";
        readonly purpose: "Immutable log of erasure/anonymization requests.";
        readonly columns: readonly ["app_id", "id", "target_user_id", "actor_user_id", "strategy", "reason", "details", "created_at", "completed_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_gdpr_erasure_log_target";
            readonly columns: readonly ["app_id", "target_user_id", "created_at"];
        }];
    };
    readonly gdprRestrictions: {
        readonly table: "_armadillo_gdpr_restrictions";
        readonly migration: "0010_gdpr.sql";
        readonly purpose: "Article 18 restriction flag per user.";
        readonly columns: readonly ["app_id", "user_id", "restricted", "reason", "updated_at", "updated_by"];
        readonly primaryKey: readonly ["app_id", "user_id"];
        readonly indexes: readonly [];
    };
    readonly gdprExportLog: {
        readonly table: "_armadillo_gdpr_export_log";
        readonly migration: "0010_gdpr.sql";
        readonly purpose: "Audit log of data exports (right of access / portability).";
        readonly columns: readonly ["app_id", "id", "user_id", "actor_user_id", "created_at", "expires_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_gdpr_export_log_user";
            readonly columns: readonly ["app_id", "user_id", "created_at"];
        }];
    };
    readonly groupProjection: {
        readonly table: "_armadillo_group_projection";
        readonly migration: "0011_group_projection.sql";
        readonly purpose: "Records which JSON team field has been copied into objects.group_id.";
        readonly columns: readonly ["app_id", "collection", "field"];
        readonly primaryKey: readonly ["app_id", "collection"];
        readonly indexes: readonly [];
    };
    readonly bootstrapSessions: {
        readonly table: "_armadillo_bootstrap_sessions";
        readonly migration: "0012_burrow.sql";
        readonly purpose: "Short-lived hashed grants exchanged from the one-time bootstrap secret.";
        readonly columns: readonly ["app_id", "token_hash", "expires_at", "created_at"];
        readonly primaryKey: readonly ["app_id", "token_hash"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_bootstrap_sessions_expiry";
            readonly columns: readonly ["expires_at"];
        }];
    };
    readonly identities: {
        readonly table: "_armadillo_identities";
        readonly migration: "0012_burrow.sql";
        readonly purpose: "Provider subject mapped to one Armadillo user. The subject is the stable identity, not the email.";
        readonly columns: readonly ["app_id", "provider", "subject", "user_id", "email", "created_at", "updated_at"];
        readonly primaryKey: readonly ["app_id", "provider", "subject"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_identities_user";
            readonly columns: readonly ["app_id", "user_id"];
        }];
    };
    readonly oauthStates: {
        readonly table: "_armadillo_oauth_states";
        readonly migration: "0012_burrow.sql";
        readonly purpose: "Single-use OAuth state and PKCE verifier. The verifier is deleted when the callback is consumed.";
        readonly columns: readonly ["app_id", "state_hash", "provider", "verifier", "redirect_path", "expires_at", "created_at"];
        readonly primaryKey: readonly ["app_id", "state_hash"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_oauth_states_expiry";
            readonly columns: readonly ["expires_at"];
        }];
    };
    readonly audit: {
        readonly table: "_armadillo_audit";
        readonly migration: "0012_burrow.sql";
        readonly purpose: "Operational events for setup, secret names, and sign-in. Secret values are never stored here.";
        readonly columns: readonly ["app_id", "id", "actor_id", "action", "subject", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_audit_recent";
            readonly columns: readonly ["app_id", "created_at"];
        }];
    };
    readonly recordAudit: {
        readonly table: "_armadillo_record_audit";
        readonly migration: "0014_record_audit.sql";
        readonly purpose: "Metadata-only record mutation trail: who changed which record, when. Record contents are never stored here.";
        readonly columns: readonly ["app_id", "id", "table_name", "record_id", "action", "actor_id", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_record_audit_recent";
            readonly columns: readonly ["app_id", "created_at"];
        }, {
            readonly name: "_armadillo_record_audit_record";
            readonly columns: readonly ["app_id", "table_name", "record_id", "created_at"];
        }];
    };
    readonly bridgeInvites: {
        readonly table: "_armadillo_bridge_invites";
        readonly migration: "0017_bridge.sql";
        readonly purpose: "Hashed enrollment claim tickets. Raw tokens and API secrets are never stored.";
        readonly columns: readonly ["app_id", "id", "owner_id", "token_hash", "agent_class", "name", "scopes", "status", "fetch_count", "expires_at", "api_key_id", "approved_scopes", "created_at", "updated_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_bridge_invites_owner";
            readonly columns: readonly ["app_id", "owner_id", "created_at"];
        }];
    };
    readonly bridgeJobs: {
        readonly table: "_armadillo_bridge_jobs";
        readonly migration: "0017_bridge.sql";
        readonly purpose: "One agent intent. Completion usage is whatever the agent sent.";
        readonly columns: readonly ["app_id", "id", "agent_id", "status", "action", "payload", "usage", "created_at", "updated_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_bridge_jobs_agent";
            readonly columns: readonly ["app_id", "agent_id", "created_at"];
        }];
    };
    readonly bridgeEvents: {
        readonly table: "_armadillo_bridge_events";
        readonly migration: "0017_bridge.sql";
        readonly purpose: "Append-only enrollment and security notes. Credentials are never stored.";
        readonly columns: readonly ["app_id", "id", "kind", "invite_id", "details", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_bridge_events_recent";
            readonly columns: readonly ["app_id", "created_at"];
        }];
    };
    readonly usageRollups: {
        readonly table: "_armadillo_usage_rollups";
        readonly migration: "0018_usage_metering.sql";
        readonly purpose: "Daily UTC usage rollups per app. Counts only — no PII, record contents, or credentials.";
        readonly columns: readonly ["app_id", "day_utc", "metric", "amount", "updated_at"];
        readonly primaryKey: readonly ["app_id", "day_utc", "metric"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_usage_rollups_day";
            readonly columns: readonly ["app_id", "day_utc"];
        }];
    };
    readonly scheduleState: {
        readonly table: "_armadillo_schedule_state";
        readonly migration: "0019_scheduled_functions.sql";
        readonly purpose: "Runtime pause/lease/next-due state for declared schedules. No secrets.";
        readonly columns: readonly ["app_id", "schedule_name", "paused", "next_due_at", "running_at", "running_run_id", "pending_attempt", "last_run_at", "updated_at"];
        readonly primaryKey: readonly ["app_id", "schedule_name"];
        readonly indexes: readonly [];
    };
    readonly scheduleRuns: {
        readonly table: "_armadillo_schedule_runs";
        readonly migration: "0019_scheduled_functions.sql";
        readonly purpose: "Append-only schedule run history. Outcomes and sanitized errors only — no record contents or credentials.";
        readonly columns: readonly ["app_id", "id", "schedule_name", "principal_type", "principal_id", "attempt", "started_at", "finished_at", "outcome", "error_summary", "created_at"];
        readonly primaryKey: readonly ["app_id", "id"];
        readonly indexes: readonly [{
            readonly name: "_armadillo_schedule_runs_schedule";
            readonly columns: readonly ["app_id", "schedule_name", "created_at"];
        }, {
            readonly name: "_armadillo_schedule_runs_outcome";
            readonly columns: readonly ["app_id", "outcome", "created_at"];
        }];
    };
};
export declare const INTERNAL_TABLES: {
    readonly users: "_armadillo_users";
    readonly sessions: "_armadillo_sessions";
    readonly objects: "_armadillo_objects";
    readonly files: "_armadillo_files";
    readonly groups: "_armadillo_groups";
    readonly groupMembers: "_armadillo_group_members";
    readonly events: "_armadillo_events";
    readonly schemaState: "_armadillo_schema_state";
    readonly magicLinks: "_armadillo_magic_links";
    readonly vouchers: "_armadillo_vouchers";
    readonly voucherRedemptions: "_armadillo_voucher_redemptions";
    readonly apiKeys: "_armadillo_api_keys";
    readonly apiKeyAudit: "_armadillo_api_key_audit";
    readonly bootstrap: "_armadillo_bootstrap";
    readonly bootstrapSessions: "_armadillo_bootstrap_sessions";
    readonly identities: "_armadillo_identities";
    readonly oauthStates: "_armadillo_oauth_states";
    readonly audit: "_armadillo_audit";
    readonly recordAudit: "_armadillo_record_audit";
    readonly bridgeInvites: "_armadillo_bridge_invites";
    readonly bridgeJobs: "_armadillo_bridge_jobs";
    readonly bridgeEvents: "_armadillo_bridge_events";
    readonly usageRollups: "_armadillo_usage_rollups";
    readonly scheduleState: "_armadillo_schedule_state";
    readonly scheduleRuns: "_armadillo_schedule_runs";
    readonly rateLimits: "_armadillo_rate_limits";
    readonly mailJobs: "_armadillo_mail_jobs";
    readonly fileUploads: "_armadillo_file_uploads";
    readonly fileLinks: "__armadillo_file_link";
    readonly collectorSubmissions: "_armadillo_collector_submissions";
    readonly tickets: "_armadillo_tickets";
    readonly ticketConsumptions: "_armadillo_ticket_consumptions";
    readonly ticketTokens: "_armadillo_ticket_tokens";
    readonly realtimeConnections: "_armadillo_realtime_connections";
    readonly webhookJobs: "_armadillo_webhook_jobs";
    readonly webhookDeliveries: "_armadillo_webhook_deliveries";
    readonly gdprConsents: "_armadillo_gdpr_consents";
    readonly gdprErasureLog: "_armadillo_gdpr_erasure_log";
    readonly gdprRestrictions: "_armadillo_gdpr_restrictions";
    readonly gdprExportLog: "_armadillo_gdpr_export_log";
    readonly groupProjection: "_armadillo_group_projection";
};
export type InternalTableName = (typeof INTERNAL_TABLES)[keyof typeof INTERNAL_TABLES];
export declare const SYSTEM_RESOURCES: {
    readonly _User: {
        readonly table: "_armadillo_users";
        readonly read: "admin";
        readonly editable: false;
        readonly visibleColumns: readonly ["id", "email", "name", "created_at", "updated_at"];
        readonly hiddenColumns: readonly ["password_hash", "password_salt", "password_iterations"];
        readonly fields: {
            readonly email: {
                readonly type: "email";
            };
            readonly name: {
                readonly type: "string";
            };
        };
    };
    readonly _Team: {
        readonly table: "_armadillo_groups";
        readonly read: "admin";
        readonly editable: false;
        readonly visibleColumns: readonly ["id", "name", "slug", "trusted", "created_by", "created_at"];
        readonly hiddenColumns: readonly [];
        readonly fields: {
            readonly name: {
                readonly type: "string";
            };
            readonly slug: {
                readonly type: "string";
            };
            readonly trusted: {
                readonly type: "boolean";
            };
        };
    };
    readonly _File: {
        readonly table: "_armadillo_files";
        readonly read: "admin";
        readonly editable: false;
        readonly visibleColumns: readonly ["id", "owner_id", "name", "content_type", "size", "etag", "created_at"];
        readonly hiddenColumns: readonly ["storage_key"];
        readonly fields: {
            readonly name: {
                readonly type: "string";
            };
            readonly contentType: {
                readonly type: "string";
            };
            readonly size: {
                readonly type: "integer";
            };
            readonly ownerId: {
                readonly type: "pointer";
                readonly target: "_User";
            };
        };
    };
};
export type SystemResourceName = keyof typeof SYSTEM_RESOURCES;
export declare const DEFAULT_SYSTEM_RESOURCE_NAME: SystemResourceName;
export declare const SYSTEM_RESOURCE_NAMES: readonly ("_Team" | "_User" | "_File")[];
export declare function isSystemResourceName(value: string): value is SystemResourceName;
export interface InternalUserRow {
    id: string;
    email: string;
    name: string | null;
    password_hash: string;
    password_salt: string;
    password_iterations: number;
    password_enabled: number;
    profile_photo_id?: string | null;
    profile?: string | null;
    created_at: string;
    updated_at: string;
}
export type InternalUserSummaryRow = Pick<InternalUserRow, "id" | "email" | "name" | "created_at" | "updated_at">;
export interface InternalObjectRow {
    id: string;
    owner_id: string;
    data: string;
    created_at: string;
    updated_at: string;
}
export interface InternalFileRow {
    id: string;
    owner_id: string;
    storage_key: string;
    name: string;
    content_type: string;
    size: number;
    etag: string;
    created_at: string;
}
export interface InternalApiKeyRow {
    id: string;
    owner_id: string;
    name: string;
    description: string | null;
    key_prefix: string;
    scopes: string;
    rotated_from: string | null;
    grace_expires_at: string | null;
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
    revoked_at: string | null;
}
export interface InternalApiKeyAuditRow {
    id: string;
    key_id: string;
    actor_id: string;
    event_type: "created" | "rotated" | "revoked";
    details: string;
    created_at: string;
}
export interface InternalVoucherRow {
    id: string;
    owner_id: string;
    name: string;
    code_prefix: string;
    capacity: number;
    remaining: number;
    expires_at: string | null;
    created_at: string;
    updated_at: string;
}
export interface InternalCollectorSubmissionRow {
    id: string;
    collector_id: string;
    user_id: string | null;
    group_id: string;
    project_id: string | null;
    data: string;
    created_at: string;
    expires_at: string;
}
export interface InternalTicketRow {
    id: string;
    owner_id: string;
    team_id: string;
    holder_id: string | null;
    label: string;
    event_id: string | null;
    code_prefix: string;
    metadata: string;
    expires_at: string | null;
    consumed_at: string | null;
    consumed_by: string | null;
    created_at: string;
    updated_at: string;
}
export interface InternalGroupRow {
    id: string;
    name: string;
    slug: string;
    trusted: number;
    created_by: string;
    created_at: string;
}
export interface InternalGroupMembershipRow {
    id: string;
    name: string;
    slug: string;
    role: string;
    trusted: number;
    created_at: string;
}
export interface InternalGroupMemberUserRow {
    user_id: string;
    email: string;
    name: string | null;
    role: string;
    created_at: string;
}
export interface InternalEventWithActorRow {
    id: string;
    group_id: string;
    type: string;
    actor_id: string;
    actor_name: string | null;
    data: string;
    created_at: string;
}
