import { homedir } from 'node:os';
import { join } from 'node:path';
export function getAgentDir() { return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'); }
export class BorderedLoader {
  controller = new AbortController();
  get signal() { return this.controller.signal; }
  onAbort;
  dispose() {}
}
