# PRIVATE-01 — Private report lifecycle

Use a configured guild and explicitly authorized test accounts. Prefix the report
title with `HK_TEST` and explain that staff do not need to investigate the fixture.
Keep account identifiers, channel identifiers and screenshots in private run
artifacts, never this public case library. Preserve the closed fixture for review.

## Natural path

1. Open `/feedback` (or Apps → Hearthkeeper → feedback), select a problem category,
   choose an identified private report, and submit a short title and body.
2. Refresh the report until the private-conversation link appears. Verify the
   forum and private thread use the submitted title, with the date in the message.
   The initial status is blue Waiting and the forum has the category tag.
3. Follow the private-conversation link. Confirm the reporter was added, upload
   a harmless text attachment, and verify its filename and preview in Discord.
4. With a staff account, reply in the conversation. Refresh the management panel;
   the initial waiting state must become white Processing.
5. Select orange technical waiting, provide a test reason, then refresh.
6. Close only. Independently read both threads: archived=true, locked=false.
7. From `/cases` in an open parent channel, select this fixture and open post
   management. Close and lock; expect yellow paused status and both flags true.
8. Restore; both threads must read archived=false, locked=false.
9. Lock only; both threads must read archived=false, locked=true.
10. Select PASS with a test-completion reason. After delivery, the forum must have
    PASS plus its category tag; both threads must be archived and locked. The
    private thread must retain invitable=false and the reporter membership.
11. Recheck readiness, forum/private readiness and both pending gauges. Pending
    work must drain to zero. Record failures separately from completed steps.

## Isolation acceptance

Repeat reporter steps with ordinary member A, not a moderator. Using a separate
ordinary member B, verify that neither channel discovery nor A's direct link
allows access. Confirm staff can access A's case. An administrator successfully
uploading a file is not proof of ordinary-member permissions or isolation.

## Diagnostic boundaries

- If a form in an archived thread fails, preserve the failure and use `/cases`
  in an open parent channel to continue. Do not repeatedly operate stale panels;
  record the archived-thread path as unresolved unless independently reproduced
  and fixed. Successful parent-channel controls do not erase that finding.
- Query one known reporter with Get Thread Member. A full thread-member listing
  has privileged-intent restrictions and is not required for this workflow; see
  [Discord channel API](https://docs.discord.com/developers/resources/channel#list-thread-members).
- The bot does not request Message Content. Verify a user's uploaded file in
  Discord's UI; an empty attachments array returned to the bot is not evidence
  that the file disappeared.
- If automation corrupts Discord's rich-text composer, reload and use the Apps
  launcher. Record the browser-tool failure separately from bot behavior.

Website linking, XP awards, achievement roles, feedback-only discussion/rejection,
anonymous reports and unlink cleanup are separate cases. This checklist is not
a claim that those flows or ordinary-member isolation have passed in production.
