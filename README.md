# Coverage Orchestrator CLI

**Coverage Orchestrator CLI** es un CLI en Node.js que convierte un reporte XML de JaCoCo en un backlog priorizado y “AI-friendly” de **misiones** para aumentar la cobertura de tests unitarios Java de forma eficiente.

Está pensado para equipos que trabajan con **microservicios Java** (Maven o Gradle) y quieren:
- identificar dónde las mejoras de cobertura tienen mayor ROI,
- generar instrucciones claras y repetibles para un agente de IA (o un developer),
- iterar rápidamente hasta alcanzar un objetivo (por ejemplo **60% de cobertura global**).

---

## Tabla de contenidos

- [Conceptos clave](#conceptos-clave)
- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Quickstart](#quickstart)
- [Cómo funciona](#cómo-funciona)
- [Referencia del CLI](#referencia-del-cli)
  - [`analyze`](#analyze)
  - [`next`](#next)
  - [`mark-done` (legacy)](#mark-done-legacy)
  - [`summary`](#summary)
- [Cache y modelo de estado](#cache-y-modelo-de-estado)
- [Workflow recomendado](#workflow-recomendado)
- [Consejos para usarlo con un agente de IA](#consejos-para-usarlo-con-un-agente-de-ia)
- [Troubleshooting](#troubleshooting)
- [Limitaciones](#limitaciones)
- [Roadmap](#roadmap)
- [Contribuir](#contribuir)
- [Publicar una nueva versión](#publicar-una-nueva-versión)
- [Licencia](#licencia)

---

## Conceptos clave

### Misión
Una **misión** es un documento en Markdown que imprime `next` y que incluye:
- ruta objetivo del Java source (best-effort),
- ruta recomendada del test (best-effort),
- métodos con **0% de cobertura de línea** (según JaCoCo),
- un prompt adaptado para generar tests (Mockito + estilo de aserciones detectado).

### PriorityScore (ROI)
Para cada clase, el CLI calcula:

- `MissedLines` = counter de JaCoCo `LINE.missed`
- `Complexity` = counter de JaCoCo `COMPLEXITY.missed + COMPLEXITY.covered`
- `PriorityScore = MissedLines * Complexity`

Un score alto significa: “testear esta clase probablemente moverá más la cobertura”.

### Auto-DONE (Smart Analyze)
En cada `analyze`, las clases se etiquetan automáticamente basándose en evidencia del XML:

- si `coveragePct >= 60` → `status: DONE`, `autoVerified: true`
- si no → `status: TODO`

Esto permite iterar simplemente regenerando el reporte y re-ejecutando `analyze`.

---

## Requisitos

- Node.js **18+** (recomendado **20+**)
- Un proyecto Java que genere **JaCoCo XML**
  - Maven: típicamente `target/site/jacoco/jacoco.xml`
  - Gradle: típicamente `build/reports/jacoco/test/jacocoTestReport.xml`

---

## Instalación

### Opción A (recomendada): ejecutar con `npx` (sin instalación global)

```bash
npx coverage-orchestrator-cli --help
```

> Nota: el nombre del paquete en npm es `coverage-orchestrator-cli` y expone el binario `coverage-orchestrator`.

### Opción B: instalación global

```bash
npm install -g coverage-orchestrator-cli
coverage-orchestrator --help
```

### Opción C: desarrollo local (este repositorio)

```bash
npm install
node src/index.js --help
```

Para simular un binario global desde este repo:

```bash
npm link
coverage-orchestrator --help
```

Para eliminar el link:

```bash
npm unlink -g coverage-orchestrator-cli
```

---

## Quickstart

### 1) Genera el reporte JaCoCo en tu proyecto Java

Maven:

```bash
mvn test jacoco:report
```

Gradle:

```bash
./gradlew test jacocoTestReport
```

### 2) Analiza el reporte

Si lo ejecutas desde el root del microservicio, el CLI puede auto-detectar rutas comunes:

```bash
coverage-orchestrator analyze
```

O puedes pasar la ruta explícita:

```bash
coverage-orchestrator analyze --path "C:\\path\\to\\jacoco.xml"
```

### 3) Pide la siguiente misión

```bash
coverage-orchestrator next
```

### 4) Implementa tests y repite

Regenera el JaCoCo XML → re-ejecuta `analyze` → ejecuta `next` otra vez.

---

## Cómo funciona

### 1) Detectar el root del microservicio (projectRoot)
Dada la ruta al `jacoco.xml`, el CLI sube directorios hasta encontrar:
- `pom.xml`, o
- `build.gradle` / `build.gradle.kts`

Ese directorio se considera el **projectRoot**.

### 2) Detectar el entorno (best-effort)
Desde el projectRoot, el CLI detecta:
- build tool: Maven / Gradle
- versión Java (si se puede detectar)
- versión de Spring Boot (si se puede detectar)
- librería de aserciones:
  - AssertJ / Hamcrest / default JUnit 5 Assertions
- uso de Lombok (`usesLombok` boolean)

### 3) Parsear el JaCoCo XML
El parser normaliza el XML a paquetes/clases/métodos y counters.

> El CLI está diseñado para ser **fiel al reporte**: procesa todas las clases presentes en el XML.
> Los filtros se aplican únicamente en la capa de orquestación (p. ej. `--minCoverageToIgnore`, `--ignore`), no en el parser.

### 4) Puntuar clases y construir misiones
El orchestrator:
- calcula `PriorityScore`,
- opcionalmente ignora clases con cobertura muy alta (default `> 90%`, configurable),
- auto-etiqueta DONE/TODO usando el **umbral 60%**,
- ordena por prioridad y guarda estado en un fichero de cache.

---

## Referencia del CLI

El paquete expone el binario:

```bash
coverage-orchestrator <command> [options]
```

### `analyze`

Escanea el JaCoCo XML y guarda un estado local (cache).

```bash
coverage-orchestrator analyze [--path <jacoco.xml>]
```

Opciones:
- `--path <path>`: ruta al JaCoCo XML (opcional; auto-detecta rutas comunes si se omite)
- `--minCoverageToIgnore <pct>`: ignora clases con cobertura de líneas `> pct` (default `90`)
- `--ignore <pattern...>`: ignora clases cuyo FQCN contenga alguno de los substrings (opt-in)
- `--include <pattern...>`: fuerza incluir clases incluso si coinciden con reglas de ignore (opt-in)

Outputs:
- imprime dónde se guardó el cache,
- imprime conteo TODO/DONE.

### `next`

Imprime la siguiente misión en **Markdown**.

```bash
coverage-orchestrator next
```

Opciones:
- `--sourceRoot <path>` (default `src/main/java`)
- `--testRoot <path>` (default `src/test/java`)

Comportamiento:
- elige la clase con mayor prioridad cuyo `status !== DONE`.

### `mark-done` (legacy)

Marca manualmente una clase como DONE. Se mantiene por compatibilidad, pero el workflow recomendado es:

> escribir tests → generar JaCoCo → `analyze` → `next`

```bash
coverage-orchestrator mark-done com.foo.BarService
```

### `summary`

Muestra un resumen global de cobertura calculado desde el cache.

```bash
coverage-orchestrator summary
coverage-orchestrator summary --json
```

---

## Cache y modelo de estado

### Dónde se guarda el cache
El cache se guarda dentro del **projectRoot** del microservicio:

- `<projectRoot>/.coverage-cache.json`

Esto hace que el estado sea **por microservicio**, evitando confusiones al ejecutar el CLI desde otros directorios.

### Forma del cache (simplificada)

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

## Workflow recomendado

1) Genera cobertura:
- Maven: `mvn test jacoco:report`
- Gradle: `./gradlew test jacocoTestReport`

2) Analiza:
```bash
coverage-orchestrator analyze --path <path-to-jacoco.xml>
```

3) Obtén la siguiente misión:
```bash
coverage-orchestrator next
```

4) Implementa tests (ejecútalos localmente), regenera el reporte y repite.

---

## Consejos para usarlo con un agente de IA

- Trata la misión como el “contrato”: define la clase objetivo, los métodos 0% y la ubicación del test.
- El prompt ya asume:
  - JUnit 5
  - Mockito para dependencias
  - tu estilo de aserciones (`AssertJ` / `Hamcrest` / `JUnit 5 Assertions`)
- Si la clase usa Lombok (`env.usesLombok: true`), considera pedir al agente:
  - evitar testear boilerplate generado por Lombok salvo necesidad,
  - enfocarse en lógica y comportamiento observable.

---

## Troubleshooting

### `analyze` no encuentra `jacoco.xml`
Si no pasas `--path`, el CLI solo busca rutas comunes:
- `target/site/jacoco/jacoco.xml` (Maven)
- `build/reports/jacoco/test/jacocoTestReport.xml` (Gradle)

Pasa la ruta manualmente:

```bash
coverage-orchestrator analyze --path "<absolute-or-relative-path>"
```

### Cache no encontrado al ejecutar `next`
El cache está en `<projectRoot>/.coverage-cache.json`.

Recomendado:
- ejecutar `next` desde el root del microservicio, o
- ejecutar `analyze` antes (imprime la ruta del cache).

---

## Limitaciones

- Los paths de source/test son **best-effort**: JaCoCo provee `package` + `sourcefilename`, pero monorepos/multi-módulo pueden requerir ajustar `--sourceRoot` / `--testRoot`.
- La detección de entorno es heurística:
  - herencia de parent multi-módulo Maven y propiedades con placeholders pueden dejar `env.version` / `env.frameworkVersion` como `null`.
- La lista de métodos “0% coverage” puede incluir métodos sintéticos en casos extremos. Actualmente filtramos `$`, `<init>` y `<clinit>`.

---

## Roadmap

- Mejorar detección de Java/Spring en multi-módulo (resolver parent chain / propiedades).
- Detectar JUnit 4 vs JUnit 5 y adaptar prompts.
- Enriquecer misiones con hints de dependencias (analizando constructor injection/imports).
- Documentar mejor el output de `summary` y añadir reporting más accionable.

---

## Contribuir

1) Haz fork del repo
2) Crea una rama de feature
3) Ejecuta:
   ```bash
   npm install
   node src/index.js --help
   ```
4) Abre una PR con una descripción clara + ejemplos before/after

---

## Publicar una nueva versión

1) Elige un bump SemVer:
```bash
npm version patch
# o: npm version minor
# o: npm version major
```

2) Push de commit y tags:
```bash
git push --follow-tags
```

3) Publica:
```bash
npm publish --access public
```

4) Valida:
```bash
npx coverage-orchestrator-cli --help
npx coverage-orchestrator-cli analyze --help
```

---

## Licencia

ISC
