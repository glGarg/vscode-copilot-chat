/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AssistantMessage, PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { CopilotToolMode } from '../../../tools/common/toolsRegistry';
import { ChatToolCalls } from '../panel/toolCalling';

const MAX_DEBUG_TURNS = 35;

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
					**CRITICAL**: You MUST call debug_start to start a JDB session. Do NOT just analyze code - you must actually run the debugger!<br />
					<br />
					**CRITICAL**: You MUST report your findings using the &lt;debug_findings&gt; tag when you have completed your investigation. Always produce a &lt;debug_findings&gt; response with your conclusions.<br />
					<br />
					Your workflow should be:<br />
					1. **Build the project** - Detect the build system and compile with debug symbols<br />
					2. **Create a test if needed** - If no test exists, create a simple main class to reproduce the issue<br />
					3. **Start a debug session** - Use debug_start to initialize JDB (MANDATORY!)<br />
					4. **Set breakpoints** - Use debug_breakpoint at suspicious locations<br />
					5. **Run and step** - Use debug_control to execute and navigate code<br />
					6. **Inspect state** - Use debug_inspect to examine variables and stack<br />
					7. **Report findings** - Summarize the bug and root cause<br />
					<br />
					## JDB Debugging Tools<br />
					<br />
					- **debug_start**: Start a JDB session. Call with mode="launch" and mainClass="com.example.Main"<br />
					- **debug_breakpoint**: Set breakpoints. Call with action="set" and location="ClassName:lineNumber"<br />
					- **debug_control**: Control execution. Actions: run, continue, step_into, step_over, step_out<br />
					- **debug_inspect**: Inspect state. Actions: locals, eval, stack, this, fields<br />
					- **debug_threads**: Thread management. Actions: list, switch, suspend, resume, stack_all<br />
					<br />
					## Build Commands<br />
					<br />
					Before debugging, build with debug symbols using run_in_terminal:<br />
					- Maven: `mvn compile -DskipTests`<br />
					- Gradle: `./gradlew classes -x test` or `./gradlew compileJava compileTestJava`<br />
					- Javac: `javac -g -d out src/**/*.java`<br />
					<br />
					## Creating Test Cases<br />
					<br />
					If no test file exists, create a simple main class to reproduce the issue. For example:<br />
					```java<br />
					public class DebugMain {'{'}<br />
					{'    '}public static void main(String[] args) {'{'}<br />
					{'        '}// Code to reproduce the issue<br />
					{'    '}{'}'}<br />
					{'}'}<br />
					```<br />
					Then use debug_start with mainClass="DebugMain".<br />
					<br />
					## Output Format (REQUIRED)<br />
					<br />
					You must always end your investigation with a &lt;debug_findings&gt; response:<br />
					<br />
					&lt;debug_findings&gt;<br />
					**Issue**: [Brief description]<br />
					**Root Cause**: [What's causing the problem]<br />
					**Location**: [File:line]<br />
					**Evidence**: [Variable values observed during debugging]<br />
					**Suggested Fix**: [How to fix]<br />
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
