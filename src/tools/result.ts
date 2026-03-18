export interface AgentToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}

export function jsonResult(payload: unknown): AgentToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}
