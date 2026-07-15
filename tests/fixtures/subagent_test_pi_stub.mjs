export async function withFileMutationQueue(_path, operation) {
	return operation();
}

export function defineTool(definition) {
	return definition;
}
