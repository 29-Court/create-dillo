const INTERNAL_SCHEMA = {
  users: {
    table: "_armadillo_users",
    migration: "0001_base.sql",
    purpose: "Authenticated application identities and password credentials.",
    columns: [
      "app_id",
      "id",
      "email",
      "name",
      "password_hash",
      "password_salt",
      "password_iterations",
      "created_at",
      "updated_at",
      "password_enabled",
      "profile_photo_id",
      "profile"
    ],
    primaryKey: ["app_id", "id"],
    indexes: []
  },
  sessions: {
    table: "_armadillo_sessions",
    migration: "0001_base.sql",
    purpose: "Hashed bearer sessions with expiration and user ownership.",
    columns: ["app_id", "id", "token_hash", "user_id", "created_at", "expires_at", "auth_method"],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_sessions_user", columns: ["app_id", "user_id"] },
      { name: "_armadillo_sessions_expiry", columns: ["expires_at"] }
    ]
  },
  objects: {
    table: "_armadillo_objects",
    migration: "0001_base.sql",
    purpose: "JSON application documents. owner_id and group_id are the indexed access keys.",
    columns: ["app_id", "collection", "id", "owner_id", "data", "created_at", "updated_at", "group_id"],
    primaryKey: ["app_id", "collection", "id"],
    indexes: [
      {
        name: "_armadillo_objects_owner",
        columns: ["app_id", "collection", "owner_id", "created_at"]
      },
      {
        name: "_armadillo_objects_group",
        columns: ["app_id", "collection", "group_id", "created_at"],
        migration: "0011_group_projection.sql"
      }
    ]
  },
  files: {
    table: "_armadillo_files",
    migration: "0001_base.sql",
    purpose: "Owner-scoped metadata for file bodies stored by the active adapter.",
    columns: [
      "app_id",
      "id",
      "owner_id",
      "storage_key",
      "name",
      "content_type",
      "size",
      "etag",
      "created_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_files_owner", columns: ["app_id", "owner_id", "created_at"] }
    ]
  },
  groups: {
    table: "_armadillo_groups",
    migration: "0002_groups_events.sql",
    purpose: "Application groups, including the trust boundary for privileged functions.",
    columns: ["app_id", "id", "name", "slug", "trusted", "created_by", "created_at"],
    primaryKey: ["app_id", "id"],
    indexes: []
  },
  groupMembers: {
    table: "_armadillo_group_members",
    migration: "0002_groups_events.sql",
    purpose: "User roles within application groups.",
    columns: ["app_id", "group_id", "user_id", "role", "created_at", "updated_at"],
    primaryKey: ["app_id", "group_id", "user_id"],
    indexes: [
      {
        name: "_armadillo_group_members_user",
        columns: ["app_id", "user_id", "group_id"]
      }
    ]
  },
  events: {
    table: "_armadillo_events",
    migration: "0002_groups_events.sql",
    purpose: "Group-visible application events with their authenticated actor.",
    columns: ["app_id", "id", "group_id", "type", "actor_id", "data", "created_at"],
    primaryKey: ["app_id", "id"],
    indexes: [
      {
        name: "_armadillo_events_group_time",
        columns: ["app_id", "group_id", "created_at"]
      }
    ]
  },
  schemaState: {
    table: "_armadillo_schema_state",
    migration: "0003_schema_state.sql",
    purpose: "The last application-schema snapshot accepted by the Armadillo CLI.",
    columns: ["app_id", "schema_json", "checksum", "applied_at"],
    primaryKey: ["app_id"],
    indexes: []
  },
  magicLinks: {
    table: "_armadillo_magic_links",
    migration: "0004_pre_publish_primitives.sql",
    purpose: "Hashed, short-lived, single-use passwordless authentication challenges.",
    columns: [
      "app_id",
      "id",
      "token_hash",
      "user_id",
      "requested_email",
      "redirect_url",
      "created_at",
      "expires_at",
      "consumed_at",
      "consumed_by_session"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_magic_links_expiry", columns: ["expires_at"] },
      { name: "_armadillo_magic_links_user", columns: ["app_id", "user_id", "created_at"] }
    ]
  },
  vouchers: {
    table: "_armadillo_vouchers",
    migration: "0004_pre_publish_primitives.sql",
    purpose: "Owner-scoped finite-capacity redeemable vouchers.",
    columns: [
      "app_id",
      "id",
      "owner_id",
      "name",
      "code_hash",
      "code_prefix",
      "capacity",
      "remaining",
      "expires_at",
      "created_at",
      "updated_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_vouchers_owner", columns: ["app_id", "owner_id", "created_at"] },
      { name: "_armadillo_vouchers_expiry", columns: ["expires_at"] }
    ]
  },
  voucherRedemptions: {
    table: "_armadillo_voucher_redemptions",
    migration: "0004_pre_publish_primitives.sql",
    purpose: "Idempotent voucher-consumption ledger whose insert trigger decrements stock atomically.",
    columns: ["app_id", "id", "voucher_id", "idempotency_key", "consumed_by", "consumed_at"],
    primaryKey: ["app_id", "id"],
    indexes: [
      {
        name: "_armadillo_voucher_redemptions_voucher",
        columns: ["app_id", "voucher_id", "consumed_at"]
      }
    ]
  },
  apiKeys: {
    table: "_armadillo_api_keys",
    migration: "0004_pre_publish_primitives.sql",
    purpose: "Hashed, individually revocable machine credentials with scopes, rotation, and audit metadata.",
    columns: [
      "app_id",
      "id",
      "owner_id",
      "name",
      "key_hash",
      "key_prefix",
      "scopes",
      "created_at",
      "expires_at",
      "last_used_at",
      "revoked_at",
      "description",
      "rotated_from",
      "grace_expires_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_api_keys_owner", columns: ["app_id", "owner_id", "created_at"] },
      { name: "_armadillo_api_keys_expiry", columns: ["expires_at"] },
      {
        name: "_armadillo_api_keys_grace_expiry",
        columns: ["grace_expires_at"],
        migration: "0008_api_key_lifecycle.sql"
      }
    ]
  },
  apiKeyAudit: {
    table: "_armadillo_api_key_audit",
    migration: "0009_api_key_audit.sql",
    purpose: "Named API-key lifecycle events without recording plaintext credentials.",
    columns: ["app_id", "id", "key_id", "actor_id", "event_type", "details", "created_at"],
    primaryKey: ["app_id", "id"],
    indexes: [{ name: "_armadillo_api_key_audit_key", columns: ["app_id", "key_id", "created_at"] }]
  },
  bootstrap: {
    table: "_armadillo_bootstrap",
    migration: "0004_pre_publish_primitives.sql",
    purpose: "Database-burned record that the application has an owner. The secret is stored only as a hash.",
    columns: ["app_id", "secret_hash", "user_id", "group_id", "used_at", "schema_version"],
    primaryKey: ["app_id"],
    indexes: []
  },
  rateLimits: {
    table: "_armadillo_rate_limits",
    migration: "0004_pre_publish_primitives.sql",
    purpose: "Fixed-window abuse controls for authentication and mutation endpoints.",
    columns: ["key_hash", "count", "reset_at", "updated_at"],
    primaryKey: ["key_hash"],
    indexes: [{ name: "_armadillo_rate_limits_expiry", columns: ["reset_at"] }]
  },
  mailJobs: {
    table: "_armadillo_mail_jobs",
    migration: "0004_pre_publish_primitives.sql",
    purpose: "Observable delivery state for queued mail without retaining recipient plaintext.",
    columns: [
      "app_id",
      "id",
      "kind",
      "recipient_hash",
      "status",
      "attempts",
      "last_error",
      "created_at",
      "updated_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [{ name: "_armadillo_mail_jobs_status", columns: ["status", "updated_at"] }]
  },
  fileUploads: {
    table: "_armadillo_file_uploads",
    migration: "0004_pre_publish_primitives.sql",
    purpose: "Short-lived direct and multipart object-storage upload intents.",
    columns: [
      "app_id",
      "id",
      "owner_id",
      "storage_key",
      "name",
      "content_type",
      "expected_size",
      "kind",
      "r2_upload_id",
      "status",
      "created_at",
      "expires_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_file_uploads_owner", columns: ["app_id", "owner_id", "created_at"] },
      { name: "_armadillo_file_uploads_expiry", columns: ["expires_at"] }
    ]
  },
  fileLinks: {
    table: "__armadillo_file_link",
    migration: "0005_physical_schema_files.sql",
    purpose: "Hidden record-to-file indirection for declared fields and arbitrary attachments.",
    columns: [
      "app_id",
      "collection",
      "object_id",
      "file_id",
      "owner_id",
      "relation",
      "field_name",
      "position",
      "created_at"
    ],
    primaryKey: ["app_id", "collection", "object_id", "file_id", "relation", "field_name"],
    indexes: [
      {
        name: "__armadillo_file_link_record",
        columns: ["app_id", "collection", "object_id", "relation", "position", "created_at"]
      },
      { name: "__armadillo_file_link_file", columns: ["app_id", "file_id"] }
    ]
  },
  collectorSubmissions: {
    table: "_armadillo_collector_submissions",
    migration: "0006_collectors.sql",
    purpose: "Typed, expiring form submissions routed to an authorized team inbox.",
    columns: [
      "app_id",
      "id",
      "collector_id",
      "user_id",
      "group_id",
      "project_id",
      "data",
      "created_at",
      "expires_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      {
        name: "_armadillo_collector_submissions_inbox",
        columns: ["app_id", "collector_id", "group_id", "created_at"]
      },
      { name: "_armadillo_collector_submissions_expiry", columns: ["expires_at"] }
    ]
  },
  tickets: {
    table: "_armadillo_tickets",
    migration: "0006_collectors.sql",
    purpose: "Team-governed, single-use tickets with optional holder and event links.",
    columns: [
      "app_id",
      "id",
      "owner_id",
      "team_id",
      "holder_id",
      "label",
      "event_id",
      "code_hash",
      "code_prefix",
      "metadata",
      "expires_at",
      "consumed_at",
      "consumed_by",
      "created_at",
      "updated_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_tickets_team", columns: ["app_id", "team_id", "created_at"] },
      { name: "_armadillo_tickets_holder", columns: ["app_id", "holder_id", "created_at"] },
      { name: "_armadillo_tickets_expiry", columns: ["expires_at"] }
    ]
  },
  ticketConsumptions: {
    table: "_armadillo_ticket_consumptions",
    migration: "0006_collectors.sql",
    purpose: "Immutable, idempotent ledger for atomic ticket consumption.",
    columns: ["app_id", "id", "ticket_id", "idempotency_key", "consumed_by", "consumed_at"],
    primaryKey: ["app_id", "id"],
    indexes: [
      {
        name: "_armadillo_ticket_consumptions_actor",
        columns: ["app_id", "consumed_by", "consumed_at"]
      }
    ]
  },
  ticketTokens: {
    table: "_armadillo_ticket_tokens",
    migration: "0016_ticket_tokens.sql",
    purpose: "Single-use inventory tokens for a tickets field. The raw token is never stored.",
    columns: [
      "app_id",
      "token_hash",
      "collection",
      "field",
      "record_id",
      "consumed_at",
      "consumed_by",
      "claim_id",
      "created_at"
    ],
    primaryKey: ["app_id", "token_hash"],
    indexes: [
      {
        name: "_armadillo_ticket_tokens_record",
        columns: ["app_id", "collection", "field", "record_id"]
      }
    ]
  },
  realtimeConnections: {
    table: "_armadillo_realtime_connections",
    migration: "0007_realtime_webhooks.sql",
    purpose: "Observable authenticated realtime connections and channel membership.",
    columns: ["app_id", "id", "user_id", "channels", "connected_at", "last_heartbeat"],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_realtime_connections_user", columns: ["app_id", "user_id", "connected_at"] },
      { name: "_armadillo_realtime_connections_heartbeat", columns: ["last_heartbeat"] }
    ]
  },
  webhookJobs: {
    table: "_armadillo_webhook_jobs",
    migration: "0007_realtime_webhooks.sql",
    purpose: "Signed, retryable outbound webhook work awaiting delivery.",
    columns: [
      "app_id",
      "id",
      "webhook_name",
      "url",
      "payload",
      "signature",
      "attempts",
      "max_attempts",
      "backoff",
      "initial_delay_ms",
      "next_retry_at",
      "last_status",
      "last_response",
      "created_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [{ name: "_armadillo_webhook_jobs_ready", columns: ["next_retry_at", "attempts"] }]
  },
  webhookDeliveries: {
    table: "_armadillo_webhook_deliveries",
    migration: "0007_realtime_webhooks.sql",
    purpose: "Immutable audit trail of webhook delivery attempts.",
    columns: [
      "app_id",
      "id",
      "job_id",
      "status",
      "response_status",
      "response_body",
      "delivered_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_webhook_deliveries_job", columns: ["app_id", "job_id", "delivered_at"] }
    ]
  },
  gdprConsents: {
    table: "_armadillo_gdpr_consents",
    migration: "0010_gdpr.sql",
    purpose: "Consent ledger per purpose (granted/revoked, auditable).",
    columns: ["app_id", "id", "user_id", "purpose", "granted", "metadata", "ip_hash", "user_agent", "created_at", "updated_at", "expires_at"],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_gdpr_consents_user", columns: ["app_id", "user_id", "updated_at"] },
      { name: "_armadillo_gdpr_consents_purpose", columns: ["app_id", "purpose"] }
    ]
  },
  gdprErasureLog: {
    table: "_armadillo_gdpr_erasure_log",
    migration: "0010_gdpr.sql",
    purpose: "Immutable log of erasure/anonymization requests.",
    columns: ["app_id", "id", "target_user_id", "actor_user_id", "strategy", "reason", "details", "created_at", "completed_at"],
    primaryKey: ["app_id", "id"],
    indexes: [{ name: "_armadillo_gdpr_erasure_log_target", columns: ["app_id", "target_user_id", "created_at"] }]
  },
  gdprRestrictions: {
    table: "_armadillo_gdpr_restrictions",
    migration: "0010_gdpr.sql",
    purpose: "Article 18 restriction flag per user.",
    columns: ["app_id", "user_id", "restricted", "reason", "updated_at", "updated_by"],
    primaryKey: ["app_id", "user_id"],
    indexes: []
  },
  gdprExportLog: {
    table: "_armadillo_gdpr_export_log",
    migration: "0010_gdpr.sql",
    purpose: "Audit log of data exports (right of access / portability).",
    columns: ["app_id", "id", "user_id", "actor_user_id", "created_at", "expires_at"],
    primaryKey: ["app_id", "id"],
    indexes: [{ name: "_armadillo_gdpr_export_log_user", columns: ["app_id", "user_id", "created_at"] }]
  },
  groupProjection: {
    table: "_armadillo_group_projection",
    migration: "0011_group_projection.sql",
    purpose: "Records which JSON team field has been copied into objects.group_id.",
    columns: ["app_id", "collection", "field"],
    primaryKey: ["app_id", "collection"],
    indexes: []
  },
  bootstrapSessions: {
    table: "_armadillo_bootstrap_sessions",
    migration: "0012_burrow.sql",
    purpose: "Short-lived hashed grants exchanged from the one-time bootstrap secret.",
    columns: ["app_id", "token_hash", "expires_at", "created_at"],
    primaryKey: ["app_id", "token_hash"],
    indexes: [{ name: "_armadillo_bootstrap_sessions_expiry", columns: ["expires_at"] }]
  },
  identities: {
    table: "_armadillo_identities",
    migration: "0012_burrow.sql",
    purpose: "Provider subject mapped to one Armadillo user. The subject is the stable identity, not the email.",
    columns: ["app_id", "provider", "subject", "user_id", "email", "created_at", "updated_at"],
    primaryKey: ["app_id", "provider", "subject"],
    indexes: [{ name: "_armadillo_identities_user", columns: ["app_id", "user_id"] }]
  },
  oauthStates: {
    table: "_armadillo_oauth_states",
    migration: "0012_burrow.sql",
    purpose: "Single-use OAuth state and PKCE verifier. The verifier is deleted when the callback is consumed.",
    columns: ["app_id", "state_hash", "provider", "verifier", "redirect_path", "expires_at", "created_at"],
    primaryKey: ["app_id", "state_hash"],
    indexes: [{ name: "_armadillo_oauth_states_expiry", columns: ["expires_at"] }]
  },
  audit: {
    table: "_armadillo_audit",
    migration: "0012_burrow.sql",
    purpose: "Operational events for setup, secret names, and sign-in. Secret values are never stored here.",
    columns: ["app_id", "id", "actor_id", "action", "subject", "created_at"],
    primaryKey: ["app_id", "id"],
    indexes: [{ name: "_armadillo_audit_recent", columns: ["app_id", "created_at"] }]
  },
  recordAudit: {
    table: "_armadillo_record_audit",
    migration: "0014_record_audit.sql",
    purpose: "Metadata-only record mutation trail: who changed which record, when. Record contents are never stored here.",
    columns: ["app_id", "id", "table_name", "record_id", "action", "actor_id", "created_at"],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_record_audit_recent", columns: ["app_id", "created_at"] },
      { name: "_armadillo_record_audit_record", columns: ["app_id", "table_name", "record_id", "created_at"] }
    ]
  },
  bridgeInvites: {
    table: "_armadillo_bridge_invites",
    migration: "0017_bridge.sql",
    purpose: "Hashed enrollment claim tickets. Raw tokens and API secrets are never stored.",
    columns: [
      "app_id",
      "id",
      "owner_id",
      "token_hash",
      "agent_class",
      "name",
      "scopes",
      "status",
      "fetch_count",
      "expires_at",
      "api_key_id",
      "approved_scopes",
      "created_at",
      "updated_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_bridge_invites_owner", columns: ["app_id", "owner_id", "created_at"] }
    ]
  },
  bridgeJobs: {
    table: "_armadillo_bridge_jobs",
    migration: "0017_bridge.sql",
    purpose: "One agent intent. Completion usage is whatever the agent sent.",
    columns: ["app_id", "id", "agent_id", "status", "action", "payload", "usage", "created_at", "updated_at"],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_bridge_jobs_agent", columns: ["app_id", "agent_id", "created_at"] }
    ]
  },
  bridgeEvents: {
    table: "_armadillo_bridge_events",
    migration: "0017_bridge.sql",
    purpose: "Append-only enrollment and security notes. Credentials are never stored.",
    columns: ["app_id", "id", "kind", "invite_id", "details", "created_at"],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_bridge_events_recent", columns: ["app_id", "created_at"] }
    ]
  },
  usageRollups: {
    table: "_armadillo_usage_rollups",
    migration: "0018_usage_metering.sql",
    purpose: "Daily UTC usage rollups per app. Counts only \u2014 no PII, record contents, or credentials.",
    columns: ["app_id", "day_utc", "metric", "amount", "updated_at"],
    primaryKey: ["app_id", "day_utc", "metric"],
    indexes: [
      { name: "_armadillo_usage_rollups_day", columns: ["app_id", "day_utc"] }
    ]
  },
  scheduleState: {
    table: "_armadillo_schedule_state",
    migration: "0019_scheduled_functions.sql",
    purpose: "Runtime pause/lease/next-due state for declared schedules. No secrets.",
    columns: [
      "app_id",
      "schedule_name",
      "paused",
      "next_due_at",
      "running_at",
      "running_run_id",
      "pending_attempt",
      "last_run_at",
      "updated_at"
    ],
    primaryKey: ["app_id", "schedule_name"],
    indexes: []
  },
  scheduleRuns: {
    table: "_armadillo_schedule_runs",
    migration: "0019_scheduled_functions.sql",
    purpose: "Append-only schedule run history. Outcomes and sanitized errors only \u2014 no record contents or credentials.",
    columns: [
      "app_id",
      "id",
      "schedule_name",
      "principal_type",
      "principal_id",
      "attempt",
      "started_at",
      "finished_at",
      "outcome",
      "error_summary",
      "created_at"
    ],
    primaryKey: ["app_id", "id"],
    indexes: [
      { name: "_armadillo_schedule_runs_schedule", columns: ["app_id", "schedule_name", "created_at"] },
      { name: "_armadillo_schedule_runs_outcome", columns: ["app_id", "outcome", "created_at"] }
    ]
  }
};
const INTERNAL_TABLES = {
  users: INTERNAL_SCHEMA.users.table,
  sessions: INTERNAL_SCHEMA.sessions.table,
  objects: INTERNAL_SCHEMA.objects.table,
  files: INTERNAL_SCHEMA.files.table,
  groups: INTERNAL_SCHEMA.groups.table,
  groupMembers: INTERNAL_SCHEMA.groupMembers.table,
  events: INTERNAL_SCHEMA.events.table,
  schemaState: INTERNAL_SCHEMA.schemaState.table,
  magicLinks: INTERNAL_SCHEMA.magicLinks.table,
  vouchers: INTERNAL_SCHEMA.vouchers.table,
  voucherRedemptions: INTERNAL_SCHEMA.voucherRedemptions.table,
  apiKeys: INTERNAL_SCHEMA.apiKeys.table,
  apiKeyAudit: INTERNAL_SCHEMA.apiKeyAudit.table,
  bootstrap: INTERNAL_SCHEMA.bootstrap.table,
  bootstrapSessions: INTERNAL_SCHEMA.bootstrapSessions.table,
  identities: INTERNAL_SCHEMA.identities.table,
  oauthStates: INTERNAL_SCHEMA.oauthStates.table,
  audit: INTERNAL_SCHEMA.audit.table,
  recordAudit: INTERNAL_SCHEMA.recordAudit.table,
  bridgeInvites: INTERNAL_SCHEMA.bridgeInvites.table,
  bridgeJobs: INTERNAL_SCHEMA.bridgeJobs.table,
  bridgeEvents: INTERNAL_SCHEMA.bridgeEvents.table,
  usageRollups: INTERNAL_SCHEMA.usageRollups.table,
  scheduleState: INTERNAL_SCHEMA.scheduleState.table,
  scheduleRuns: INTERNAL_SCHEMA.scheduleRuns.table,
  rateLimits: INTERNAL_SCHEMA.rateLimits.table,
  mailJobs: INTERNAL_SCHEMA.mailJobs.table,
  fileUploads: INTERNAL_SCHEMA.fileUploads.table,
  fileLinks: INTERNAL_SCHEMA.fileLinks.table,
  collectorSubmissions: INTERNAL_SCHEMA.collectorSubmissions.table,
  tickets: INTERNAL_SCHEMA.tickets.table,
  ticketConsumptions: INTERNAL_SCHEMA.ticketConsumptions.table,
  ticketTokens: INTERNAL_SCHEMA.ticketTokens.table,
  realtimeConnections: INTERNAL_SCHEMA.realtimeConnections.table,
  webhookJobs: INTERNAL_SCHEMA.webhookJobs.table,
  webhookDeliveries: INTERNAL_SCHEMA.webhookDeliveries.table,
  gdprConsents: INTERNAL_SCHEMA.gdprConsents.table,
  gdprErasureLog: INTERNAL_SCHEMA.gdprErasureLog.table,
  gdprRestrictions: INTERNAL_SCHEMA.gdprRestrictions.table,
  gdprExportLog: INTERNAL_SCHEMA.gdprExportLog.table,
  groupProjection: INTERNAL_SCHEMA.groupProjection.table
};
const SYSTEM_RESOURCES = {
  _User: {
    table: INTERNAL_TABLES.users,
    read: "admin",
    editable: false,
    visibleColumns: ["id", "email", "name", "created_at", "updated_at"],
    hiddenColumns: ["password_hash", "password_salt", "password_iterations"],
    fields: {
      email: { type: "email" },
      name: { type: "string" }
    }
  },
  _Team: {
    table: INTERNAL_TABLES.groups,
    read: "admin",
    editable: false,
    visibleColumns: ["id", "name", "slug", "trusted", "created_by", "created_at"],
    hiddenColumns: [],
    fields: {
      name: { type: "string" },
      slug: { type: "string" },
      trusted: { type: "boolean" }
    }
  },
  _File: {
    table: INTERNAL_TABLES.files,
    read: "admin",
    editable: false,
    visibleColumns: ["id", "owner_id", "name", "content_type", "size", "etag", "created_at"],
    hiddenColumns: ["storage_key"],
    fields: {
      name: { type: "string" },
      contentType: { type: "string" },
      size: { type: "integer" },
      ownerId: { type: "pointer", target: "_User" }
    }
  }
};
const DEFAULT_SYSTEM_RESOURCE_NAME = "_User";
const SYSTEM_RESOURCE_NAMES = Object.freeze(
  Object.keys(SYSTEM_RESOURCES)
);
function isSystemResourceName(value) {
  return Object.prototype.hasOwnProperty.call(SYSTEM_RESOURCES, value);
}
export {
  DEFAULT_SYSTEM_RESOURCE_NAME,
  INTERNAL_SCHEMA,
  INTERNAL_TABLES,
  SYSTEM_RESOURCES,
  SYSTEM_RESOURCE_NAMES,
  isSystemResourceName
};
