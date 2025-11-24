/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKModelCapabilities, resolveModelInfo } from '../common/byokProvider';
import { SGLangEndpoint } from '../node/sglangEndpoint';
import { IBYOKStorageService } from './byokStorageService';
import { CustomOAIBYOKModelProvider, CustomOAIModelInfo } from './customOAIProvider';

/**
 * Provider for SGLang and other local OpenAI-compatible servers.
 * Uses SGLangEndpoint which properly handles max_tokens to prevent unlimited responses.
 */
export class SGLangBYOKModelProvider extends CustomOAIBYOKModelProvider {
	static override readonly providerName: string = 'SGLang';
	protected override providerName: string = SGLangBYOKModelProvider.providerName;

	constructor(
		byokStorageService: IBYOKStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExperimentationService experimentationService: IExperimentationService
	) {
		super(byokStorageService, configurationService, logService, instantiationService, experimentationService);
	}

	protected override getConfigKey() {
		return ConfigKey.SGLangModels;
	}

	async provideLanguageModelChatResponse(
		model: CustomOAIModelInfo,
		messages: (LanguageModelChatMessage | LanguageModelChatMessage2)[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<unknown> {
		const requireAPIKey = this.requiresAPIKey(model.id);
		let apiKey: string | undefined;
		if (requireAPIKey) {
			apiKey = await this._byokStorageService.getAPIKey(this.providerName, model.id);
			if (!apiKey) {
				this._logService.error(`No API key found for model ${model.id}`);
				throw new Error(`No API key found for model ${model.id}`);
			}
		}

		const modelInfo = await this.getModelInfo(model.id, apiKey, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.imageInput || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking,
			editTools: model.capabilities.editTools?.filter(t => typeof t === 'string'),
			requestHeaders: model.requestHeaders,
		});
		
		// Use SGLangEndpoint instead of OpenAIEndpoint
		const sglangEndpoint = this._instantiationService.createInstance(SGLangEndpoint, modelInfo, apiKey ?? '', model.url);
		return this._lmWrapper.provideLanguageModelResponse(sglangEndpoint, messages, options, options.requestInitiator, progress, token);
	}

	async provideTokenCount(model: CustomOAIModelInfo, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const requireAPIKey = this.requiresAPIKey(model.id);
		let apiKey: string | undefined;
		if (requireAPIKey) {
			apiKey = await this._byokStorageService.getAPIKey(this.providerName, model.id);
			if (!apiKey) {
				this._logService.error(`No API key found for model ${model.id}`);
				throw new Error(`No API key found for model ${model.id}`);
			}
		}

		const modelInfo = await this.getModelInfo(model.id, apiKey, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.imageInput || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking,
			requestHeaders: model.requestHeaders
		});
		
		// Use SGLangEndpoint instead of OpenAIEndpoint
		const sglangEndpoint = this._instantiationService.createInstance(SGLangEndpoint, modelInfo, apiKey ?? '', model.url);
		return this._lmWrapper.provideTokenCount(sglangEndpoint, text);
	}
}
