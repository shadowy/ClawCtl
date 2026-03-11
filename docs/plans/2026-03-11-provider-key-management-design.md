# Provider Key Management Design

Date: 2026-03-11

## Problem

ClawSafeMng's model provider tab does not track API key validity. Users cannot tell if a key has expired, and there's no way to manage multiple keys per provider. Adding a new key blindly overwrites the existing one.

## Requirements

1. **Multiple keys per provider**: same provider can have multiple API keys side by side
2. **Key validity detection**: verify keys by calling provider API (e.g., `GET /v1/models`) via SSH on the OpenClaw machine
3. **Visual status indicators**: valid / invalid / unknown with error messages
4. **Delete any key**: valid or invalid, user can delete
5. **Smart add behavior**: new keys are appended (not overwriting valid ones)
6. **Account info**: capture email/org during verification, store and display
7. **Usage display**: show per-provider usage totals on provider cards (from existing gateway usage data)
8. **Auto-refresh**: keys cached > 1 hour are re-verified in background when the models tab opens; manual refresh button available

## Data Model

### auth-profiles.json (unchanged, OpenClaw native format)

```json
{
  "version": 1,
  "profiles": {
    "openai:default": { "type": "api_key", "provider": "openai", "key": "sk-xxx" },
    "openai:key2": { "type": "api_key", "provider": "openai", "key": "sk-yyy" },
    "anthropic:default": { "type": "api_key", "provider": "anthropic", "key": "sk-ant-xxx" }
  },
  "order": { "openai": ["openai:default", "openai:key2"] }
}
```

Profile ID format: `<provider>:<identifier>` (e.g., `openai:default`, `openai:key2`, `openai:key3`).

### New SQLite table: provider_keys

```sql
CREATE TABLE IF NOT EXISTS provider_keys (
  instance_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  key_masked TEXT,
  status TEXT DEFAULT 'unknown',  -- 'valid' | 'invalid' | 'unknown'
  checked_at TEXT,
  error_message TEXT,
  email TEXT,
  account_info TEXT,              -- JSON: org, plan, etc.
  PRIMARY KEY (instance_id, profile_id)
);
```

No plaintext keys stored in SQLite. Only masked version (last 4 chars) for display. Actual keys always read from remote auth-profiles.json.

## Backend API

### Modified endpoint

**`PUT /lifecycle/{id}/providers`** — add a provider key:
- Validate key via SSH curl on OpenClaw machine before writing
- On success: write to auth-profiles.json for all agents, update `order` array, update provider_keys cache
- On failure: return error with reason, do not write
- Auto-generate profile ID: `<provider>:default` for first key, `<provider>:key2`, `key3`... for subsequent
- Duplicate detection: read existing auth-profiles.json and compare full plaintext key values, reject if duplicate

### New endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/lifecycle/{id}/keys` | GET | List all profiles with masked key + cached status + email. Returns immediately with cached data. |
| `/lifecycle/{id}/keys/refresh` | POST | Trigger background re-verification of all stale (>1h) keys. Returns immediately, frontend polls for updated status. |
| `/lifecycle/{id}/keys/:profileId/verify` | POST | Manually re-verify a single key. `profileId` passed URL-encoded (e.g., `openai%3Adefault`). |
| `/lifecycle/{id}/keys/:profileId` | DELETE | Remove key from auth-profiles.json (all agents) + clean up `order`/`lastGood`/`usageStats` refs + clear cache. |

Note: Profile IDs contain colons. The `profileId` path parameter must be URL-encoded by the frontend (e.g., `openai%3Adefault`). Hono auto-decodes path params.

### Key verification

Verification runs **on the OpenClaw machine via SSH** (using CommandExecutor) to match the actual network environment.

**Security**: API keys must NOT be passed as command-line arguments (visible in `/proc/<pid>/cmdline`). Use temp file approach:

```bash
# Write key to temp file
echo '<key>' > /tmp/.clawctl-verify-key && \
curl -s -o /tmp/.clawctl-verify-out -w '%{http_code}' -m 10 \
  -H "Authorization: Bearer $(cat /tmp/.clawctl-verify-key)" \
  <baseUrl>/v1/models ; \
rm -f /tmp/.clawctl-verify-key
```

For providers using non-Bearer auth (Anthropic: `x-api-key`, Google: query param), adjust accordingly.

200 → valid, 401/403 → invalid, timeout/other → unknown.

For local instances (`local-*`), curl runs directly on the ClawSafeMng host.

### Provider-specific verification

| Provider | Verify endpoint | Auth method | Account info endpoint |
|----------|----------------|-------------|----------------------|
| OpenAI | `GET /v1/models` | `Bearer <key>` | `GET /v1/me` (email, org) |
| Anthropic | `GET /v1/models` | `x-api-key: <key>` | N/A |
| Google (Gemini) | `GET /v1beta/models?key=<key>` | Query param | N/A |
| Mistral | `GET /v1/models` | `Bearer <key>` | N/A |
| DeepSeek | `GET /v1/models` | `Bearer <key>` | `GET /v1/user/balance` |
| Groq | `GET /v1/models` | `Bearer <key>` | N/A |
| Together | `GET /v1/models` | `Bearer <key>` | N/A |
| Cohere | `GET /v2/models` | `Bearer <key>` | N/A |
| Other (has baseUrl) | `GET /v1/models` | `Bearer <key>` | N/A |
| Unknown (no baseUrl) | skip | mark `unknown` | N/A |

