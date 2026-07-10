import express from "express";
import { loadConfig } from "./config.js";
import { apiRegisterRepo, apiListRepos, apiGetRepo, apiCreateGithubRepo, apiClone, apiPull, apiPush, apiSync, apiSyncStatus, apiStatus, apiListTags, apiCreateTag, apiLog, apiLogAudit, apiCheckout, apiCheck, apiSyncCode, apiSnapshot, apiRepoPull, } from "./tools/gitOps.js";
const cfg = loadConfig();
const app = express();
app.use(express.json({ limit: "5mb" }));
const tools = {
    repo_register: { handler: apiRegisterRepo, description: "Register a GitHub repo for git-mcp", inputSchema: { type: "object", properties: { name: { type: "string", description: "Repo name" }, github_url: { type: "string", description: "GitHub URL" }, default_branch: { type: "string" }, description: { type: "string" }, tags: { type: "string" }, guard_config: { type: "string" } }, required: ["name", "github_url"] } },
    repo_list: { handler: apiListRepos, description: "List all registered repos", inputSchema: { type: "object", properties: { search: { type: "string" } } } },
    repo_info: { handler: apiGetRepo, description: "Get repo details", inputSchema: { type: "object", properties: { name: { type: "string", description: "Repo name" } }, required: ["name"] } },
    git_create_repo: { handler: apiCreateGithubRepo, description: "Create GitHub repo", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" } }, required: ["name"] } },
    git_clone: { handler: apiClone, description: "Clone a registered repo", inputSchema: { type: "object", properties: { name: { type: "string" }, branch: { type: "string" } }, required: ["name"] } },
    git_pull: { handler: apiPull, description: "Pull latest from GitHub", inputSchema: { type: "object", properties: { name: { type: "string" }, branch: { type: "string" } }, required: ["name"] } },
    git_push: { handler: apiPush, description: "Commit to MCP local repo", inputSchema: { type: "object", properties: { name: { type: "string" }, message: { type: "string" }, branch: { type: "string" }, files: { type: "array", items: { type: "string" } }, force: { type: "boolean" }, skipChecks: { type: "boolean" } }, required: ["name", "message"] } },
    git_sync: { handler: apiSync, description: "Push MCP-local to GitHub", inputSchema: { type: "object", properties: { name: { type: "string" }, branch: { type: "string" }, tag: { type: "string" } }, required: ["name"] } },
    git_sync_status: { handler: apiSyncStatus, description: "Check unsynced commits", inputSchema: { type: "object", properties: { name: { type: "string", description: "Optional: check single repo" } } } },
    git_status: { handler: apiStatus, description: "Repo working tree status", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    git_tags: { handler: apiListTags, description: "List tags", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    git_create_tag: { handler: apiCreateTag, description: "Create a tag", inputSchema: { type: "object", properties: { name: { type: "string" }, tag: { type: "string" }, description: { type: "string" } }, required: ["name", "tag"] } },
    git_log: { handler: apiLog, description: "Commit log", inputSchema: { type: "object", properties: { name: { type: "string" }, limit: { type: "number" } }, required: ["name"] } },
    git_audit: { handler: apiLogAudit, description: "Audit trail", inputSchema: { type: "object", properties: { name: { type: "string" }, limit: { type: "number" } } } },
    git_checkout: { handler: apiCheckout, description: "Switch branch", inputSchema: { type: "object", properties: { name: { type: "string" }, ref: { type: "string" } }, required: ["name", "ref"] } },
    repo_check: { handler: apiCheck, description: "Pre-push integrity check", inputSchema: { type: "object", properties: { name: { type: "string" }, branch: { type: "string" } }, required: ["name"] } },
    repo_sync: { handler: apiSyncCode, description: "Sync code from test server", inputSchema: { type: "object", properties: { team: { type: "string" }, source_host: { type: "string" }, source_path: { type: "string" } }, required: ["team", "source_host", "source_path"] } },
    repo_snapshot: { handler: apiSnapshot, description: "Get snapshot SHA", inputSchema: { type: "object", properties: { team: { type: "string" } }, required: ["team"] } },
    repo_pull: { handler: apiRepoPull, description: "Pull from test server + commit + push", inputSchema: { type: "object", properties: { team: { type: "string" }, source_host: { type: "string" }, source_path: { type: "string" }, message: { type: "string" }, author: { type: "string" } }, required: ["team", "source_host", "source_path"] } },
};
// MCP JSON-RPC Handler
async function mcpHandler(req: any, res: any) {
    const { jsonrpc, method, params, id } = req.body ?? {};
    const send = (r: any) => res.json({ jsonrpc: "2.0", result: r, id });
    const fail = (c: number, m: string) => res.json({ jsonrpc: "2.0", error: { code: c, message: m }, id });
    if (method === "initialize")
        return send({ protocolVersion: "2024-11-05", serverInfo: { name: "git-mcp", version: "1.0" }, capabilities: { tools: {} } });
    if (method === "tools/list") {
        const list = Object.entries(tools).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.inputSchema }));
        return send({ tools: list });
    }
    if (method === "tools/call") {
        const tool = (tools as any)[params?.name];
        if (!tool)
            return fail(-32602, "Unknown tool: " + params?.name);
        try {
            const rawArgs: any = { ...(params?.arguments ?? {}) };
            // Normalize: OpenClaw may pass "repo" instead of "name" or "team"
            if (rawArgs.repo && !rawArgs.name && !rawArgs.team) {
                rawArgs.name = rawArgs.repo;
                rawArgs.team = rawArgs.repo;
                delete rawArgs.repo;
            }
            const result = await tool.handler(rawArgs);
            return send({ content: [{ type: "text", text: JSON.stringify(result) }] });
        }
        catch (e: any) {
            return fail(-32000, e.message);
        }
    }
    if (method === "notifications/initialized")
        return res.json({ jsonrpc: "2.0", id });
    return fail(-32601, "Unknown method: " + method);
}
app.post("/", mcpHandler);
app.post("/mcp", mcpHandler);
app.get("/tools", (_req, res) => { const list = Object.entries(tools).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.inputSchema })); res.json({ tools: list }); });
app.post("/tools/:name", async (req, res) => { const tool = (tools as any)[req.params.name]; if (!tool) {
    res.status(404).json({ error: "Not found" });
    return;
} try {
    const r = await tool.handler(req.body ?? {});
    res.json({ ok: true, tool: req.params.name, ...r });
}
catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
} });
app.get("/health", (_req, res) => { res.json({ status: "ok", timestamp: new Date().toISOString(), tools: Object.keys(tools).length }); });
app.listen(cfg.port, cfg.host, () => { console.log(`git-mcp on http://${cfg.host}:${cfg.port}`); });
//# sourceMappingURL=server.js.map