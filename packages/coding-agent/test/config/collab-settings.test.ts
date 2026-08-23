import { expect, test } from "bun:test";
import { getDefault, getEnumValues } from "../../src/config/settings-schema";

test("automatic collaboration settings default to backward-compatible off", () => {
	expect(getDefault("collab.autoStart")).toBe("off");
	expect(getEnumValues("collab.autoStart")).toEqual(["off", "view", "control"]);
	expect(getDefault("collab.registryEndpoint")).toBe("auto");
});
