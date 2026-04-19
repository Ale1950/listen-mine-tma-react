/**
 * ═══ Mamaboard Service ═══
 *
 * Read on-chain NACKL LOCKED (Mamaboard contract balance) and auto-discover
 * which contract holds it for a given wallet.
 *
 * Doc references:
 *  - https://dev.ackinacki.com/graphql/blockchain-api
 *  - https://dev.ackinacki.com/graphql/field-descriptions
 *  - https://dev.ackinacki.com/examples/graphql-api-examples/accounts
 *
 * currency=1 in balance_other = NACKL (confirmed by wallet-balance code).
 */

import { NETWORKS } from './blockchain';

const NETS = [NETWORKS.mainnet, NETWORKS.mainnetCf];

async function gql(endpoint: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// ═══ Read locked NACKL (currency=1) of a single account ═══
export interface LockedNacklRead {
  address: string;
  nackl: number;              // full NACKL units (raw / 1e9)
  nacklRaw: string;           // raw nano-string as returned by node
  accType: number | null;
  network: string;            // endpoint name that answered
  timestamp: number;          // ms
}

export async function getLockedNackl(address: string): Promise<LockedNacklRead> {
  const query = `query($addr:String!){
    blockchain { account(address:$addr){ info {
      address acc_type balance_other { currency value(format:DEC) }
    } } }
  }`;
  let lastErr: string | null = null;
  for (const net of NETS) {
    try {
      const data = await gql(net.endpoint, query, { addr: address });
      const info = data?.blockchain?.account?.info;
      if (!info) { lastErr = 'account not found'; continue; }
      let raw = '0';
      for (const tok of info.balance_other || []) {
        if (tok.currency === 1) { raw = tok.value || '0'; break; }
      }
      return {
        address,
        nackl: parseFloat(raw) / 1e9,
        nacklRaw: raw,
        accType: info.acc_type ?? null,
        network: net.name,
        timestamp: Date.now(),
      };
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr || 'no network answered');
}

// ═══ Linked accounts discovery ═══
// Scans the wallet's outbound internal messages to find contracts it has
// interacted with, then ranks them by NACKL balance. Top holder is almost
// certainly the Mamaboard, since that is where mining rewards accumulate.
export interface LinkedAccount {
  address: string;
  nackl: number;
  nacklRaw: string;
  messageCount: number;
  codeHash: string | null;
  dappId: string | null;
}

async function fetchOutboundDests(
  endpoint: string, wallet: string, first = 100
): Promise<Map<string, number>> {
  const query = `query($addr:String!,$first:Int!){
    blockchain { account(address:$addr){
      messages(msg_type:[IntOut], first:$first){
        edges { node { dst } }
      }
    } }
  }`;
  const counts = new Map<string, number>();
  const data = await gql(endpoint, query, { addr: wallet, first });
  const edges = data?.blockchain?.account?.messages?.edges || [];
  for (const e of edges) {
    const dst: string | undefined = e?.node?.dst;
    if (!dst) continue;
    if (dst === wallet) continue;
    if (!dst.startsWith('0:') && !dst.startsWith('-1:')) continue;
    counts.set(dst, (counts.get(dst) || 0) + 1);
  }
  return counts;
}

async function fetchAccountsBatch(
  endpoint: string, addrs: string[]
): Promise<LinkedAccount[]> {
  if (addrs.length === 0) return [];
  const aliases = addrs.map((_, i) =>
    `a${i}: account(address:$a${i}){ info {
      address acc_type code_hash dapp_id
      balance_other { currency value(format:DEC) }
    } }`
  ).join('\n');
  const decls = addrs.map((_, i) => `$a${i}:String!`).join(',');
  const query = `query(${decls}){ blockchain { ${aliases} } }`;
  const vars: Record<string, string> = {};
  addrs.forEach((a, i) => { vars[`a${i}`] = a; });
  const data = await gql(endpoint, query, vars);
  const chain = data?.blockchain || {};
  return addrs.map((addr, i) => {
    const info = chain[`a${i}`]?.info;
    if (!info) {
      return { address: addr, nackl: 0, nacklRaw: '0', messageCount: 0, codeHash: null, dappId: null };
    }
    let raw = '0';
    for (const tok of info.balance_other || []) {
      if (tok.currency === 1) { raw = tok.value || '0'; break; }
    }
    return {
      address: addr,
      nackl: parseFloat(raw) / 1e9,
      nacklRaw: raw,
      messageCount: 0,
      codeHash: info.code_hash || null,
      dappId: info.dapp_id || null,
    };
  });
}

export async function discoverLinkedAccounts(wallet: string): Promise<LinkedAccount[]> {
  let lastErr: string | null = null;
  for (const net of NETS) {
    try {
      const counts = await fetchOutboundDests(net.endpoint, wallet, 100);
      if (counts.size === 0) { lastErr = 'no outbound messages'; continue; }
      const sorted = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
      const addrs = sorted.map(([a]) => a);
      const accs = await fetchAccountsBatch(net.endpoint, addrs);
      const countMap = new Map(sorted);
      for (const a of accs) a.messageCount = countMap.get(a.address) || 0;
      accs.sort((a, b) => b.nackl - a.nackl);
      return accs;
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (lastErr && lastErr !== 'no outbound messages') throw new Error(lastErr);
  return [];
}

// Pick the best Mamaboard candidate from a discovered list.
// Heuristic: top NACKL holder. Returns null if none holds NACKL.
export function guessMamaboard(linked: LinkedAccount[]): LinkedAccount | null {
  if (linked.length === 0) return null;
  const top = linked[0];
  return top.nackl > 0 ? top : null;
}
