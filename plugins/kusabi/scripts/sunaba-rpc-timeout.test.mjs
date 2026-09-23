import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callTool, verifyInContainer, sandboxExec } from "./sunaba-rpc.mjs";

describe("sunaba-rpc transport timeouts", () => {
  let server = null;
  const activeSockets = new Set();
  const originalEnv = {
    KUSABI_SUNABA_URL: process.env.KUSABI_SUNABA_URL,
    KUSABI_SUNABA_HANDSHAKE_TIMEOUT_MS: process.env.KUSABI_SUNABA_HANDSHAKE_TIMEOUT_MS,
    KUSABI_SUNABA_CALL_TIMEOUT_MS: process.env.KUSABI_SUNABA_CALL_TIMEOUT_MS,
  };

  afterEach(async () => {
    // Restore environment variables
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    // Close server and destroy open sockets
    if (server) {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  function startServer(handler) {
    return new Promise((resolve, reject) => {
      server = http.createServer(async (req, res) => {
        let body = "";
        req.setEncoding("utf8");
        for await (const chunk of req) {
          body += chunk;
        }
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch {
          // ignore
        }
        handler(req, res, json);
      });

      server.on("connection", (socket) => {
        activeSockets.add(socket);
        socket.on("close", () => activeSockets.delete(socket));
      });

      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        process.env.KUSABI_SUNABA_URL = `http://127.0.0.1:${port}/mcp`;
        resolve(`http://127.0.0.1:${port}/mcp`);
      });

      server.on("error", reject);
    });
  }

  // (a) server accepts and never responds to initialize
  it("times out on initialize when server never responds", async () => {
    await startServer((req, res, json) => {
      if (json?.method === "initialize") {
        // Accept TCP connection, do not respond
        return;
      }
    });

    process.env.KUSABI_SUNABA_HANDSHAKE_TIMEOUT_MS = "200";
    const start = Date.now();

    await assert.rejects(
      () => callTool("sandbox_exec", { commands: ["true"] }),
      (err) => {
        assert.equal(err.code, "SUNABA_RPC_TIMEOUT");
        assert.match(err.message, /^sunaba-rpc: initialize timed out after 200 ms/);
        assert.match(err.message, /initialize/);
        return true;
      },
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `Expected elapsed < 3000 ms, took ${elapsed} ms`);
  });

  // (b) server answers initialize and notifications, but hangs on tools/call body
  it("times out on tools/call when server sends headers but never finishes body", async () => {
    await startServer((req, res, json) => {
      if (json?.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mock-session-b",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: { serverInfo: { name: "test-server", version: "1.0.0" } },
          }),
        );
        return;
      }
      if (json?.method === "notifications/initialized") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end();
        return;
      }
      if (json?.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: partial-stream\n");
        // never finish the body
        return;
      }
    });

    process.env.KUSABI_SUNABA_CALL_TIMEOUT_MS = "200";
    const start = Date.now();

    await assert.rejects(
      () => callTool("sandbox_exec", { commands: ["true"] }),
      (err) => {
        assert.equal(err.code, "SUNABA_RPC_TIMEOUT");
        assert.match(
          err.message,
          /^sunaba-rpc: tools\/call sandbox_exec timed out after 200 ms/,
        );
        assert.match(err.message, /tools\/call sandbox_exec/);
        return true;
      },
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `Expected elapsed < 3000 ms, took ${elapsed} ms`);
  });

  // (c) same as (b) but bound set per call via callTool timeoutMs override
  it("per-call timeoutMs overrides KUSABI_SUNABA_CALL_TIMEOUT_MS", async () => {
    await startServer((req, res, json) => {
      if (json?.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mock-session-c",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: { serverInfo: { name: "test-server", version: "1.0.0" } },
          }),
        );
        return;
      }
      if (json?.method === "notifications/initialized") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end();
        return;
      }
      if (json?.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: partial-stream\n");
        return;
      }
    });

    process.env.KUSABI_SUNABA_CALL_TIMEOUT_MS = "600000";
    const start = Date.now();

    await assert.rejects(
      () => callTool("sandbox_exec", { commands: ["true"] }, { timeoutMs: 200 }),
      (err) => {
        assert.equal(err.code, "SUNABA_RPC_TIMEOUT");
        assert.match(
          err.message,
          /^sunaba-rpc: tools\/call sandbox_exec timed out after 200 ms/,
        );
        return true;
      },
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `Expected elapsed < 3000 ms, took ${elapsed} ms`);
  });

  // (d) healthy fake server returning valid SSE resolves to { ok: true }
  it("resolves successfully with a healthy server", async () => {
    await startServer((req, res, json) => {
      if (json?.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mock-session-d",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: { serverInfo: { name: "test-server", version: "1.0.0" } },
          }),
        );
        return;
      }
      if (json?.method === "notifications/initialized") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end();
        return;
      }
      if (json?.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
            },
          })}\n\n`,
        );
        return;
      }
    });

    const result = await callTool("sandbox_exec", { commands: ["true"] });
    assert.deepEqual(result, { ok: true });
  });

  // (e) invalid env value does not throw and happy path still resolves
  it("ignores non-positive-integer env timeouts and resolves happy path", async () => {
    await startServer((req, res, json) => {
      if (json?.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mock-session-e",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: { serverInfo: { name: "test-server", version: "1.0.0" } },
          }),
        );
        return;
      }
      if (json?.method === "notifications/initialized") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end();
        return;
      }
      if (json?.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
            },
          })}\n\n`,
        );
        return;
      }
    });

    process.env.KUSABI_SUNABA_CALL_TIMEOUT_MS = "abc";
    process.env.KUSABI_SUNABA_HANDSHAKE_TIMEOUT_MS = "-10";

    const result = await callTool("sandbox_exec", { commands: ["true"] });
    assert.deepEqual(result, { ok: true });
  });

  // (f) connection refused rejects with an error whose code is NOT "SUNABA_RPC_TIMEOUT"
  it("rejects with non-SUNABA_RPC_TIMEOUT error when connection is refused", async () => {
    // Acquire a closed port by briefly binding and closing a server
    const dummyServer = http.createServer();
    await new Promise((resolve) => dummyServer.listen(0, "127.0.0.1", resolve));
    const closedPort = dummyServer.address().port;
    await new Promise((resolve) => dummyServer.close(resolve));

    process.env.KUSABI_SUNABA_URL = `http://127.0.0.1:${closedPort}/mcp`;

    await assert.rejects(
      () => callTool("sandbox_exec", { commands: ["true"] }),
      (err) => {
        assert.notEqual(err.code, "SUNABA_RPC_TIMEOUT");
        return true;
      },
    );
  });

  // (g) times out on notifications/initialized when server never responds
  it("times out on notifications/initialized when server never responds", async () => {
    await startServer((req, res, json) => {
      if (json?.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mock-session-g",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: { serverInfo: { name: "test-server", version: "1.0.0" } },
          }),
        );
        return;
      }
      if (json?.method === "notifications/initialized") {
        // Accept TCP connection, do not respond
        return;
      }
    });

    process.env.KUSABI_SUNABA_HANDSHAKE_TIMEOUT_MS = "200";
    const start = Date.now();

    await assert.rejects(
      () => callTool("sandbox_exec", { commands: ["true"] }),
      (err) => {
        assert.equal(err.code, "SUNABA_RPC_TIMEOUT");
        assert.match(
          err.message,
          /^sunaba-rpc: notifications\/initialized timed out after 200 ms/,
        );
        assert.match(err.message, /notifications\/initialized/);
        return true;
      },
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `Expected elapsed < 3000 ms, took ${elapsed} ms`);
  });

  // (h) convenience wrappers forward timeoutMs
  it("convenience wrappers sandboxExec and verifyInContainer forward timeoutMs", async () => {
    await startServer((req, res, json) => {
      if (json?.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mock-session-h",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            result: { serverInfo: { name: "test-server", version: "1.0.0" } },
          }),
        );
        return;
      }
      if (json?.method === "notifications/initialized") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end();
        return;
      }
      if (json?.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: partial-stream\n");
        return;
      }
    });

    process.env.KUSABI_SUNABA_CALL_TIMEOUT_MS = "600000";

    await assert.rejects(
      () => sandboxExec({ commands: ["true"] }, { timeoutMs: 200 }),
      (err) => {
        assert.equal(err.code, "SUNABA_RPC_TIMEOUT");
        assert.match(err.message, /tools\/call sandbox_exec timed out after 200 ms/);
        return true;
      },
    );

    await assert.rejects(
      () => verifyInContainer({ path: "/workspace" }, { timeoutMs: 200 }),
      (err) => {
        assert.equal(err.code, "SUNABA_RPC_TIMEOUT");
        assert.match(err.message, /tools\/call verify_in_container timed out after 200 ms/);
        return true;
      },
    );
  });
});