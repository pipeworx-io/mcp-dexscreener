# mcp-dexscreener

DEX Screener MCP — DEX price/liquidity/volume data

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 673+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `get_pair` | Pair detail (price USD/native, liquidity, 24h volume, 5m/1h/6h/24h tx counts). |
| `get_token` | All trading pairs for a token address on one chain. |
| `search_pairs` | Free-text search across all chains. Returns up to 30 pairs. |
| `latest_token_profiles` | Newest token profiles created (cross-chain). |
| `latest_boosted_tokens` | Tokens being actively promoted on DEX Screener. |
| `token_boosts_top` | Most-boosted tokens, optionally filtered to a chain / token. |

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

Or connect to the full Pipeworx gateway for access to all 673+ data sources:

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

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
