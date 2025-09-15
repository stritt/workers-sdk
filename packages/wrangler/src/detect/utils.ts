import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'path';
// Removed chalk import - using plain output for production

export const EXIT_CODES = {
  SUCCESS: 0,
  PARTIAL: 2,
  USAGE: 64,
  CONFIG: 65
} as const;

export interface Context {
  cwd: string;
  args: string[];
  config: Record<string, any>;
}

export interface DetectionResult {
  detector: {
    id: string;
    name: string;
    detect: (ctx: Context, opts: any) => Promise<DetectionResult | null>;
    scaffold: (ctx: Context, opts: any, result: DetectionResult) => Promise<any>;
    deploy: (ctx: Context, opts: any, scaffoldResult: any) => Promise<boolean>;
  };
  confidence: number;
  indicators: string[];
  metadata: Record<string, any>;
}

export async function loadContext(args?: string[]): Promise<Context> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  
  return {
    cwd,
    args: args || [],
    config
  };
}

async function loadConfig(cwd: string): Promise<Record<string, any>> {
  const configFiles = ['cf.config.json', 'cf.config.js', '.cfrc.json'];
  
  for (const configFile of configFiles) {
    const configPath = path.join(cwd, configFile);
    if (existsSync(configPath)) {
      try {
        if (configFile.endsWith('.json')) {
          return JSON.parse(await fs.readFile(configPath, 'utf8'));
        } else if (configFile.endsWith('.js')) {
          // Note: Dynamic imports in Node.js for ES modules
          const module = await import(configPath);
          return module.default || module;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(chalk.yellow('⚠'), `Failed to load config from ${configFile}: ${errorMessage}`);
      }
    }
  }
  
  return {};
}

export async function autoDetect(
  detectors: Array<{ detect: (ctx: Context, opts: any) => Promise<DetectionResult | null> }>,
  ctx: Context,
  opts: any
): Promise<DetectionResult | null> {
  const results: DetectionResult[] = [];
  
  for (const detector of detectors) {
    const result = await detector.detect(ctx, opts);
    if (result) {
      results.push(result);
    }
  }
  
  if (results.length === 0) return null;
  
  results.sort((a, b) => b.confidence - a.confidence);
  
  if (results.length > 1 && results[0].confidence - results[1].confidence < 0.1) {
    if (opts.noPrompt) {
      return results[0];
    }
    
    const choices = results.map(r => ({
      label: `${r.detector.name} (confidence: ${Math.round(r.confidence * 100)}%)`,
      value: r
    }));
    
    const { select } = await import('../dialogs');
    return await select('Multiple project types detected. Which would you like to use?', choices);
  }
  
  return results[0];
}

export function printDetectionResult(detection: DetectionResult): void {
  console.log(`\nDetected: ${detection.detector.name}`);
  
  if (detection.indicators && detection.indicators.length > 0) {
    console.log('\nIndicators:');
    detection.indicators.forEach(indicator => {
      console.log(`  - ${indicator}`);
    });
  }
  
  if (detection.metadata && Object.keys(detection.metadata).length > 0) {
    console.log('\nMetadata:');
    Object.entries(detection.metadata).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  }
}

export function printPlan(result: DetectionResult, ctx: Context, opts: any): void {
  console.log('\nExecution Plan\n');
  
  console.log('Detected project type:');
  console.log(`  ${result.detector.name}`);
  
  console.log('\nFiles that would be created/modified:');
  
  if (result.detector.id === 'container') {
    console.log('  - src/index.ts (Worker proxy code)');
    console.log('  - wrangler.jsonc (Cloudflare configuration)');
    console.log('  - tsconfig.json (if missing)');
    console.log('  - package.json (if missing)');
    console.log('  - .cfignore');
    if (result.metadata.image && !result.metadata.dockerfilePath) {
      console.log('  - Dockerfile.generated (for remote image)');
    }
  }
  
  console.log('\nCommands that would run:');
  console.log('  - npm install (to install dependencies)');
  console.log('  - wrangler deploy (if requested)');
}
