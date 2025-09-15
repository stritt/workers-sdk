import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'path';
import chalk from 'chalk';
import { parse as parseJsonc, modify as modifyJsonc, applyEdits } from 'jsonc-parser';
import { spawn } from 'child_process';
import { logger } from '../logger';
import type { Context, DetectionResult } from './utils';

interface DetectorOptions {
  ship?: boolean;
  plan?: boolean;
  detect?: boolean;
  type?: string;
  name?: string;
  class?: string;
  maxInstances?: string;
  migrationTag?: string;
  noPrompt?: boolean;
  force?: boolean;
  verbose?: boolean;
}

interface ContainerMetadata {
  image?: string;
  dockerfilePath?: string;
}

interface ContainerInfo {
  port: number;
}

interface ScaffoldResult {
  projectName: string;
  className: string;
  bindingName: string;
}

interface WranglerContainer {
  class_name: string;
  image: string;
  max_instances: number;
  instance_type: string;
}

interface WranglerBinding {
  class_name: string;
  name: string;
}

interface WranglerMigration {
  new_sqlite_classes?: string[];
  tag: string;
}

interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  observability?: {
    enabled: boolean;
  };
  containers?: WranglerContainer[];
  durable_objects?: {
    bindings: WranglerBinding[];
  };
  migrations?: WranglerMigration[];
}

interface PackageJson {
  name: string;
  description: string;
  private: boolean;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  dependencies: Record<string, string>;
}

interface TsConfig {
  compilerOptions: {
    target: string;
    lib: string[];
    module: string;
    moduleResolution: string;
    types: string[];
    resolveJsonModule: boolean;
    allowJs: boolean;
    checkJs: boolean;
    noEmit: boolean;
    isolatedModules: boolean;
    allowSyntheticDefaultImports: boolean;
    forceConsistentCasingInFileNames: boolean;
    strict: boolean;
    skipLibCheck: boolean;
  };
  exclude: string[];
  include: string[];
}

export abstract class Detector {
  public id: string;
  public name: string;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  abstract detect(ctx: Context, opts: DetectorOptions): Promise<DetectionResult | null>;
  abstract scaffold(ctx: Context, opts: DetectorOptions, detection: DetectionResult): Promise<ScaffoldResult | null>;
  abstract deploy(ctx: Context, opts: DetectorOptions, scaffoldResult: ScaffoldResult): Promise<boolean>;
}

export class ContainerDetector extends Detector {
  constructor() {
    super('container', 'Container');
  }

  async detect(ctx: Context, opts: DetectorOptions): Promise<DetectionResult | null> {
    const indicators: string[] = [];
    let confidence = 0;
    let image: string | null = null;
    let dockerfilePath: string | null = null;

    if (ctx.args.length > 0) {
      const arg = ctx.args[0];
      if ((arg.includes(':') || arg.includes('/')) && !path.extname(arg)) {
        image = arg;
        indicators.push(`Explicit image reference: ${arg}`);
        confidence = 0.95;
      }
    }

    const dockerfiles = ['Dockerfile', 'Containerfile', 'dockerfile'];
    for (const df of dockerfiles) {
      const dfPath = path.join(ctx.cwd, df);
      if (existsSync(dfPath)) {
        indicators.push(`Found ${df}`);
        confidence = Math.max(confidence, 0.9);
        dockerfilePath = dfPath;

        // Extract base image from Dockerfile
        try {
          const dockerfileContent = await fs.readFile(dfPath, 'utf8');
          const fromMatch = dockerfileContent.match(/^FROM\s+([^\s]+)/m);
          if (fromMatch) {
            image = fromMatch[1];
          }
        } catch (error) {
          // Ignore errors reading Dockerfile
        }
        break;
      }
    }

    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const cf of composeFiles) {
      if (existsSync(path.join(ctx.cwd, cf))) {
        indicators.push(`Found ${cf}`);
        confidence = Math.max(confidence, 0.7);
        break;
      }
    }

    if (existsSync(path.join(ctx.cwd, '.docker'))) {
      indicators.push('Found .docker directory');
      confidence = Math.max(confidence, 0.6);
    }

