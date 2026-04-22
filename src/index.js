#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { parseJacocoXml } from "./parser.js";
import {
  buildCacheItems,
  loadCache,
  logCacheSummary,
  markDone,
  pickNextMission,
  renderMissionMarkdown,
  saveCache,
} from "./orchestrator.js";

const program = new Command();

program
  .name("coverage-orchestrator")
  .description(
    "Coverage Orchestrator CLI - Prioritiza clases Java para aumentar cobertura con JaCoCo",
  )
  .version("1.0.0");

program
  .command("analyze")
  .description("Escanea jacoco.xml y guarda el estado local en .coverage-cache.json")
  .option("--path <path>", "Ruta al archivo jacoco.xml (auto-detecta si no se especifica)")
  .option(
    "--include <pattern...>",
    "Incluye clases aunque coincidan con ignore rules (substrings)",
  )
  .option(
    "--ignore <pattern...>",
    "Ignora clases por nombre (substrings). Default: DTO Entity Configuration",
  )
  .option(
    "--minCoverageToIgnore <pct>",
    "Ignora clases con cobertura de líneas > pct (default: 90)",
    "90",
  )
  .action(async (opts) => {
    let xmlPath = opts.path;
    
    // Auto-detect jacoco.xml if --path not provided
    if (!xmlPath) {
      const { autoDetectJacocoXml } = await import("./orchestrator.js");
      xmlPath = await autoDetectJacocoXml();
      
      if (!xmlPath) {
        console.log(chalk.red("No se encontró jacoco.xml automáticamente."));
        console.log(chalk.yellow("Rutas buscadas:"));
        console.log("  - target/site/jacoco/jacoco.xml (Maven)");
        console.log("  - build/reports/jacoco/test/jacocoTestReport.xml (Gradle)");
        console.log("");
        console.log(chalk.cyan("Por favor, especifica la ruta manualmente:"));
        console.log(chalk.white("  coverage-orchestrator analyze --path <ruta_al_jacoco.xml>"));
        process.exitCode = 1;
        return;
      }
      
      console.log(chalk.green(`✓ JaCoCo XML auto-detectado: ${xmlPath}`));
    }
    
    const minCoverageToIgnorePct = Number.parseFloat(opts.minCoverageToIgnore);
    const includePatterns = opts.include ?? [];
    const ignorePatterns = opts.ignore ?? null;

    console.log(chalk.cyan(`Parsing JaCoCo report: ${xmlPath}`));
    const parsed = await parseJacocoXml(xmlPath);

    const items = buildCacheItems(parsed, {
      includePatterns,
      ignorePatterns,
      minCoverageToIgnorePct: Number.isFinite(minCoverageToIgnorePct)
        ? minCoverageToIgnorePct
        : 90,
    });

    const cache = {
      version: 1,
      generatedAt: new Date().toISOString(),
      xmlPath,
      items,
    };

    const cachePath = await saveCache(cache);
    console.log(chalk.green(`Cache saved: ${cachePath}`));
    logCacheSummary(cache);
  });

program
  .command("next")
  .description("Devuelve la siguiente misión priorizada en Markdown")
  .option("--sourceRoot <path>", "Root de fuentes Java", "src/main/java")
  .option("--testRoot <path>", "Root de tests Java", "src/test/java")
  .action(async (opts) => {
    const cache = await loadCache();
    const item = pickNextMission(cache);

    if (!item) {
      console.log(
        chalk.green("No hay misiones pendientes. (cache vacío o todo DONE)"),
      );
      return;
    }

    const md = renderMissionMarkdown(item, {
      sourceRoot: opts.sourceRoot,
      testRoot: opts.testRoot,
    });

    console.log(md);
  });

program
  .command("mark-done")
  .description("Marca una clase como DONE en el cache local")
  .argument("<className>", "Nombre fully-qualified de la clase (e.g. com.foo.BarService)")
  .action(async (className) => {
    const cache = await loadCache();
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

    const cachePath = await saveCache(cache);
    console.log(chalk.green(`DONE: ${className}`));
    console.log(chalk.cyan(`Cache updated: ${cachePath}`));
    logCacheSummary(cache);
  });

program.parseAsync(process.argv);
