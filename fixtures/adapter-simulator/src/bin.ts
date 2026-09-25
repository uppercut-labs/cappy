#!/usr/bin/env node
/*
 * Run the simulator as a game process. Cappy supplies CAPPY_ENDPOINT and
 * CAPPY_SESSION_TOKEN; the process exits when the controller disconnects.
 */
import { ENDPOINT_ENV, TOKEN_ENV } from "@cappy/protocol";
import { AdapterSimulator } from "./simulator.js";

const endpoint = process.env[ENDPOINT_ENV];
const token = process.env[TOKEN_ENV];
if (endpoint === undefined || token === undefined) {
  process.stderr.write(`adapter simulator: ${ENDPOINT_ENV} and ${TOKEN_ENV} must be set\n`);
  process.exit(2);
}

try {
  const simulator = await AdapterSimulator.connect({ endpoint, token });
  const stop = (): void => simulator.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await simulator.closed;
} catch (cause) {
  process.stderr.write(`adapter simulator: ${(cause as Error).message}\n`);
  process.exit(1);
}
