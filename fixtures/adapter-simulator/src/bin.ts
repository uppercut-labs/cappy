#!/usr/bin/env node
/*
 * Run the simulator as a game process. Cappy supplies CAPPY_ENDPOINT and
 * CAPPY_SESSION_TOKEN; tests may pass CAPPY_SIM_OPTIONS as JSON. The process
 * exits when the controller disconnects.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ENDPOINT_ENV, TOKEN_ENV } from "@cappy/protocol";
import { AdapterSimulator, type SimulatorProcessOptions } from "./simulator.js";

const endpoint = process.env[ENDPOINT_ENV];
const token = process.env[TOKEN_ENV];
if (endpoint === undefined || token === undefined) {
  process.stderr.write(`adapter simulator: ${ENDPOINT_ENV} and ${TOKEN_ENV} must be set\n`);
  process.exit(2);
}
const extra = JSON.parse(process.env["CAPPY_SIM_OPTIONS"] ?? "{}") as SimulatorProcessOptions;

try {
  const simulator = await AdapterSimulator.connect({
    endpoint,
    token,
    ...(extra.capabilities === undefined ? {} : { capabilities: extra.capabilities }),
    ...(extra.adapter === undefined ? {} : { adapter: extra.adapter }),
    ...(extra.game === undefined ? {} : { game: extra.game }),
    ...(extra.build === undefined ? {} : { build: extra.build }),
    ...(extra.replayPayloadBase64 === undefined ? {} : { replayPayload: Buffer.from(extra.replayPayloadBase64, "base64") }),
    ...(extra.replayHandoff === undefined ? {} : { replayHandoff: extra.replayHandoff }),
    ...(extra.replayDir === undefined ? {} : { replayDir: extra.replayDir }),
    ...(extra.omitReplay === undefined ? {} : { omitReplay: extra.omitReplay }),
    ...(extra.timeScale === undefined ? {} : { timeScale: extra.timeScale }),
  });
  const stop = (): void => simulator.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await simulator.closed;
  if (extra.receivedReplayDir !== undefined) {
    simulator.receivedReplays.forEach((bytes, index) => {
      writeFileSync(path.join(extra.receivedReplayDir ?? ".", `received-${index}.bin`), bytes);
    });
  }
} catch (cause) {
  process.stderr.write(`adapter simulator: ${(cause as Error).message}\n`);
  process.exit(1);
}
