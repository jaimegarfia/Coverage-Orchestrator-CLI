import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { flattenClasses, getZeroCoverageMethods } from "./parser.js";

const DEFAULT_CACHE_FILE = ".coverage-cache.json";

/**
 * Intenta auto-detectar jacoco.xml en rutas comunes (Maven/Gradle)
 * @returns {Promise<string|null>} ruta al jacoco.xml o null si no se encuentra
 */
export async function autoDetectJacocoXml() {
  const candidates = [
    "target/site/jacoco/jacoco.xml",           // Maven default
    "build/reports/jacoco/test/jacocoTestReport.xml", // Gradle default
  ];

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return path.resolve(candidate);
    }
  }

  return null;
}

export function getCachePath(cacheFile = DEFAULT_CACHE_FILE) {
  return path.resolve(process.cwd(), cacheFile);
}

export async function loadCache(cacheFile = DEFAULT_CACHE_FILE) {
  const p = getCachePath(cacheFile);
  const exists = await fs.pathExists(p);
  if (!exists) {
    return {
      version: 1,
      generatedAt: null,
      xmlPath: null,
      items: [],
    };
  }
  return fs.readJson(p);
}

export async function saveCache(cache, cacheFile = DEFAULT_CACHE_FILE) {
  const p = getCachePath(cacheFile);
  await fs.writeJson(p, cache, { spaces: 2 });
  return p;
}

export function shouldIgnoreClassByName(className, ignorePatterns) {
  const patterns = ignorePatterns?.length
    ? ignorePatterns
    : ["DTO", "Entity", "Configuration"];

  return patterns.some((p) => className.includes(p));
}

export function computePriorityScore({ missedLines, complexity }) {
  return missedLines * complexity;
}

/**
 * Build cache items from parsed JaCoCo report.
 * Filtering rules:
 * - Ignore classes with line coverage > 90%
 * - Ignore classes that contain DTO/Entity/Configuration by default
 */
export function buildCacheItems(parsed, { includePatterns = [], ignorePatterns = null, minCoverageToIgnorePct = 90 } = {}) {
  const classes = flattenClasses(parsed);

  const items = [];
  for (const clazz of classes) {
    const line = clazz.counters?.LINE ?? { missed: 0, covered: 0 };
    const complexity = clazz.counters?.COMPLEXITY ?? { missed: 0, covered: 0 };

    const missedLines = line.missed ?? 0;
    const coveredLines = line.covered ?? 0;

    const totalLines = missedLines + coveredLines;
    const coveragePct = totalLines > 0 ? (coveredLines / totalLines) * 100 : 100;

    const className = clazz.name;

    // includePatterns: if provided, allow overriding ignore by forcing include match
    const forcedInclude =
      includePatterns.length > 0 && includePatterns.some((p) => className.includes(p));

    if (!forcedInclude) {
      if (coveragePct > minCoverageToIgnorePct) continue;
      if (shouldIgnoreClassByName(className, ignorePatterns)) continue;
    }

    const complexityTotal = (complexity.missed ?? 0) + (complexity.covered ?? 0);
    const priorityScore = computePriorityScore({
      missedLines,
      complexity: complexityTotal || 1,
    });

    const zeroMethods = getZeroCoverageMethods(clazz).map((m) => ({
      name: m.name,
      desc: m.desc,
      line: m.line,
    }));

    items.push({
      className,
      packageName: clazz.packageName ?? null,
      sourceFilename: clazz.sourceFilename ?? null,
      internalName: clazz.internalName ?? null,

      metrics: {
        missedLines,
        coveredLines,
        coveragePct,
        complexityTotal,
      },

      priorityScore,

      methods: {
        zeroCoverage: zeroMethods,
      },

      status: "TODO",
      updatedAt: new Date().toISOString(),
    });
  }

  // Highest priority first
  items.sort((a, b) => b.priorityScore - a.priorityScore);

  return items;
}

export function pickNextMission(cache) {
  const next = (cache?.items ?? []).find((i) => i.status !== "DONE");
  return next ?? null;
}

export function markDone(cache, className) {
  const item = (cache?.items ?? []).find((i) => i.className === className);
  if (!item) return { updated: false, reason: "NOT_FOUND" };

  item.status = "DONE";
  item.updatedAt = new Date().toISOString();
  return { updated: true };
}

/**
 * Render mission markdown.
 * Note: Java file paths are best-effort because jacoco.xml only contains package + sourcefilename.
 * We output conventional Maven/Gradle paths; user/agent can adjust based on repository layout.
 */
export function renderMissionMarkdown(item, { sourceRoot = "src/main/java", testRoot = "src/test/java" } = {}) {
  const pkgPath = (item.packageName ?? "").replaceAll(".", "/");
  const javaFile = item.sourceFilename
    ? path.posix.join(sourceRoot, pkgPath, item.sourceFilename)
    : "(unknown - missing sourcefilename in jacoco.xml)";

  const testFile = item.sourceFilename
    ? path.posix.join(
        testRoot,
        pkgPath,
        item.sourceFilename.replace(/\\.java$/i, "Test.java"),
      )
    : "(unknown - missing sourcefilename in jacoco.xml)";

  const methods0 = item.methods?.zeroCoverage ?? [];
  const methodsList =
    methods0.length > 0
      ? methods0.map((m) => `- \`${m.name}\`${m.line ? ` (line ${m.line})` : ""}`).join("\n")
      : "_No se detectaron métodos con 0% LINE coverage (JaCoCo puede agregar counters agregados)._";

  const prompt = [
    `Genera tests unitarios JUnit 5 para la clase \`${item.className}\``,
    `con foco en aumentar la cobertura de líneas y ramas.`,
    ``,
    `Requisitos:`,
    `- Usa Mockito para simular dependencias (repositorios, clients HTTP, etc.).`,
    `- Cubre especialmente los métodos con 0% de cobertura listados abajo.`,
    `- Incluye casos: happy path, validaciones/errores, y edge cases.`,
    `- Si hay lógica condicional, añade tests para ambas ramas.`,
    `- Evita tests frágiles: no asserts sobre logs ni detalles internos innecesarios.`,
  ].join("\n");

  return [
    `# Mission: Increase coverage for \`${item.className}\``,
    ``,
    `## ROI / Priority`,
    `- **PriorityScore**: ${item.priorityScore}`,
    `- **MissedLines**: ${item.metrics.missedLines}`,
    `- **Complexity**: ${item.metrics.complexityTotal}`,
    `- **Current Line Coverage**: ${item.metrics.coveragePct.toFixed(2)}%`,
    ``,
    `## Target files`,
    `- **Java source**: \`${javaFile}\``,
    `- **Test file**: \`${testFile}\``,
    ``,
    `## Methods with 0% coverage (LINE)`,
    methodsList,
    ``,
    `## Suggested prompt for the AI agent`,
    "```text",
    prompt,
    "```",
    ``,
    `## Notes`,
    `- Ajusta rutas si tu proyecto usa otra estructura (multi-módulo, /app, etc.).`,
    `- Si el método requiere builders/fixtures, crea helpers para mantener tests legibles.`,
  ].join("\n");
}

export function logCacheSummary(cache) {
  const total = cache?.items?.length ?? 0;
  const done = (cache?.items ?? []).filter((i) => i.status === "DONE").length;
  const todo = total - done;

  console.log(chalk.cyan(`Cache items: ${total} (TODO: ${todo}, DONE: ${done})`));
}
