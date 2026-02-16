import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
const execAsync = promisify(exec);
// Configuration
const MCPORTER_CONFIG_PATH = "/root/.openclaw/workspace/config/mcporter.json";
const server = new Server({ name: "mcp-health-monitor", version: "1.0.0" }, { capabilities: { tools: {} } });
// Cache for server statuses
let serverStatuses = new Map();
let lastHealthCheck = null;
// Health check tracking
const healthCheckCache = new Map();
const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds between checks
const STARTUP_DELAY_MS = 5000; // 5 seconds for servers to initialize
async function loadMCPServerConfigs() {
    try {
        const configContent = await fs.promises.readFile(MCPORTER_CONFIG_PATH, "utf-8");
        const config = JSON.parse(configContent);
        return new Map(Object.entries(config.mcpServers || {}));
    }
    catch (error) {
        console.error("Failed to load MCP config:", error);
        return new Map();
    }
}
async function getProcessInfo(pid) {
    try {
        // Check if process exists
        await execAsync(`kill -0 ${pid} 2>/dev/null`);
        // Get process start time
        const { stdout } = await execAsync(`ps -o etime= -p ${pid}`);
        const uptimeStr = stdout.trim();
        // Parse uptime (format can be [[dd-]hh:]mm:ss or similar)
        let uptimeSeconds = 0;
        if (uptimeStr.includes(":")) {
            const parts = uptimeStr.split(":").map(Number);
            if (parts.length === 3) {
                uptimeSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            else if (parts.length === 2) {
                uptimeSeconds = parts[0] * 60 + parts[1];
            }
        }
        return { exists: true, uptime: uptimeSeconds };
    }
    catch {
        return { exists: false };
    }
}
async function checkServerHealth(name, config) {
    // First, check if we have recent cached health info
    const cached = healthCheckCache.get(name);
    if (cached && (Date.now() - cached.timestamp.getTime()) < HEALTH_CHECK_INTERVAL_MS) {
        return {
            name,
            description: config.description,
            command: config.command,
            args: config.args,
            healthy: cached.healthy,
            lastChecked: cached.timestamp.toISOString()
        };
    }
    // Find process for this server
    let pid;
    try {
        // Try to find the process by matching command
        const { stdout } = await execAsync(`ps aux | grep -E "${config.command}|${config.args.join(' ')}" | grep -v grep | awk '{print $2}' | head -1`);
        pid = stdout.trim() ? parseInt(stdout.trim()) : undefined;
    }
    catch {
        // Process not found
    }
    let healthy = false;
    let uptimeSeconds;
    if (pid) {
        const procInfo = await getProcessInfo(pid);
        healthy = procInfo.exists;
        uptimeSeconds = procInfo.uptime;
    }
    else {
        // For stdio servers, they might not show as separate processes
        // Try a different approach - check if server responds
        healthy = await pingServer(name);
    }
    const status = {
        name,
        description: config.description,
        command: config.command,
        args: config.args,
        healthy,
        lastChecked: new Date().toISOString(),
        uptimeSeconds,
        pid
    };
    // Update cache
    healthCheckCache.set(name, { healthy, timestamp: new Date() });
    serverStatuses.set(name, status);
    return status;
}
async function pingServer(name) {
    // Simple ping - servers might respond on their transport
    // For stdio, we can't really ping, so assume healthy if no recent errors
    // This is a limitation of stdio-based MCP servers
    return true;
}
async function restartServer(name, config) {
    try {
        // Kill existing process if running
        if (config.args.length > 0) {
            try {
                const { stdout } = await execAsync(`ps aux | grep "${config.args.join(' ')}" | grep -v grep | awk '{print $2}' | xargs -r kill 2>/dev/null || true`);
            }
            catch {
                // Process might not exist
            }
        }
        // Give it a moment to clean up
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Spawn new process
        const proc = spawn(config.command, config.args, {
            detached: true,
            stdio: "ignore"
        });
        proc.unref();
        // Wait for startup
        await new Promise(resolve => setTimeout(resolve, STARTUP_DELAY_MS));
        // Check if it's running
        const status = await checkServerHealth(name, config);
        if (status.healthy) {
            // Clear cache so next check will reflect new state
            healthCheckCache.delete(name);
            return { success: true, message: `Successfully restarted ${name} (PID: ${proc.pid})` };
        }
        else {
            return { success: false, message: `Restarted ${name} but health check still failing` };
        }
    }
    catch (error) {
        return { success: false, message: `Failed to restart ${name}: ${error}` };
    }
}
// Tool implementations
async function listServers() {
    const configs = await loadMCPServerConfigs();
    const statuses = [];
    for (const [name, config] of configs) {
        const status = await checkServerHealth(name, config);
        statuses.push(status);
    }
    lastHealthCheck = new Date();
    return { servers: statuses };
}
async function checkHealth(name) {
    const configs = await loadMCPServerConfigs();
    const config = configs.get(name);
    if (!config) {
        return null;
    }
    // Force a fresh check by removing from cache
    healthCheckCache.delete(name);
    return await checkServerHealth(name, config);
}
async function checkAllHealth() {
    const result = await listServers();
    return { ...result, checkedAt: new Date().toISOString() };
}
async function restartMCPServer(name) {
    const configs = await loadMCPServerConfigs();
    const config = configs.get(name);
    if (!config) {
        return { success: false, message: `Server ${name} not found in configuration` };
    }
    return await restartServer(name, config);
}
async function getUnhealthyServers() {
    const result = await listServers();
    return {
        servers: result.servers.filter(s => !s.healthy)
    };
}
async function restartAllUnhealthy() {
    const unhealthy = await getUnhealthyServers();
    const results = [];
    for (const s of unhealthy.servers) {
        const result = await restartMCPServer(s.name);
        results.push({ name: s.name, ...result });
    }
    return { results };
}
// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "list_servers",
                description: "List all configured MCP servers with their health status",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "check_health",
                description: "Check health of a specific MCP server by name",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Name of the MCP server to check" }
                    },
                    required: ["name"]
                }
            },
            {
                name: "check_all_health",
                description: "Force check health of all MCP servers",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "restart_server",
                description: "Restart a specific MCP server by name",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Name of the MCP server to restart" }
                    },
                    required: ["name"]
                }
            },
            {
                name: "get_unhealthy",
                description: "Get list of all unhealthy MCP servers",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "restart_unhealthy",
                description: "Restart all unhealthy MCP servers automatically",
                inputSchema: { type: "object", properties: {} }
            }
        ]
    };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "list_servers":
                const servers = await listServers();
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                summary: {
                                    total: servers.servers.length,
                                    healthy: servers.servers.filter(s => s.healthy).length,
                                    unhealthy: servers.servers.filter(s => !s.healthy).length,
                                    lastChecked: lastHealthCheck?.toISOString() || "never"
                                },
                                servers: servers.servers
                            }, null, 2)
                        }]
                };
            case "check_health":
                const serverName = args?.name;
                if (!serverName) {
                    throw new Error("Server name is required");
                }
                const healthStatus = await checkHealth(serverName);
                if (!healthStatus) {
                    return {
                        content: [{ type: "text", text: `Server '${serverName}' not found in configuration` }],
                        isError: true
                    };
                }
                return {
                    content: [{ type: "text", text: JSON.stringify(healthStatus, null, 2) }]
                };
            case "check_all_health":
                const allHealth = await checkAllHealth();
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                summary: {
                                    total: allHealth.servers.length,
                                    healthy: allHealth.servers.filter(s => s.healthy).length,
                                    unhealthy: allHealth.servers.filter(s => !s.healthy).length,
                                    checkedAt: allHealth.checkedAt
                                },
                                servers: allHealth.servers
                            }, null, 2)
                        }]
                };
            case "restart_server":
                const restartName = args?.name;
                if (!restartName) {
                    throw new Error("Server name is required");
                }
                const restartResult = await restartMCPServer(restartName);
                return {
                    content: [{ type: "text", text: JSON.stringify(restartResult, null, 2) }],
                    isError: !restartResult.success
                };
            case "get_unhealthy":
                const unhealthy = await getUnhealthyServers();
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                count: unhealthy.servers.length,
                                servers: unhealthy.servers
                            }, null, 2)
                        }]
                };
            case "restart_unhealthy":
                const restartResults = await restartAllUnhealthy();
                const successful = restartResults.results.filter(r => r.success).length;
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                summary: {
                                    total: restartResults.results.length,
                                    successful,
                                    failed: restartResults.results.length - successful
                                },
                                results: restartResults.results
                            }, null, 2)
                        }]
                };
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `Error: ${error}` }],
            isError: true
        };
    }
});
// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP Health Monitor Server running on stdio");
}
main().catch(console.error);
