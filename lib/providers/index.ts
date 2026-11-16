import type { Backend, Family, ProviderAdapter } from '../contracts.ts';
import { openCode } from './opencode.ts';
import { commandCode } from './commandcode.ts';

const providers: Record<Family, ProviderAdapter> = { ocg: openCode, ccg: commandCode };
export function providerFor(backend: Pick<Backend, 'family'>): ProviderAdapter {
  const provider = providers[backend.family];
  if (!provider) throw new Error(`unsupported backend family: ${backend.family}`);
  return provider;
}
