/**
 * ═══ Blockchain Service ═══
 *
 * GraphQL queries to read wallet balances and debug info from Acki Nacki MainNet.
 * All responses include raw data for debugging.
 */

export const NETWORKS = {
  mainnet: { name: 'MainNet', endpoint: 'https://mainnet.ackinacki.org/graphql' },
  mainnetCf: { name: 'MainNet-CF', endpoint: 'https://mainnet-cf.ackinacki.org/graphql' },
  shellnet: { name: 'ShellNet', endpoint: 'https://shellnet.ackinacki.org/graphql' },
};

// Explorer URL builders for open-in-browser buttons
export const EXPLORER_BASE = 'https://mainnet-cf.ackinacki.org';
export function explorerAccountUrl(address: string): string {
  return `${EXPLORER_BASE}/accounts/${address}`;
}

export interface WalletBalance {
  network: string;
  address: string;
  accType: number;
  vmShell: string;
  nacklFree: string;
  shell: string;
  usdc: string;
  // Raw balance_other array for debug
  rawBalanceOther: Array<{ currency: number; value: string }>;
  found: boolean;
  error?: string;
}

export interface DebugAccountInfo {
  network: string;
  address: string;
  accType: number | null;
  balance: string;
  balanceOther: Array<{ currency: number; value: string }>;
  codeHash: string | null;
  lastPaid: number | null;
  dappId: string | null;
  recentMessagesCount: number;
  error: string | null;
  raw: any;
}

async function gqlQuery(endpoint: string, query: string, variables: any = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

async function queryAccount(endpoint: string, address: string) {
  const query = `query($addr:String!){
    blockchain {
      account(address:$addr) {
        info {
          address
          acc_type
          balance(format:DEC)
          balance_other { currency value(format:DEC) }
        }
      }
    }
  }`;
  const data = await gqlQuery(endpoint, query, { addr: address });
  return data?.blockchain?.account?.info || null;
}

export async function getWalletBalance(address: string): Promise<WalletBalance> {
  const networks = [NETWORKS.mainnet, NETWORKS.mainnetCf, NETWORKS.shellnet];

  for (const net of networks) {
    try {
      const info = await queryAccount(net.endpoint, address);
      if (!info || info.acc_type === undefined || info.acc_type === 3) continue;

      const vmShell = (parseFloat(info.balance || '0') / 1e9).toFixed(4);

      let nacklFree = '0.0000';
      let shell = '0.0000';
      let usdc = '0.0000';

      const rawBalanceOther: Array<{ currency: number; value: string }> = [];
      for (const t of info.balance_other || []) {
        const v = (parseFloat(t.value || '0') / 1e9).toFixed(4);
        rawBalanceOther.push({ currency: t.currency, value: t.value });
        if (t.currency === 1) nacklFree = v;
        if (t.currency === 2) shell = v;
        if (t.currency === 3) usdc = v;
      }

      return {
        network: net.name,
        address,
        accType: info.acc_type,
        vmShell,
        nacklFree,
        shell,
        usdc,
        rawBalanceOther,
        found: true,
      };
    } catch (e) {
      continue;
    }
  }

  return {
    network: '—',
    address,
    accType: -1,
    vmShell: '0',
    nacklFree: '0',
    shell: '0',
    usdc: '0',
    rawBalanceOther: [],
    found: false,
    error: 'Account not found on any network',
  };
}

// ═══ Deep debug query — returns verbose info for a single address ═══
// Includes balance, dapp_id, recent messages count, and full raw response
export async function getDebugAccountInfo(address: string): Promise<DebugAccountInfo> {
  const networks = [NETWORKS.mainnet, NETWORKS.mainnetCf];

  for (const net of networks) {
    try {
      const query = `query($addr:String!){
        blockchain {
          account(address:$addr) {
            info {
              address
              acc_type
              balance(format:DEC)
              balance_other { currency value(format:DEC) }
              code_hash
              last_paid
              dapp_id
            }
          }
        }
      }`;
      const data = await gqlQuery(net.endpoint, query, { addr: address });
      const info = data?.blockchain?.account?.info;
      if (!info) continue;

      return {
        network: net.name,
        address,
        accType: info.acc_type ?? null,
        balance: info.balance || '0',
        balanceOther: (info.balance_other || []).map((b: any) => ({
          currency: b.currency,
          value: b.value,
        })),
        codeHash: info.code_hash || null,
        lastPaid: info.last_paid ?? null,
        dappId: info.dapp_id || null,
        recentMessagesCount: 0,
        error: null,
        raw: info,
      };
    } catch (e: any) {
      continue;
    }
  }

  return {
    network: '—',
    address,
    accType: null,
    balance: '0',
    balanceOther: [],
    codeHash: null,
    lastPaid: null,
    dappId: null,
    recentMessagesCount: 0,
    error: 'Account not found on any network',
    raw: null,
  };
}

// ═══ LINKED ACCOUNTS DISCOVERY ═══
// Queries the wallet's outbound internal messages (IntOut) to discover all
// contracts it has ever interacted with. Among these we expect to find the
// Mamaboard contract(s) where mining rewards are locked.

export interface LinkedAccount {
  address: string;
  nacklBalance: number;      // NACKL (currency 1), in full units (not nano)
  nacklRawValue: string;     // Raw nano value as string
  shellBalance: number;      // SHELL (currency 2), in full units
  usdcBalance: number;       // USDC (currency 3), in full units
  vmShell: number;           // VMSHELL balance, in full units
  codeHash: string | null;
  dappId: string | null;
  accType: number | null;
  label?: string;            // Optional human label (e.g. "Mamaboard", "Miner")
  messageCount: number;      // How many IntOut messages went to this account
}

// Query the wallet's outbound internal messages and extract unique destination addresses.
// Returns them sorted by frequency (most-messaged first), limited to `maxUnique`.
async function fetchOutboundDestinations(
  endpoint: string,
  walletAddress: string,
  pageSize = 50,
  maxUnique = 20
): Promise<Map<string, number>> {
  const query = `query($addr: String!, $first: Int!) {
    blockchain {
      account(address: $addr) {
        messages(msg_type: [IntOut], first: $first) {
          edges {
            node {
              dst
              msg_type
            }
          }
        }
      }
    }
  }`;

  const counts = new Map<string, number>();
  try {
    const data = await gqlQuery(endpoint, query, { addr: walletAddress, first: pageSize });
    const edges = data?.blockchain?.account?.messages?.edges || [];
    for (const edge of edges) {
      const dst: string | undefined = edge?.node?.dst;
      if (!dst) continue;
      // Skip self-messages and empty/invalid addresses
      if (dst === walletAddress) continue;
      if (!dst.startsWith('0:') && !dst.startsWith('-1:')) continue;
      counts.set(dst, (counts.get(dst) || 0) + 1);
    }
  } catch (e) {
    // Fail silently — will try next network
  }

  // Sort by count descending and limit
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxUnique);
  return new Map(sorted);
}

