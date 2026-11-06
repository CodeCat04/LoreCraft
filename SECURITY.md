# Security policy

## Reporting a problem

Please report security problems privately, never in a public issue, pull request or discussion.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/CodeCat04/LoreCraft/security/advisories/new>. Only the maintainers see the report, and the fix can be worked on with you in a private copy of the repository.

Please include:

- what an attacker could do, and what they need first, such as a project file they made or a page they wrote,
- the steps to make it happen, ideally with a small made-up project rather than your own writing,
- the LoreCraft version and your system, which Help > "Copy diagnostics" gives.

You should hear back within a week. Once a fix is released, the advisory is published with credit to you, unless you would rather not be named.

## Supported versions

Only the latest release gets security fixes.

## What is worth reporting

LoreCraft keeps people's writing on their own computer and treats lore, imported files and AI output as untrusted. For example:

- Lore text, an imported file, a project file or a model's response that runs script in the app, reads or writes files the writer did not choose, or reaches the network.
- An API key leaving the system credential store, or showing up in logs, diagnostics, exports or project files, or being sent anywhere but its own provider.
- Text marked "local only" reaching a cloud model.
- The MCP server answering anything other than this computer, or letting an outside tool change text without the writer accepting it.
- The update check sending anything beyond its one request to GitHub.

Bugs that lose work but are not attacks are just as important. Report those in a normal issue, so they get fixed in the open.

Not in scope: the installers not being code signed yet (see [docs/RELEASING.md](docs/RELEASING.md)), and problems in a local model server or a cloud provider themselves.
