#!/usr/bin/env node
import path from "node:path";
import fs from "fs-extra";
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { parseJacocoXml } from "./parser.js";
import { detectEnvironment, findProjectRoot } from "./detector.js";
import {
  autoDetectJacocoXml,
  buildCacheItems,
  loadCache,
  logCacheSummary,
  markDone,
  pickNextMission,
  renderMissionMarkdown,
  saveCache,
} from "./orchestrator.js";

function buildSuggestedTestCommand({ env, item }) {
  if (!env?.buildTool || !item?.className) return null;

  const simpleName = String(item.className).split(".").pop();
  const testClass = `${simpleName}Test`;
  const module = env.moduleName ? env.moduleName : null;

  if (env.buildTool === "Maven") {
    // -pl only if we can infer module
    return module
      ? `mvn test -pl ${module} -Dtest=${testClass}`
      : `mvn test -Dtest=${testClass}`;
  }

  if (env.buildTool === "Gradle") {
    const gradleModule = env.gradleModulePath ?? (module ? `:${module}` : null);
    return gradleModule
      ? `./gradlew ${gradleModule}:test --tests ${testClass}`
      : `./gradlew test --tests ${testClass}`;
  }

  return null;
}

const program = new Command();

program
  .name("coverage-orchestrator")
  .description(
    [
      "Coverage Orchestrator CLI",
      "",
      "Convierte un reporte JaCoCo XML (jacoco.xml) en un backlog priorizado de 'misiones' en Markdown",
      "para aumentar cobertura de tests unitarios en microservicios Java.",
      "",
      "Flujo recomendado:",
      "  1) Genera jacoco.xml (Maven: mvn test jacoco:report | Gradle: ./gradlew test jacocoTestReport)",
      "  2) coverage-orchestrator analyze --path <ruta_al_xml>   (o sin --path si se auto-detecta)",
      "  3) coverage-orchestrator next                           (imprime una misión en Markdown)",
      "  4) Implementa tests -> vuelve a generar jacoco.xml -> repite",
      "",
      "Conceptos:",
      "  - PriorityScore = MissedLines * Complexity (ROI por clase)",
      "  - Auto-DONE: si coveragePct >= 60% la clase se marca DONE automáticamente al analizar",
      "  - Cache por microservicio: se guarda en <projectRoot>/.coverage-cache.json",
      "",
      "Ejemplos rápidos:",
      "  coverage-orchestrator analyze --path target/site/jacoco/jacoco.xml",
      "  coverage-orchestrator next",
      "  coverage-orchestrator summary",
      "",
      "Ayuda por comando:",
      "  coverage-orchestrator analyze --help",
      "  coverage-orchestrator next --help",
      "  coverage-orchestrator summary --help",
    ].join("\n"),
  )
  .version("1.2.0")
  .addHelpText(
    "after",
    [
      "",
      "Notas:",
      "  - Por defecto se ignoran clases con cobertura de líneas > 90% (configurable con --minCoverageToIgnore).",
      "  - No se ignora ninguna clase por nombre salvo que uses --ignore explícitamente.",
      "  - 'mark-done' existe por compatibilidad, pero el flujo recomendado es: tests -> analyze -> next.",
      "",
      "Repositorio:",
      "  https://github.com/jaimegarfia/Coverage-Orchestrator-CLI",
      "",
    ].join("\n"),
  );