// Batch-fetch account info for multiple addresses via a single GraphQL query.
async function fetchMultipleAccountInfo(
  endpoint: string,
  addresses: string[]
): Promise<LinkedAccount[]> {
  if (addresses.length === 0) return [];
  // Build a single query with aliased fields for each address.
  const aliases = addresses.map((_, i) => {
    return `a${i}: account(address: $addr${i}) {
      info {
        address
        acc_type
        balance(format: DEC)
        balance_other { currency value(format: DEC) }
        code_hash
        dapp_id
      }
    }`;
  }).join('\n');
  const varDecls = addresses.map((_, i) => `$addr${i}: String!`).join(', ');
  const query = `query(${varDecls}) {
    blockchain {
      ${aliases}
    }
  }`;
  const variables: Record<string, string> = {};
  addresses.forEach((addr, i) => { variables[`addr${i}`] = addr; });

  const results: LinkedAccount[] = [];
  try {
    const data = await gqlQuery(endpoint, query, variables);
    const blockchain = data?.blockchain || {};
    addresses.forEach((addr, i) => {
      const info = blockchain[`a${i}`]?.info;
      if (!info) {
        results.push({
          address: addr,
          nacklBalance: 0,
          nacklRawValue: '0',
          shellBalance: 0,
          usdcBalance: 0,
          vmShell: 0,
          codeHash: null,
          dappId: null,
          accType: null,
          messageCount: 0,
        });
        return;
      }
      let nackl = 0, nacklRaw = '0', shell = 0, usdc = 0;
      for (const t of info.balance_other || []) {
        const v = parseFloat(t.value || '0') / 1e9;
        if (t.currency === 1) { nackl = v; nacklRaw = t.value; }
        if (t.currency === 2) { shell = v; }
        if (t.currency === 3) { usdc = v; }
      }
      results.push({
        address: addr,
        nacklBalance: nackl,
        nacklRawValue: nacklRaw,
        shellBalance: shell,
        usdcBalance: usdc,
        vmShell: parseFloat(info.balance || '0') / 1e9,
        codeHash: info.code_hash || null,
        dappId: info.dapp_id || null,
        accType: info.acc_type ?? null,
        messageCount: 0,
      });
    });
  } catch {
    // Partial failure — return empty results for missing entries
  }
  return results;
}

// MAIN: Discover all contracts linked to the wallet and fetch their balances.
// Returns the list sorted by NACKL balance descending (Mamaboard should be #1).
export async function discoverLinkedAccounts(
  walletAddress: string
): Promise<LinkedAccount[]> {
  const networks = [NETWORKS.mainnet, NETWORKS.mainnetCf];

  for (const net of networks) {
    try {
      // Step 1: discover destinations from outbound messages
      const counts = await fetchOutboundDestinations(net.endpoint, walletAddress, 100, 30);
      if (counts.size === 0) continue;

      // Step 2: fetch balances for all discovered addresses
      const addresses = Array.from(counts.keys());
      const accounts = await fetchMultipleAccountInfo(net.endpoint, addresses);

      // Step 3: attach message counts
      for (const acc of accounts) {
        acc.messageCount = counts.get(acc.address) || 0;
      }

      // Step 4: sort by NACKL balance descending (locked NACKL holders first)
      accounts.sort((a, b) => b.nacklBalance - a.nacklBalance);
      return accounts;
    } catch {
      continue;
    }
  }
  return [];
}

// Aggregate all locked NACKL across linked accounts.
// This sums NACKL from every contract the wallet has interacted with,
// so the result matches what dev.acki.live shows as "NACKL LOCKED".
export function sumLockedNackl(linked: LinkedAccount[]): number {
  return linked.reduce((sum, a) => sum + a.nacklBalance, 0);
}
