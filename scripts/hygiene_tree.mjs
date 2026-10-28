// What every concern module reads a tree with. It imports nothing from
// check_hygiene.mjs, which runs the scan when it loads.
export const lines = (ctx, file) => ctx.read(file).split("\n");
export function scan(ctx, file, pattern, finding) {
	lines(ctx, file).forEach((line, index) => {
		if (pattern.test(line)) ctx.report(`${file}:${index + 1}: ${finding}`);
	});
}
