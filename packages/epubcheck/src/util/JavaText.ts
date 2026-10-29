// Java's String.trim, which strips every character up to U+0020 but not NBSP.
export const trim = (value: string) => value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
