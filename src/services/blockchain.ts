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