program
  .command("analyze")
  .description("Escanea jacoco.xml y guarda el estado local en .coverage-cache.json")
  .option("--path <path>", "Ruta al archivo jacoco.xml (auto-detecta si no se especifica)")
  .option(
    "--include <pattern...>",
    "Incluye clases aunque coincidan con ignore rules (substrings)",
  )
  .option("--ignore <pattern...>", "Ignora clases por nombre (substrings).")
  .option(
    "--minCoverageToIgnore <pct>",
    "Ignora clases con cobertura de líneas > pct (default: 90)",
    "90",
  )
  .action(async (opts) => {
    let xmlPath = opts.path;

    // Auto-detect jacoco.xml if --path not provided
    if (!xmlPath) {
      // Primero intentamos en el cwd actual; si no, hacemos búsqueda recursiva (útil en monorepos).
      xmlPath =
        (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: false })) ??
        (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: true, maxDepth: 4 }));

      if (!xmlPath) {
        console.log(chalk.red("No se encontró jacoco.xml automáticamente."));
        console.log(chalk.yellow("Rutas buscadas:"));
        console.log("  - target/site/jacoco/jacoco.xml (Maven)");
        console.log("  - build/reports/jacoco/test/jacocoTestReport.xml (Gradle)");
        console.log("");
        console.log(chalk.cyan("Por favor, especifica la ruta manualmente:"));
        console.log(
          chalk.white(
            "  coverage-orchestrator analyze --path <ruta_al_jacoco.xml>",
          ),
        );
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`✓ JaCoCo XML auto-detectado: ${xmlPath}`));
    }

    const minCoverageToIgnorePct = Number.parseFloat(opts.minCoverageToIgnore);
    const includePatterns = opts.include ?? [];
    const ignorePatterns = opts.ignore ?? null;

    // 0) Detectar projectRoot (módulo/microservicio) basándonos en la ubicación del jacoco.xml
    const projectRoot = await findProjectRoot(xmlPath);

    // Blindaje (monorepo): si existe un cache en el directorio padre, advertimos pero NO lo tocamos
    // (nunca mezclamos datos entre microservicios).
    try {
      const parentCache = path.resolve(path.dirname(projectRoot), ".coverage-cache.json");
      if (await fs.pathExists(parentCache)) {
        console.log(
          chalk.yellow(
            `Aviso: se detectó un cache en el directorio superior: ${parentCache}. ` +
              `Este analyze NO lo usará ni lo mezclará.`,
          ),
        );
      }
    } catch {
      // non-fatal
    }

    // 1) Detectar entorno del proyecto real (incluyendo nombre de módulo best-effort)
    const env = await detectEnvironment({ projectRoot, xmlPath });

    // 2) Cargar cache previo del microservicio (si existe)
    const oldCache = await loadCache(undefined, { projectRoot });
    const oldItemsByClass = new Map(
      (oldCache.items ?? []).map((it) => [it.className, it]),
    );
    const oldTopCandidateClassName = pickNextMission(oldCache)?.className ?? null;

    console.log(chalk.cyan(`Parsing JaCoCo report: ${xmlPath}`));
    const parsed = await parseJacocoXml(xmlPath);

    // 2) Construir nuevos items (status TODO por defecto)
    // Auto-DONE threshold: si una clase llega a >= 60% coverage, se considera terminada
    const COVERAGE_THRESHOLD = 60;

    const newItemsRaw = buildCacheItems(parsed, {
      includePatterns,
      ignorePatterns,
      minCoverageToIgnorePct: Number.isFinite(minCoverageToIgnorePct)
        ? minCoverageToIgnorePct
        : 90,
      autoDoneThresholdPct: COVERAGE_THRESHOLD,
    });

    // 3) Fusionar con cache previo
    //
    // Fuente de verdad: JaCoCo XML.
    // - El status base se calcula desde el XML (Auto-DONE si coveragePct >= threshold).
    // - Nunca mantenemos DONE "manual" si el XML actual dice que la cobertura no cumple el umbral.
    //   (Ej: coverage 0% => siempre TODO).
    //
    // Lo único que preservamos del cache anterior es el "marcado manual" cuando el XML lo permite,
    // para no perder el trabajo del usuario en clases que sí superan el umbral.
    const mergedItems = newItemsRaw.map((newItem) => {
      const old = oldItemsByClass.get(newItem.className);
      if (!old) return newItem;

      const threshold = COVERAGE_THRESHOLD;
      const coveragePct = newItem.metrics?.coveragePct ?? 0;

      // attempts: preservar contador entre análisis
      const prevAttempts = Number.isFinite(old.attempts) ? old.attempts : 0;

      // Resiliencia / strikes:
      // - Si esta clase fue la última recomendada (top candidate) y NO mejora su cobertura vs análisis anterior,
      //   incrementamos attempts. Esto cubre casos de fallo de compilación/ejecución o tests que no mueven cobertura.
      // - Si llega a attempts >= 5, la forzamos a SKIPPED.
      const oldCoveragePct = old.metrics?.coveragePct ?? null;
      const isSameAsOldTop = oldTopCandidateClassName === newItem.className;
      const didImprove =
        typeof oldCoveragePct === "number" && Number.isFinite(oldCoveragePct)
          ? coveragePct > oldCoveragePct
          : true;

      let attempts = prevAttempts;
      if (isSameAsOldTop && !didImprove) {
        attempts = prevAttempts + 1;
      }

      if (attempts >= 5) {
        return {
          ...newItem,
          attempts,
          status: "SKIPPED",
          skipReason: "MAX_ATTEMPTS",
          autoVerified: false,
          updatedAt: new Date().toISOString(),
        };
      }

      // Si el XML no cumple threshold => jamás DONE, aunque estuviera DONE antes.
      if (!(coveragePct >= threshold)) {
        return {
          ...newItem,
          attempts,
          status: "TODO",
          autoVerified: false,
          updatedAt: new Date().toISOString(),
        };
      }

      // Si el XML sí cumple threshold, se respeta DONE si estaba previamente DONE (manual)
      if (old.status === "DONE") {
        return {
          ...newItem,
          attempts: prevAttempts,
          status: "DONE",
          autoVerified: newItem.autoVerified ?? false,
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        ...newItem,
        attempts: prevAttempts,
      };
    });

    const cache = {
      version: oldCache.version ?? 1,
      generatedAt: new Date().toISOString(),
      xmlPath,
      env,
      items: mergedItems,
    };

    const cachePath = await saveCache(cache, undefined, { projectRoot });
    console.log(chalk.green(`Cache saved: ${cachePath}`));
    console.log(chalk.gray(`Project root: ${projectRoot}`));
    logCacheSummary(cache);
  });

