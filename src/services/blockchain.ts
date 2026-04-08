/**
 * ═══ Blockchain Service ═══
 *
 * Pure GraphQL queries to read wallet balances from Acki Nacki MainNet.
 * No TVM SDK dependency — works directly with the GraphQL API.
 *
 * Reads:
 * - NACKL Free (ECC[1])
 * - SHELL (ECC[2])
 * - USDC (ECC[3]) — new native token
 * - VMSHELL (account.balance, gas)
 *
 * For NACKL Locked + on-chain wallet name verification we'd need TVM SDK
 * with the Wallet ABI. Phase 2 enhancement.
 */

export const NETWORKS = {
  mainnet: { name: 'MainNet', endpoint: 'https://mainnet.ackinacki.org/graphql' },
  mainnetCf: { name: 'MainNet-CF', endpoint: 'https://mainnet-cf.ackinacki.org/graphql' },
  shellnet: { name: 'ShellNet', endpoint: 'https://shellnet.ackinacki.org/graphql' },
};

export interface WalletBalance {
  network: string;
  address: string;
  accType: number;
  vmShell: string;
  nacklFree: string;
  shell: string;
  usdc: string;
  found: boolean;
  error?: string;
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

      for (const t of info.balance_other || []) {
        const v = (parseFloat(t.value || '0') / 1e9).toFixed(4);
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
    found: false,
    error: 'Wallet not found on any network',
  };
}
