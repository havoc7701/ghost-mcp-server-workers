# Ghost MCP Server for Cloudflare Workers

A Cloudflare Workers-native [Model Context Protocol](https://modelcontextprotocol.io/)
server for securely managing posts in [Ghost](https://ghost.org/). It provides a
small, post-only tool surface over the Ghost Admin API and is designed for remote
MCP clients, Cloudflare MCP Portals, and Workers Builds.

The reference deployment manages [Knowledge.Wine](https://knowledge.wine) at
`https://ghost-mcp.vkdesigns.com/mcp`.

## Features

- Runs natively on Cloudflare Workers using the Cloudflare Agents SDK.
- Uses short-lived, five-minute Ghost Admin API JWTs generated per request.
- Seals Worker-to-Ghost requests with a high-entropy `X-Seal-Probe` secret header.
- Requires bearer authentication at the MCP endpoint.
- Supports Cloudflare Access authentication in front of an MCP Portal.
- Returns allowlisted post fields instead of raw Ghost Admin API responses.
- Creates drafts by default and requires explicit confirmation to publish or schedule.
- Uses Ghost's `updated_at` value for optimistic locking.
- Requires explicit confirmation before permanent deletion.
- Retrieves bounded writing samples so clients can match an existing publication's style.

The server deliberately excludes pages, members, newsletters, users, integrations,
webhooks, themes, and arbitrary image uploads.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_posts` | Browse drafts, scheduled posts, and published posts. |
| `get_post` | Read editable post content by Ghost post ID. |
| `get_post_by_slug` | Read editable post content by URL slug. |
| `get_style_context` | Retrieve bounded samples of recently published writing. |
| `create_post` | Create a draft, scheduled, or published post from Markdown. |
| `update_post` | Update a post with optimistic locking. |
| `delete_post` | Permanently delete a post after explicit confirmation. |

## Architecture

```text
MCP client
  -> Cloudflare Access
  -> Cloudflare MCP Portal
  -> bearer-authenticated Cloudflare Worker /mcp
  -> Ghost Admin API
```

The reference deployment uses two independent authentication boundaries. Cloudflare
Access authenticates clients to the MCP Portal, while `MCP_API_TOKEN` authenticates
the Portal to the Worker upstream. Rotating the Worker bearer requires updating the
Portal upstream token; expired Access sessions require client reauthentication and
do not require changing the Worker secret.

AI Gateway is complementary but separate: it governs model inference traffic, not
MCP tool traffic or Worker-to-Ghost requests.

## Prerequisites

- A Cloudflare account with Workers enabled
- A Ghost site and a custom integration Admin API key
- Node.js and npm

Create the Ghost key under **Settings > Advanced > Integrations** in Ghost Admin.
Treat the key as a secret; it grants administrative access to posts.

## Configuration

Install dependencies:

```sh
npm ci
```

Customize `wrangler.jsonc` for your deployment:

- `name`: Worker name
- `routes`: custom domain or route
- `GHOST_ADMIN_API_URL`: Ghost site origin
- `GHOST_API_VERSION`: Ghost API version, such as `v6.0`
- `MCP_ALLOWED_HOSTNAMES`: comma-separated hostnames accepted by the MCP handler

Store credentials as encrypted Worker secrets:

```sh
npx wrangler secret put GHOST_ADMIN_API_KEY
npx wrangler secret put MCP_API_TOKEN
npx wrangler secret put X_SEAL_PROBE_TOKEN
```

The Ghost key must use the `id:secret` value provided by a Ghost custom integration.
Use independent high-entropy values for `MCP_API_TOKEN` and `X_SEAL_PROBE_TOKEN`.

### Origin seal

Do not identify trusted Worker traffic with a User-Agent rule. User-Agent strings are
public and trivial to forge. Instead, generate an origin-seal token without placing
its value in source code or shell history:

```sh
SEAL_PROBE_TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$SEAL_PROBE_TOKEN" | npx wrangler secret put X_SEAL_PROBE_TOKEN
printf '%s\n' "$SEAL_PROBE_TOKEN"
```

Copy the printed value into the Cloudflare Bot Management custom rule on the zone
that protects Ghost. Add the seal as an exclusion from the challenge condition:

```text
(<bot challenge conditions> and
 all(http.request.headers["x-seal-probe"][*] ne "<replace-token-value-here>"))
```

The `all(... ne ...)` condition remains true when the header is absent or no value
matches, so ordinary low-score bots are still challenged. A matching seal makes the
condition false and excludes only that request from this challenge rule. Keep all
other WAF, rate-limiting, and access controls active. After saving the rule, clear
the shell variable:

```sh
unset SEAL_PROBE_TOKEN
```

The Worker secret and WAF rule must always contain the same value. During rotation,
update the WAF rule and Worker secret as one coordinated change, then validate Ghost
reads before removing the previous rule value.

For local development, copy `.dev.vars.example` to a gitignored `.dev.vars` file and
set all three values:

```dotenv
GHOST_ADMIN_API_KEY="id:secret"
MCP_API_TOKEN="replace-with-a-random-local-token"
X_SEAL_PROBE_TOKEN="replace-with-the-origin-seal-token"
```

Start the development server:

```sh
npm run dev
```

The MCP endpoint is `/mcp` and requires this header:

```text
Authorization: Bearer <MCP_API_TOKEN>
```

When using an Access-protected MCP Portal, configure this bearer value on the
Portal's upstream server. Clients authenticate to Access at the Portal URL instead
of receiving the Worker bearer token.

## Deployment

Validate and deploy with Wrangler:

```sh
npm run type-check
npm run deploy
```

For Cloudflare Workers Builds, connect the GitHub repository, choose `main` as
the production branch, and use `npm run deploy` as the deploy command. Configure
the three Worker secrets in Cloudflare; never add them to the repository.

Cloudflare Deploy Buttons can detect and prompt for the secrets declared in
`.dev.vars.example`, with descriptions supplied by `package.json`. They cannot safely
create the matching custom rule in a separately selected Ghost zone or generate a
token that must also be copied into that rule. The origin-seal rule therefore remains
an explicit deployment step rather than insecure hidden automation.

Commits to `main` deploy to production through Workers Builds. Other branches use
`npx wrangler preview` to create isolated Preview URLs for validation before merge.
The checked-in preview configuration intentionally uses a non-routable Ghost origin
and no production secrets, so previews validate bundling and Worker startup only.

Before every major GitHub update, follow the Knowledge.Wine validation gate in
[`PROJECT_PLAN.md`](PROJECT_PLAN.md).

## Origin

This implementation is a Cloudflare Workers-native refactor inspired by the narrow
post-management scope of
[`nautis/ghost-mcp-server`](https://github.com/nautis/ghost-mcp-server). Its
transport and deployment architecture were rewritten for Workers, with the tool
surface deliberately limited to the documented Ghost post CRUD operations. It is
not a GitHub fork and does not share the original Node.js `stdio` transport.

## License

Licensed under the [MIT License](LICENSE).
