/**
 * dsh-mcp-skill-manager — uninstall cleanup.
 *
 * Runs as the package's `postuninstall` lifecycle script (pnpm executes it
 * when `dsh plugin --profile <p> remove dsh-mcp-skill-manager` removes the
 * package), so the plugin's persisted state is removed together with the
 * plugin, as the user requested.
 *
 * Deletes the whole plugin-owned state directory:
 *   `<harness home>/mcp-skill-manager/`
 * (`<harness home>` = `$DSH_HOME` or `~/.dsh`). Idempotent and safe: a
 * missing directory is not an error.
 */
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const dir = join(home, 'mcp-skill-manager');

try {
  await rm(dir, { recursive: true, force: true });
  console.log(`mcp-skill-manager: removed state directory ${dir}`);
} catch (error) {
  console.error(`mcp-skill-manager: failed to remove state directory ${dir}: ${String(error)}`);
  process.exitCode = 1;
}
