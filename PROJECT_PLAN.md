# Ghost MCP Server Project Plan

## Objective

Maintain a reusable, remote MCP server on Cloudflare Workers that gives authorized
AI clients focused CRUD access to Ghost posts. The reference deployment manages
Knowledge.Wine and uses published posts as bounded writing-style context.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal and Access (planned)
  -> ghost-mcp.vkdesigns.com/mcp
  -> Ghost Admin API at www.knowledge.wine
```

AI Gateway is optional and separate. It governs model inference, not MCP tool
traffic or Worker-to-Ghost Admin API calls.

## Security Model

- Ghost Admin keys remain encrypted Worker secrets.
- Ghost authentication uses a fresh five-minute HS256 JWT per request.
- `/mcp` requires a high-entropy bearer credential until Portal OAuth replaces it.
- Post responses are allowlisted to prevent private Ghost author fields leaking.
- Updates require Ghost's current `updated_at` value for optimistic locking.
- Publishing, scheduling, and deletion require explicit confirmation arguments.
- The MCP handler enforces an explicit hostname allowlist.

## Knowledge.Wine Validation Gate

Complete this gate before the initial GitHub push and before every major update to
GitHub. A major update includes tool behavior, authentication, Ghost request logic,
content conversion, dependencies, or deployment configuration.

1. Run `npm run type-check` and confirm the Worker starts successfully.
2. Confirm unauthenticated `/mcp` requests receive HTTP 401.
3. Initialize MCP and verify the expected seven-tool allowlist.
4. Validate `list_posts`, `get_post`, `get_post_by_slug`, and `get_style_context`
   against Knowledge.Wine.
5. Confirm an unapproved publish or schedule operation is rejected.
6. Create an unmistakably named temporary draft, then read and update it.
7. Confirm deletion requires explicit approval, delete the temporary draft, and
   verify it no longer exists.
8. Verify no published Knowledge.Wine content was modified.
9. Review the Git diff and staged files for credentials and local artifacts.
10. Commit and push only after every preceding check passes.

If any check fails, stop the release, clean up the temporary draft manually if
necessary, and resolve the failure before updating GitHub.

## Roadmap

1. Add the Worker as a bearer-authenticated upstream to a Cloudflare MCP Portal.
2. Rotate the bearer credential while configuring the Portal.
3. Apply Access policies and an explicit seven-tool allowlist.
4. Enable Gateway routing and DLP only when tool-traffic inspection is required.
5. Add automated tests for Ghost response sanitization and content conversion.
