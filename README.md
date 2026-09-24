# @pipeworx/dexscreener

DEX Screener MCP — real-time DEX prices and liquidity across all major EVM + Solana chains. No auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `get_pair(chain, pair_address)` — single pair detail (price, liquidity, volume, txns)
- `get_token(chain, token_address)` — all pairs for a token on one chain
- `search_pairs(query)` — free-text search across pairs (max 30 results)
- `latest_token_profiles()` — newest tokens listed
- `latest_boosted_tokens()` — tokens currently being promoted on DEX Screener
- `token_boosts_top(chain?, token?)` — leaderboard of most-boosted tokens

## Data source

`https://api.dexscreener.com/` — JSON. Rate-limit ~300 req/min per IP.

Endpoints used, because two of the obvious-looking ones are wrong (fleet #1579,
verified against the live API 2026-09-08):

| Tool | Route | Note |
|---|---|---|
| `get_pair` | `/latest/dex/pairs/{chain}/{pair}` | |
| `get_token` | `/token-pairs/v1/{chain}/{token}` | **not** `/tokens/v1/{chain}/{token}` — that route answers 200 with a SINGLE pool (WETH: 1 vs 30), so the wrong one loses 97% of the data without erroring |
| `search_pairs` | `/latest/dex/search?q=` | |
| `latest_token_profiles` | `/token-profiles/latest/v1` | bare array |
| `latest_boosted_tokens` | `/token-boosts/latest/v1` | bare array |
| `token_boosts_top` | `/token-boosts/top/v1` | takes no path filter; `chain`/`token` are filtered client-side |

## What an empty answer means here

DEX Screener signals "nothing indexed" with **HTTP 200 and an empty list** —
`[]` from the `v1` routes, `{"pairs":null}` from `/latest/dex/pairs`. It does
not 404 for an unknown address. So this pack only ever says `not_found:` on a
200 it actually read; any error status is reported as `upstream_down:` and
explicitly says it is NOT evidence about the caller's arguments. Before #1579
the pack mapped every 404 to "no pairs for that address, check the chain and
the exact contract address" — which was false for every `get_token` call it
ever served, and convincing enough that callers re-checked correct addresses.

Common chain ids: `ethereum`, `solana`, `bsc`, `polygon`, `arbitrum`, `base`, `avalanche`, `optimism`, `fantom`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "dexscreener": {
      "url": "https://gateway.pipeworx.io/dexscreener/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/dexscreener/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/dexscreener_get_pair \
  -H 'Content-Type: application/json' \
  -d '{"chain":"ethereum","pair_address":"0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/dexscreener_get_pair`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "dexscreener": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-dexscreener"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-dexscreener
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Dexscreener data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