    const envFile = path.join(ctx.cwd, '.env');
    if (existsSync(envFile)) {
      const envContent = await fs.readFile(envFile, 'utf8');
      const imageMatch = envContent.match(/^IMAGE\s*=\s*(.+)$/m);
      if (imageMatch) {
        image = imageMatch[1].replace(/['"]/g, '');
        indicators.push(`Found IMAGE in .env: ${image}`);
        confidence = Math.max(confidence, 0.8);
      }
    }

    if (existsSync(path.join(ctx.cwd, 'manifest.json'))) {
      indicators.push('Found OCI manifest.json');
      confidence = Math.max(confidence, 0.85);
    }

    if (confidence === 0) return null;

    return {
      detector: this,
      confidence,
      indicators,
      metadata: { image, dockerfilePath } as ContainerMetadata
    };
  }

  async scaffold(ctx: Context, opts: DetectorOptions, detection: DetectionResult): Promise<ScaffoldResult | null> {
    const { image, dockerfilePath } = detection.metadata as ContainerMetadata;

    let projectName = opts.name;
    if (!projectName) {
      if (image) {
        projectName = image.split('/').pop()?.split(':')[0].replace(/[^a-zA-Z0-9-]/g, '-') || 'container-project';
      } else {
        projectName = path.basename(ctx.cwd);
      }
    }

    const existingContainer = await this.findExistingContainer(ctx.cwd, image, dockerfilePath);

    let className = opts.class;
    if (existingContainer) {
      className = existingContainer.class_name;
      logger.log(`Found existing container for this image: ${className}`);
    } else if (!className) {
      const baseName = `${projectName.charAt(0).toUpperCase()}${projectName.slice(1).replace(/-/g, '')}Container`;
      className = await this.generateUniqueClassName(ctx.cwd, baseName);
    }

    const bindingName = `${className.toUpperCase().replace('CONTAINER', '')}_CONTAINER`;
    const maxInstances = parseInt(opts.maxInstances || '10');

    const existingWorker = existsSync(path.join(ctx.cwd, 'src', 'index.ts'));
    const existingWrangler = existsSync(path.join(ctx.cwd, 'wrangler.jsonc'));

    if ((existingWorker || existingWrangler) && !opts.force && !opts.noPrompt) {
      const { confirm } = await import('../dialogs');
      const proceed = await confirm('This will modify existing project files. Continue?');

      if (!proceed) {
        logger.log('Operation cancelled');
        return null;
      }
    }

    logger.log(`Project: ${projectName}`);
    logger.log(`Class: ${className}`);
    logger.log(`Binding: ${bindingName}`);

    let finalDockerfilePath = dockerfilePath;
    let containerInfo: ContainerInfo = { port: 8080 };

    if (image && !dockerfilePath) {
      const generatedPath = path.join(ctx.cwd, 'Dockerfile.generated');
      const generatedDockerfile = `FROM ${image}
EXPOSE 8080`;
      await fs.writeFile(generatedPath, generatedDockerfile);
      logger.log('Generated Dockerfile for remote image');
      finalDockerfilePath = './Dockerfile.generated';
    } else if (dockerfilePath) {
      containerInfo = await this.analyzeDockerfile(dockerfilePath);
      finalDockerfilePath = path.relative(ctx.cwd, dockerfilePath);
      if (!finalDockerfilePath.startsWith('.')) {
        finalDockerfilePath = `./${finalDockerfilePath}`;
      }
      logger.log(`Detected port: ${containerInfo.port}`);
    }

    const srcDir = path.join(ctx.cwd, 'src');
    await fs.mkdir(srcDir, { recursive: true });

    logger.log('Generating project files...');

    const workerPath = path.join(srcDir, 'index.ts');
    if (existsSync(workerPath)) {
      await this.updateWorkerCode(workerPath, className, bindingName, containerInfo.port);
      logger.log('Updated src/index.ts with container class');
    } else {
      const workerCode = this.generateWorkerCode(className, bindingName, containerInfo.port);
      await fs.writeFile(workerPath, workerCode);
      logger.log('Generated src/index.ts');
    }

    const wranglerPath = path.join(ctx.cwd, 'wrangler.jsonc');
    if (existsSync(wranglerPath)) {
      await this.mergeWranglerConfig(wranglerPath, className, bindingName, finalDockerfilePath || './Dockerfile', maxInstances, ctx, opts);
      logger.log('Updated wrangler.jsonc with container configuration');
    } else {
      const wranglerConfig = this.generateWranglerConfig(projectName, className, bindingName, finalDockerfilePath || './Dockerfile', maxInstances);
      await fs.writeFile(wranglerPath, JSON.stringify(wranglerConfig, null, 2));
      logger.log('Generated wrangler.jsonc');
    }

    const tsConfigPath = path.join(ctx.cwd, 'tsconfig.json');
    if (!existsSync(tsConfigPath)) {
      const tsConfig = this.generateTsConfig();
      await fs.writeFile(tsConfigPath, JSON.stringify(tsConfig, null, 2));
      logger.log('Generated tsconfig.json');
    }

    const packageJsonPath = path.join(ctx.cwd, 'package.json');
    if (!existsSync(packageJsonPath)) {
      const packageJson = this.generatePackageJson(projectName);
      await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
      logger.log('Generated package.json');
    } else {
      await this.mergePackageJsonDependencies(packageJsonPath, projectName);
      logger.log('Updated package.json with required dependencies');
    }

    const cfignorePath = path.join(ctx.cwd, '.cfignore');
    if (!existsSync(cfignorePath)) {
      const cfignore = `node_modules/
*.log
.env
.DS_Store
dist/
build/
coverage/
.nyc_output/
*.tgz
*.tar.gz`;
      await fs.writeFile(cfignorePath, cfignore);
      logger.log('Generated .cfignore');
    }

    return { projectName, className, bindingName };
  }

  async deploy(ctx: Context, opts: DetectorOptions, scaffoldResult: ScaffoldResult): Promise<boolean> {
    logger.log('Installing dependencies...');

    return new Promise((resolve) => {
      const npmInstall = spawn('npm', ['install'], { cwd: ctx.cwd, stdio: 'inherit' });

      npmInstall.on('close', (code) => {
        if (code !== 0) {
          logger.error('Failed to install dependencies');
          resolve(false);
          return;
        }

        logger.log('Dependencies installed successfully');

        // Generate types
        logger.log('Generating TypeScript types...');
        const wranglerTypes = spawn('npx', ['wrangler', 'types'], { cwd: ctx.cwd, stdio: 'inherit' });

        wranglerTypes.on('close', (typesCode) => {
          if (typesCode === 0) {
            logger.log('TypeScript types generated');
          }

          // Deploy
          logger.log('Deploying to Cloudflare...');
          const wranglerDeploy = spawn('npx', ['wrangler', 'deploy'], { cwd: ctx.cwd, stdio: 'inherit' });

          wranglerDeploy.on('close', (deployCode) => {
            if (deployCode === 0) {
              logger.log('Deployment completed successfully!');
              resolve(true);
            } else {
              logger.error('Deployment failed');
              resolve(false);
            }
          });
        });
      });
    });
  }

  // ... (include all the other methods from your original detectors.ts)
  // I'll include a few key ones here for brevity

  async findExistingContainer(cwd: string, image?: string, dockerfilePath?: string): Promise<WranglerContainer | null> {
    const wranglerPath = path.join(cwd, 'wrangler.jsonc');
    if (!existsSync(wranglerPath)) {
      return null;
    }

    try {
      const wranglerContent = await fs.readFile(wranglerPath, 'utf8');
      const wranglerConfig = parseJsonc(wranglerContent) as WranglerConfig;

      if (!wranglerConfig.containers) {
        return null;
      }

      const targetImage = image ? `./Dockerfile.generated` : (dockerfilePath ? path.relative(cwd, dockerfilePath) : './Dockerfile');

      return wranglerConfig.containers.find(container =>
        container.image === targetImage ||
        container.image === `./Dockerfile` ||
        (image && container.image === './Dockerfile.generated')
      ) || null;
    } catch (error) {
      return null;
    }
  }

  async generateUniqueClassName(cwd: string, baseName: string): Promise<string> {
    // Check both worker file and wrangler config to avoid conflicts
    const workerPath = path.join(cwd, 'src', 'index.ts');
    const wranglerPath = path.join(cwd, 'wrangler.jsonc');

    const existingClasses = new Set<string>();

    // Check worker file for existing classes
    if (existsSync(workerPath)) {
      try {
        const existingCode = await fs.readFile(workerPath, 'utf8');
        const classMatches = existingCode.match(/export class (\w+)/g);
        if (classMatches) {
          classMatches.forEach(match => {
            const className = match.replace('export class ', '');
            existingClasses.add(className);
          });
        }
      } catch (error) {
        // Ignore errors
      }
    }

    // Check wrangler config for existing container classes
    if (existsSync(wranglerPath)) {
      try {
        const wranglerContent = await fs.readFile(wranglerPath, 'utf8');
        const wranglerConfig = parseJsonc(wranglerContent) as WranglerConfig;
        if (wranglerConfig.containers) {
          wranglerConfig.containers.forEach(container => {
            existingClasses.add(container.class_name);
          });
        }
      } catch (error) {
        // Ignore errors
      }
    }

    // Find a unique name
    let className = baseName;
    let counter = 1;

    while (existingClasses.has(className)) {
      className = `${baseName}${counter}`;
      counter++;
    }

    return className;
  }

  async analyzeDockerfile(dockerfilePath: string): Promise<ContainerInfo> {
    try {
      const content = await fs.readFile(dockerfilePath, 'utf8');
      const lines = content.split('\n');

      let port = 8080; // default

      // Look for EXPOSE directive
      for (const line of lines) {
        const exposeLine = line.trim().toUpperCase();
        if (exposeLine.startsWith('EXPOSE ')) {
          const exposedPort = parseInt(exposeLine.split(' ')[1]);
          if (!isNaN(exposedPort)) {
            port = exposedPort;
            break;
          }
        }
      }

      return { port };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`Could not analyze Dockerfile: ${errorMessage}`);
      return { port: 8080 };
    }
  }

