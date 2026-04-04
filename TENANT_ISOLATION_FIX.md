# TASK — Sigcore: Fix Tenant Isolation on Conversations

## Problem

Tenant-scoped API keys (`sc_tenant_*`) return ALL conversations in the workspace, not just the ones belonging to that tenant. This means when Service Flow syncs via its tenant key, it sees Callio's conversations too.

## Root Cause

The `communication_conversations` table has no `tenant_id` column. Everything is scoped only by `workspace_id`. The auth guard extracts `tenantId` from the API key but no downstream code uses it.

## Affected Files

| File | Issue | Line |
|------|-------|------|
| `backend/src/database/entities/communication-conversation.entity.ts` | No `tenantId` field | — |
| `backend/src/modules/communication/conversations.controller.ts` | No `@TenantId()` decorator extracted | 24-49 |
| `backend/src/modules/communication/communication.service.ts` | `getConversations()` WHERE only filters by `workspaceId` | 187 |
| `backend/src/modules/communication/communication.service.ts` | Sync creates conversations without `tenantId` | 1488-1506 |
| `backend/src/modules/communication/communication.service.ts` | Sync uses workspace-scoped `CommunicationIntegration` instead of `TenantIntegration` | 1272 |

## Required Changes

### 1. Database: Add `tenantId` to `communication_conversations`

```sql
ALTER TABLE communication_conversations ADD COLUMN tenant_id UUID;
CREATE INDEX idx_comm_conv_tenant ON communication_conversations(tenant_id);
```

### 2. Entity: Add field

In `communication-conversation.entity.ts`:
```typescript
@Column({ name: 'tenant_id', nullable: true })
@Index()
tenantId: string | null;
```

### 3. Controller: Extract tenantId

In `conversations.controller.ts`, add `@TenantId()` decorator:
```typescript
@Get()
async getConversations(
  @WorkspaceId() workspaceId: string,
  @TenantId() tenantId: string | null,  // ADD THIS
  ...
) {
  const result = await this.communicationService.getConversations(workspaceId, {
    tenantId,  // PASS IT
    ...
  });
}
```

### 4. Service: Filter by tenantId

In `communication.service.ts`, add to the query builder:
```typescript
if (tenantId) {
  queryBuilder.andWhere('conv.tenantId = :tenantId', { tenantId });
}
```

### 5. Sync: Save tenantId on conversations

When creating/updating conversations during sync, include `tenantId`:
```typescript
conversation = this.conversationRepo.create({
  workspaceId,
  tenantId,  // ADD THIS
  externalId: convData.externalId,
  ...
});
```

### 6. Migration: Backfill existing conversations

Associate existing conversations with tenants based on phone number ownership:
- Query `tenant_phone_numbers` to map phone numbers to tenants
- Update `communication_conversations.tenant_id` where `phone_number` matches

## Impact

- **Service Flow**: Currently works around this with phone number filtering (SF-level guard)
- **Callio**: May also be affected — could see SF conversations
- **LeadBridge**: Same workspace, same issue potential

## Priority

Medium — SF has a workaround. Fix when working on Sigcore next.

## Related

- `MULTI_TENANT_FIX.md` in Sigcore repo documents the same pattern
- The `@TenantId()` decorator exists at `backend/src/decorators/workspace-id.decorator.ts:10-15` but is unused in conversations
