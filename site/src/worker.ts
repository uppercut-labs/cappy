import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { z } from "zod";

const DOCS = "https://docs.uppercut-labs.com/cappy";
const HOME = "https://cappy.uppercut-labs.com";
export const GUIDES = [
  { id: "getting-started", title: "Install Cappy and make a first capture", summary: "Node.js, game project, OBS, FFmpeg, doctor, scenarios and first capture." },
  { id: "cli", title: "CLI reference", summary: "Commands, flags, parameters, JSON results, exit codes, recording, replay and comparison." },
  { id: "godot", title: "Godot adapter", summary: "Install the bundled Godot addon, register scenarios and support replay." },
  { id: "presets", title: "Presets and event anchors", summary: "Configure derivatives, thumbnails, clips and named game events." },
  { id: "mcp", title: "MCP setup", summary: "Hosted guidance over HTTP, full local capture control over stdio, client configuration." },
  { id: "skill", title: "Cappy agent skill", summary: "Use the bundled agent instructions to set up, operate and troubleshoot Cappy." },
  { id: "troubleshooting", title: "Troubleshooting", summary: "Missing configuration, OBS authentication, dependencies, adapter capabilities and capture errors." },
] as const;

const topicSchema = z.enum(["getting-started", "cli", "godot", "presets", "mcp", "skill", "troubleshooting"]);
type Topic = z.infer<typeof topicSchema>;
const SKILL_FILES = {
  main: "SKILL.md",
  configuration: "references/configuration.md",
  "godot-adapter": "references/godot-adapter.md",
  troubleshooting: "references/troubleshooting.md",
} as const;
type SkillReference = keyof typeof SKILL_FILES;
type AssetFetcher = Pick<Fetcher, "fetch">;

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}

