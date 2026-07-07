import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { TelegramExtensionNoticeType } from "./telegram-ui-context.js";

export interface ProviderResponseNoticeEvent {
	status: number;
	headers: Record<string, string>;
}

export interface ProviderResponseNotice {
	message: string;
	type: TelegramExtensionNoticeType;
}

export function getProviderResponseNotice(
	event: ProviderResponseNoticeEvent,
): ProviderResponseNotice | undefined {
	if (event.status >= 200 && event.status < 300) {
		return undefined;
	}

	const headers = normalizeHeaders(event.headers);
	const warning = formatWarningHeader(headers.warning);
	const retryAfter = formatRetryAfter(headers["retry-after"]);
	const requestId = firstHeader(headers, [
		"request-id",
		"x-request-id",
		"anthropic-request-id",
		"openai-request-id",
	]);

	if (event.status === 401 || event.status === 403) {
		// Auth/access failures need operator action; surfacing Retry-After here would
		// imply a transient backoff signal when the credentials or permissions are the issue.
		return {
			message: joinSentences(
				`Provider authentication failed (HTTP ${event.status}). Check API credentials or provider access.`,
				warning ? `Provider warning: ${warning}.` : undefined,
				requestId ? `Request ID: ${requestId}.` : undefined,
			),
			type: "error",
		};
	}

	if (event.status === 429) {
		return {
			message: joinSentences(
				"Provider rate limit reached (HTTP 429). Please retry shortly.",
				retryAfter ? `Retry after ${retryAfter}.` : undefined,
				warning ? `Provider warning: ${warning}.` : undefined,
				requestId ? `Request ID: ${requestId}.` : undefined,
			),
			type: "warning",
		};
	}

	if (event.status === 408 || event.status >= 500) {
		return {
			message: joinSentences(
				`Provider appears unavailable or degraded (HTTP ${event.status}). Please retry later.`,
				retryAfter ? `Retry after ${retryAfter}.` : undefined,
				warning ? `Provider warning: ${warning}.` : undefined,
				requestId ? `Request ID: ${requestId}.` : undefined,
			),
			type: "warning",
		};
	}

	if (warning || retryAfter) {
		return {
			message: joinSentences(
				`Provider reported an issue (HTTP ${event.status}).`,
				retryAfter ? `Retry after ${retryAfter}.` : undefined,
				warning ? `Provider warning: ${warning}.` : undefined,
				requestId ? `Request ID: ${requestId}.` : undefined,
			),
			type: "warning",
		};
	}

	return undefined;
}

export function createProviderResponseNoticeExtension(): ExtensionFactory {
	return (pi) => {
		pi.on("after_provider_response", (event, ctx) => {
			const notice = getProviderResponseNotice({
				status: event.status,
				headers: event.headers,
			});
			if (!notice) {
				return;
			}

			// If the SDK/client ever starts retrying provider calls internally, this hook
			// will fire for each attempted response. Keep any future dedupe at this edge so
			// getProviderResponseNotice stays a pure mapper for direct unit coverage.
			ctx.ui.notify(notice.message, notice.type);
		});
	};
}

function normalizeHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers)
			.map(([name, value]) => [name.toLowerCase(), value.trim()])
			.filter((entry) => entry[1].length > 0),
	);
}

function firstHeader(
	headers: Record<string, string>,
	names: string[],
): string | undefined {
	for (const name of names) {
		const value = headers[name];
		if (value) {
			return value;
		}
	}

	return undefined;
}

function formatRetryAfter(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	if (/^\d+$/.test(value)) {
		const seconds = Number.parseInt(value, 10);
		return `${seconds} second${seconds === 1 ? "" : "s"}`;
	}

	return value;
}

function formatWarningHeader(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const quotedMessage = value.match(/"([^"]+)"/);
	const trimmed = (quotedMessage?.[1] ?? value)
		.replace(/^\d{3}\s+/u, "")
		.replace(/^"|"$/gu, "")
		.trim();

	return trimmed || undefined;
}

function joinSentences(...parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => Boolean(part)).join(" ");
}