  generateWorkerCode(className: string, bindingName: string, port: number = 8080): string {
    return `import { Container, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";

export class ${className} extends Container<Env> {
  defaultPort = ${port};
  sleepAfter = "2m";

  override onStart() {
    console.log("${className} successfully started on port ${port}");
  }

  override onStop() {
    console.log("${className} successfully shut down");
  }

  override onError(error: unknown) {
    console.log("${className} error:", error);
  }
}

const app = new Hono<{
  Bindings: Env;
}>();

// Forward all requests to container - no health check needed
app.all("*", async (c) => {
  const container = getContainer(c.env.${bindingName});
  return await container.fetch(c.req.raw);
});

export default app;`;
  }

  generateWranglerConfig(projectName: string, className: string, bindingName: string, dockerfilePath: string, maxInstances: number): WranglerConfig {
    return {
      name: projectName,
      main: "src/index.ts",
      compatibility_date: new Date().toISOString().split('T')[0],
      compatibility_flags: ["nodejs_compat"],
      observability: {
        enabled: true
      },
      containers: [
        {
          class_name: className,
          image: dockerfilePath,
          max_instances: maxInstances,
          instance_type: "basic"
        }
      ],
      durable_objects: {
        bindings: [
          {
            class_name: className,
            name: bindingName
          }
        ]
      },
      migrations: [
        {
          new_sqlite_classes: [className],
          tag: "v1"
        }
      ]
    };
  }

