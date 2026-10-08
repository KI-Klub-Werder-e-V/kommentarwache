# Connectors

A connector reads comments from one platform and carries out actions there. Each one
declares what it can do; the action ladder never asks for more. Sources are polled every
two minutes by the worker, so no public URL is needed. Credentials are stored encrypted
with `KW_SECRET_KEY`.

```bash
kw source-add --kind youtube --name "club channel" \
  --config '{"channel_id":"UC..."}' \
  --secrets '{"client_id":"...","client_secret":"...","refresh_token":"..."}'
kw source-test --source "club channel"      # proves the credentials, lists capabilities
kw source modes --source "club channel" --hide dry_run --delete off --ban off
kw source-poll --source "club channel"      # one poll now
```

Every new source starts with all actions `off`. Choose the modes deliberately; a dry run
for a week or two shows in the dashboard what the system would have done.

| Kind        | Reads                             | Hide            | Delete               | Ban                      | Notes                                       |
| ----------- | --------------------------------- | --------------- | -------------------- | ------------------------ | ------------------------------------------- |
| `api`       | your site POSTs to `/v1/moderate` | via callback    | via callback         | via callback             | no platform approval needed                 |
| `youtube`   | polls `commentThreads`            | `heldForReview` | `rejected` (one-way) | `rejected` + `banAuthor` | 50 quota units per action                   |
| `facebook`  | polls the Page's posts            | `is_hidden`     | yes                  | block user               | Standard Access is enough for your own Page |
| `instagram` | polls the account's media         | `hide`          | yes                  | none                     | professional account                        |
| `fake`      | nothing                           | in memory       | in memory            | in memory                | demos and tests                             |

## Generic site (`api`)

Your site sends each new comment:

```http
POST /v1/moderate
Authorization: Bearer kw_...
Content-Type: application/json

{"source":"my-site","id":"comment-42","text":"...","author_ref":"user-7","permalink":"https://..."}
```

and gets the stage-1 verdict back at once. If the source has a callback URL, actions
come back as signed HTTP calls your site applies:

```bash
kw source-add --kind api --name my-site \
  --config '{"callback_url":"https://example.org/kw/actions"}' \
  --secrets '{"callback_secret":"a long random string"}'
```

```http
POST https://example.org/kw/actions
X-KW-Action: hide
X-KW-Signature: sha256=<hex HMAC-SHA256 of the raw body with callback_secret>

{"action":"hide","comment_id":"comment-42","author_ref":"user-7","thread_ref":null,"sent_at":"..."}
```

Verify the signature before applying anything. Actions: `hide`, `unhide`, `delete`,
`ban`, `unban`. Answer with any 2xx.

## YouTube

1. In Google Cloud, create a project, enable the YouTube Data API v3, and create an OAuth
   client (Desktop app). Add the scope `https://www.googleapis.com/auth/youtube.force-ssl`.
2. Authorise once as the channel owner and keep the refresh token. While the consent
   screen is in testing mode, refresh tokens expire after seven days; publishing the app
   and passing Google's verification for the sensitive scope removes that limit (allow a
   few weeks).
3. `kw source-add --kind youtube` with `channel_id` and the three secrets above.

Quota: polling costs 1 unit per page, a moderation call 50 units (one call can cover up
to 50 comments, but this connector sends one per action). The default 10,000 units a day
is enough for a club channel. YouTube cannot republish a rejected comment, so "delete"
here is permanent, while hide (`heldForReview`) is reversible.

## Facebook Page

1. Create a Meta app, add the Facebook Login product, and give every person who will use
   it a role on the app. With that, Standard Access covers your own Page; no App Review.
2. Get a Page access token with `pages_read_user_content`, `pages_manage_engagement` and
   `pages_manage_metadata` (Graph API Explorer works for the first token; exchange it for
   a long-lived one).
3. `kw source-add --kind facebook --config '{"page_id":"..."}' --secrets '{"page_access_token":"..."}'`.

Ban blocks the user from the Page (`/{page-id}/blocked`) and can be undone.

## Instagram

1. The account must be a professional account. Use either Instagram Login
   (`instagram_business_manage_comments`, API host `https://graph.instagram.com`) or
   Facebook Login on the linked Page (`instagram_manage_comments`).
2. `kw source-add --kind instagram --config '{"ig_user_id":"...","api_host":"https://graph.instagram.com"}' --secrets '{"access_token":"..."}'`.

Instagram offers hide and delete; there is no block endpoint, so the ladder's ban step
becomes a proposal for a human. Comments by the account owner cannot be hidden.

## What is not verified yet

The API shapes above follow the official documentation as of October 2026 and are
covered by tests against recorded responses, not yet by a run on a real account. The
first live run on your own accounts is the milestone-5 check: a test comment appears,
its link opens, hide and unhide round-trip.
