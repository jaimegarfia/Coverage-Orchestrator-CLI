# Coverage Orchestrator CLI

**Coverage Orchestrator CLI** is a Node.js CLI that turns a JaCoCo XML report into a prioritized, AI-friendly backlog of “missions” to increase Java unit test coverage efficiently.

It is designed for teams working with **Java microservices** (Maven or Gradle) who want to:
- identify where coverage improvements have the highest ROI,
- generate clear, repeatable instructions for an AI agent (or a developer),
- iterate quickly until reaching a target (e.g. **60% global coverage**).

---

## Table of contents

- [Key concepts](#key-concepts)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [CLI reference](#cli-reference)
  - [`analyze`](#analyze)
  - [`next`](#next)
  - [`mark-done` (legacy)](#mark-done-legacy)
  - [`summary`](#summary)
- [Cache and state model](#cache-and-state-model)
- [Recommended workflow](#recommended-workflow)
- [Tips for using it with an AI agent](#tips-for-using-it-with-an-ai-agent)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Publishing a new version](#publishing-a-new-version)
- [License](#license)

---

## Key concepts

### Mission
A **mission** is a Markdown document printed by `next` that includes:
- target Java source file path (best-effort),
- recommended test file path (best-effort),
- methods with **0% line coverage** (as reported by JaCoCo),
- a tailored prompt to generate tests (Mockito + detected assertion style).

### PriorityScore (ROI)
For each class, the CLI computes:

- `MissedLines` = JaCoCo counter `LINE.missed`
- `Complexity` = JaCoCo counter `COMPLEXITY.missed + COMPLEXITY.covered`
- `PriorityScore = MissedLines * Complexity`

Higher score means: “fixing this class is likely to move coverage more”.

### Auto-DONE (Smart Analyze)
On each `analyze` run, classes are automatically labeled based on evidence from the XML:

- if `coveragePct >= 60` → `status: DONE`, `autoVerified: true`
- else → `status: TODO`

This enables a loop where you simply regenerate the JaCoCo report and rerun `analyze` to advance.

---

## Requirements

- Node.js **18+** (recommended **20+**)
- A Java project that produces **JaCoCo XML**
  - Maven: typically `target/site/jacoco/jacoco.xml`
  - Gradle: typically `build/reports/jacoco/test/jacocoTestReport.xml`

---

## Installation

### Option A (recommended): run via `npx` (no global install)

```bash
npx coverage-orchestrator-cli --help
```

> Note: the npm package name is `coverage-orchestrator-cli` and it exposes the binary `coverage-orchestrator`.

### Option B: global install

```bash
npm install -g coverage-orchestrator-cli
coverage-orchestrator --help
```

### Option C: local development (this repository)

```bash
npm install
node src/index.js --help
```

To simulate a global binary from this repo:

```bash
npm link
coverage-orchestrator --help
```

To remove the link:

```bash
npm unlink -g coverage-orchestrator-cli
```

---

## Quickstart

### 1) Generate JaCoCo report in your Java project

Maven:

```bash
mvn test jacoco:report
```

Gradle:

```bash
./gradlew test jacocoTestReport
```

### 2) Analyze the report

If you run it from your microservice root, it can auto-detect common paths:

```bash
coverage-orchestrator analyze
```

Or pass the path explicitly:

```bash
coverage-orchestrator analyze --path "C:\\path\\to\\jacoco.xml"
```

### 3) Ask for the next mission

```bash
coverage-orchestrator next
```

### 4) Implement tests and repeat

Regenerate JaCoCo XML → rerun `analyze` → run `next` again.

---

## How it works

### 1) Detect the microservice root (projectRoot)
Given a `jacoco.xml` path, the CLI walks up directories until it finds:
- `pom.xml`, or
- `build.gradle` / `build.gradle.kts`

That directory becomes the **projectRoot**.

### 2) Detect the environment (best-effort)
From the projectRoot, the CLI detects:
- build tool: Maven / Gradle
- Java version (if detectable)
- Spring Boot version (if detectable)
- assertion library:
  - AssertJ / Hamcrest / default JUnit 5 Assertions
- Lombok usage (`usesLombok` boolean)

### 3) Parse JaCoCo XML
The parser normalizes the XML into packages/classes/methods and counters.

> The CLI is designed to be **faithful to the report**: it processes all classes present in the XML.
> Filtering is only applied in the orchestrator layer (e.g. `--minCoverageToIgnore`, `--ignore`), not in the parser.

### 4) Score classes and build missions
The orchestrator:
- computes `PriorityScore`,
- optionally ignores very high coverage classes (default `> 90%`, configurable),
- auto-labels DONE/TODO using the **60% threshold**,
- sorts by priority and stores state in a cache file.

---

## CLI reference

The package exposes the binary:

```bash
coverage-orchestrator <command> [options]
```

### `analyze`

Scans JaCoCo XML and stores a local state cache.

```bash
coverage-orchestrator analyze [--path <jacoco.xml>]
```

Options:
- `--path <path>`: JaCoCo XML path (optional; will auto-detect common paths if omitted)
- `--minCoverageToIgnore <pct>`: ignore classes with line coverage `> pct` (default `90`)
- `--ignore <pattern...>`: ignore classes whose FQCN contains any substring in the list (opt-in)
- `--include <pattern...>`: force-include classes even if ignored by other rules (opt-in)

Outputs:
- prints where the cache was saved,
- prints TODO/DONE counts.

### `next`

Prints the next mission in **Markdown**.

```bash
coverage-orchestrator next
```

Options:
- `--sourceRoot <path>` (default `src/main/java`)
- `--testRoot <path>` (default `src/test/java`)

Behavior:
- chooses the highest-priority class with `status !== DONE`.

### `mark-done` (legacy)

Marks a class as DONE manually. Kept for backwards compatibility, but the recommended workflow is:

> write tests → generate JaCoCo → `analyze` → `next`

```bash
coverage-orchestrator mark-done com.foo.BarService
```

### `summary`

Shows a global coverage summary computed from the cache.

```bash
coverage-orchestrator summary
coverage-orchestrator summary --json
```

---

## Cache and state model

### Where the cache is stored
The cache is stored inside your microservice **projectRoot**:

- `<projectRoot>/.coverage-cache.json`

This makes the state **per microservice**, avoiding confusion when running the CLI from other directories.

### Cache shape (simplified)

```jsonc
{
  "version": 1,
  "generatedAt": "2026-04-23T00:00:00.000Z",
  "xmlPath": "C:\\path\\to\\jacoco.xml",
  "env": {
    "language": "Java",
    "buildTool": "Maven",
    "version": "17",
    "framework": "Spring Boot",
    "frameworkVersion": "3.2.0",
    "assertionLib": "AssertJ",
    "usesLombok": true
  },
  "items": [
    {
      "className": "com.acme.FooService",
      "metrics": { "coveragePct": 12.3, "missedLines": 100, "coveredLines": 14, "complexityTotal": 20 },
      "priorityScore": 2000,
      "status": "TODO",
      "autoVerified": false
    }
  ]
}
```

---

## Recommended workflow

1) Generate coverage:
- Maven: `mvn test jacoco:report`
- Gradle: `./gradlew test jacocoTestReport`

2) Analyze:
```bash
coverage-orchestrator analyze --path <path-to-jacoco.xml>
```

3) Pick next mission:
```bash
coverage-orchestrator next
```

4) Implement tests (run them locally), regenerate report, and loop.

---

## Tips for using it with an AI agent

- Keep the mission as the “contract”: it defines the target class, methods with 0% coverage, and the test location.
- The prompt already assumes:
  - JUnit 5
  - Mockito for dependencies
  - your assertion style (`AssertJ` / `Hamcrest` / `JUnit 5 Assertions`)
- If the class uses Lombok (`env.usesLombok: true`), consider asking the agent to:
  - avoid testing Lombok-generated boilerplate unless needed,
  - focus on behavioral logic and public API.

---

## Troubleshooting

### `analyze` cannot find `jacoco.xml`
If you do not pass `--path`, the CLI only checks common defaults:
- `target/site/jacoco/jacoco.xml` (Maven)
- `build/reports/jacoco/test/jacocoTestReport.xml` (Gradle)

Provide the path manually:

```bash
coverage-orchestrator analyze --path "<absolute-or-relative-path>"
```

### Cache not found when running `next`
The cache is stored in `<projectRoot>/.coverage-cache.json`.

Recommended:
- run `next` from the microservice root, or
- run `analyze` first (it prints the cache path).

---

## Limitations

- Source/test file paths are **best-effort**: JaCoCo provides `package` + `sourcefilename`, but monorepos/multi-module layouts may require adjusting `--sourceRoot` / `--testRoot`.
- Environment detection is heuristic:
  - multi-module Maven parent inheritance and placeholder properties may result in `env.version` / `env.frameworkVersion` being `null`.
- Method list for “0% coverage” may include synthetic methods in some edge cases. We currently filter `$`, `<init>`, and `<clinit>`.

---

## Roadmap

- Improve Java/Spring detection for multi-module projects (resolve parent chain / properties).
- Detect JUnit 4 vs JUnit 5 and adapt mission prompts.
- Enrich missions with dependency hints (by analyzing constructor injection/imports).
- Document `summary` output more thoroughly and add more actionable reporting.

---

## Contributing

1) Fork the repo
2) Create a feature branch
3) Run:
   ```bash
   npm install
   node src/index.js --help
   ```
4) Open a PR with a clear description + before/after examples

---

## Publishing a new version

1) Choose a SemVer bump:
```bash
npm version patch
# or: npm version minor
# or: npm version major
```

2) Push commit and tags:
```bash
git push --follow-tags
```

3) Publish:
```bash
npm publish --access public
```

4) Validate:
```bash
npx coverage-orchestrator-cli --help
npx coverage-orchestrator-cli analyze --help
```

---

## License

ISC
