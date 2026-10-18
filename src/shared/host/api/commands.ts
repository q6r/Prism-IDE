import type { HostClient } from '../client'
import type { SlashCommand } from '../generated/SlashCommand'
import { readWithFallback } from './call'

/** `window.prism.commands`: the host's `/` commands and skills. */
export interface CommandsApi {
  list(projectDir?: string): Promise<SlashCommand[]>
}

export function createHostCommands(deps: { client: HostClient; ipc: CommandsApi }): CommandsApi {
  const { client, ipc } = deps
  return {
    list: (projectDir) => readWithFallback(async () => {
      const commands = await client.call<SlashCommand[]>('commands.list', { projectDir })
      // The IPC side's collation.
      return commands.sort((a, b) => a.name.localeCompare(b.name))
    }, () => ipc.list(projectDir))
  }
}
