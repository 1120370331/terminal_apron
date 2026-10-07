type RandomSource = { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array };

/** Browser UUIDs used for request deduplication must also work on HTTP LAN/Tailscale addresses. */
export function createClientId(source: RandomSource | undefined = globalThis.crypto): string {
  if (source?.randomUUID) return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (source?.getRandomValues) source.getRandomValues(bytes);
  else for (let index=0;index<bytes.length;index++) bytes[index]=Math.floor(Math.random()*256);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
