// Validate /api/walker-interview by running each kickoff fixture through the
// extraction → interview pipeline and printing the resulting interview script.
//
// Usage:
//   node scripts/test-interview.js              # default = medium
//   node scripts/test-interview.js sparse       # named fixture
//   node scripts/test-interview.js all          # run every fixture in sequence
//
// Requires the dev API server on http://localhost:3001 (or HOST env var).

const HOST = process.env.HOST || 'http://localhost:3001';

const FIXTURES = {
  sparse: {
    profile: { jobTitle: 'Senior Engineer', tenure: '4 years', typicalWeek: 'Reviewing PRs, writing code, sprint planning' },
    coreTask: 'Review pull requests',
    kickoffAnswer: 'I look at the code and leave comments, then approve or ask for changes.',
  },
  medium: {
    profile: { jobTitle: 'Senior Engineer', tenure: '4 years', typicalWeek: 'Reviewing PRs, writing code, sprint planning' },
    coreTask: 'Review pull requests',
    kickoffAnswer: 'When a PR comes in I check the description and the diff, leave inline comments on anything that looks wrong, run the tests, and either approve or request changes.',
  },
  detailed: {
    profile: { jobTitle: 'Senior Engineer', tenure: '4 years', typicalWeek: 'Reviewing PRs, writing code, sprint planning' },
    coreTask: 'Review pull requests',
    kickoffAnswer: 'I get a Slack notification from GitHub, open the PR, read the description and linked ticket, scan the diff for obvious issues, pull the branch locally, run the test suite, leave inline comments where I see problems, and either approve or request changes. If I request changes, the author pushes more commits and I re-review.',
  },
  prd: {
    profile: { jobTitle: 'Product Manager', tenure: '3 years', typicalWeek: 'Sprint planning, writing PRDs, syncing with engineering' },
    coreTask: 'Write a PRD',
    kickoffAnswer: 'I talk to stakeholders, draft the PRD in Notion, share it with engineering and design for feedback, and finalize it.',
  },
  hiring: {
    profile: { jobTitle: 'Engineering Manager', tenure: '5 years', typicalWeek: 'Hiring, 1:1s, sprint planning, technical reviews' },
    coreTask: 'Run a hiring loop',
    kickoffAnswer: 'I screen resumes, schedule interviews with the team, run the debrief, and make a decision.',
  },
  triage: {
    profile: { jobTitle: 'Customer Support Engineer', tenure: '2 years', typicalWeek: 'Ticket triage, escalations, customer calls' },
    coreTask: 'Triage incoming bug reports',
    kickoffAnswer: 'I look at the ticket, try to reproduce, file an issue if it is a real bug, and respond to the customer.',
  },
};

const KICKOFF_HINT = (task) =>
  `Ask the participant exactly: "Can you walk me through how you ${task} from start to finish?"`;

async function runExtraction({ profile, coreTask, kickoffAnswer }) {
  const taskPhrase = coreTask.charAt(0).toLowerCase() + coreTask.slice(1);
  const messages = [
    { id: '_k', role: 'user', content: KICKOFF_HINT(taskPhrase), timestamp: 0 },
    { id: '_a', role: 'user', content: kickoffAnswer, timestamp: 1 },
  ];

  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      coreTask,
      nodes: [],
      skipSuggestions: true,
      userProfile: profile,
      selectedTasks: [coreTask],
      typicalWorkflow: null,
    }),
  });
  if (!res.ok) throw new Error(`extraction failed: ${res.status} ${await res.text()}`);

  const nodes = [];
  const edges = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const lines = part.split('\n');
      const eventLine = lines.find(l => l.startsWith('event: '));
      const dataLine = lines.find(l => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7);
      const data = JSON.parse(dataLine.slice(6));
      if (event === 'graph_update') {
        if (data.tool === 'add_node') nodes.push(data.input);
        else if (data.tool === 'add_edge') edges.push(data.input);
      } else if (event === 'error') throw new Error(data.error);
    }
  }
  return { nodes, edges };
}