program
  .command("next")
  .description("Devuelve la siguiente misión priorizada en Markdown")
  .option("--sourceRoot <path>", "Root de fuentes Java", "src/main/java")
  .option("--testRoot <path>", "Root de tests Java", "src/test/java")
  .action(async (opts) => {
    // Contexto de ejecución (monorepo):
    // - next SOLO busca el cache en la carpeta actual (process.cwd()).
    // - Si no existe, pedimos ejecutar desde el módulo o correr analyze allí.
    const projectRoot = process.cwd();
    const cachePath = path.resolve(projectRoot, ".coverage-cache.json");
    const exists = await fs.pathExists(cachePath);

    if (!exists) {
      console.log(
        chalk.red(
          "No se encontró caché de cobertura en este directorio. Ejecuta 'analyze' primero dentro de este microservicio.",
        ),
      );
      process.exitCode = 2;
      return;
    }

    const cache = await loadCache(undefined, { projectRoot });

    // Forzado de SKIPPED: si hay items con attempts >= 5, marcarlos SKIPPED y persistir.
    // Esto evita que queden "en limbo" si por cualquier motivo el status no se actualizó en analyze.
    let mutated = false;
    for (const it of cache.items ?? []) {
      const attempts = Number.isFinite(it.attempts) ? it.attempts : 0;
      if (attempts >= 5 && it.status !== "SKIPPED" && it.status !== "DONE") {
        it.status = "SKIPPED";
        it.skipReason = "MAX_ATTEMPTS";
        it.updatedAt = new Date().toISOString();
        mutated = true;
      }
    }
    if (mutated) {
      await saveCache(cache, undefined, { projectRoot });
    }

    const item = pickNextMission(cache);

    if (!item) {
      console.log(chalk.green("No hay misiones pendientes. (cache vacío o todo DONE)"));
      return;
    }

    const suggestedTestCommand = buildSuggestedTestCommand({
      env: cache.env ?? null,
      item,
    });

    const md = renderMissionMarkdown(item, {
      sourceRoot: opts.sourceRoot,
      testRoot: opts.testRoot,
      env: cache.env ?? null,
      suggestedTestCommand,
    });

    console.log(md);
  });

