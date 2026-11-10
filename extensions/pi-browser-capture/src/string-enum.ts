import { type TUnsafe, Type } from "typebox";

// Same JSON Schema as pi-ai's StringEnum ({ type: "string", enum }), which providers
// without anyOf/const support need. Since Pi 1.5.0 the published pi-ai types return a
// pi-schema Schema, which TypeBox's Static cannot read, so build it as TUnsafe.
export function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
