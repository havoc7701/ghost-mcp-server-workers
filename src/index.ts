import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  GHOST_ADMIN_API_URL: string;
  GHOST_ADMIN_API_KEY: string;
  GHOST_API_VERSION: string;
  GHOST_USER_AGENT: string;
  MCP_ALLOWED_HOSTNAMES: string;
  MCP_API_TOKEN: string;
}

type GhostPostInput = {
  title?: string;
  lexical?: string;
  status?: "draft" | "published" | "scheduled";
  published_at?: string;
  custom_excerpt?: string;
  feature_image?: string;
  feature_image_alt?: string;
  feature_image_caption?: string;
  featured?: boolean;
  tags?: Array<{ name: string }>;
  updated_at?: string;
};

const pagingSchema = {
  limit: z.number().int().min(1).max(50).default(10),
  page: z.number().int().min(1).default(1),
};

const statusSchema = z.enum(["draft", "published", "scheduled"]);
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const tagsSchema = z.array(z.string().trim().min(1).max(191)).max(20).optional();
const imageUrlSchema = z.url().startsWith("https://").optional();

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown Ghost API error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function base64Url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeHex(value: string) {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error("Ghost Admin API key has an invalid secret");
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function createGhostToken(adminKey: string) {
  const [id, secret, ...extra] = adminKey.split(":");
  if (!id || !secret || extra.length > 0) {
    throw new Error("Ghost Admin API key must use the id:secret format");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const payload = base64Url(
    JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }),
  );
  const unsignedToken = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    decodeHex(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  return `${unsignedToken}.${base64Url(new Uint8Array(signature))}`;
}

async function ghostAdminRequest(
  env: Env,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    params?: Record<string, string | number | undefined>;
    body?: unknown;
  } = {},
) {
  const base = env.GHOST_ADMIN_API_URL.replace(/\/$/, "");
  const url = new URL(`${base}/ghost/api/admin/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      "Accept-Version": env.GHOST_API_VERSION,
      Authorization: `Ghost ${await createGhostToken(env.GHOST_ADMIN_API_KEY)}`,
      "User-Agent": env.GHOST_USER_AGENT,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { errors?: Array<{ message?: string }> };
      detail = body.errors?.[0]?.message ? `: ${body.errors[0].message}` : "";
    } catch {
      // Do not echo arbitrary upstream bodies or credentials to MCP clients.
    }
    if (!detail) {
      const contentType = response.headers.get("Content-Type") ?? "unknown content type";
      const ray = response.headers.get("CF-Ray");
      detail = ` (${contentType}${ray ? `, CF-Ray ${ray}` : ""})`;
    }
    throw new Error(`Ghost Admin API request failed with HTTP ${response.status}${detail}`);
  }

  return response.status === 204 ? { success: true } : response.json();
}

function markdownLexical(markdown: string) {
  const nativeMarker = "<!-- ghost-native -->";
  if (markdown.startsWith(nativeMarker)) {
    const blocks = markdown
      .slice(nativeMarker.length)
      .trim()
      .split(/\n\s*\n/)
      .map((block) => block.replace(/\s*\n\s*/g, " ").trim());

    const textNode = (text: string, format = 0) => ({
      detail: 0,
      format,
      mode: "normal",
      style: "",
      text,
      type: "text",
      version: 1,
    });
    const children = blocks.map((block) => {
      const heading = block.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        return {
          children: [textNode(heading[2])],
          direction: null,
          format: "",
          indent: 0,
          tag: `h${heading[1].length}`,
          type: "heading",
          version: 1,
        };
      }

      const italic = block.match(/^\*([^*]+)\*$/);
      return {
        children: [textNode(italic ? italic[1] : block, italic ? 2 : 0)],
        direction: null,
        format: "",
        indent: 0,
        type: "paragraph",
        version: 1,
      };
    });

    return JSON.stringify({
      root: {
        children,
        direction: null,
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    });
  }

  return JSON.stringify({
    root: {
      children: [{ type: "markdown", version: 1, markdown }],
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });
}

function replaceLexicalText(value: unknown, from: string, to: string): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + replaceLexicalText(item, from, to), 0);
  }
  if (!value || typeof value !== "object") return 0;

  const node = value as Record<string, unknown>;
  let replacements = 0;
  if (node.text === from) {
    node.text = to;
    replacements += 1;
  }
  for (const child of Object.values(node)) {
    replacements += replaceLexicalText(child, from, to);
  }
  return replacements;
}

function postInput(values: {
  title?: string;
  markdown?: string;
  status?: "draft" | "published" | "scheduled";
  publishedAt?: string;
  customExcerpt?: string;
  featureImage?: string;
  featureImageAlt?: string;
  featureImageCaption?: string;
  featured?: boolean;
  tags?: string[];
  updatedAt?: string;
}): GhostPostInput {
  return {
    title: values.title,
    lexical: values.markdown === undefined ? undefined : markdownLexical(values.markdown),
    status: values.status,
    published_at: values.publishedAt,
    custom_excerpt: values.customExcerpt,
    feature_image: values.featureImage,
    feature_image_alt: values.featureImageAlt,
    feature_image_caption: values.featureImageCaption,
    featured: values.featured,
    tags: values.tags?.map((name) => ({ name })),
    updated_at: values.updatedAt,
  };
}

function sanitizePost(post: Record<string, unknown>, includeContent: boolean) {
  const tags = Array.isArray(post.tags) ? post.tags : [];
  const authors = Array.isArray(post.authors) ? post.authors : [];

  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    ...(includeContent ? { html: post.html, lexical: post.lexical } : {}),
    status: post.status,
    visibility: post.visibility,
    featured: post.featured,
    feature_image: post.feature_image,
    feature_image_alt: post.feature_image_alt,
    feature_image_caption: post.feature_image_caption,
    custom_excerpt: post.custom_excerpt,
    canonical_url: post.canonical_url,
    created_at: post.created_at,
    updated_at: post.updated_at,
    published_at: post.published_at,
    url: post.url,
    excerpt: post.excerpt,
    tags: tags.map((tag) => {
      const value = tag as Record<string, unknown>;
      return { id: value.id, name: value.name, slug: value.slug };
    }),
    authors: authors.map((author) => {
      const value = author as Record<string, unknown>;
      return { id: value.id, name: value.name, slug: value.slug };
    }),
  };
}

function sanitizePostResponse(value: unknown, includeContent: boolean) {
  const result = value as { posts?: Array<Record<string, unknown>>; meta?: unknown };
  return {
    posts: (result.posts ?? []).map((post) => sanitizePost(post, includeContent)),
    ...(result.meta === undefined ? {} : { meta: result.meta }),
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "ghost-mcp-server-workers",
    version: "0.2.0",
  });

  server.registerTool(
    "list_posts",
    {
      description: "List Ghost posts, including drafts and scheduled posts.",
      inputSchema: z.object({
        ...pagingSchema,
        status: z.enum(["all", "draft", "published", "scheduled"]).default("all"),
        order: z
          .enum(["published_at DESC", "published_at ASC", "updated_at DESC", "title ASC"])
          .default("updated_at DESC"),
      }),
    },
    async ({ limit, page, status, order }) => {
      try {
        const result = await ghostAdminRequest(env, "posts/", {
            params: {
              limit,
              page,
              order,
              filter: status === "all" ? undefined : `status:${status}`,
              include: "authors,tags",
              formats: "html,lexical",
            },
          });
        return textResult(sanitizePostResponse(result, false));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_post",
    {
      description: "Read a Ghost post by post ID, including editable content.",
      inputSchema: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) }),
    },
    async ({ id }) => {
      try {
        const result = await ghostAdminRequest(env, `posts/${id}/`, {
            params: { include: "authors,tags", formats: "html,lexical" },
          });
        return textResult(sanitizePostResponse(result, true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_post_by_slug",
    {
      description: "Read a Ghost post by URL slug, including editable content.",
      inputSchema: z.object({ slug: slugSchema }),
    },
    async ({ slug }) => {
      try {
        const result = await ghostAdminRequest(env, `posts/slug/${slug}/`, {
            params: { include: "authors,tags", formats: "html,lexical" },
          });
        return textResult(sanitizePostResponse(result, true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_style_context",
    {
      description:
        "Return representative published posts to study before drafting. Use this first to match the site's language, tone, structure, and level of detail.",
      inputSchema: z.object({
        sampleCount: z.number().int().min(1).max(5).default(3),
        charactersPerPost: z.number().int().min(1000).max(8000).default(5000),
      }),
    },
    async ({ sampleCount, charactersPerPost }) => {
      try {
        const result = (await ghostAdminRequest(env, "posts/", {
          params: {
            limit: sampleCount,
            order: "published_at DESC",
            filter: "status:published",
            include: "authors,tags",
            formats: "html",
          },
        })) as { posts?: Array<Record<string, unknown> & { html?: string }> };

        return textResult({
          guidance:
            "Infer style only from these samples. Preserve factual accuracy; do not invent tasting details, events, producers, vintages, or scores.",
          posts: (result.posts ?? []).map((post) => ({
            ...sanitizePost(post, false),
            html: post.html?.slice(0, charactersPerPost),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "create_post",
    {
      description:
        "Create a Ghost post from Markdown. Call get_style_context first. Posts default to draft; publishing requires confirmPublish=true.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(255),
        markdown: z.string().min(1).max(200_000),
        status: statusSchema.default("draft"),
        confirmPublish: z.boolean().default(false),
        publishedAt: z.iso.datetime().optional(),
        customExcerpt: z.string().max(300).optional(),
        featureImage: imageUrlSchema,
        featureImageAlt: z.string().max(500).optional(),
        featureImageCaption: z.string().max(2000).optional(),
        featured: z.boolean().optional(),
        tags: tagsSchema,
      }),
    },
    async ({ confirmPublish, ...values }) => {
      if (values.status !== "draft" && !confirmPublish) {
        return errorResult(new Error("Publishing or scheduling requires confirmPublish=true"));
      }

      try {
        const result = await ghostAdminRequest(env, "posts/", {
            method: "POST",
            body: { posts: [postInput(values)] },
          });
        return textResult(sanitizePostResponse(result, true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "update_post",
    {
      description:
        "Update a Ghost post. Supply updatedAt from get_post for optimistic locking. Publishing requires confirmPublish=true.",
      inputSchema: z.object({
        id: z.string().regex(/^[a-f0-9]{24}$/i),
        updatedAt: z.iso.datetime(),
        title: z.string().trim().min(1).max(255).optional(),
        markdown: z.string().min(1).max(200_000).optional(),
        status: statusSchema.optional(),
        confirmPublish: z.boolean().default(false),
        publishedAt: z.iso.datetime().optional(),
        customExcerpt: z.string().max(300).optional(),
        featureImage: imageUrlSchema,
        featureImageAlt: z.string().max(500).optional(),
        featureImageCaption: z.string().max(2000).optional(),
        featured: z.boolean().optional(),
        tags: tagsSchema,
      }),
    },
    async ({ id, confirmPublish, ...values }) => {
      if (values.status && values.status !== "draft" && !confirmPublish) {
        return errorResult(new Error("Publishing or scheduling requires confirmPublish=true"));
      }

      try {
        const patchMarker = "<!-- ghost-replace-text -->";
        const input = postInput(values);
        if (values.markdown?.startsWith(patchMarker)) {
          const patch = JSON.parse(values.markdown.slice(patchMarker.length)) as {
            from?: unknown;
            to?: unknown;
          };
          if (typeof patch.from !== "string" || typeof patch.to !== "string") {
            throw new Error("Native text patch requires string from and to values");
          }

          const current = (await ghostAdminRequest(env, `posts/${id}/`, {
            params: { formats: "lexical" },
          })) as { posts?: Array<{ lexical?: string }> };
          const lexical = current.posts?.[0]?.lexical;
          if (!lexical) throw new Error("Post does not contain editable Lexical content");

          const document = JSON.parse(lexical) as unknown;
          const replacements = replaceLexicalText(document, patch.from, patch.to);
          if (replacements !== 1) {
            throw new Error(`Native text patch matched ${replacements} nodes; expected exactly 1`);
          }
          input.lexical = JSON.stringify(document);
        }

        const result = await ghostAdminRequest(env, `posts/${id}/`, {
            method: "PUT",
            body: { posts: [input] },
          });
        return textResult(sanitizePostResponse(result, true));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "delete_post",
    {
      description: "Permanently delete a Ghost post. This cannot be undone.",
      inputSchema: z.object({
        id: z.string().regex(/^[a-f0-9]{24}$/i),
        confirmDelete: z.literal(true),
      }),
    },
    async ({ id }) => {
      try {
        return textResult(
          await ghostAdminRequest(env, `posts/${id}/`, { method: "DELETE" }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        name: "ghost-mcp-server-workers",
        status: "ok",
        capabilities: "post-crud",
        mcp: "/mcp",
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Authorization") !== `Bearer ${env.MCP_API_TOKEN}`) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }

    const allowedHostnames = env.MCP_ALLOWED_HOSTNAMES.split(",")
      .map((hostname) => hostname.trim())
      .filter(Boolean);
    const handler = createMcpHandler(() => createServer(env), {
      allowedHostnames,
      corsOptions: false,
      responseMode: "json",
    });

    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