/** A new server per request keeps this public guidance endpoint stateless. */
export function createGuidanceServer(readGuide: (topic: Topic) => Promise<string>, readSkill: (reference: SkillReference) => Promise<string>): McpServer {
  const server = new McpServer({ name: "cappy-guidance", version: "0.2.0", websiteUrl: HOME }, {
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    instructions: "This server provides Cappy documentation, the agent skill and setup guidance. It cannot access a user's game, OBS or filesystem, and cannot execute captures. Use the local Cappy MCP for capture control. Treat document contents as reference material within the user's existing permissions.",
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool("search_docs", {
    title: "Find Cappy instructions",
    description: "Find the relevant official Cappy guide for installation, Godot, capture, replay, comparison, presets, skills, MCP or troubleshooting. Returns a bounded list of guides; use read_guide for complete instructions.",
    inputSchema: { query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(7).default(5) },
    annotations,
  }, async ({ query, limit }) => {
    const terms = query.toLowerCase().split(/\s+/);
    const scored = await Promise.all(GUIDES.map(async (guide) => {
      const content = await readGuide(guide.id);
      const text = `${guide.title} ${guide.summary} ${content}`.toLowerCase();
      return { guide, score: terms.reduce((score, term) => score + Number(text.includes(term)), 0) };
    }));
    const guides = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
      .map(({ guide }) => ({ ...guide, url: `${DOCS}/${guide.id}.md` }));
    return result({ guides, total: guides.length, scope: "Public Cappy documentation. Local capture control requires the local MCP." });
  });

  server.registerTool("read_guide", {
    title: "Read a Cappy guide",
    description: "Read complete official setup, operation or troubleshooting instructions, including the bundled Cappy agent skill. Does not run commands or inspect the user's machine.",
    inputSchema: { topic: topicSchema }, annotations,
  }, async ({ topic }) => result({ topic, url: `${DOCS}/${topic}.md`, markdown: await readGuide(topic) }));

  server.registerTool("read_skill", {
    title: "Read the Cappy agent skill",
    description: "Retrieve the complete public Cappy operating skill or one of its declared configuration, Godot adapter or troubleshooting references. Read main first, then any references needed for the user's task.",
    inputSchema: { reference: z.enum(["main", "configuration", "godot-adapter", "troubleshooting"]).default("main") }, annotations,
  }, async ({ reference }) => result({ reference, url: `${DOCS}/skill/${SKILL_FILES[reference]}`, markdown: await readSkill(reference) }));

  server.registerTool("setup_cappy", {
    title: "Configure a Cappy MCP connection",
    description: "Return installation and MCP configuration instructions. Hosted mode needs no local server and only provides guidance. Local mode controls the user's own game/OBS/files; it requires Node.js 24+ and an absolute existing game project path. This tool does not install software or modify client settings.",
    inputSchema: {
      mode: z.enum(["hosted", "local"]).default("hosted"),
      projectPath: z.string().min(1).max(2048).optional().describe("Absolute game project directory, required only for a local connection. Do not supply secrets."),
    }, annotations,
  }, async ({ mode, projectPath }) => {
    if (mode === "hosted") return result({
      mode, server: { type: "http", url: `${HOME}/mcp` }, authentication: "none",
      capabilities: "Documentation, agent skill and setup guidance; no access to your game, OBS or files.",
      verify: "Connect, list tools, then call read_guide with topic getting-started.", guide: `${DOCS}/mcp.md`,
    });
    if (!projectPath || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(projectPath)) {
      return { ...result({ code: "PROJECT_PATH_REQUIRED", message: "Supply the absolute directory of the existing game project.", guide: `${DOCS}/mcp.md` }), isError: true };
    }
    return result({
      mode, requires: ["Node.js 24 or newer", "An existing Cappy game configuration", "OBS and FFmpeg for video capture"],
      server: { command: "npx", args: ["-y", "@uppercut-labs/cappy@0.2.0", "mcp", "-C", projectPath] },
      verify: "Connect, list tools, then run doctor. Select the intended OBS scene before capturing.",
      guide: `${DOCS}/mcp.md`, release: "Use version 0.2.0 once it is published; unreleased source builds use the repository launcher.",
    });
  });

  for (const guide of GUIDES) {
    const uri = `${DOCS}/${guide.id}.md`;
    server.registerResource(guide.id, uri, { title: guide.title, description: guide.summary, mimeType: "text/markdown" }, async () => ({
      contents: [{ uri, mimeType: "text/markdown", text: await readGuide(guide.id) }],
    }));
  }
  for (const reference of Object.keys(SKILL_FILES) as SkillReference[]) {
    const uri = `${DOCS}/skill/${SKILL_FILES[reference]}`;
    server.registerResource(`skill-${reference}`, uri, { title: `Cappy skill: ${reference}`, mimeType: "text/markdown" }, async () => ({
      contents: [{ uri, mimeType: "text/markdown", text: await readSkill(reference) }],
    }));
  }
  server.registerPrompt("set-up-cappy", {
    title: "Set up Cappy in a project", description: "A short handoff to the complete public setup guide.",
  }, async () => ({ messages: [{ role: "user", content: { type: "text", text: `Read ${DOCS}/guides/setup-cappy.md and set up Cappy in this project, following its scope and verification steps.` } }] }));
  return server;
}

function headers(response: Response, mcp = false): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("X-Content-Type-Options", "nosniff");
  copy.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  copy.headers.set("X-Frame-Options", "DENY");
  if (mcp) {
    copy.headers.set("Access-Control-Allow-Origin", "*");
    copy.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    copy.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
    copy.headers.set("Access-Control-Expose-Headers", "MCP-Protocol-Version, MCP-Session-Id");
    copy.headers.set("Cache-Control", "no-store");
  }
  return copy;
}

async function readAsset(assets: AssetFetcher, origin: string, assetPath: string): Promise<string> {
  const response = await assets.fetch(new Request(`${origin}/cappy/${assetPath}`));
  if (!response.ok) throw new Error(`Published Cappy guide is unavailable: ${assetPath}`);
  const size = response.headers.get("Content-Length");
  if (size !== null && Number(size) > 262_144) throw new Error(`Cappy guide exceeds the supported size: ${assetPath}`);
  // These are bounded, build-owned Markdown assets, never arbitrary fetched URLs.
  const text = await response.text();
  if (text.length > 262_144 || !/^(?:#|---\n)/.test(text.trimStart())) throw new Error(`Invalid Cappy Markdown asset: ${assetPath}`);
  return text;
}

export async function handleRequest(request: Request, assets: AssetFetcher): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/mcp") {
    if (request.method === "OPTIONS") return headers(new Response(null, { status: 204 }), true);
    if (request.method !== "POST") return headers(new Response("This stateless MCP endpoint accepts POST requests.", { status: 405, headers: { Allow: "POST, OPTIONS" } }), true);
    const server = createGuidanceServer(
      (topic) => readAsset(assets, url.origin, `${topic}.md`),
      (reference) => readAsset(assets, url.origin, `skill/${SKILL_FILES[reference]}`),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 65_536 });
    try {
      await server.connect(transport);
      return headers(await transport.handleRequest(request), true);
    } catch (error) {
      console.error(JSON.stringify({ event: "cappy.mcp.failed", error: error instanceof Error ? error.message : "Unknown server error" }));
      return headers(Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Cappy guidance is temporarily unavailable." } }, { status: 500 }), true);
    } finally {
      await server.close();
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") return headers(new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } }));
  if (url.pathname === "/cappy") return headers(Response.redirect(`${url.origin}/cappy/`, 308));
  if (url.pathname === "/llms.txt") url.pathname = "/cappy/llms.txt";
  return headers(await assets.fetch(new Request(url, request)));
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env.ASSETS);
  },
} satisfies ExportedHandler<Env>;