  generatePackageJson(projectName: string): PackageJson {
    return {
      name: projectName,
      description: `Cloudflare Worker with Container - ${projectName}`,
      private: true,
      scripts: {
        deploy: "wrangler deploy",
        dev: "wrangler dev",
        start: "wrangler dev",
        "cf-typegen": "wrangler types"
      },
      devDependencies: {
        "@types/node": "^24.3.0",
        "typescript": "5.8.3",
        "wrangler": "^4.33.1"
      },
      dependencies: {
        "@cloudflare/containers": "^0.0.19",
        "hono": "4.8.2"
      }
    };
  }

  generateTsConfig(): TsConfig {
    return {
      compilerOptions: {
        target: "es2021",
        lib: ["es2021"],
        module: "es2022",
        moduleResolution: "Bundler",
        types: ["./worker-configuration.d.ts", "node"],
        resolveJsonModule: true,
        allowJs: true,
        checkJs: false,
        noEmit: true,
        isolatedModules: true,
        allowSyntheticDefaultImports: true,
        forceConsistentCasingInFileNames: true,
        strict: true,
        skipLibCheck: true
      },
      exclude: ["test"],
      include: ["worker-configuration.d.ts", "src/**/*.ts"]
    };
  }

  async updateWorkerCode(workerPath: string, className: string, bindingName: string, port: number = 8080): Promise<void> {
    try {
      const existingCode = await fs.readFile(workerPath, 'utf8');

      // Check if the class already exists
      if (existingCode.includes(`export class ${className}`)) {
        logger.log(`Container class ${className} already exists in worker`);
        return;
      }

      // Add the new container class at the top (after imports)
      const lines = existingCode.split('\n');
      let insertIndex = 0;

      // Find the end of imports
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('import ') || line.startsWith('//') || line === '') {
          insertIndex = i + 1;
        } else {
          break;
        }
      }

      const containerClass = `
export class ${className} extends Container<Env> {
  defaultPort = ${port};
  sleepAfter = "2m";

  override onStart() {
    console.log("${className} successfully started on port ${port}");
  }

  override onStop() {
    console.log("${className} successfully shut down");
  }

  override onError(error: unknown) {
    console.log("${className} error:", error);
  }
}
`;

      lines.splice(insertIndex, 0, containerClass);
      await fs.writeFile(workerPath, lines.join('\n'));