async function runInterview({ nodes, edges, profile, coreTask, participantOverview }) {
  const res = await fetch(`${HOST}/api/walker-interview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodes: nodes.map(n => ({ id: n.id, type: n.type, label: n.label, description: n.description })),
      edges: edges.map(e => ({ source: e.source, target: e.target, label: e.label })),
      coreTask,
      jobTitle: profile.jobTitle,
      participantOverview,
    }),
  });
  if (!res.ok) throw new Error(`interview failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.steps ?? [];
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  blue: '\x1b[34m', cyan: '\x1b[36m', violet: '\x1b[35m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
};

function nodeLabel(nodes, id) {
  return nodes.find(n => n.id === id)?.label ?? id;
}

function printStep(step, i, nodes) {
  const kindColor = step.kind === 'transition' ? C.violet : C.blue;
  const anchorLabel = nodeLabel(nodes, step.anchor_node_id);
  const prevLabel = step.prev_node_id ? nodeLabel(nodes, step.prev_node_id) : null;

  console.log(`\n  ${kindColor}${C.bold}[${i + 1}] ${step.kind.toUpperCase()}${C.reset}  ${C.dim}anchor: ${anchorLabel}${prevLabel ? `  prev: ${prevLabel}` : ''}${C.reset}`);
  console.log(`  ${C.bold}Q:${C.reset} ${step.question}`);
  if (step.suggestions?.length) {
    console.log(`  ${C.dim}suggestions:${C.reset}`);
    step.suggestions.forEach(s => {
      console.log(`    - ${C.bold}${s.label}${C.reset}${s.description ? `${C.dim} — ${s.description}${C.reset}` : ''}`);
    });
  }
}

function gradeStep(step, nodes, edges, prevAnchor) {
  const issues = [];
  const anchor = nodes.find(n => n.id === step.anchor_node_id);

  if (!anchor) {
    issues.push('anchor not in graph');
    return issues;
  }
  if (anchor.type === 'start' || anchor.type === 'end') {
    issues.push(`anchor is sentinel (${anchor.type})`);
  }

  if (step.kind === 'transition') {
    if (step.prev_node_id) {
      const edgeExists = edges.some(e => e.source === step.prev_node_id && e.target === step.anchor_node_id);
      if (!edgeExists) issues.push(`no edge ${step.prev_node_id} → ${step.anchor_node_id} in graph`);
    }
    if (prevAnchor && prevAnchor !== step.prev_node_id && step.prev_node_id) {
      // Each transition's prev should chain from the previous transition's anchor (rough check)
      // Skip — graphs with branches break this rule legitimately.
    }
  }

  if (step.kind === 'decompose') {
    if (anchor.type === 'decision') issues.push('decompose anchored at decision node');
    if (!step.suggestions || step.suggestions.length === 0) issues.push('no sub-step suggestions');
    if (step.suggestions && step.suggestions.length < 2) issues.push(`only ${step.suggestions.length} suggestion(s), expected 2-4`);
    // Detect overlap-shaped sub-steps
    if (step.suggestions) {
      const labels = step.suggestions.map(s => s.label.toLowerCase());
      const hasDraftAndFormat = labels.some(l => l.includes('draft')) && labels.some(l => l.includes('format'));
      if (hasDraftAndFormat) issues.push('overlapping suggestions (draft + format)');
    }
  }

  // Snake_case ids in question text
  for (const n of nodes) {
    if (step.question.includes(n.id) && !step.question.includes(n.label)) {
      issues.push(`uses raw id "${n.id}" in question instead of label`);
      break;
    }
  }

  return issues;
}

async function runOne(name) {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`unknown fixture: ${name}`);

  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║ FIXTURE: ${name.padEnd(56)}║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  ${C.dim}role:${C.reset}   ${fixture.profile.jobTitle}`);
  console.log(`  ${C.dim}task:${C.reset}   ${fixture.coreTask}`);
  console.log(`  ${C.dim}answer:${C.reset} "${fixture.kickoffAnswer}"`);

  const tExtract = Date.now();
  const { nodes, edges } = await runExtraction(fixture);
  console.log(`\n  ${C.dim}extracted ${nodes.length} nodes, ${edges.length} edges in ${Date.now() - tExtract}ms${C.reset}`);
  for (const n of nodes) {
    console.log(`    ${C.bold}${n.id}${C.reset} ${C.dim}[${n.type}]${C.reset} ${n.label}`);
  }

  const tInterview = Date.now();
  const steps = await runInterview({ ...fixture, nodes, edges, participantOverview: fixture.kickoffAnswer });
  const dt = Date.now() - tInterview;

  console.log(`\n${C.bold}INTERVIEW${C.reset} ${C.dim}(${steps.length} steps, ${dt}ms)${C.reset}`);

  let totalIssues = 0;
  let prevAnchor = null;
  steps.forEach((s, i) => {
    printStep(s, i, nodes);
    const issues = gradeStep(s, nodes, edges, prevAnchor);
    if (issues.length) {
      issues.forEach(iss => console.log(`    ${C.red}⚠ ${iss}${C.reset}`));
      totalIssues += issues.length;
    }
    if (s.kind === 'transition') prevAnchor = s.anchor_node_id;
  });

  // Coverage: do we have a transition step for every task → next-task edge?
  const taskNodes = nodes.filter(n => n.type !== 'start' && n.type !== 'end');
  const transitionAnchors = new Set(steps.filter(s => s.kind === 'transition').map(s => s.anchor_node_id));
  const missingCoverage = taskNodes.filter(n => !transitionAnchors.has(n.id));

  console.log(`\n  ${C.dim}coverage:${C.reset} ${transitionAnchors.size}/${taskNodes.length} task anchors covered`);
  if (missingCoverage.length) {
    console.log(`  ${C.yellow}⚠ uncovered tasks:${C.reset} ${missingCoverage.map(n => n.label).join(', ')}`);
  }
  console.log(`  ${C.dim}quality:${C.reset} ${totalIssues === 0 ? C.green + 'no issues flagged' + C.reset : C.red + totalIssues + ' issues flagged' + C.reset}`);
}

(async () => {
  const arg = process.argv[2] ?? 'medium';
  if (arg === 'all') {
    for (const name of Object.keys(FIXTURES)) {
      await runOne(name);
    }
  } else {
    await runOne(arg);
  }
  console.log();
})().catch(err => {
  console.error(`${C.red}error:${C.reset}`, err.message);
  process.exit(1);
});
