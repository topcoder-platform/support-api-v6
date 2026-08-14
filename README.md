# Topcoder Support API v6

NestJS service for member support tickets, replies, per-user read state, staff
assignment, closure, and durable email/Slack notifications.

## Routes

The service mounts all operations below `/v6/support`:

- `GET /v6/support/health` — database readiness
- `POST /v6/support/tickets` — open a ticket for the authenticated member
- `GET /v6/support/tickets` — list the member's tickets, or all tickets for a
  user with the `Topcoder Support Team` role
- `GET /v6/support/tickets/:ticketId` — get an authorized ticket timeline
- `POST /v6/support/tickets/:ticketId/responses` — add a member reply, or an
  assigned Support Team reply
- `POST /v6/support/tickets/:ticketId/read` — mark the ticket and current
  replies read
- `POST|DELETE /v6/support/tickets/:ticketId/assignees/me` — assign or
  unassign the current Support Team user
- `POST /v6/support/tickets/:ticketId/close` — close a ticket assigned to the
  current Support Team user

Interactive OpenAPI documentation is served at
`/v6/support/api-docs`.

Member visibility is always derived from the authenticated JWT. A member
cannot expand visibility by supplying another member ID or a staff-only filter.
Role checks for `Topcoder Support Team` are case-insensitive, while preserving
the role as one multi-word value.

## Opportunities: Contact the team contract

The Opportunities challenge-detail **Contact the team** dialog uses the
existing ticket-creation operation; it must not introduce another support
route:

```http
POST /v6/support/tickets
Authorization: Bearer <Topcoder member JWT>
Content-Type: application/json
```

```json
{
  "challengeId": "9f20b3ef-b052-4a0f-bfec-9a92ff385b0b",
  "description": "## Submission issue\n\nMy upload stalls after screening. [Diagnostic details](https://example.com/diagnostic)."
}
```

The JSON body contains only:

- `description` (required): Markdown text, trimmed by the API, from 1 through
  50,000 characters.
- `challengeId` (optional): the current v5 numeric or v6 UUID challenge ID, at
  most 64 characters and containing only letters, numbers, `_`, or `-`.

There is intentionally no subject, category, or files field. The Platform UI
should omit those controls and fields. Images or other assets inserted by the
Markdown editor are represented by their uploaded URLs in `description`; this
operation accepts JSON only and does not accept multipart uploads or attachment
metadata. Unknown fields such as `subject`, `category`, or `files` are rejected
with HTTP 400.

A successful request returns HTTP 201 with the newly created authorized ticket
detail. The ticket is open, owned by the JWT member, marked read for that member,
and initially has no replies or assignees:

```json
{
  "id": "82982c2e-c9b2-4874-823d-5ef53e6569a4",
  "memberUserId": "123456",
  "memberHandle": "member_handle",
  "memberHandleColor": "#2D7E2D",
  "challengeId": "9f20b3ef-b052-4a0f-bfec-9a92ff385b0b",
  "description": "## Submission issue\n\nMy upload stalls after screening. [Diagnostic details](https://example.com/diagnostic).",
  "status": "OPEN",
  "openedAt": "2026-08-13T01:23:45.000Z",
  "updatedAt": "2026-08-13T01:23:45.000Z",
  "latestActivityAt": "2026-08-13T01:23:45.000Z",
  "responseCount": 0,
  "hasUnread": false,
  "assignees": [],
  "readBy": [
    {
      "userId": "123456",
      "readAt": "2026-08-13T01:23:45.000Z"
    }
  ],
  "responses": []
}
```

Expected failure responses are:

- HTTP 400 for a missing, blank, non-string, or over-length `description`; an
  invalid `challengeId`; malformed JSON; or any unrecognized body field.
- HTTP 401 for a missing or invalid bearer token, or a human token without a
  user ID.
- HTTP 403 for a machine-to-machine token. This is a member-authored workflow.
- HTTP 5xx when a required Identity, database, or notification-enqueue
  dependency fails. The UI should keep the Markdown draft available for retry.

Notification delivery after the database commit is retried asynchronously and
does not turn an otherwise successful HTTP 201 response into a failure.

## Data model and unread behavior

Prisma owns a dedicated PostgreSQL `support` schema. The initial migration
creates tickets, chronologically ordered responses, many-to-many assignees,
ticket read states, response read receipts, and a notification outbox.
Closed ticket responses include the stored closer user ID for audit display.

