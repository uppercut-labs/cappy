#!/usr/bin/env node
import { createInterface } from "node:readline";
import type { Interrupts } from "./context.js";
import { main } from "./main.js";

/** Enter stops a running command; Ctrl+C or SIGTERM cancels it. */
function listenForInterrupts(): Interrupts {
  let stop!: () => void;
  let cancel!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const cancelled = new Promise<void>((resolve) => (cancel = resolve));
  const lines = createInterface({ input: process.stdin });
  lines.on("line", () => stop());
  let interrupts = 0;
  const onSignal = (): void => {
    interrupts += 1;
    if (interrupts > 1) {
      process.exit(130);
    }
    cancel();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    stop: stopped,
    cancel: cancelled,
    dispose() {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      lines.close();
      // stdin may be a TTY, a pipe, or a file stream; only some can be unref'd.
      process.stdin.pause();
      (process.stdin as { unref?: () => void }).unref?.();
    },
  };
}

const exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
  listenForInterrupts,
});
process.exitCode = exitCode;
