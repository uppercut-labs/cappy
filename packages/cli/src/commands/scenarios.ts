import { type CommandResult, type Result, type Scenario, cappyError, commandFailure, commandSuccess, err } from "@uppercut-labs/cappy-internal-core";
import type { NegotiatedAdapter } from "@uppercut-labs/cappy-internal-protocol";
import type { CommandContext } from "../context.js";
import { launchGame } from "../game.js";
import { loadCommandConfig } from "../project.js";

export interface ScenariosReport {
  readonly adapter: NegotiatedAdapter;
  readonly scenarios: readonly Scenario[];
}

/** Launch the game, negotiate with its adapter, and list registered scenarios. Records nothing. */
export async function scenarios(context: CommandContext): Promise<CommandResult<ScenariosReport>> {
  const options = { correlationId: context.correlationId };
  const loaded = await loadCommandConfig(context);
  if (!loaded.ok) {
    return commandFailure("scenarios", loaded.error, options);
  }
  const { config, projectDir } = loaded.value;

  const session = await launchGame({ config, projectDir, env: context.env, signal: context.signal });
  if (!session.ok) {
    return commandFailure("scenarios", session.error, options);
  }
  let onAbort!: () => void;
  const aborted = new Promise<Result<readonly Scenario[]>>((resolve) => (onAbort = () => resolve(err(cappyError("OPERATION_CANCELLED", "scenario discovery cancelled", "scenarios")))));
  context.signal?.addEventListener("abort", onAbort, { once: true });
  if (context.signal?.aborted === true) {
    onAbort();
  }
  try {
    const listed = await Promise.race([session.value.connection.listScenarios(config.timeouts.readyMs), aborted]);
    if (!listed.ok) {
      return commandFailure("scenarios", listed.error, options);
    }
    return commandSuccess("scenarios", { adapter: session.value.connection.negotiated, scenarios: listed.value }, options);
  } finally {
    context.signal?.removeEventListener("abort", onAbort);
    await session.value.close();
  }
}
