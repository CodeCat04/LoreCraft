/** Ready-to-copy setup for the actual program and project. See docs/MCP.md. */

export interface SetupInput {
  exePath: string;
  projectPath: string | null;
  url: string | null;
  token: string;
}

export interface SetupSnippets {
  claudeLocal: string;
  claudeRemote: string | null;
  opencodeLocal: string;
  opencodeRemote: string | null;
  generic: string;
}

const NAME = 'lorecraft';

/** Double quotes work the same in PowerShell, cmd and POSIX shells for these paths. */
function quoted(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

function args(project: string | null): string[] {
  return project ? ['--mcp', '--project', project] : ['--mcp'];
}

export function setupSnippets({ exePath, projectPath, url, token }: SetupInput): SetupSnippets {
  const command = [exePath, ...args(projectPath)];
  const claudeArgs = projectPath ? `--mcp --project ${quoted(projectPath)}` : '--mcp';
  const opencode = (server: Record<string, unknown>) =>
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { [NAME]: server } }, null, 2);
  const header = `Authorization: Bearer ${token}`;
  return {
    claudeLocal: `claude mcp add --scope user ${NAME} -- ${quoted(exePath)} ${claudeArgs}`,
    claudeRemote: url ? `claude mcp add --scope user --transport http ${NAME} ${url} --header ${quoted(header)}` : null,
    opencodeLocal: opencode({ type: 'local', command, enabled: true }),
    opencodeRemote: url
      ? opencode({ type: 'remote', url, enabled: true, headers: { Authorization: `Bearer ${token}` } })
      : null,
    generic: [
      `Command: ${exePath}`,
      `Arguments: ${args(projectPath).join(' ')}`,
      'Transport: stdio',
      ...(url ? ['', `Or over HTTP: ${url}`, `Header: ${header}`] : []),
    ].join('\n'),
  };
}
