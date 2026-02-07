/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';

export interface IPdbSession {
	sessionId: string;
	process: ChildProcess;
	status: 'starting' | 'ready' | 'running' | 'suspended' | 'terminated';
	outputBuffer: string;
	lastCommand?: string;
	lastOutput?: string;
}

// Global PDB session storage
const sessions = new Map<string, IPdbSession>();

/**
 * Start a new PDB session to debug a Python script.
 * For regular scripts, uses: python -m pdb script.py [args]
 */
export async function startPdbSession(
	sessionId: string,
	script: string,
	args: string[] = [],
	workingDir?: string
): Promise<{ success: boolean; output: string; error?: string }> {

	// Build PDB command: python -m pdb script.py [args]
	const pythonArgs: string[] = ['-m', 'pdb', script, ...args];

	console.log(`[PdbSession] Starting PDB (script mode): python ${pythonArgs.join(' ')}`);

	return launchPdbProcess(sessionId, pythonArgs, workingDir);
}

/**
 * Start a pytest session with PDB debugging.
 * Uses: pytest --pdb -s testFile [testSelector]
 */
export async function startPytestPdbSession(
	sessionId: string,
	testFile: string,
	testName?: string,
	workingDir?: string
): Promise<{ success: boolean; output: string; error?: string }> {

	// Build pytest command with --pdb
	// pytest --pdb -s tests/test_example.py::test_func
	const testTarget = testName ? `${testFile}::${testName}` : testFile;
	
	const pytestArgs: string[] = [
		'-m', 'pytest',
		'--pdb',              // Drop into PDB on failure
		'-s',                 // Don't capture stdout (allows PDB interaction)
		'--tb=short',         // Short traceback format
		testTarget
	];

	console.log(`[PdbSession] Starting pytest with PDB: python ${pytestArgs.join(' ')}`);

	return launchPdbProcess(sessionId, pytestArgs, workingDir);
}

/**
 * Internal helper to launch PDB process
 */
