export const DATA_POLICY = "Conversation text and tool data go to the configured worker providers. Thinking is omitted. Recognizable credentials are redacted (best effort). Worker sessions persist locally. Use /om off to stop capture.";

export function redactCredentials(text: string): string {
	return text
		.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|authorization)(?:["']?)\s*[:=]\s*["']?)([^\s"',}\n&]+)/gi, "$1[REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function redactPayload(value: unknown): unknown {
	if (typeof value === "string") return redactCredentials(value);
	if (Array.isArray(value)) return value.map(redactPayload);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
			/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|authorization)$/i.test(key)
				? "[REDACTED]" : redactPayload(item),
		]));
	}
	return value;
}
