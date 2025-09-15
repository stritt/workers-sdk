import { logger } from "../logger";
import { confirm, select } from "../dialogs";
import { loadContext, autoDetect } from "./utils";
import { ContainerDetector } from "./detectors";

const detectors = [new ContainerDetector()];

export async function runInteractiveDetection(): Promise<void> {
	try {
		// Load context
		const ctx = await loadContext();
		
		// Auto-detect project type
		logger.log("Detecting project type...");
		const detection = await autoDetect(detectors, ctx, { noPrompt: false });

		if (!detection) {
			// No project detected - offer to create new one
			await handleNoDetection(ctx);
			return;
		}

		// Show what we detected
		logger.log(`\nDetected ${detection.detector.name} project`);
		if (detection.metadata && Object.keys(detection.metadata).length > 0) {
			Object.entries(detection.metadata).forEach(([key, value]) => {
				logger.log(`  ${key}: ${value}`);
			});
		}

		// Ask user if they want to proceed
		const proceed = await confirm(`Set up Cloudflare integration for your ${detection.detector.name} project?`);

		if (!proceed) {
			logger.log("Run `wrangler --help` to see all available commands.");
			return;
		}

		// Scaffold the project
		logger.log("\nSetting up your Cloudflare project...");
		const scaffoldResult = await detection.detector.scaffold(ctx, {}, detection);

		if (!scaffoldResult) {
			logger.log("Failed to scaffold project");
			return;
		}

		logger.log("\nProject setup complete!");
		logger.log(`Project: ${scaffoldResult.projectName}`);
		
		// Offer to deploy
		const deploy = await confirm('Deploy to Cloudflare now?');

		if (deploy) {
			logger.log("\nDeploying to Cloudflare...");
			const success = await detection.detector.deploy(ctx, {}, scaffoldResult);
			
			if (success) {
				logger.log("\nDeployment successful!");
				logger.log("Your project is now live on Cloudflare.");
			} else {
				logger.log("\nDeployment had issues, but your project is configured.");
				logger.log("You can deploy later with: `wrangler deploy`");
			}
		} else {
			logger.log("\nYour project is ready!");
			logger.log("Deploy anytime with: `wrangler deploy`");
			logger.log("Start development with: `wrangler dev`");
		}

	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to run detection: ${errorMessage}`);
		
		// Fallback to help
		logger.log("\nRun `wrangler --help` to see all available commands.");
	}
}

async function handleNoDetection(ctx: any): Promise<void> {
	logger.log("No existing project detected in this directory.");
	
	const action = await select('What would you like to do?', [
		{ label: 'Create a new Cloudflare Worker project', value: 'init' },
		{ label: 'I have an existing project (try manual detection)', value: 'manual' },
		{ label: 'Show help and available commands', value: 'help' },
		{ label: 'Exit', value: 'exit' }
	]);

	switch (action) {
		case 'init':
			// Delegate to existing init command
			const { init } = await import('../init');
			await init.handler({ name: undefined, yes: false, fromDash: undefined, delegateC3: true });
			break;
			
		case 'manual':
			await runManualDetection(ctx);
			break;
					case 'help':
				// Show help - we'll need to import the CLI parser
				logger.log("\nWrangler Commands:");
				logger.log("Run `wrangler --help` for full command list");
				break;
				
			case 'exit':
				logger.log("Goodbye!");
				break;
	}
}

async function runManualDetection(ctx: any): Promise<void> {
	const detectorType = await select('What type of project do you have?', [
		{ label: 'Container/Docker project', value: 'container' },
		// Future detectors will be enabled here
		// { label: 'Next.js project', value: 'nextjs' },
		// { label: 'Astro project', value: 'astro' },
	]);

	const detector = detectors.find(d => d.id === detectorType);
	if (!detector) {
		logger.log("Detector not found");
		return;
	}

	// Force detection with the selected detector
	const detection = await detector.detect(ctx, { force: true });
	if (detection) {
		// Continue with the normal flow
		await runDetectionFlow(detector, detection, ctx);
	} else {
		logger.log(`No ${detector.name} project detected in this directory.`);
	}
}

async function runDetectionFlow(detector: any, detection: any, ctx: any): Promise<void> {
	logger.log(`\nDetected ${detection.detector.name} project`);
	if (detection.metadata && Object.keys(detection.metadata).length > 0) {
		Object.entries(detection.metadata).forEach(([key, value]) => {
			logger.log(`  ${key}: ${value}`);
		});
	}
	
	const scaffoldResult = await detector.scaffold(ctx, {}, detection);
	if (scaffoldResult) {
		logger.log("\nProject setup complete!");
		
		const deploy = await confirm('Deploy to Cloudflare now?');

		if (deploy) {
			await detector.deploy(ctx, {}, scaffoldResult);
		}
	}
}
