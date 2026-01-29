/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';

export interface IJdbSession {
	sessionId: string;
	process: ChildProcess;
	status: 'starting' | 'ready' | 'running' | 'suspended' | 'terminated';
	outputBuffer: string;
	lastCommand?: string;
	lastOutput?: string;
}

// Global JDB session storage
const sessions = new Map<string, IJdbSession>();

/**
 * Start a new JDB session (launch mode)
 */
export async function startJdbSession(
	sessionId: string,
	mainClass: string,
	classpath?: string,
	workingDir?: string
): Promise<{ success: boolean; output: string; error?: string }> {
	
	// Build JDB command
	const args: string[] = [];
	if (classpath) {
		args.push('-classpath', classpath);
	}
	args.push(mainClass);

	console.log(`[JdbSession] Starting JDB: jdb ${args.join(' ')}`);

	return launchJdbProcess(sessionId, args, workingDir);
}

/**
 * Attach JDB to a running JVM (attach mode)
 * The target JVM must be started with: -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=<port>
 */
export async function attachJdbSession(
	sessionId: string,
	port: number,
	host: string = 'localhost',
	workingDir?: string
): Promise<{ success: boolean; output: string; error?: string }> {
	
	// Build JDB attach command
	const args: string[] = ['-attach', `${host}:${port}`];

	console.log(`[JdbSession] Attaching JDB to ${host}:${port}`);

	return launchJdbProcess(sessionId, args, workingDir);
}

/**
 * Internal helper to launch JDB process
 */
async function launchJdbProcess(
	sessionId: string,
	args: string[],
	workingDir?: string
): Promise<{ success: boolean; output: string; error?: string }> {
	return new Promise((resolve) => {
		try {
			const proc = spawn('jdb', args, {
				cwd: workingDir || process.cwd(),
				shell: true,
			});

			const session: IJdbSession = {
				sessionId,
				process: proc,
				status: 'starting',
				outputBuffer: '',
			};
			sessions.set(sessionId, session);

			let initialOutput = '';
			let resolved = false;

			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					session.status = 'ready';
					resolve({ 
						success: true, 
						output: initialOutput || 'JDB started (waiting for input)' 
					});
				}
			}, 5000); // Longer timeout for attach mode

			proc.stdout?.on('data', (data: Buffer) => {
				const text = data.toString();
				session.outputBuffer += text;
				initialOutput += text;
				console.log(`[JdbSession] stdout: ${text}`);
				
				// JDB is ready when we see the prompt or "Set uncaught"
				if ((text.includes('>') || text.includes('Set uncaught') || text.includes('VM Started')) && !resolved) {
					resolved = true;
					clearTimeout(timeout);
					session.status = 'ready';
					resolve({ success: true, output: initialOutput });
				}
			});

			proc.stderr?.on('data', (data: Buffer) => {
				const text = data.toString();
				console.log(`[JdbSession] stderr: ${text}`);
				initialOutput += text;
				
				// Check for connection errors
				if (text.includes('Unable to attach') || text.includes('Connection refused')) {
					if (!resolved) {
						resolved = true;
						clearTimeout(timeout);
						session.status = 'terminated';
						resolve({ success: false, output: initialOutput, error: 'Failed to attach - is the target JVM running with debug agent?' });
					}
				}
			});

			proc.on('error', (err) => {
				console.error(`[JdbSession] Process error:`, err);
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					session.status = 'terminated';
					resolve({ success: false, output: '', error: err.message });
				}
			});

			proc.on('close', (code) => {
				console.log(`[JdbSession] Process closed with code ${code}`);
				session.status = 'terminated';
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					resolve({ 
						success: code === 0, 
						output: initialOutput,
						error: code !== 0 ? `JDB exited with code ${code}` : undefined
					});
				}
			});

		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			resolve({ success: false, output: '', error });
		}
	});
}

/**
 * Send a command to JDB and get the response
 */
export async function sendJdbCommand(
	sessionId: string,
	command: string,
	timeoutMs: number = 5000
): Promise<{ success: boolean; output: string; error?: string }> {
	
	const session = sessions.get(sessionId);
	if (!session) {
		return { success: false, output: '', error: `Session ${sessionId} not found` };
	}

	if (session.status === 'terminated') {
		return { success: false, output: '', error: 'JDB session has terminated' };
	}

	console.log(`[JdbSession] Sending command: ${command}`);
	session.lastCommand = command;

	return new Promise((resolve) => {
		// Clear the buffer before sending command
		const bufferBefore = session.outputBuffer.length;
		
		// Send the command
		session.process.stdin?.write(command + '\n');

		let resolved = false;
		const startTime = Date.now();

		const checkOutput = () => {
			if (resolved) return;
			
			const newOutput = session.outputBuffer.slice(bufferBefore);
			
			// Check if we have a complete response (ends with prompt)
			if (newOutput.includes('\n>') || newOutput.includes('\nmain[')) {
				resolved = true;
				session.lastOutput = newOutput.trim();
				resolve({ success: true, output: session.lastOutput });
				return;
			}

			// Check timeout
			if (Date.now() - startTime > timeoutMs) {
				resolved = true;
				session.lastOutput = newOutput.trim() || '(no output within timeout)';
				resolve({ success: true, output: session.lastOutput });
				return;
			}

			// Keep checking
			setTimeout(checkOutput, 100);
		};

		// Start checking for output
		setTimeout(checkOutput, 100);
	});
}

/**
 * Get an existing JDB session
 */
export function getJdbSession(sessionId: string): IJdbSession | undefined {
	return sessions.get(sessionId);
}

/**
 * Get the active JDB session (most recent)
 * Also checks if the process is still alive and cleans up dead sessions
 */
export function getActiveJdbSession(): IJdbSession | undefined {
	let latest: IJdbSession | undefined;
	const deadSessions: string[] = [];
	
	for (const [sessionId, session] of sessions.entries()) {
		if (session.status !== 'terminated') {
			// Check if process is actually still alive
			if (session.process.killed || session.process.exitCode !== null) {
				// Process died but status wasn't updated
				session.status = 'terminated';
				deadSessions.push(sessionId);
				console.log(`[JdbSession] Cleaning up dead session ${sessionId}`);
			} else {
				latest = session;
			}
		}
	}
	
	return latest;
}

/**
 * Terminate a JDB session
 */
export function terminateJdbSession(sessionId: string): boolean {
	const session = sessions.get(sessionId);
	if (!session) {
		return false;
	}

	try {
		session.process.stdin?.write('quit\n');
		session.process.kill();
		session.status = 'terminated';
		return true;
	} catch {
		return false;
	}
}

/**
 * Clear all sessions
 */
export function clearAllSessions(): void {
	for (const session of sessions.values()) {
		try {
			session.process.kill();
		} catch {
			// ignore
		}
	}
	sessions.clear();
}
