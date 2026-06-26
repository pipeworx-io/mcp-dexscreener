interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * DEX Screener MCP — DEX price/liquidity/volume data
 *
 * Auth: none. ~300 req/min per IP.
 * Docs: https://docs.dexscreener.com/api/reference
 */


const BASE = 'https://api.dexscreener.com';
const LATEST = `${BASE}/latest/dex`;

const tools: McpToolExport['tools'] = [
  {
    name: 'get_pair',
    description: 'Pair detail (price USD/native, liquidity, 24h volume, 5m/1h/6h/24h tx counts).',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Chain id — ethereum | solana | bsc | polygon | arbitrum | base | …' },
        pair_address: { type: 'string', description: 'Pair / pool address' },
      },
      required: ['chain', 'pair_address'],
    },
  },
  {
    name: 'get_token',
    description: 'All trading pairs for a token address on one chain.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Chain id' },
        token_address: { type: 'string', description: 'Token contract address' },
      },
      required: ['chain', 'token_address'],
    },
  },
  {
    name: 'search_pairs',
    description: 'Free-text search across all DEX Screener chains for trading pairs matching a token name, symbol, or address. Returns up to 30 pairs with price USD, liquidity, 24h volume, and chain/DEX info.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'latest_token_profiles',
    description: 'Newest token profiles created (cross-chain).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'latest_boosted_tokens',
    description: 'Tokens being actively promoted on DEX Screener.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'token_boosts_top',
    description: 'Most-boosted tokens, optionally filtered to a chain / token.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string' },
        token: { type: 'string', description: 'Token address (chain required if passed)' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_pair':
      return dsGet(`${LATEST}/pairs/${encodeURIComponent(reqStr(args, 'chain', '"ethereum"'))}/${encodeURIComponent(reqStr(args, 'pair_address', '"0x..."'))}`);
    case 'get_token':
      return dsGet(`${LATEST}/tokens/${encodeURIComponent(reqStr(args, 'token_address', '"0x..."'))}/${encodeURIComponent(reqStr(args, 'chain', '"ethereum"'))}`);
    case 'search_pairs':
      return dsGet(`${LATEST}/search?q=${encodeURIComponent(reqStr(args, 'query', '"WETH"'))}`);
    case 'latest_token_profiles':
      return dsGet(`${BASE}/token-profiles/latest/v1`);
    case 'latest_boosted_tokens':
      return dsGet(`${BASE}/token-boosts/latest/v1`);
    case 'token_boosts_top':
      if (args.chain && args.token) {
        return dsGet(`${BASE}/token-boosts/top/v1/${encodeURIComponent(String(args.chain))}/${encodeURIComponent(String(args.token))}`);
      }
      return dsGet(`${BASE}/token-boosts/top/v1`);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function dsGet(url: string) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'pipeworx-mcp-dexscreener/1.0 (+https://pipeworx.io)',
    },
  });
  if (res.status === 404) throw new Error('DEX Screener: not found');
  if (res.status === 429) throw new Error('DEX Screener: rate-limit (HTTP 429)');
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DEX Screener error: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
