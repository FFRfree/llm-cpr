#!/usr/bin/env node
import { startGateway } from './server.ts';

try {
  await startGateway();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
