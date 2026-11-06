import { describe, expect, it } from 'vitest';

import { setupSnippets } from './setup';

const input = {
  exePath: 'C:\\Program Files\\LoreCraft\\lorecraft.exe',
  projectPath: 'C:\\Books\\My World.lorecraft',
  url: 'http://127.0.0.1:47615/mcp',
  token: 'abc123',
};

describe('setupSnippets', () => {
  it('gives the exact Claude Code commands for this program and project', () => {
    const s = setupSnippets(input);
    expect(s.claudeLocal).toBe(
      'claude mcp add --scope user lorecraft -- "C:\\Program Files\\LoreCraft\\lorecraft.exe" --mcp --project "C:\\Books\\My World.lorecraft"',
    );
    expect(s.claudeRemote).toBe(
      'claude mcp add --scope user --transport http lorecraft http://127.0.0.1:47615/mcp --header "Authorization: Bearer abc123"',
    );
  });

  it('gives OpenCode config for local and remote servers', () => {
    const s = setupSnippets(input);
    expect(JSON.parse(s.opencodeLocal).mcp.lorecraft).toEqual({
      type: 'local',
      command: [input.exePath, '--mcp', '--project', input.projectPath],
      enabled: true,
    });
    expect(JSON.parse(s.opencodeRemote ?? '').mcp.lorecraft).toEqual({
      type: 'remote',
      url: input.url,
      enabled: true,
      headers: { Authorization: 'Bearer abc123' },
    });
  });

  it('leaves out what is not known yet', () => {
    const s = setupSnippets({ ...input, projectPath: null, url: null });
    expect(s.claudeLocal).toBe('claude mcp add --scope user lorecraft -- "C:\\Program Files\\LoreCraft\\lorecraft.exe" --mcp');
    expect(s.claudeRemote).toBeNull();
    expect(s.opencodeRemote).toBeNull();
    expect(JSON.parse(s.opencodeLocal).mcp.lorecraft.command).toEqual([input.exePath, '--mcp']);
    expect(s.generic).toContain('Arguments: --mcp');
  });
});
