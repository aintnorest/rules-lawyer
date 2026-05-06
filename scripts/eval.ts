import { chunkDocument } from "../src/ingest/chunk";
import { provider } from "../src/providers/ollama";
import { generateAnswer } from "../src/query/generate";
import fs from "fs";
import path from "path";

async function runEval() {
  const casesPath = path.join(__dirname, "../eval/cases.json");
  const fixturePath = path.join(__dirname, "../eval/fixtures/mini-rules.md");

  const text = fs.readFileSync(fixturePath, "utf-8");
  const chunks = chunkDocument(
    provider,
    "mini-rules",
    "eval-lib",
    [{ pageNumber: 1, content: text }],
    300,
    40,
  );

  const cases = JSON.parse(fs.readFileSync(casesPath, "utf-8"));
  let passed = 0;

  console.log("Running Eval...\n");
  for (const c of cases) {
    process.stdout.write(`Evaluating: "${c.question}"... `);
    const { output } = await generateAnswer("eval-lib", c.question, chunks, []);

    let pass = false;
    if (c.expectedConfidence && output.confidence === c.expectedConfidence) {
      pass = true;
    }
    if (
      c.expectedAnswerSnippet &&
      !output.answer
        .toLowerCase()
        .includes(c.expectedAnswerSnippet.toLowerCase())
    ) {
      pass = false;
    }

    if (pass) {
      passed++;
      console.log("✅ PASS");
    } else {
      console.log(`❌ FAIL`);
      console.log(
        `   Expected conf: ${c.expectedConfidence}, Got: ${output.confidence}`,
      );
    }
  }

  console.log(`\nEval Complete: ${passed}/${cases.length} passed.`);
}

runEval().catch(console.error);
