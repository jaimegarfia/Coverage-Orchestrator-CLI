# Coverage Orchestrator CLI
CLI en Node.js para **orquestar la subida de cobertura** en microservicios Java a partir de un reporte **JaCoCo XML**. Analiza el reporte, calcula un **ROI de cobertura** por clase y genera “misiones” en Markdown para que un agente de IA cree tests unitarios de alto impacto.

---

## Requisitos

- Node.js 18+ (recomendado 20+)
- Proyecto Java que genere `jacoco.xml` (Maven o Gradle)

---

## Instalación / Distribución

### Opción A (recomendada): usarlo sin instalar (npx)
Cuando publiques el paquete en npm, cualquier usuario podrá ejecutar:

```bash
npx coverage-orchestrator analyze --path <ruta_al_jacoco.xml>
npx coverage-orchestrator next
# (Opcional) mark-done existe por compatibilidad, pero el flujo recomendado ya no lo necesita:
npx coverage-orchestrator mark-done <className>
```

### Opción B: instalación global

```bash
npm install -g coverage-orchestrator-cli
coverage-orchestrator --help
```

### Opción C: desarrollo local (este repo)

```bash
npm install
node src/index.js --help
```

Para simular instalación del binario desde el repo:

```bash
npm link
coverage-orchestrator --help
```

Para desinstalar el link:

```bash
npm unlink -g coverage-orchestrator-cli
```

---

## Dónde encontrar el `jacoco.xml`

### Maven (lo más común)
Tras ejecutar tests + report:

```bash
mvn test jacoco:report
```

Suele quedar en:

- `target/site/jacoco/jacoco.xml`

### Gradle
Normalmente:

- `build/reports/jacoco/test/jacocoTestReport.xml`

---

## Uso

### 1) Analizar el reporte y generar cache

El CLI **auto-detecta** el `jacoco.xml` en rutas comunes (Maven/Gradle):

```bash
coverage-orchestrator analyze
```

Si no lo encuentra automáticamente, especifica la ruta:

```bash
coverage-orchestrator analyze --path "C:\\path\\to\\jacoco.xml"
```

Esto genera un fichero local **en el root del microservicio** (projectRoot detectado por `pom.xml`/`build.gradle`):

- `<projectRoot>/.coverage-cache.json`

Opciones:

- `--path <ruta>`: ruta al jacoco.xml (opcional, auto-detecta si no se especifica)
- `--minCoverageToIgnore <pct>`: ignora clases con cobertura de líneas > pct (default 90)
- `--ignore <pattern...>`: ignora clases cuyo nombre contenga alguno de esos substrings (opcional; por defecto no se ignora por nombre)
- `--include <pattern...>`: fuerza incluir clases aunque coincidan con reglas de ignore

Ejemplo:

```bash
coverage-orchestrator analyze --minCoverageToIgnore 95
```

### 2) Pedir la siguiente misión

```bash
coverage-orchestrator next
```

`next` devuelve una misión en Markdown con:

- Ruta sugerida del Java a testear
- Ruta sugerida del test (o dónde crearlo)
- Lista de métodos con 0% cobertura (según JaCoCo)
- Prompt sugerido para que un agente de IA genere los tests

Opciones:

- `--sourceRoot <path>` (default: `src/main/java`)
- `--testRoot <path>` (default: `src/test/java`)

### 3) (Opcional) Marcar una clase como completada

> El workflow recomendado ya no requiere `mark-done`.
> El CLI marca automáticamente como `DONE` las clases que alcancen el umbral de cobertura al re-ejecutar `analyze`.

```bash
coverage-orchestrator mark-done com.foo.BarService
```

---

## Funcionamiento del CLI (end-to-end)

### Objetivo
Subir la cobertura de un microservicio Java hasta un objetivo (p.ej. **60% global**) generando una cola de trabajo (“misiones”) priorizada por ROI de cobertura.

### Flujo recomendado
1) Ejecuta tests + genera reporte JaCoCo (`jacoco.xml`) en el microservicio.
2) Ejecuta `coverage-orchestrator analyze` para convertir el XML en un estado local.
3) Ejecuta `coverage-orchestrator next` para obtener la siguiente misión en Markdown.
4) Implementa tests, vuelve a generar el reporte JaCoCo y repite.

### Qué hace `analyze`
1) Localiza el **projectRoot** del microservicio subiendo carpetas desde el `jacoco.xml` hasta encontrar `pom.xml` o `build.gradle(.kts)`.
2) Detecta el **entorno** del repo (best-effort): Maven/Gradle, versión Java (si se puede), Spring Boot (si se puede), librería de aserciones (AssertJ/Hamcrest/JUnit) y si usa Lombok.
3) **Parsea** el `jacoco.xml` y obtiene todas las clases del reporte.
4) Por clase, calcula métricas y ROI:
   - `MissedLines` = `LINE.missed`
   - `Complexity` = `COMPLEXITY.missed + COMPLEXITY.covered`
   - `PriorityScore = MissedLines * Complexity`
5) Aplica filtros (solo si el usuario lo pide o por coverage):
   - Por defecto ignora clases con `coveragePct > 90` (configurable con `--minCoverageToIgnore`).
   - Por defecto **no** ignora clases por nombre. Si quieres filtrar, usa `--ignore` explícitamente.
6) Ordena por `PriorityScore` y guarda el estado en:
   - `<projectRoot>/.coverage-cache.json`

### Auto-DONE (Smart Analyze)
Durante `analyze`, el CLI marca automáticamente una clase como `DONE` si su `coveragePct >= 60` (umbral actual).
En ese caso añade:
- `autoVerified: true`

Esto elimina la necesidad del workflow manual de `mark-done` (se mantiene como compatibilidad).

---

## Limitaciones conocidas

- La ruta sugerida del test depende de `sourcefilename` del XML y puede necesitar ajustes.
- JaCoCo puede listar métodos sintéticos (por ejemplo `lambda$...`) en la lista de 0% (ya filtramos `$`, `<init>`, `<clinit>`, pero puede haber otros casos).
- Proyectos multi-módulo o versiones definidas por herencia/variables pueden hacer que `env.version` / `env.frameworkVersion` quede como `null` (best-effort).

---

## Workflow recomendado (sin mark-done)

1) Genera/actualiza cobertura en el proyecto:
   - Maven: `mvn test jacoco:report`
   - Gradle: `./gradlew test jacocoTestReport`
2) Ejecuta:
   ```bash
   coverage-orchestrator analyze --path <ruta_al_jacoco.xml>
   ```
3) Pide la siguiente misión:
   ```bash
   coverage-orchestrator next
   ```
4) Implementa los tests, vuelve a ejecutar Maven/Gradle, y repite.

---

## Roadmap

- Mejorar resolución de `java.version` y `spring-boot` en proyectos multi-módulo (herencia/propiedades).
- Detectar JUnit4 vs JUnit5 (prompt adaptativo).
- Enriquecer el “prompt” con dependencias reales (parseando imports / constructor injection).
- Añadir `summary` al README (tabla + `--json`).


## Licencia

ISC
