// Validate the gap-analysis component in isolation.
//
// Pipeline: kickoff overview → /api/chat (extracts nodes+edges) → /api/gap-analysis
// → print structured output.
//
// Usage:
//   node scripts/test-gaps.js            # uses default fixture
//   node scripts/test-gaps.js sparse     # named fixture
//   node scripts/test-gaps.js --custom   # reads kickoff text from stdin
//
// Requires the dev server to be running on http://localhost:3001.

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

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

// Replicates the SSE parsing the sidebar does for /api/chat.
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
  let assistantMessage = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const lines = part.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7);
      const data = JSON.parse(dataLine.slice(6));
      if (event === 'graph_update') {
        if (data.tool === 'add_node') nodes.push(data.input);
        else if (data.tool === 'add_edge') edges.push(data.input);
      } else if (event === 'done') {
        assistantMessage = data.message ?? '';
      } else if (event === 'error') {
        throw new Error(data.error);
      }
    }
  }

  return { nodes, edges, assistantMessage };
}

async function runGapAnalysis({ nodes, edges, profile, coreTask, participantOverview }) {
  const res = await fetch(`${HOST}/api/gap-analysis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        description: n.description,
      })),
      edges: edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
      coreTask,
      jobTitle: profile.jobTitle,
      participantOverview,
    }),
  });
  if (!res.ok) throw new Error(`gap-analysis failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.gaps ?? [];
}

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

function lensColor(lens) {
  return lens === 'breakdown'
    ? COLOR.blue
    : lens === 'dependency'
    ? COLOR.green
    : lens === 'handoff'
    ? COLOR.magenta
    : COLOR.yellow;
}

function printSection(title) {
  console.log(`\n${COLOR.bold}${COLOR.cyan}${title}${COLOR.reset}`);
  console.log(COLOR.dim + '─'.repeat(72) + COLOR.reset);
}

function printGraph(nodes, edges) {
  for (const n of nodes) {
    console.log(`  ${COLOR.bold}${n.id}${COLOR.reset} ${COLOR.dim}[${n.type}]${COLOR.reset} ${n.label}${n.description ? COLOR.dim + ' — ' + n.description + COLOR.reset : ''}`);
  }
  if (edges.length) {
    console.log();
    for (const e of edges) {
      console.log(`  ${e.source} ${COLOR.dim}→${COLOR.reset} ${e.target}${e.label ? COLOR.dim + ' (' + e.label + ')' + COLOR.reset : ''}`);
    }
  }
}

function printGap(g, i) {
  const c = lensColor(g.lens);
  console.log(`\n  ${c}${COLOR.bold}[${i + 1}] ${g.lens?.toUpperCase()}${COLOR.reset}  ${COLOR.dim}${g.id ?? ''} → ${g.anchor_node_id ?? '?'}${COLOR.reset}`);
  console.log(`  ${COLOR.bold}title:${COLOR.reset}     ${g.title ?? g.summary ?? ''}`);
  console.log(`  ${COLOR.dim}rationale:${COLOR.reset} ${g.rationale ?? g.question ?? ''}`);
  if (g.proposed_changes?.length) {
    console.log(`  ${COLOR.dim}if accepted:${COLOR.reset}`);
    for (const ch of g.proposed_changes) {
      if (ch.tool === 'add_node') {
        const i = ch.input;
        const sub = i.parentId ? ` (sub-step of ${i.parentId})` : '';
        console.log(`    + add_node ${COLOR.dim}[${i.type}]${COLOR.reset} ${i.id}: "${i.label}"${sub}`);
      } else if (ch.tool === 'add_edge') {
        const i = ch.input;
        console.log(`    + add_edge ${i.source} → ${i.target}${i.label ? ` (${i.label})` : ''}`);
      }
    }
  }
}

(async () => {
  const arg = process.argv[2];
  let fixture;

  if (arg === '--custom') {
    const text = await readStdin();
    if (!text) {
      console.error('no stdin received');
      process.exit(1);
    }
    fixture = { ...FIXTURES.sparse, kickoffAnswer: text };
  } else if (arg && FIXTURES[arg]) {
    fixture = FIXTURES[arg];
  } else if (arg) {
    console.error(`unknown fixture: ${arg}. Available: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(1);
  } else {
    fixture = FIXTURES.medium;
  }

  printSection('KICKOFF');
  console.log(`  ${COLOR.bold}role:${COLOR.reset}     ${fixture.profile.jobTitle} (${fixture.profile.tenure})`);
  console.log(`  ${COLOR.bold}task:${COLOR.reset}     ${fixture.coreTask}`);
  console.log(`  ${COLOR.bold}answer:${COLOR.reset}   "${fixture.kickoffAnswer}"`);

  const tExtract0 = Date.now();
  const { nodes, edges, assistantMessage } = await runExtraction(fixture);
  const tExtract = Date.now() - tExtract0;

  printSection(`EXTRACTED GRAPH  ${COLOR.dim}(${nodes.length} nodes, ${edges.length} edges, ${tExtract}ms)${COLOR.reset}`);
  printGraph(nodes, edges);
  if (assistantMessage) {
    console.log(`\n  ${COLOR.dim}assistant said: "${assistantMessage}"${COLOR.reset}`);
  }

  const tGaps0 = Date.now();
  const gaps = await runGapAnalysis({ nodes, edges, profile: fixture.profile, coreTask: fixture.coreTask, participantOverview: fixture.kickoffAnswer });
  const tGaps = Date.now() - tGaps0;

  printSection(`GAPS  ${COLOR.dim}(${gaps.length} gaps, ${tGaps}ms)${COLOR.reset}`);
  if (gaps.length === 0) {
    console.log(`  ${COLOR.dim}(none)${COLOR.reset}`);
  } else {
    gaps.forEach(printGap);
  }

  // Lens distribution summary
  const byLens = gaps.reduce((acc, g) => ((acc[g.lens] = (acc[g.lens] ?? 0) + 1), acc), {});
  console.log();
  console.log(`  ${COLOR.dim}lens breakdown:${COLOR.reset} ${Object.entries(byLens).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
  console.log();
})().catch((err) => {
  console.error(`${COLOR.red}error:${COLOR.reset}`, err.message);
  process.exit(1);
});
