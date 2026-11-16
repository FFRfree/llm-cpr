#!/usr/bin/env node
import { startGateway } from './server.mjs';

try {
  await startGateway();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
