// Smoke test for the retrieval grounding pipeline.
//
//   RETRIEVAL_ENABLED=true node --env-file=.env scripts/test-retrieval.js
//
// Pass a job title inline to override the default sample:
//   ... scripts/test-retrieval.js "PhD student in machine learning"
//
// Prints the matched occupation(s) and the exemplar block that would be
// injected into the generator prompt. Makes one real occupation-match LLM call.

import { retrieveExemplarBlock, RETRIEVAL_ENABLED } from '../lib/retrieval.js';

const [jobTitle] = process.argv.slice(2);

const profile = {
  jobTitle: jobTitle || 'PhD student in machine learning',
};

console.log('RETRIEVAL_ENABLED =', RETRIEVAL_ENABLED);
console.log('Profile:', profile, '\n');

const { block, occupations, count } = await retrieveExemplarBlock(profile);

console.log('Matched occupations:', occupations);
console.log('Statements injected:', count);
console.log('\n--- injected block ---');
console.log(block || '(empty — disabled, no match, or error)');