program
  .command("mark-done")
  .description("Marca una clase como DONE en el cache local")
  .argument("<className>", "Nombre fully-qualified de la clase (e.g. com.foo.BarService)")
  .action(async (className) => {
    // mark-done kept for backwards compatibility, but the intended workflow is now:
    // write tests -> run tests -> analyze -> next
    //
    // IMPORTANTE: el cache está asociado al microservicio (projectRoot). Por eso resolvemos el
    // projectRoot del mismo modo que `analyze`, a partir del jacoco.xml auto-detectado.
    const xmlPath =
      (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: false })) ??
      (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: true, maxDepth: 4 }));
    const projectRoot = xmlPath ? await findProjectRoot(xmlPath) : process.cwd();

    const cache = await loadCache(undefined, { projectRoot });
    const res = markDone(cache, className);

    if (!res.updated) {
      console.log(
        chalk.red(
          `No se encontró la clase en el cache: ${className} (ejecuta analyze primero)`,
        ),
      );
      process.exitCode = 2;
      return;
    }

    const cachePath = await saveCache(cache, undefined, { projectRoot });
    console.log(chalk.green(`DONE: ${className}`));
    console.log(chalk.cyan(`Cache updated: ${cachePath}`));
    logCacheSummary(cache);
  });

program
  .command("summary")
  .description("Muestra un resumen global de cobertura basado en .coverage-cache.json")
  .option("--json", "Devuelve el resumen en formato JSON")
  .action(async (opts) => {
    // Contexto de ejecución (monorepo):
    // - summary SOLO busca el cache en la carpeta actual (process.cwd()).
    // - Si no existe, pedimos ejecutar desde el módulo o correr analyze allí.
    const projectRoot = process.cwd();
    const cachePath = path.resolve(projectRoot, ".coverage-cache.json");
    const exists = await fs.pathExists(cachePath);

    if (!exists) {
      console.log(
        chalk.red(
          "No se encontró caché de cobertura en este directorio. Ejecuta 'analyze' primero dentro de este microservicio.",
        ),
      );
      process.exitCode = 2;
      return;
    }

    const cache = await loadCache(undefined, { projectRoot });
    const items = cache.items ?? [];

    if (items.length === 0) {
      console.log(
        chalk.yellow(
          "No hay datos en el cache. Ejecuta primero: coverage-orchestrator analyze",
        ),
      );
      return;
    }

    // 1) Agregados globales (sumando todas las clases del cache)
    let totalMissed = 0;
    let totalCovered = 0;
    let totalMissedInstr = 0;
    let totalCoveredInstr = 0;

    for (const it of items) {
      totalMissed += it.metrics?.missedLines ?? 0;
      totalCovered += it.metrics?.coveredLines ?? 0;
      totalMissedInstr += it.metrics?.missedInstructions ?? 0;
      totalCoveredInstr += it.metrics?.coveredInstructions ?? 0;
    }

    const totalLines = totalMissed + totalCovered;
    const globalLineCoveragePct = totalLines > 0 ? (totalCovered / totalLines) * 100 : 0;

    const totalInstr = totalMissedInstr + totalCoveredInstr;
    const globalInstructionCoveragePct =
      totalInstr > 0 ? (totalCoveredInstr / totalInstr) * 100 : 0;

    // Gap respecto a target 60% (objetivo basado en LINE coverage)
    const targetPct = 60;
    const gapPct = targetPct - globalLineCoveragePct;

    // 2) Top 5 por priorityScore
    const sortedByPriority = [...items].sort(
      (a, b) => b.priorityScore - a.priorityScore,
    );
    const top5 = sortedByPriority.slice(0, 5);

    // 3) Siguiente recomendación (primera clase TODO) sin modificar el cache
    const next = pickNextMission(cache);

    const data = {
      total: {
        missedLines: totalMissed,
        coveredLines: totalCovered,
        totalLines,
        lineCoveragePct: Number(globalLineCoveragePct.toFixed(2)),
        instructionCoveragePct: Number(globalInstructionCoveragePct.toFixed(2)),
        targetPct,
        gapPct: Number(gapPct.toFixed(2)),
      },
      topByPriority: top5.map((it) => ({
        className: it.className,
        coveragePct: Number(it.metrics.coveragePct.toFixed(2)),
        priorityScore: it.priorityScore,
        status: it.status,
      })),
      nextRecommendation: next
        ? {
            className: next.className,
            coveragePct: Number(next.metrics.coveragePct.toFixed(2)),
            priorityScore: next.priorityScore,
            status: next.status,
          }
        : null,
      cacheMeta: {
        generatedAt: cache.generatedAt,
        xmlPath: cache.xmlPath,
        items: items.length,
      },
    };

    // Modo JSON
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // Modo humano con tabla
    console.log(
      chalk.cyan("== Resumen global de cobertura (desde .coverage-cache.json) =="),
    );
    console.log(
      `Líneas totales: ${totalLines}  |  Covered: ${totalCovered}  |  Missed: ${totalMissed}`,
    );
    console.log(`Line Coverage: ${globalLineCoveragePct.toFixed(2)}%`);
    console.log(`Instruction Coverage: ${globalInstructionCoveragePct.toFixed(2)}%`);
    console.log(
      `Target (Line): ${targetPct}%  |  Gap (Line): ${gapPct.toFixed(2)}%`,
    );
    console.log("");

    // Nota: en algunas terminales (especialmente integradas) los caracteres de caja pueden renderizar raro.
    // Forzamos el estilo ASCII para evitar cortes y “saltos” de línea.
    const table = new Table({
      chars: {
        top: "-",
        "top-mid": "+",
        "top-left": "+",
        "top-right": "+",
        bottom: "-",
        "bottom-mid": "+",
        "bottom-left": "+",
        "bottom-right": "+",
        left: "|",
        "left-mid": "+",
        mid: "-",
        "mid-mid": "+",
        right: "|",
        "right-mid": "+",
        middle: "|",
      },
      head: [
        chalk.white("Clase"),
        chalk.white("Cobertura %"),
        chalk.white("PriorityScore"),
        chalk.white("Status"),
      ],
      wordWrap: true,
      wrapOnWordBoundary: false,
    });

    for (const it of top5) {
      table.push([
        it.className,
        `${it.metrics.coveragePct.toFixed(2)}%`,
        String(it.priorityScore),
        it.status,
      ]);
    }

    console.log(chalk.cyan("Top 5 clases por PriorityScore:"));
    console.log(table.toString());
    console.log("");

    if (next) {
      console.log(
        chalk.green("Siguiente recomendación (sin modificar el cache):"),
      );
      console.log(
        `- Clase: ${next.className} | Coverage: ${next.metrics.coveragePct.toFixed(
          2,
        )}% | PriorityScore: ${next.priorityScore} | Status: ${next.status}`,
      );
    } else {
      console.log(
        chalk.green(
          "No hay siguiente recomendación: todas las clases están DONE o el cache está vacío.",
        ),
      );
    }
  });

program.parseAsync(process.argv);
