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
- `POST /v6/support/tickets/:ticketId/responses` — add a reply
- `POST /v6/support/tickets/:ticketId/read` — mark the ticket and current
  replies read
- `POST|DELETE /v6/support/tickets/:ticketId/assignees/me` — assign or
  unassign the current Support Team user
- `POST /v6/support/tickets/:ticketId/close` — close a ticket as Support Team

Interactive OpenAPI documentation is served at
`/v6/support/api-docs`.

Member visibility is always derived from the authenticated JWT. A member
cannot expand visibility by supplying another member ID or a staff-only filter.
Role checks for `Topcoder Support Team` are case-insensitive, while preserving
the role as one multi-word value.

## Data model and unread behavior

Prisma owns a dedicated PostgreSQL `support` schema. The initial migration
creates tickets, chronologically ordered responses, many-to-many assignees,
ticket read states, response read receipts, and a notification outbox.

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
and SSM values. Run a controlled one-off task from the released image with
`./node_modules/.bin/prisma migrate deploy`; the image includes the CLI and
migrations for that purpose. API Gateway must map `/v6/support` to the target
group.

Serving Platform UI at `support.topcoder.com` is a separate infrastructure
step: configure DNS, certificate, CloudFront alternate domain and SPA fallback,
the authentication return URL, and API CORS. Use
`SUPPORT_APP_BASE_URL` per environment so notification links never point from a
development event to production.
