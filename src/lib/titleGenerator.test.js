import assert from 'node:assert/strict';
import { createSeedTitle, normalizeGeneratedTitle } from './titleGenerator.js';

function runTest(name, fn) {
  try {
    fn();
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

runTest('createSeedTitle turns buy-advice questions into compact topic titles', () => {
  assert.equal(
    createSeedTitle('Which laptop should I buy for local llm work?'),
    'Laptop for Local LLM Work',
  );
});

runTest('createSeedTitle removes question phrasing from medical checks', () => {
  assert.equal(
    createSeedTitle('Is there a drug interaction between sertraline and ibuprofen?'),
    'Drug Interaction Between Sertraline and Ibuprofen',
  );
});

runTest('createSeedTitle keeps how-to prompts readable', () => {
  assert.equal(
    createSeedTitle('How do I make a sourdough starter from scratch?'),
    'How to Make a Sourdough Starter from Scratch',
  );
});

runTest('normalizeGeneratedTitle strips generic lead-in phrases from model output', () => {
  assert.equal(
    normalizeGeneratedTitle('Title: What are the best laptops for video editing?'),
    'Best Laptops for Video Editing',
  );
});

runTest('normalizeGeneratedTitle falls back to a deterministic prompt-based title', () => {
  assert.equal(
    normalizeGeneratedTitle('', 'Can you summarize this quarterly sales report?'),
    'Summary of Quarterly Sales Report',
  );
});

runTest('createSeedTitle returns a safe default for empty prompts', () => {
  assert.equal(createSeedTitle('   '), 'New Chat');
});

// eslint-disable-next-line no-console
console.log('Title generator tests completed.');
