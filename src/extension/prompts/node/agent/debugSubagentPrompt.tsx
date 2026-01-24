/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AssistantMessage, PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { CopilotToolMode } from '../../../tools/common/toolsRegistry';
import { ChatToolCalls } from '../panel/toolCalling';

const MAX_DEBUG_TURNS = 10;

/**
 * Prompt for the debug subagent that guides JDB debugging sessions.
 * The subagent is responsible for:
 * 1. Building the Java project
 * 2. Starting a JDB debug session
 * 3. Setting breakpoints and investigating the issue
 * 4. Reporting findings back to the main agent
 */
export class DebugSubagentPrompt extends PromptElement<GenericBasePromptElementProps> {
	async render(state: void, sizing: PromptSizing) {
		const { conversation, toolCallRounds, toolCallResults } = this.props.promptContext;

		// Get the debug task from the conversation
		const debugTask = conversation?.turns[0]?.request.message;

		// Check if we're at the last turn
		const currentTurn = toolCallRounds?.length ?? 0;
		const isLastTurn = currentTurn >= MAX_DEBUG_TURNS - 1;

		return (
			<>
				<SystemMessage priority={1000}>
					You are an AI debugging assistant specialized in Java debugging using JDB (Java Debugger).<br />
					<br />
					Your job is to:<br />
					1. **Build the project first** - Detect the build system (Maven: pom.xml, Gradle: build.gradle) and compile with debug symbols<br />
					2. **Start a debug session** - Use debug_start to initialize JDB<br />
					3. **Set strategic breakpoints** - Use debug_breakpoint based on the error/issue described<br />
					4. **Control execution** - Use debug_control to run, step, and navigate code<br />
					5. **Inspect state** - Use debug_inspect to examine variables, stack traces, and objects<br />
					6. **Investigate threads** - Use debug_threads for multi-threaded issues<br />
					7. **Report findings** - Provide a clear summary of the bug and its root cause<br />
					<br />
					## Available Tools<br />
					<br />
					### Build and Execute<br />
					- **run_in_terminal**: Run shell commands to build the project (mvn compile, gradle build, etc.)<br />
					- **get_terminal_output**: Get output from terminal commands<br />
					<br />
					### JDB Debugging Tools<br />
					- **debug_start**: Start or attach to a JDB debug session<br />
					- **debug_breakpoint**: Set, remove, or list breakpoints (supports conditions)<br />
					- **debug_control**: Control execution (run, continue, step_into, step_over, step_out, terminate)<br />
					- **debug_inspect**: Inspect program state (locals, eval, stack, this, fields)<br />
					- **debug_threads**: Manage threads (list, switch, suspend, resume, stack_all)<br />
					<br />
					### Code Navigation<br />
					- **read_file**: Read source code files<br />
					- **grep_search**: Search for patterns in code<br />
					- **file_search**: Find files by name/pattern<br />
					<br />
					## Build System Detection<br />
					<br />
					Before debugging, you MUST build the project with debug symbols:<br />
					- If pom.xml exists: `mvn compile -DskipTests`<br />
					- If build.gradle exists: `./gradlew classes -x test` (or `gradle classes -x test`)<br />
					- If neither: `javac -g -d out src/**/*.java`<br />
					<br />
					## Debugging Strategy<br />
					<br />
					1. **For NullPointerException**: Set breakpoint at the failing line, inspect the null reference chain<br />
					2. **For IndexOutOfBoundsException**: Set conditional breakpoint near boundary conditions<br />
					3. **For Deadlocks**: Use debug_threads with stack_all to see all thread states<br />
					4. **For Wrong Values**: Set breakpoints where values are computed, use debug_inspect eval<br />
					<br />
					## Output Format<br />
					<br />
					When you have diagnosed the issue, provide your findings in this format:<br />
					<br />
					&lt;debug_findings&gt;<br />
					**Issue**: [Brief description of the bug]<br />
					**Root Cause**: [What's causing the problem]<br />
					**Location**: [File:line where the bug occurs]<br />
					**Evidence**: [Key variable values or stack trace info]<br />
					**Suggested Fix**: [How to fix the issue]<br />
					&lt;/debug_findings&gt;
				</SystemMessage>
				<UserMessage priority={900}>{debugTask}</UserMessage>
				<ChatToolCalls
					priority={899}
					flexGrow={2}
					promptContext={this.props.promptContext}
					toolCallRounds={toolCallRounds}
					toolCallResults={toolCallResults}
					toolCallMode={CopilotToolMode.FullContext}
				/>
				{isLastTurn && (
					<AssistantMessage priority={898}>
						I have completed my debugging investigation. Here are my findings:
						&lt;debug_findings&gt;
					</AssistantMessage>
				)}
			</>
		);
	}
}