An absent receipt means unread. List responses compare the caller's
`lastReadAt` with the latest request, response, or close activity. Opening or
writing a response marks that content read for its author. Loading a ticket
does not mutate state; clients explicitly call the `read` operation after a
successful load.

## Notifications

Notification intents are committed in the same database transaction as the
domain change. A multi-instance-safe outbox worker attempts delivery after the
commit and retries failed intents with capped exponential backoff.

- A new ticket emails all users currently assigned the
  `Topcoder Support Team` role and posts to Slack.
- A Support Team reply emails the member who opened the ticket.
- A ticket-owner reply to a closed ticket atomically reopens it, emails the
  Support Team, and posts to Slack.
- Closing a ticket emails the member and posts to Slack.
- Assigning a ticket to a Support Team member posts to Slack only, so the rest
  of the team sees who picked the ticket up.

Slack messages are multi-line: an event headline, the challenge as a link to
`CHALLENGE_APP_BASE_URL/challenges/{challengeId}` when the ticket has one, the
support ticket link, and — for a new ticket — the request body as a sanitized,
bounded plain-text preview.

Email is published through Bus API v6 to Kafka topic
`external.action.email`. `tc-bus-api-wrapper` appends `/bus/events`, so
`BUSAPI_URL` must be the API base ending in `/v6`, not an `/eventBus` or full
event URL. The outbound M2M client needs `write:bus_api`; role-recipient lookup
also needs `read:roles`.

Slack is posted from the ECS-hosted service using `chat.postMessage`, following
the existing Topcoder Leave API pattern. Both HTTP status and Slack's response
body `ok` flag are checked. Notification intents must commit atomically with the
ticket mutation; post-commit delivery failures are retried without changing the
successful ticket response. Logs exclude markdown, addresses, and secrets.

## Local development

```bash
nvm use
cp .env.example .env
pnpm install
pnpm prisma:migrate:deploy
pnpm start:dev
```

The Platform UI local proxy expects this service at port `3014`; set
`PORT=3014` locally if Platform UI is also running. The container defaults to
the ECS-configured port (normally `3000`).

Validation commands:

```bash
pnpm lint
pnpm test --runInBand
pnpm build
```

## Configuration

See `.env.example` for the complete list. Secrets such as
`AUTH0_CLIENT_SECRET` and `SLACK_BOT_KEY` must be stored as encrypted values and
must never be committed.

The four SendGrid dynamic-template IDs are:

- `SENDGRID_SUPPORT_NEW_TICKET_TEMPLATE_ID`
- `SENDGRID_SUPPORT_REPLY_TEMPLATE_ID`
- `SENDGRID_SUPPORT_REOPENED_TEMPLATE_ID`
- `SENDGRID_SUPPORT_CLOSED_TEMPLATE_ID`

Every template receives `ticketId`, `ticketUrl`, member/actor handles,
challenge context, and a bounded plain-text preview. The full markdown body is
not written to application logs. Known placeholder values such as `REPLACE_ME`
are rejected before Bus API publication.

Reopened-template data contains `ticketId`, `ticketUrl`, `memberHandle`,
`challengeId`, `responsePreview`, and `reopenedAt`. Notification failures retain
only outbox ID, channel, type, attempt, status, and a sanitized integration code;
provider messages, response bodies, addresses, markdown, and secrets are not
written to the database or logs.

## Deployment

CircleCI validates the service while building its image, then invokes the
shared Topcoder deployment suite with `APPNAME=support-api-v6` and platform
`FARGATE`. It reads:

- `/config/support-api-v6/deployvar`
- `/config/support-api-v6/appvar`
- `/config/common/global-appvar`

The pipeline deploys to an existing ECS service; it intentionally does not
provision infrastructure. Before the first deployment, operations must provide
the ECR repository, ECS service/task family, target group, database and secret,
and SSM values. Container startup applies pending Prisma migrations before the
API process starts; Prisma's advisory lock keeps concurrent ECS task starts
safe. API Gateway must map `/v6/support` to the target group.

Serving Platform UI at `support.topcoder.com` is a separate infrastructure
step: configure DNS, certificate, CloudFront alternate domain and SPA fallback,
the authentication return URL, and API CORS. Use
`SUPPORT_APP_BASE_URL` per environment so notification links never point from a
development event to production. `CHALLENGE_APP_BASE_URL` sets the Work app host
used for Slack challenge links and defaults to `https://work.topcoder.com`.