Account info is best-effort: if the endpoint fails or isn't available, just skip it.

### Credential type handling

OpenClaw supports 3 credential types in auth-profiles.json:

- **`api_key`**: has `key` field. Standard add/delete/verify flow.
- **`token`**: has `token` field (non-refreshable bearer). Same verify flow, use `token` instead of `key`.
- **`oauth`**: has `access`/`refresh`/`expires` fields. Display-only in UI (status + email). No add/delete key buttons — managed by OpenClaw's OAuth flow.

### Usage data

Per-provider usage totals come from the **existing** `usage.query` Gateway RPC, which is already fetched for the models tab. Group by provider name and sum tokens/cost. No new endpoint needed.

## Frontend UI

### Models tab — provider cards

```
大模型提供商                                    [+ 添加提供商]
┌──────────────────────────────────────────────────────┐
│ OpenAI   https://api.openai.com/v1                   │
│ 总用量: 13,463k tok  $27.49                           │
│                                                       │
│  sk-...xR1a  ✅ 有效  kris@example.com  2分钟前  [🔄] [🗑] │
│  sk-...mK2b  ❌ 已失效 "Invalid API key"  1小时前  [🔄] [🗑] │
│                                                       │
│  [+ 添加密钥]                                         │
├──────────────────────────────────────────────────────┤
│ Anthropic   https://api.anthropic.com/v1              │
│ 总用量: 0 tok  $0.00                                  │
│                                                       │
│  sk-ant-...j3c  ✅ 有效  team@company.com  1小时前 [🔄] [🗑] │
│                                                       │
│  [+ 添加密钥]                                         │
└──────────────────────────────────────────────────────┘
```

Each key row: masked key + status badge + email + last verified time + verify button + delete button.

Status colors: green `有效`, red `已失效` (with error), gray `未知`.

### Interactions

- **Add key**: input dialog → call `PUT /lifecycle/{id}/providers` → auto-verify on remote → success: refresh list / fail: show error, don't save
- **Delete key**: confirm dialog → `DELETE /lifecycle/{id}/keys/{profileId}` → refresh list
- **Verify key**: click 🔄 → `POST /lifecycle/{id}/keys/{profileId}/verify` → update status inline
- **Page load**: `GET /lifecycle/{id}/keys` returns cached data immediately. Frontend calls `POST /keys/refresh` which triggers background re-verification of stale keys. Frontend polls `GET /keys` every few seconds until all stale keys are refreshed.

### OAuth credentials (e.g., openai-codex)

Display-only: show status + email + expiry. No add/delete key buttons. Refresh/re-auth handled by OpenClaw's OAuth flow.

## Edge Cases

- **Network unreachable from OpenClaw machine**: verification returns non-200, non-401 → status = `unknown`, display "无法连接"
- **Delete last key of a provider**: provider card stays (openclaw.json still has config), shows "无密钥"
- **SSH connection failure**: return error to frontend, keep existing cached status
- **Duplicate key**: on add, read existing auth-profiles.json and compare full plaintext key values. Reject with error if same key already exists.
- **Local instances**: skip SSH, run curl directly on host
- **Delete cleanup**: when deleting a profile, also remove its references from `order`, `lastGood`, and `usageStats` fields in auth-profiles.json
- **Concurrent add requests**: read-modify-write of auth-profiles.json is serialized per instance (one request at a time via existing SSH connection pool)
- **Partial write failure**: if writing to some agents' auth-profiles.json fails (e.g., SSH timeout on agent 3 of 3), report partial success to frontend with details of which agents succeeded/failed
- **New agents added later**: new agents won't automatically get previously-added keys. This is a known limitation — user can re-add the key from the UI.

## i18n keys

New keys under `models.*` namespace:
- `models.keys.valid` / `models.keys.invalid` / `models.keys.unknown`
- `models.keys.addKey` / `models.keys.deleteKey` / `models.keys.verify`
- `models.keys.noKeys` / `models.keys.lastChecked`
- `models.keys.verifying` / `models.keys.deleteConfirm`
- `models.keys.totalUsage` / `models.keys.invalidError`
- `models.keys.addProvider` / `models.keys.providerName` / `models.keys.baseUrl`
- `models.keys.networkUnreachable` / `models.keys.duplicateKey`
- `models.keys.sshError` / `models.keys.partialSuccess`
- `models.keys.refreshing` / `models.keys.oauthManaged`

## Files to modify

### Backend
- `packages/server/src/instances/store.ts` — add `provider_keys` table
- `packages/server/src/api/lifecycle.ts` — modify PUT providers, add GET/POST/DELETE keys endpoints
- `packages/server/src/lifecycle/verify.ts` — new file: key verification logic via SSH curl (temp file for key security)
- `packages/server/src/lifecycle/config.ts` — add helper to delete a single profile from auth-profiles.json (including order/lastGood/usageStats cleanup)

### Frontend
- `packages/web/src/pages/Instance.tsx` — rewrite ModelsTab provider section with key cards
- `packages/web/src/locales/en.json` — add i18n keys
- `packages/web/src/locales/zh.json` — add i18n keys

### Tests
- `packages/server/src/api/__tests__/lifecycle-keys.test.ts` — new test file for key management endpoints
- `packages/web/src/pages/__tests__/Instance-models.test.tsx` — test models tab UI
