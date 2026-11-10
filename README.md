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
- Requires bearer authentication at the MCP endpoint.
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
  -> Cloudflare MCP Portal or direct bearer authentication
  -> Cloudflare Worker /mcp
  -> Ghost Admin API
```

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
- `GHOST_USER_AGENT`: stable identifier sent to Ghost and usable in narrow WAF rules
- `MCP_ALLOWED_HOSTNAMES`: comma-separated hostnames accepted by the MCP handler

Store credentials as encrypted Worker secrets:

```sh
npx wrangler secret put GHOST_ADMIN_API_KEY
npx wrangler secret put MCP_API_TOKEN
```

The Ghost key must use the `id:secret` value provided by a Ghost custom integration.
Generate a high-entropy value for `MCP_API_TOKEN`.

For local development, place both values in a gitignored `.dev.vars` file:

```dotenv
GHOST_ADMIN_API_KEY="id:secret"
MCP_API_TOKEN="replace-with-a-random-local-token"
```

Start the development server:

```sh
npm run dev
```

The MCP endpoint is `/mcp` and requires this header:

```text
Authorization: Bearer <MCP_API_TOKEN>
```

## Deployment

Validate and deploy with Wrangler:

```sh
npm run type-check
npm run deploy
```

For Cloudflare Workers Builds, connect the GitHub repository, choose `main` as
the production branch, and use `npm run deploy` as the deploy command. Configure
the two Worker secrets in Cloudflare; never add them to the repository.

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
