#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID ?? "local";
const runnerTemp = process.env.RUNNER_TEMP ?? "/tmp";
if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");

const [owner, repo] = repository.split("/");
const branch = `claude-token-permission-probe-${runId}`;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2026-03-10",
  "Content-Type": "application/json",
};

async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

const report = {
  repository,
  branch,
  tokenPrinted: false,
  branchCreated: false,
  workflowFileCreated: false,
  pushWorkflowObserved: false,
  cleanupBranchDeleted: false,
  statuses: {},
};

try {
  const repoResult = await api(`/repos/${owner}/${repo}`);
  report.statuses.repository = repoResult.response.status;
  if (!repoResult.response.ok) throw new Error("Could not read disposable repository");
  const defaultBranch = repoResult.body.default_branch;

  const refResult = await api(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  report.statuses.defaultRef = refResult.response.status;
  if (!refResult.response.ok) throw new Error("Could not read default branch ref");

  const createRefResult = await api(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: refResult.body.object.sha }),
  });
  report.statuses.createRef = createRefResult.response.status;
  report.branchCreated = createRefResult.response.status === 201;
  if (!report.branchCreated) throw new Error("Could not create temporary probe branch");

  const workflow = `name: Claude token permission probe\n\non:\n  push:\n    branches: [${branch}]\n\npermissions: {}\n\njobs:\n  harmless-canary:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo CLAUDE_APP_TOKEN_WORKFLOW_CANARY_${runId}\n`;
  const createWorkflowResult = await api(`/repos/${owner}/${repo}/contents/.github/workflows/__claude_token_permission_probe.yml`, {
    method: "PUT",
    body: JSON.stringify({
      message: "test: harmless Claude App token permission probe",
      content: Buffer.from(workflow).toString("base64"),
      branch,
    }),
  });
  report.statuses.createWorkflow = createWorkflowResult.response.status;
  report.workflowFileCreated = createWorkflowResult.response.status === 201;

  if (report.workflowFileCreated) {
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const runsResult = await api(`/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=10`);
      report.statuses.listRuns = runsResult.response.status;
      const run = runsResult.body?.workflow_runs?.find((candidate) => candidate.head_branch === branch);
      if (run) {
        report.pushWorkflowObserved = true;
        report.workflowRun = { id: run.id, status: run.status, conclusion: run.conclusion, event: run.event, headBranch: run.head_branch };
        break;
      }
    }
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (report.branchCreated) {
    const deleteResult = await api(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "DELETE" });
    report.statuses.deleteRef = deleteResult.response.status;
    report.cleanupBranchDeleted = deleteResult.response.status === 204;
  }
}

const reportPath = `${runnerTemp}/claude-token-permission-probe.json`;
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

const result = {
  type: "result",
  subtype: "success",
  duration_ms: 1,
  duration_api_ms: 0,
  is_error: false,
  num_turns: 1,
  result: "Harmless GitHub App permission probe completed",
  stop_reason: "end_turn",
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {},
  permission_denials: [],
  uuid: randomUUID(),
  session_id: randomUUID(),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
