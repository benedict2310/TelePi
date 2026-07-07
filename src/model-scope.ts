import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ModelRegistry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";

export interface ScopedModelOption {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

export async function resolveScopedModels(
	settingsManager: SettingsManager,
	modelRegistry: ModelRegistry,
): Promise<ScopedModelOption[]> {
	const patterns = settingsManager.getEnabledModels();
	if (!patterns || patterns.length === 0) {
		return [];
	}

	const availableModels = await modelRegistry.getAvailable();
	const scopedModels: ScopedModelOption[] = [];

	for (const rawPattern of patterns) {
		const pattern = rawPattern.trim();
		if (!pattern) {
			continue;
		}

		if (hasGlob(pattern)) {
			const { modelPattern, thinkingLevel } = splitThinkingLevel(pattern);
			const matches = availableModels.filter((model) =>
				matchesPattern(modelPattern, model),
			);
			if (matches.length === 0) {
				console.warn(`Warning: No models match pattern "${pattern}"`);
				continue;
			}

			for (const model of matches) {
				addUniqueScopedModel(scopedModels, model, thinkingLevel);
			}
			continue;
		}

		const { modelPattern, thinkingLevel } = splitThinkingLevel(pattern);
		const model = findModel(modelPattern, availableModels);
		if (!model) {
			console.warn(`Warning: No models match pattern "${pattern}"`);
			continue;
		}

		addUniqueScopedModel(scopedModels, model, thinkingLevel);
	}

	return scopedModels;
}

export function resolveInitialScopedModelSelection(options: {
	configuredModel: Model<Api> | undefined;
	scopedModels: ScopedModelOption[];
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	hasExistingSession: boolean;
}): { model: Model<Api> | undefined; thinkingLevel?: ThinkingLevel } {
	const {
		configuredModel,
		scopedModels,
		settingsManager,
		modelRegistry,
		hasExistingSession,
	} = options;

	if (configuredModel || hasExistingSession || scopedModels.length === 0) {
		return { model: configuredModel, thinkingLevel: undefined };
	}

	const defaultProvider = settingsManager.getDefaultProvider();
	const defaultModelId = settingsManager.getDefaultModel();
	const defaultModel =
		defaultProvider && defaultModelId
			? modelRegistry.find(defaultProvider, defaultModelId)
			: undefined;

	const selectedScopedModel = defaultModel
		? scopedModels.find(
				(scoped) =>
					scoped.model.provider === defaultModel.provider &&
					scoped.model.id === defaultModel.id,
			)
		: undefined;
	const fallbackScopedModel = selectedScopedModel ?? scopedModels[0];

	return {
		model: fallbackScopedModel?.model,
		thinkingLevel: fallbackScopedModel?.thinkingLevel,
	};
}

function hasGlob(pattern: string): boolean {
	return (
		pattern.includes("*") || pattern.includes("?") || pattern.includes("[")
	);
}

function splitThinkingLevel(pattern: string): {
	modelPattern: string;
	thinkingLevel?: ThinkingLevel;
} {
	const colonIndex = pattern.lastIndexOf(":");
	if (colonIndex === -1) {
		return { modelPattern: pattern };
	}

	const suffix = pattern.slice(colonIndex + 1).trim();
	if (!THINKING_LEVELS.has(suffix as ThinkingLevel)) {
		return { modelPattern: pattern };
	}

	return {
		modelPattern: pattern.slice(0, colonIndex),
		thinkingLevel: suffix as ThinkingLevel,
	};
}

function matchesPattern(pattern: string, model: Model<Api>): boolean {
	const fullId = `${model.provider}/${model.id}`;
	return (
		minimatch(fullId, pattern, { nocase: true }) ||
		minimatch(model.id, pattern, { nocase: true })
	);
}

function findModel(
	pattern: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const normalized = pattern.toLowerCase();
	const exactCanonical = availableModels.find(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
	);
	if (exactCanonical) {
		return exactCanonical;
	}

	const exactIdMatches = availableModels.filter(
		(model) => model.id.toLowerCase() === normalized,
	);
	if (exactIdMatches.length === 1) {
		return exactIdMatches[0];
	}
	if (exactIdMatches.length > 1) {
		return undefined;
	}

	const partialMatches = availableModels.filter(
		(model) =>
			model.id.toLowerCase().includes(normalized) ||
			model.name?.toLowerCase().includes(normalized),
	);
	if (partialMatches.length === 0) {
		return undefined;
	}

	const aliases = partialMatches.filter((model) => isAlias(model.id));
	const candidates = aliases.length > 0 ? aliases : partialMatches;
	return [...candidates].sort((left, right) =>
		right.id.localeCompare(left.id),
	)[0];
}

function addUniqueScopedModel(
	scopedModels: ScopedModelOption[],
	model: Model<Api>,
	thinkingLevel?: ThinkingLevel,
): void {
	const exists = scopedModels.some(
		(scoped) =>
			scoped.model.provider === model.provider && scoped.model.id === model.id,
	);
	if (!exists) {
		scopedModels.push({ model, thinkingLevel });
	}
}

function isAlias(modelId: string): boolean {
	if (modelId.endsWith("-latest")) {
		return true;
	}
	return !/-\d{8}$/.test(modelId);
}
