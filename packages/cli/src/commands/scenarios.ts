import { type CommandResult, type Scenario, commandFailure, commandSuccess } from "@cappy/core";
import type { NegotiatedAdapter } from "@cappy/protocol";
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

  const session = await launchGame({ config, projectDir, env: context.env });
  if (!session.ok) {
    return commandFailure("scenarios", session.error, options);
  }
  try {
    const listed = await session.value.connection.listScenarios(config.timeouts.readyMs);
    if (!listed.ok) {
      return commandFailure("scenarios", listed.error, options);
    }
    return commandSuccess("scenarios", { adapter: session.value.connection.negotiated, scenarios: listed.value }, options);
  } finally {
    await session.value.close();
  }
}
