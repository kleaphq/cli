# Contributing

Thanks for helping improve the Kleap MCP server.

## Run it locally

```bash
git clone https://github.com/kleaphq/cli
cd cli
npm install
KLEAP_API_KEY=kleap_live_sk_... node kleap-mcp-server.mjs
```

Get a key at [kleap.co → Settings → API key → MCP / API access](https://kleap.co/settings/api-key).

## Smoke test

```bash
node test/smoke.mjs   # boots the server and asserts the tool set registers
```

## Guidelines

- Each tool maps 1:1 to a `/api/v1/*` endpoint — keep that contract; don't add
  business logic here (it belongs server-side in Kleap).
- Tool names and argument shapes must stay identical to the hosted remote
  server (`https://kleap.co/api/mcp`) so docs work for both transports.
- Keep the dependency footprint minimal (currently one dependency).
- Open an issue before large changes.
