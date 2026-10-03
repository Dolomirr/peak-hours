import { getPeakHoursStatus, formatPeakHoursMessage } from './utils.js';
import { DEFAULT_CONFIG, type PluginConfig } from './config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types: OpenCode V2 plugin context ──────────────────────────────────────
// Minimal structural types so the package needs no dependency on the
// OpenCode plugin SDK (V2 accepts plain objects).

interface V2CommandExecuteArgs {
	sessionID: string;
	prompt?: string;
	delivery?: string;
}

interface V2Command {
	name: string;
	description: string;
	execute: (args: V2CommandExecuteArgs) => Promise<void> | void;
}

interface V2CommandEditor {
	add: (command: V2Command) => unknown;
}

interface V2PluginContext {
	command: {
		transform: (fn: (editor: V2CommandEditor) => void) => Promise<unknown>;
	};
	session: {
		prompt: (args: {
			sessionID: string;
			text: string;
			delivery?: string;
			resume?: boolean;
			metadata?: unknown;
		}) => Promise<unknown>;
	};
}

// ─── Types: OpenCode V1 hooks (legacy fallback) ─────────────────────────────

interface PluginConfigInput {
	command?: Record<string, { template: string; description: string }>;
}

interface CommandExecuteInput {
	command: string;
	sessionID: string;
}

interface OpencodeClient {
	session: {
		prompt: (params: {
			path: { id: string };
			body: {
				noReply?: boolean;
				parts: Array<{ type: 'text'; text: string; ignored?: boolean }>;
			};
		}) => Promise<unknown>;
	};
}

interface V1ServerContext {
	client: unknown;
}

// Command-handled sentinel (V1 only)
const COMMAND_HANDLED_SENTINEL = '__PEAK_HOURS_COMMAND_HANDLED__' as const;

function handled(): never {
	throw new Error(COMMAND_HANDLED_SENTINEL);
}

function getConfigPath(): string {
	const configDir = process.env.XDG_CONFIG_HOME
		? path.join(process.env.XDG_CONFIG_HOME, 'opencode')
		: path.join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'opencode');
	return path.join(configDir, 'peak-hours.json');
}

function loadConfig(): PluginConfig {
	const configPath = getConfigPath();

	if (fs.existsSync(configPath)) {
		try {
			const configContent = fs.readFileSync(configPath, 'utf-8');
			const userConfig = JSON.parse(configContent);
			return {
				enabled: userConfig.enabled !== undefined ? userConfig.enabled : DEFAULT_CONFIG.enabled,
			};
		} catch (error) {
			console.error('Error loading peak-hours config:', error);
		}
	}

	return DEFAULT_CONFIG;
}

function isPluginConfigInput(value: unknown): value is PluginConfigInput {
	return typeof value === 'object' && value !== null && 'command' in value;
}

/**
 * Dual-export plugin definition.
 *
 * - OpenCode V2 (>= 2.0) uses `id` + `setup(ctx)`: registers a native
 *   `peak_hours` command that owns its own execution and injects the
 *   output via `ctx.session.prompt` with `resume: false` (admits the
 *   message without starting a model turn — replaces the V1
 *   noReply + ignored + sentinel-throw pattern).
 * - OpenCode V1 (>= 1.18.29) calls `server({ client })` and receives the
 *   legacy hooks object, unchanged from 0.7.0.
 */
const plugin = {
	id: 'zai-peak-hours',

	async setup(ctx: V2PluginContext) {
		const config = loadConfig();

		await ctx.command.transform((editor) => {
			editor.add({
				name: 'peak_hours',
				description: 'Display current z.ai peak hours status and time until next transition',
				execute: async ({ sessionID }) => {
					const output = config.enabled
						? formatPeakHoursMessage(getPeakHoursStatus())
						: 'Peak Hours plugin is disabled';

					await ctx.session.prompt({
						sessionID,
						text: output,
						delivery: 'steer',
						resume: false,
					});
				},
			});
		});
	},

	/** V1 fallback (OpenCode < 2.0): classic hooks + sentinel. */
	async server({ client }: V1ServerContext) {
		const config = loadConfig();
		const typedClient = client as OpencodeClient;

		async function injectRawOutput(sessionID: string, output: string): Promise<void> {
			try {
				await typedClient.session.prompt({
					path: { id: sessionID },
					body: {
						noReply: true,
						parts: [{ type: 'text', text: output, ignored: true }],
					},
				});
			} catch (err) {
				console.error('Failed to inject output:', err);
			}
		}

		async function injectCommandOutputAndHandle(sessionID: string, output?: string | null): Promise<never> {
			if (output !== undefined && output !== null) {
				await injectRawOutput(sessionID, output);
			}
			handled();
		}

		async function handlePeakHoursSlashCommand(input: CommandExecuteInput): Promise<never> {
			if (!config.enabled) {
				return await injectCommandOutputAndHandle(input.sessionID, 'Peak Hours plugin is disabled');
			}

			const status = getPeakHoursStatus();
			const output = formatPeakHoursMessage(status);
			return await injectCommandOutputAndHandle(input.sessionID, output);
		}

		return {
			// Register built-in slash commands
			config: async (input: unknown) => {
				if (!isPluginConfigInput(input)) {
					return;
				}
				input.command ??= {};
				input.command['peak_hours'] = {
					template: '/peak_hours',
					description: 'Display current z.ai peak hours status and time until next transition',
				};
			},

			// Intercept slash commands and handle them without LLM invocation
			'command.execute.before': async (input: CommandExecuteInput) => {
				try {
					const cmd = input.command;

					if (cmd === 'peak_hours') {
						return await handlePeakHoursSlashCommand(input);
					}
				} catch (err) {
					// IMPORTANT: do not swallow command-handled sentinel errors.
					// If this hook resolves, the command proceeds to the LLM.
					throw err;
				}
			},
		};
	},
};

export default plugin;
export const PeakHours = plugin;