      logger.log(`Added ${className} to existing worker`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to update worker code: ${errorMessage}`);
      // Fall back to generating new worker code
      const workerCode = this.generateWorkerCode(className, bindingName, port);
      await fs.writeFile(workerPath, workerCode);
    }
  }

  async mergePackageJsonDependencies(packageJsonPath: string, projectName: string): Promise<void> {
    try {
      const existingPackageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      const requiredDeps = this.generatePackageJson(projectName);

      // Merge dependencies
      existingPackageJson.dependencies = {
        ...existingPackageJson.dependencies,
        ...requiredDeps.dependencies
      };

      // Merge devDependencies
      existingPackageJson.devDependencies = {
        ...existingPackageJson.devDependencies,
        ...requiredDeps.devDependencies
      };

      // Add scripts if they don't exist
      existingPackageJson.scripts = {
        ...existingPackageJson.scripts,
        ...requiredDeps.scripts
      };

      await fs.writeFile(packageJsonPath, JSON.stringify(existingPackageJson, null, 2));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to merge package.json: ${errorMessage}`);
    }
  }

  async mergeWranglerConfig(
    wranglerPath: string,
    className: string,
    bindingName: string,
    dockerfilePath: string,
    maxInstances: number,
    ctx: Context,
    opts: DetectorOptions
  ): Promise<void> {
    try {
      const wranglerContent = await fs.readFile(wranglerPath, 'utf8');
      const existingConfig = parseJsonc(wranglerContent) as WranglerConfig;

      // Add container configuration
      if (!existingConfig.containers) {
        existingConfig.containers = [];
      }

      const existingContainerIndex = existingConfig.containers.findIndex(c =>
        c.image === dockerfilePath || c.class_name === className
      );

      const newContainer: WranglerContainer = {
        class_name: className,
        image: dockerfilePath,
        max_instances: maxInstances,
        instance_type: "basic"
      };

      if (existingContainerIndex >= 0) {
        existingConfig.containers[existingContainerIndex] = newContainer;
        logger.log(`Updated existing container configuration for ${className}`);
      } else {
        existingConfig.containers.push(newContainer);
        logger.log(`Added new container configuration for ${className}`);
      }

      if (!existingConfig.durable_objects) {
        existingConfig.durable_objects = { bindings: [] };
      }
      if (!existingConfig.durable_objects.bindings) {
        existingConfig.durable_objects.bindings = [];
      }

      const existingBindingIndex = existingConfig.durable_objects.bindings.findIndex(b => b.class_name === className);
      const newBinding: WranglerBinding = {
        class_name: className,
        name: bindingName
      };

      if (existingBindingIndex >= 0) {
        existingConfig.durable_objects.bindings[existingBindingIndex] = newBinding;
      } else {
        existingConfig.durable_objects.bindings.push(newBinding);
      }

      if (!existingConfig.migrations) {
        existingConfig.migrations = [];
      }

      const classExistsInMigrations = existingConfig.migrations.some(migration =>
        migration.new_sqlite_classes?.includes(className)
      );

      if (!classExistsInMigrations) {
        let latestMigration = existingConfig.migrations[existingConfig.migrations.length - 1];

        if (!latestMigration) {
          const migrationTag = opts.migrationTag || "v1";
          latestMigration = {
            new_sqlite_classes: [className],
            tag: migrationTag
          };
          existingConfig.migrations.push(latestMigration);
          logger.log(`Created new migration ${migrationTag} for ${className}`);
        } else {
          if (!latestMigration.new_sqlite_classes) {
            latestMigration.new_sqlite_classes = [];
          }

          if (latestMigration.new_sqlite_classes.length >= 3) {
            const newTagNumber = existingConfig.migrations.length + 1;
            const newMigration: WranglerMigration = {
              new_sqlite_classes: [className],
              tag: `v${newTagNumber}`
            };
            existingConfig.migrations.push(newMigration);
            logger.log(`Created new migration v${newTagNumber} for ${className}`);
          } else {
            latestMigration.new_sqlite_classes.push(className);
            logger.log(`Added ${className} to existing migration ${latestMigration.tag}`);
          }
        }
      } else {
        logger.log(`Class ${className} already exists in migrations, skipping`);
      }

      if (!existingConfig.compatibility_flags) {
        existingConfig.compatibility_flags = [];
      }
      if (!existingConfig.compatibility_flags.includes("nodejs_compat")) {
        existingConfig.compatibility_flags.push("nodejs_compat");
      }

      await fs.writeFile(wranglerPath, JSON.stringify(existingConfig, null, 2));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to merge wrangler config: ${errorMessage}`);
      throw error;
    }
  }
}
