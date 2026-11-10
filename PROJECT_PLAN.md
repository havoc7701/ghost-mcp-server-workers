# Ghost MCP Server Project Plan

## Objective

Maintain a reusable, remote MCP server on Cloudflare Workers that gives authorized
AI clients focused CRUD access to Ghost posts. The reference deployment manages
Knowledge.Wine and uses published posts as bounded writing-style context.

## Architecture

```text
MCP client
  -> Cloudflare Access
  -> Cloudflare MCP Portal at mcp.vkdesigns.com
  -> ghost-mcp.vkdesigns.com/mcp
  -> Ghost Admin API at www.knowledge.wine
```

AI Gateway is optional and separate. It governs model inference, not MCP tool
traffic or Worker-to-Ghost Admin API calls.

## Security Model

- Ghost Admin keys remain encrypted Worker secrets.
- Ghost authentication uses a fresh five-minute HS256 JWT per request.
- Worker-to-Ghost requests carry a high-entropy `X-Seal-Probe` secret excluded from
  the Ghost-zone Bot Management challenge rule without bypassing other controls.
- Cloudflare Access authenticates clients to the MCP Portal.
- `/mcp` requires a separate high-entropy bearer credential held by the Portal
  upstream configuration.
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
4. Confirm direct Ghost Admin traffic without the origin seal does not receive the
   Bot Management bypass.
5. Validate `list_posts`, `get_post`, `get_post_by_slug`, and `get_style_context`
   against Knowledge.Wine.
6. Confirm an unapproved publish or schedule operation is rejected.
7. Create an unmistakably named temporary draft, then read and update it.
8. Confirm deletion requires explicit approval, delete the temporary draft, and
   verify it no longer exists.
9. Verify no published Knowledge.Wine content was modified.
10. Review the Git diff and staged files for credentials and local artifacts.
11. Commit and push only after every preceding check passes.

If any check fails, stop the release, clean up the temporary draft manually if
necessary, and resolve the failure before updating GitHub.

## Roadmap

1. Maintain the Access policy and explicit seven-tool Portal allowlist.
2. Add a documented bearer-token rotation procedure for Portal operators.
3. Enable Gateway routing and DLP only when tool-traffic inspection is required.
4. Add automated tests for Ghost response sanitization and content conversion.
