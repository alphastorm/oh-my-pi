/**
 * Arktype schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (allows extra keys) so providers can attach extra
 * keys without rejection; only `input` is required.
 */
import { type } from "@oh-my-pi/omptype";

const HASHLINE_INPUT_DESCRIPTION =
	"Hashline edit payload. First nonblank line: [PATH#TAG], where TAG is the latest 4-hex snapshot from read/search; repeat sections for multiple files." +
	"\nOptional envelope: *** Begin Patch before the first section and *** End Patch after the last." +
	"\nOperations: PUT N.=M: plus +TEXT body rows replaces lines; PUT <N: / PUT >N: inserts; CUT N.=M deletes; PUT N*: / CUT N* targets a syntactic block; REM deletes the file; MV DEST moves it." +
	"\nExample:\n[src/app.ts#A1B2]\nPUT 2.=2:\n+const ready = true;" +
	"\nAn envelope containing *** Add File:, *** Update File:, or *** Delete File: is parsed as apply_patch.";

export const hashlineEditParamsSchema = type({
	input: type("string").describe(HASHLINE_INPUT_DESCRIPTION),
});

export type HashlineParams = typeof hashlineEditParamsSchema.infer;
