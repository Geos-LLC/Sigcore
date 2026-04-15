# WhatsApp Media — Integration Guide for Service Flow

Sigcore handles all WhatsApp media storage and retrieval. Service Flow (and any other tenant client) consumes a single stable contract on every message — no guessing, no path construction, no polling.

## The contract

Every message returned by `GET /api/conversations/:id/messages` includes these top-level fields:

```ts
{
  id: "uuid",
  conversationId: "uuid",
  direction: "in" | "out",
  body: "📷 Photo",           // WhatsApp-style caption/label
  fromNumber: "+15551234567",
  toNumber:   "+15559876543",
  createdAt:  "2026-04-14T10:23:00Z",

  // ── WhatsApp media contract (always present) ──
  hasMedia:      true,                                   // boolean
  mediaType:     "image",                                // "image" | "video" | "audio" | "document" | null
  mediaMimetype: "image/jpeg",                           // string | null
  mediaFilename: "photo.jpg",                            // string | null
  mediaStatus:   "downloaded",                           // see enum below
  mediaUrl:      "/conversations/messages/<id>/media",   // string | null — RELATIVE path

  metadata: { /* internal; avoid depending on these directly */ }
}
```

### Rules
1. **Never infer media from `body`.** The 📷 emoji is just a caption — use `hasMedia`.
2. **Never construct media URLs.** Use `mediaUrl` verbatim. The path is stable; the storage location is not.
3. **Always surface `mediaStatus`** to your UI — it tells the user *why* media may be missing (size cap, LID chat, etc.).

## `mediaStatus` enum

| Value | What it means | UI action |
|---|---|---|
| `downloaded` | Media is available. Fetching `mediaUrl` will return the bytes. | Render the media. |
| `skipped_too_large` | File exceeded Sigcore's size cap (default 5 MB) during sync. No bytes stored. | Show "File too large (>5 MB)" placeholder. `hasMedia` will be `false`. |
| `unsupported_store_message` | LID-only chat — WhatsApp's Puppeteer store can't download. | Show a retry/tooltip: "Media unavailable for this chat type." `hasMedia` is `true` so users can see something happened. |
| `not_found` | WhatsApp returned no data. | Show generic "Media unavailable." |
| `failed` | Download or S3 upload errored. | Transient — the user can retry by hitting `mediaUrl` later (on-demand path will re-attempt). |

## Fetching the bytes

Call `GET <baseUrl><mediaUrl>` — e.g. `GET https://sigcore-production.up.railway.app/api/conversations/messages/<id>/media` — with your tenant API key:

```
GET /api/conversations/messages/<id>/media
x-api-key: sc_tenant_<your_key>
```

Response: raw binary bytes, with `Content-Type` set to the original mimetype (`image/jpeg`, `video/mp4`, `audio/ogg`, etc.) and `Cache-Control: public, max-age=86400`.

### ⚠️ Browser gotcha
**You cannot set the `<img src="...">` attribute directly to the media URL.** Browsers don't send custom auth headers (`x-api-key`) for `<img>`, `<video>`, or `<audio>` tags, so the request will return **401 Unauthorized** and the media will silently fail to load.

Two correct patterns:

### Option A — server-side proxy (recommended for SF web app)
Your SF backend proxies the Sigcore call. Your browser hits `https://app.serviceflow.com/api/media/<sigcoreMessageId>`; your backend adds the Sigcore key and pipes the response. This is the same pattern you already use for other authed assets.

### Option B — authed blob fetch in the browser
```ts
// inside a React component
const { data } = await sfApi.get(`/sigcore-media/${messageId}`, { responseType: 'blob' });
const objectUrl = URL.createObjectURL(data);
// render <img src={objectUrl} />
// revoke on unmount: URL.revokeObjectURL(objectUrl)
```
(This is what the Sigcore admin UI does — see `<AuthedMedia>` in `AdminWhatsAppTestPage.tsx`.)

## What happens under the hood

You don't need to know this to integrate, but for debugging:

1. **Real-time** — when a WhatsApp message arrives, the WhatsApp service downloads the media, size-checks it, and forwards base64 to Sigcore, which persists it to S3 at `s3://sigcore-whatsapp-media/whatsapp/<workspaceId>/<messageId>.<ext>`. The message is stored with `mediaS3Key` in metadata and `mediaSource='realtime'`.
2. **Sync** — on reconnect/resync, the same download runs for the last ~20 messages per chat, with adaptive throttle (250ms/media, 75ms/text). `mediaSource='sync'`.
3. **On-demand** — if a message exists without media (e.g. an old message predating this feature), the first call to `mediaUrl` triggers a lookup on WhatsApp (paged up to 500 messages, 3000ms timeout), saves to S3, then streams the bytes. Subsequent calls serve directly from S3. `mediaSource='on_demand'`.
4. **Reconnects** don't wipe data anymore — upsert by `providerMessageId`. Media in S3 survives Railway redeploys.

## Error handling

| Status | Meaning | What to do |
|---|---|---|
| 200 | Bytes returned | Render |
| 401 | Missing/invalid API key | Fix auth |
| 404 "No media for this message" | The message has no media attached. | Don't fetch — gate on `hasMedia` first. |
| 404 "Media no longer available" | WhatsApp has forgotten the media (old message, LID chat, etc.). | Surface `mediaStatus` to the user. |

## Quick integration checklist

- [ ] UI gates media rendering on `hasMedia` (not on `body` content)
- [ ] UI picks renderer based on `mediaType` (`image`/`video`/`audio`/`document`)
- [ ] Media URL is `mediaUrl` verbatim, never constructed
- [ ] Auth header is added (proxy or blob fetch — not bare `<img src>`)
- [ ] `mediaStatus` is surfaced for non-`downloaded` states
- [ ] File name (if present) is shown for documents: `mediaFilename`

## Related

- API docs: `/admin/api-docs` on the Sigcore dashboard — "WhatsApp Integration" category has a `📌 WhatsApp media contract` note at the bottom.
- Backend source:
  - `backend/src/modules/communication/message-media.mapper.ts` — builds the contract.
  - `backend/src/modules/communication/conversations.controller.ts` `getMessageMedia` — the media endpoint.
  - `backend/src/shared/storage/s3.service.ts` — S3 read/write.
- Contact: Sigcore team for auth key provisioning and tenant scoping.
