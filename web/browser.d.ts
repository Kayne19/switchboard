interface TranscriptEntry {
	role: string;
	text: string;
	id?: string;
	route?: string;
	ts?: number;
	pending?: boolean;
}

interface BrowserMessage {
	type?: string;
	id?: string;
	source?: string;
	title?: string;
	notes?: string;
	text?: string;
	message?: string;
	route?: string;
	label?: string;
	model?: string;
	model_name?: string;
	thinking?: string;
	thinking_default?: string;
	thinking_confirmed?: boolean;
	model_swaps?: boolean;
	models_available?: boolean;
	models_diagnostic?: string;
	projects?: string[];
	levels?: string[];
	models?: Array<{ provider: string; model: string; thinks: boolean }>;
	entries?: TranscriptEntry[];
	entry?: TranscriptEntry;
	waiting?: number;
	steered?: boolean;
	generation?: number;
	[key: string]: unknown;
}

interface Window {
	renderDiagram?: (message: BrowserMessage) => Promise<void>;
}
