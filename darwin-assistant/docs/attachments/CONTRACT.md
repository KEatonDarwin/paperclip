# Chat file attachments — backend contract (tree-9b58ddb7)

Kevin's ask: *"I need a way to easily add files to the chat … these should
'upload' to you and go into a folder or something local that is earmarked with
the chat in question, and I need to be able to see/view the files inside of the
chat … and in the settings … a new tab where I can look at the files we have
and manage them."*

This is the backend half (node #1392). The cockpit UI (composer chip row,
in-thread file list, Settings → Files tab) is a separate node and consumes
exactly what's below.

## 1. Where the bytes live

```
uploads/<conversationId>/              <- images (DAR-744, unchanged)
uploads/<conversationId>/files/<uuid>.<ext>   <- attachments (new)
```

`uploads/` is `JARVIS_UPLOADS_DIR` or `<darwin-assistant>/uploads`, shared with
`image-store.ts`. The `files/` subdirectory exists so attachment names can
never collide with the flat image filenames already in that directory.

The stored filename is always a server-generated `<uuid>.<ext>`. The name Kevin
chose is display metadata on the row and is **never** used as a path component.

## 2. Table: `attachments`

Declared in `conversation-db.ts` (in the eager `db.exec` block, same reason as
`conversation_groups`). Dropped — rows **and** `uploads/<id>/files/` — by
`deleteConversation`.

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | |
| `conversation_id` | INTEGER NOT NULL → conversations(id) | indexed with `id` |
| `original_name` | TEXT NOT NULL | what Kevin sees |
| `stored_filename` | TEXT NOT NULL | `<uuid>.<ext>` on disk |
| `mime` | TEXT NOT NULL | canonical, resolved server-side |
| `bytes` | INTEGER NOT NULL | decoded size |
| `kind` | TEXT NOT NULL | `text` \| `binary` \| `image` |
| `source` | TEXT NOT NULL DEFAULT `'chat'` | `chat` \| `settings` |
| `turn_index` | INTEGER NULL | null until the file rides on a sent message |
| `created_at` / `updated_at` | TEXT | |

Accessors (all in `conversation-db.ts`): `insertAttachment`, `getAttachment`,
`listAttachments`, `listAttachmentsForTurn`, `updateAttachment`,
`setAttachmentTurnIndex`, `deleteAttachment`, `listAllAttachments`.

## 3. Routes (all under `/api/v1`, all bearer-authed)

Every thread-scoped route runs `findConversationForCaller` first, then
re-checks that the row's `conversation_id` matches. An attachment id from
thread A is a **404** through thread B's URL — never a read.

| method | path | body / query | returns |
|---|---|---|---|
| POST | `/threads/:external_id/attachments` | `{name, mime, data}` (base64, `data:` URL ok), optional `source:'settings'` | `201 {attachment}` |
| GET | `/threads/:external_id/attachments` | — | `{attachments: [...]}` |
| GET | `/threads/:external_id/attachments/:id/download` | — | the bytes, `Content-Type: <mime>`, `Content-Disposition: inline; filename="<original>"`, `X-Content-Type-Options: nosniff` |
| PUT | `/threads/:external_id/attachments/:id` | `{name?}` and/or `{data, mime?}` | `{attachment}` |
| DELETE | `/threads/:external_id/attachments/:id` | — | `{status:'deleted', id}` |
| GET | `/attachments` | `?external_id=` `?limit=` (default 500, max 2000) | `{attachments: [...]}` each **also** carrying `conversation_id`, `conversation_external_id`, `conversation_title` |

Serialized attachment shape:

```json
{ "id": 12, "name": "notes.md", "mime": "text/markdown", "bytes": 2048,
  "kind": "text", "source": "chat", "turn_index": 3,
  "created_at": "...", "updated_at": "...",
  "download_url": "/threads/cockpit%3Aabc/attachments/12/download" }
```

`download_url` is relative on purpose — the cockpit prefixes `/cockpit-api`
(see `turnImageSrc` in `routes/threads.tsx`) so the browser never holds a bearer.

`GET /attachments` is scoped like `/decisions`: an admin-scope key sees
everything, a narrower key only its own `external_id` prefix.

Error codes: `invalid_request` (400), `invalid_attachment` (400, bad
type/size/base64), `attachment_not_found` (404), plus the usual
`thread_not_found` / `thread_not_owned_by_caller`.

## 4. Allowed types

An **allowlist**, not a denylist (`attachment-store.ts`):

- text/docs: `txt` `log` `md` `markdown` `mdx` `html` `htm` `csv` `tsv` `json`
  `xml` `yaml` `yml` `css` `pdf`
- images: `png` `jpg/jpeg` `webp` `gif` (same set `image-store.ts` takes)

Resolution order: a known mime wins → else the file **extension** (because
Chrome/Windows routinely hand up `application/octet-stream` for `.md`, which
is exactly Kevin's headline case) → else a generic `text/*` is accepted as
`text/plain`. Anything else is a 400.

`DENIED_EXT` refuses executables and scripts (`exe sh bat ps1 js py rb php
jar …`) even when the mime looks fine — `text/*` otherwise covers
`text/x-shellscript`. SVG is deliberately **not** allowed: it is
script-capable markup and would be served from the cockpit's own origin.

Per-file cap: `MAX_ATTACHMENT_BYTES` = 25MB decoded. Base64 inflates by 4/3, so
an at-cap file arrives as a ~33.4MB body — which is why
`express.json({limit})` in `ui-server.ts` was raised 30mb → **40mb**. Raise one
without the other and at-cap uploads 413 before any handler runs.

## 5. "Upload to you" — inline on send

`POST /threads/:external_id/messages` takes an optional `attachment_ids:
number[]`.

- Ids are ownership-checked. A foreign or unknown id is a **404** for the whole
  send (not silently dropped) — a message that reaches the model without the
  file it was about is worse than an error.
- Each accepted row gets `turn_index` stamped with the turn it rode on.
- `buildAttachmentModelBlock` renders the files into the text the **model**
  receives:
  - `kind: 'text'` → a fenced block, capped at `MAX_INLINE_TEXT_BYTES` (200KB)
    with an explicit truncation note:
    ````
    ```file: notes.md
    # Notes
    …
    ```
    ````
  - `kind: 'binary' | 'image'` → one line: `attached file: deck.pdf
    (application/pdf, 1234 bytes) — not inlined; ask if you need its contents`
- The block is passed as `processMessage(..., { modelInputSuffix })` and is
  appended to **`modelInput` only** — the same split plan mode already uses.
  The persisted user turn keeps showing exactly what Kevin typed, so a 200KB
  upload is never pasted into the visible transcript nor replayed in every
  later continuation prompt.
- Queued sends (a turn already running) persist the ids in
  `thread_message_queue.attachment_ids` and re-resolve them on drain, so a file
  deleted while the message waited is skipped rather than resurrected.

**Images are untouched.** They still go through `image-store.ts` and the vision
path; this pipeline is additive.

## 6. Tests

`npm run attachments:check` — 10 checks against the real Express router on a
throwaway port, a scratch DB and a scratch uploads dir
(`scripts/attachments-check.mjs`). Covers the auth gate, storage layout, mime
resolution and rejections, download headers, **cross-thread isolation**,
rename/replace, delete-removes-bytes, the cross-thread list, the model block
(inline/reference/truncate), and `attachment_ids` validation + turn stamping.