async function launchPdbProcess(
	sessionId: string,
	args: string[],
	workingDir?: string
): Promise<{ success: boolean; output: string; error?: string }> {
	return new Promise((resolve) => {
		try {
			const proc = spawn('python', args, {
				cwd: workingDir || process.cwd(),
				shell: false,
				env: {
					...process.env,
					// Ensure Python doesn't buffer output
					PYTHONUNBUFFERED: '1',
				},
			});

			const session: IPdbSession = {
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
						output: initialOutput || 'PDB started (waiting for input)'
					});
				}
			}, 5000);

			proc.stdout?.on('data', (data: Buffer) => {
				const text = data.toString();
				session.outputBuffer += text;
				initialOutput += text;
				console.log(`[PdbSession] stdout: ${text}`);

				// PDB is ready when we see the prompt "(Pdb)" or "-> " (source line indicator)
				if ((text.includes('(Pdb)') || text.includes('-> ')) && !resolved) {
					resolved = true;
					clearTimeout(timeout);
					session.status = 'ready';
					resolve({ success: true, output: initialOutput });
				}
			});

			proc.stderr?.on('data', (data: Buffer) => {
				const text = data.toString();
				console.log(`[PdbSession] stderr: ${text}`);
				initialOutput += text;

				// Check for common errors
				if (text.includes('No module named') || text.includes('can\'t find \'__main__\'')) {
					if (!resolved) {
						resolved = true;
						clearTimeout(timeout);
						session.status = 'terminated';
						resolve({ success: false, output: initialOutput, error: 'Module or script not found' });
					}
				}
				if (text.includes('SyntaxError') || text.includes('IndentationError')) {
					if (!resolved) {
						resolved = true;
						clearTimeout(timeout);
						session.status = 'terminated';
						resolve({ success: false, output: initialOutput, error: 'Python syntax error in target' });
					}
				}
			});

			proc.on('error', (err) => {
				console.error(`[PdbSession] Process error:`, err);
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					session.status = 'terminated';
					resolve({ success: false, output: '', error: err.message });
				}
			});

			proc.on('close', (code) => {
				console.log(`[PdbSession] Process closed with code ${code}`);
				session.status = 'terminated';
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					resolve({
						success: code === 0,
						output: initialOutput,
						error: code !== 0 ? `PDB exited with code ${code}` : undefined
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
 * Send a command to PDB and get the response
 */
export async function sendPdbCommand(
	sessionId: string,
	command: string,
	timeoutMs: number = 5000
): Promise<{ success: boolean; output: string; error?: string }> {

	const session = sessions.get(sessionId);
	if (!session) {
		return { success: false, output: '', error: `Session ${sessionId} not found` };
	}

	if (session.status === 'terminated') {
		return { success: false, output: '', error: 'PDB session has terminated' };
	}

	console.log(`[PdbSession] Sending command: ${command}`);
	session.lastCommand = command;

	return new Promise((resolve) => {
		// Clear the buffer before sending command
		const bufferBefore = session.outputBuffer.length;

		// Send the command
		session.process.stdin?.write(command + '\n');

		let resolved = false;
		const startTime = Date.now();

		const checkOutput = () => {
			if (resolved) {
				return;
			}

			const newOutput = session.outputBuffer.slice(bufferBefore);

			// Check if we have a complete response (ends with PDB prompt)
			// PDB prompts: "(Pdb) " or "(Pdb++) " (for pdb++) or "ipdb> " (for ipdb)
			if (newOutput.includes('\n(Pdb)') || newOutput.match(/\n\(Pdb\+*\)\s*$/) || newOutput.includes('\nipdb>')) {
				resolved = true;
				session.lastOutput = newOutput.trim();
				resolve({ success: true, output: session.lastOutput });
				return;
			}

			// Also check for program completion
			if (newOutput.includes('The program finished') || newOutput.includes('--Return--') || newOutput.includes('--Call--')) {
				// Wait a bit more to capture the prompt
				setTimeout(() => {
					if (!resolved) {
						resolved = true;
						session.lastOutput = session.outputBuffer.slice(bufferBefore).trim();
						resolve({ success: true, output: session.lastOutput });
					}
				}, 200);
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
 * Get an existing PDB session
 */
export function getPdbSession(sessionId: string): IPdbSession | undefined {
	return sessions.get(sessionId);
}

/**
 * Get the active PDB session (most recent)
 * Also checks if the process is still alive and cleans up dead sessions
 */
export function getActivePdbSession(): IPdbSession | undefined {
	let latest: IPdbSession | undefined;
	const deadSessions: string[] = [];

	for (const [sessionId, session] of sessions.entries()) {
		if (session.status !== 'terminated') {
			// Check if process is actually still alive
			if (session.process.killed || session.process.exitCode !== null) {
				// Process died but status wasn't updated
				session.status = 'terminated';
				deadSessions.push(sessionId);
				console.log(`[PdbSession] Cleaning up dead session ${sessionId}`);
			} else {
				latest = session;
			}
		}
	}

	return latest;
}

/**
 * Terminate a PDB session
 */
export function terminatePdbSession(sessionId: string): boolean {
	const session = sessions.get(sessionId);
	if (!session) {
		return false;
	}

	try {
		// Send quit command first for graceful shutdown
		session.process.stdin?.write('q\n');
		// Then force kill after a short delay
		setTimeout(() => {
			try {
				session.process.kill();
			} catch {
				// Ignore if already dead
			}
		}, 500);
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

/**
 * Parse PDB output to extract useful information
 */
export function parsePdbOutput(output: string): {
	currentFile?: string;
	currentLine?: number;
	currentFunction?: string;
	sourceLine?: string;
	variables?: Record<string, string>;
	isAtBreakpoint?: boolean;
	isException?: boolean;
	exceptionType?: string;
	exceptionMessage?: string;
} {
	const result: ReturnType<typeof parsePdbOutput> = {};

	// Parse location: "> /path/to/file.py(123)function_name()"
	const locationMatch = output.match(/>\s*(.+?)\((\d+)\)([^(]*)\(\)/);
	if (locationMatch) {
		result.currentFile = locationMatch[1];
		result.currentLine = parseInt(locationMatch[2], 10);
		result.currentFunction = locationMatch[3] || '<module>';
	}

	// Parse source line: "-> source code here"
	const sourceMatch = output.match(/->\s*(.+)/);
	if (sourceMatch) {
		result.sourceLine = sourceMatch[1].trim();
	}

	// Check for breakpoint hit
	if (output.includes('Breakpoint') && output.includes('at')) {
		result.isAtBreakpoint = true;
	}

	// Check for exception
	if (output.includes('Exception') || output.includes('Error:') || output.includes('Traceback')) {
		result.isException = true;
		const exMatch = output.match(/(\w+Error|\w+Exception):\s*(.+)/);
		if (exMatch) {
			result.exceptionType = exMatch[1];
			result.exceptionMessage = exMatch[2];
		}
	}

	return result;
}
