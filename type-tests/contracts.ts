// Compile-only public contracts; node --test never executes this file.
import type { Backend, ProviderAdapter } from '../lib/contracts.ts';
import { providerFor } from '../lib/providers/index.ts';
import { chatCompletions } from '../lib/protocols/chat-completions.ts';

const backend: Backend = { name: 'stable-id', family: 'ocg', base_url: 'http://localhost', key_env: 'TEST_KEY' };
const provider: ProviderAdapter = providerFor(backend);
const headers = provider.requestHeaders({ headers: {}, upstreamKey: 'fake', identity: { kind: 'fingerprint', key: 'abc' } });
const session: string | string[] | number | undefined = headers['x-opencode-session'];
const target: URL = chatCompletions.target(backend.base_url);
const usage: Record<string, unknown> | null = chatCompletions.usageCollector(true).end();
void [session, target, usage];
// @ts-expect-error Unknown families must not silently choose the OCG adapter.
providerFor({ ...backend, family: 'imaginary' });
// @ts-expect-error Both real adapters must implement quota reads as well as request headers.
const incomplete: ProviderAdapter = { requestHeaders: () => ({}) };
// @ts-expect-error A provider secret is not an optional part of request preparation.
provider.requestHeaders({ headers: {} });
// @ts-expect-error Protocol paths accept a URL prefix, not a backend identity.
chatCompletions.target(42);
void incomplete;
