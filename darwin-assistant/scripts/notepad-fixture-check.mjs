#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Only allow these clean envs
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixtures');

// Import parseNotepadBlocks from dist
const { parseNotepadBlocks, notepadBlockId } = await import(
  path.join(__dirname, '..', 'dist', 'notepad-blocks.js')
);

const EXPECTED_LINES_PER_DAY = 73;

console.log('Fixture check: notepad-real-days.json and notepad-real-blocks.json');
console.log('='.repeat(70));

// 1. Parse JSON files
let daysFixture, blocksFixture;
try {
  daysFixture = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'notepad-real-days.json'), 'utf8')
  );
  console.log('✓ notepad-real-days.json parsed as valid JSON');
} catch (e) {
  console.error('✗ Failed to parse notepad-real-days.json:', e.message);
  process.exit(1);
}

try {
  blocksFixture = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'notepad-real-blocks.json'), 'utf8')
  );
  console.log('✓ notepad-real-blocks.json parsed as valid JSON');
} catch (e) {
  console.error('✗ Failed to parse notepad-real-blocks.json:', e.message);
  process.exit(1);
}

// 2. Verify line counts match capture and expected
for (const dayData of daysFixture.days) {
  const count = dayData.lines.length;
  if (count !== EXPECTED_LINES_PER_DAY) {
    console.error(
      `✗ Day ${dayData.day}: expected ${EXPECTED_LINES_PER_DAY} lines, got ${count}`
    );
    process.exit(1);
  }
  console.log(`✓ Day ${dayData.day}: ${count} lines`);
}

// 3. Verify text round-trips unchanged through JSON
let textIssues = 0;
for (const dayData of daysFixture.days) {
  for (const line of dayData.lines) {
    const serialized = JSON.stringify(line.text);
    const deserialized = JSON.parse(serialized);
    if (deserialized !== line.text) {
      console.error(
        `✗ Day ${dayData.day} line ${line.line_id}: text round-trip failed`
      );
      textIssues++;
    }
  }
}
if (textIssues === 0) {
  console.log('✓ All line texts round-trip unchanged through JSON');
} else {
  process.exit(1);
}

// 4. Re-run parseNotepadBlocks and compare to fixture
let blockMismatch = false;
for (const dayData of daysFixture.days) {
  const blockData = blocksFixture.days.find(d => d.day === dayData.day);
  if (!blockData) {
    console.error(`✗ Day ${dayData.day}: blocks fixture missing`);
    process.exit(1);
  }

  // Convert lines to parseNotepadBlocks format
  const inputLines = dayData.lines.map(line => ({
    id: line.line_id,
    idx: line.sort_order,
    text: line.text
  }));

  // Parse
  const parsedBlocks = parseNotepadBlocks(inputLines);

  // Compare count
  if (parsedBlocks.length !== blockData.blocks.length) {
    console.error(
      `✗ Day ${dayData.day}: parsed ${parsedBlocks.length} blocks, fixture has ${blockData.blocks.length}`
    );
    blockMismatch = true;
  } else {
    // Compare each block
    for (let i = 0; i < parsedBlocks.length; i++) {
      const parsed = parsedBlocks[i];
      const expected = blockData.blocks[i];
      const block_id = notepadBlockId(parsed);

      // Check headline match
      if (parsed.headline !== expected.headline) {
        console.error(
          `✗ Day ${dayData.day} block ${i}: headline mismatch. Expected "${expected.headline}", got "${parsed.headline}"`
        );
        blockMismatch = true;
      }

      // Check member_line_ids match
      if (
        JSON.stringify(parsed.member_line_ids) !==
        JSON.stringify(expected.member_line_ids)
      ) {
        console.error(
          `✗ Day ${dayData.day} block ${i}: member_line_ids mismatch`
        );
        blockMismatch = true;
      }

      // Check block_id matches
      if (block_id !== expected.block_id) {
        console.error(
          `✗ Day ${dayData.day} block ${i}: block_id mismatch. Expected ${expected.block_id}, got ${block_id}`
        );
        blockMismatch = true;
      }
    }
  }

  if (!blockMismatch) {
    console.log(`✓ Day ${dayData.day}: ${blockData.blocks.length} blocks match parsed output`);
  }
}

if (blockMismatch) {
  process.exit(1);
}

console.log('='.repeat(70));
console.log('✓ All fixture checks passed!');
process.exit(0);
