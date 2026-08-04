# @pipeworx/dexscreener

DEX Screener MCP — real-time DEX prices and liquidity across all major EVM + Solana chains. No auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `get_pair(chain, pair_address)` — single pair detail (price, liquidity, volume, txns)
- `get_token(chain, token_address)` — all pairs for a token on one chain
- `search_pairs(query)` — free-text search across pairs (max 30 results)
- `latest_token_profiles()` — newest tokens listed
- `latest_boosted_tokens()` — tokens currently being promoted on DEX Screener
- `token_boosts_top(chain?, token?)` — leaderboard of most-boosted tokens

## Data source

`https://api.dexscreener.com/` — JSON. Rate-limit ~300 req/min per IP.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Dexscreener data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
