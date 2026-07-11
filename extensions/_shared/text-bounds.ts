export function truncateUtf8Head(text: string, maxBytes: number, label = "output"): string {
	const source = Buffer.from(text, "utf8");
	if (source.length <= maxBytes) return text;
	const markerTemplate = (omitted: number) => Buffer.from(`\n[${label} truncated: ${omitted} bytes omitted]`, "utf8");
	let keepBytes = maxBytes;
	while (true) {
		let head = source.subarray(0, keepBytes).toString("utf8");
		while (Buffer.byteLength(head, "utf8") > keepBytes) head = head.slice(0, -1);
		const headBytes = Buffer.byteLength(head, "utf8");
		const marker = markerTemplate(source.length - headBytes);
		if (headBytes + marker.length <= maxBytes) return `${head}${marker.toString("utf8")}`;
		const nextKeepBytes = Math.max(0, maxBytes - marker.length);
		if (nextKeepBytes === keepBytes) return marker.subarray(0, maxBytes).toString("utf8");
		keepBytes = nextKeepBytes;
	}
}
