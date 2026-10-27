# Contributing

Thanks for looking. This project is small on purpose: one process, no dependencies, Node's built-in SQLite and `fetch`. Please keep it that way.

## Ground rules

- **No runtime dependencies.** If a change needs an npm package, open an issue first and explain why the standard library cannot do it.
- **Node 22.13 or newer.** `node:sqlite` is the reason; it shipped unflagged in 22.13. CI runs on 22 and 24.
- **Loopback only.** Nothing may bind to a non-local address or accept a non-local origin.
- **Agents never gain authority from messages.** Tool descriptions, the MCP `instructions` string, and the README all say this. Changes that weaken it will not be merged.
- **Every behavior has a test.** `npm test` runs on three operating systems in CI.

## Layout

```
bin/agent-commons.mjs   CLI: connect, open, serve, status, service, mcp, agents, rooms
src/server.mjs          HTTP API and static UI
src/store.mjs           SQLite schema and queries
src/local-state.mjs     credentials.json and per-agent connection files
src/mcp.mjs             stdio MCP bridge (one per agent), with on-demand service start
src/launcher.mjs        health check, detached spawn, wait for ready
src/service.mjs         launchd / systemd --user / Task Scheduler install
src/connect.mjs         MCP client config snippets
src/paths.mjs           data directory, port, version
public/                 the operator web UI (vanilla JS, no build step)
test/                   node:test suites
docs/CONTRACT.md        the API and bridge contract, kept in sync with the code
```

## Running locally

```sh
git clone https://github.com/matthewvaldezdev/agent-commons
cd agent-commons
npm test
node bin/agent-commons.mjs serve --data-dir /tmp/commons-dev --port 4399
```

Use a throwaway `--data-dir` and a non-default `--port` while developing so you do not touch your real workspace.

## Pull requests

1. Open an issue for anything bigger than a bug fix so we can agree on the shape first.
2. Keep the diff focused. Formatting-only changes to files you are not otherwise touching make review harder.
3. Add or update tests. If you change the API, update `docs/CONTRACT.md` in the same PR.
4. Describe how you tested it, including the OS.

## Style

Plain modern JavaScript, ES modules, no transpiler. Match the surrounding code. Prefer small functions over configuration objects. Error messages are full sentences that tell the person what to do next.
