# HearthRoom integration operations

Version 0.6 connects the website to Hearthkeeper without a new listening port or an AI service. Website contracts and configuration are maintained in HearthRoom's `docs/community-integration.md`.

## Configure the Bot

Set the `COMMUNITY_*` values documented in `.env.example` in the private service environment. `COMMUNITY_SITE_URL` is the authorized HTTPS website origin. `COMMUNITY_BRIDGE_KEY` is an independent 64-character hexadecimal secret shared with the website, never a Discord token or case encryption key. `COMMUNITY_DATABASE_PATH` is an absolute durable path separate from the case database; include it in backup and restore operations. Do not copy production keys or actual role/member/channel IDs into this public repository.

`COMMUNITY_XP_CHANNELS` explicitly allowlists public normal text channels. The website must use the same list. The Bot independently excludes threads, non-public channels, bots, webhooks and system messages. The existing Guilds + GuildMessages intents suffice; Message Content and privileged Guild Members intents are not needed.

`COMMUNITY_ROLES` is a JSON array, maximum 25 unique roles. Each object has an `id` and exactly one condition:

- `level`: integer threshold from 1 to 1000; Discord-only XP roles remain after unlink.
- `badge`: a badge key from the website's catalog (lowercase letters, digits and underscores, up to 60 characters), for example `first_work` or a milestone such as `creator_featured`. The website projects every active award key; the Bot only mirrors the keys listed here, so add a rule per role you want displayed.
- `linked`: `true`, a display role for an active website link.

Use only Bot-managed **display** roles with zero permissions and no granting channel overwrites. Put them below the Bot and grant the Bot Manage Roles. Staff/admin/reviewer roles and managed integration roles are rejected. Never reuse the three case staff roles as a reward. Permissions and channel overwrites are read again on every projection. A missing/unsafe configuration reports denied instead of claiming success. Existing unrelated roles and pre-existing manually granted roles are preserved; only recorded Bot grants are removed.

Do not simply remove an assigned managed role from the mapping: first clean up its assignments through the authorized operational path, then retire it. Otherwise the controller intentionally blocks the cleanup receipt. A shared-key rotation must update both sides together. Run one Bot controller for the guild and preserve its local grant receipts.

`COMMUNITY_REVIEW_CHANNEL` is optional and must be a private normal text channel. A review reminder contains only the website queue link, never author information; Discord staff membership does not grant website reviewer rights. Individual community notifications use optional DMs and generic links. Existing case private conversations are configured separately with `CASE_PRIVATE_PARENT_ID`.

## Commands and delivery

Register commands from the same committed build after enabling the environment:

- `/link`: own link state and website account entry.
- `/level`: own XP, level and website profile entry.
- `/xp enabled:false` / `true`: stop/resume future chat XP.
- `/subscriptions`: website notification settings.
- `/card number:<public card number>`: current public, non-adult card preview.

All these command responses are ephemeral. Cases keep their existing commands and moderator workflow. Website-created cases enter the same CaseStore; the Bot only accepts a fresh signed lease and constructs a non-staff Discord actor. Case access checks, optimistic versions, cooldowns and durable operation replay remain active. Website replies carry no Discord moderation authority.

The Bot writes metadata events locally before delivery. A failed/paused XP endpoint does not stop unlink cleanup, case work or notifications. Role jobs re-read their current revision before mutations and acknowledge only after Discord member readback. A stale acknowledgement is rejected by the website.

## Rollout and evidence

1. Review and commit both repository changes with the anonymous project identity; synchronize and run both full trusted suites.
2. Deploy the website additive migration and exact pushed source with new ingestion disabled. Configure the OAuth redirect, client secret and independent bridge key privately.
3. Deploy the exact tested Bot source using the authorized host workflow; retain the old release and database backups. Do not treat source publication as a running release.
4. Configure the official invite, actual public XP channels and reviewed role IDs. Enable the website and Bot integration, then register the new commands.
5. With test accounts, prove direct OAuth binding, one-use return receipt, an allowed chat XP event, role readback, opted-in public badge, a website case, and unlink cleanup. Confirm another member cannot read that case. Check not-in-guild, role-permission failure and DM-disabled behavior.
6. Read `hearthkeeper_community_sync_total{outcome="synced|not_member|denied|failed"}` from the existing loopback `/metrics`; check the website's `hearthroom_community_requests_total`. No identity or private content appears in metric labels or error logs.

On rollback, disable new website ingestion first but keep the signed bridge and Bot cleanup lane alive until revocations receive durable readback. Do not stop the Bot or delete either database before cleanup. Queue/case results on the website expire after ten minutes, notifications after thirty days; local XP metadata expires after forty-eight hours and local delivery receipts after thirty days. Central XP and achievements retain their original owners.

The schema and code are additive. This document describes the required deployment path; it is not a claim that production has been configured or upgraded.

## 0.6.1 remaining-flow verification

Archived-thread forms reuse only their ephemeral source panel (`deferUpdate` then
`editReply`). Public-source forms still create an ephemeral reply. Actor, ownership,
version, expiry and replay checks remain in CaseStore. A parent-channel link on
persistent case panels provides a stable path to `/myreports` and `/cases`.

Counter `hearthkeeper_case_interactions_total{kind="command|button|modal",outcome="success|failure|denied"}`
records each handled interaction, including failures previously hidden by the UI
error fallback. Verify successful modal submissions and failure counts through the
loopback registry. No identifiers, message text or SDK payloads are logged.
MCP remains not applicable: this repairs Discord interaction acknowledgements;
website cases continue through the existing member-authorized bridge.

Release evidence must distinguish implementation from actual journeys: website case
creation and supplementation, feedback discussion/rejection, unlink role cleanup and
relink, and ordinary member A/B isolation. Never claim human isolation from an admin
session or fabricate production awards/notifications to make a check green.

## 0.7 supporter appearance

The controller publishes verified guild boosting status (`premiumSinceTimestamp`),
current global/guild avatars and equipped decoration asset hashes for active linked
members. The existing signed HTTPS bridge and per-link version protect ownership.
No new credential, inbound port, privileged intent or AI service is needed. Deploy
HearthRoom migration 0029 and its appearance-sync endpoint before this Bot release.
Linked subjects are periodically rechecked by the website pending queue (15 minutes),
and the existing website sync action requests an earlier check.

A successful member read publishes appearance before role safety operations; a role
permission failure cannot revoke a confirmed boost. Unknown Member on that initial
member read publishes absence; other Discord failures retain the last verified state.
The website bounds stale entitlements to 24 hours, enforces public appearance consent,
and keeps cosmetic preferences after entitlement loss. See the website's
`docs/community-appearance.md` for API, media, privacy and rollback contracts.
Existing `hearthkeeper_community_sync_total` records failures including bridge failures;
no member, asset or Discord identifier is logged. MCP remains not applicable to these
private member-session cosmetic choices.
