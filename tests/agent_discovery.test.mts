import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { discoverAgents } from "../extensions/spawn-subagent/agents.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-discovery-"));
  const project = path.join(root, "project");
  const agents = path.join(project, ".pi", "agents");
  const vendor = path.join(root, "vendor");
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(vendor);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function link(name: string, content: string) {
    const target = path.join(vendor, `${name}.md`);
    fs.writeFileSync(target, content);
    fs.symlinkSync(target, path.join(agents, name));
    return target;
  }
  return { project, agents, link, discover: () => discoverAgents(project, "project").agents };
}

test("plain Markdown vendor links infer stable names and retain the exact canonical prompt", (t) => {
  const f = fixture(t);
  const body = "\n# Jira Ticket Assistant\r\n\r\nFollow canonical vendor instructions.\r\n";
  const target = f.link("jira-ticket-assistant", body);
  f.link("Slack-Discovery.md", "# Slack Discovery Agent\n\nInstructions.\n");
  const found = f.discover();
  const jira = found.find((agent) => agent.name === "jira-ticket-assistant")!;
  assert.equal(jira.description, "Jira Ticket Assistant");
  assert.equal(jira.systemPrompt, body);
  assert.equal(jira.model, undefined);
  assert.equal(jira.tools, undefined);
  assert.equal(jira.source, "project");
  assert.equal(jira.filePath, path.join(f.agents, "jira-ticket-assistant"));
  assert.equal(fs.readFileSync(target, "utf8"), body);
  assert.ok(found.some((agent) => agent.name === "Slack-Discovery"));
  assert.deepEqual(discoverAgents(f.project, "project", { allowProject: false }).agents, []);
});

test("frontmatter identity, description, tools and model retain precedence", (t) => {
  const f = fixture(t);
  f.link("filename-not-name", "---\nname: canonical\ndescription: Explicit description\ntools: read, bash\nmodel: provider/model\n---\n\n# Different title\nBody.\n");
  const [agent] = f.discover();
  assert.equal(agent.name, "canonical");
  assert.equal(agent.description, "Explicit description");
  assert.deepEqual(agent.tools, ["read", "bash"]);
  assert.equal(agent.model, "provider/model");
  assert.equal(agent.systemPrompt, "# Different title\nBody.");
});

test("incomplete or invalid YAML never falls back to filename or Markdown heading", (t) => {
  const f = fixture(t);
  f.link("missing-name", "---\ndescription: Existing metadata\n---\n# Missing Name\nBody");
  f.link("missing-description", "---\nname: explicit\n---\n# Missing Description\nBody");
  f.link("malformed", "---\nname: [broken\ndescription: Bad\n---\n# Malformed\nBody");
  f.link("unclosed", "---\nname: unclosed\n# Missing delimiter\nBody");
  f.link("empty", "---\n---\n# Empty Metadata\nBody");
  f.link("valid", "# Valid Agent\nStill discovered after bad YAML.\n");
  assert.deepEqual(f.discover().map((agent) => agent.name), ["valid"]);
});

test("fallback excludes ordinary Markdown, invalid names and missing headings", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.agents, "ordinary.md"), "# Not vendor linked\nBody");
  f.link("invalid name", "# Invalid Filename\nBody");
  f.link("no-heading", "Description only\nBody");
  f.link("second-level", "## Not a level-one heading\nBody");
  f.link("blank-title", "#   \nBody");
  assert.deepEqual(f.discover(), []);
});
