import { CollabRegistryPublisher } from "../../src/collab/registry-publisher";

const endpoint = process.env.OMP_GATEWAY_TEST_ENDPOINT;
if (!endpoint) throw new Error("OMP_GATEWAY_TEST_ENDPOINT is required");

const generation = 1;
const publisher = new CollabRegistryPublisher({
	instanceId: "publisher-explicit-token-instance",
	pid: process.pid,
	endpointSetting: endpoint,
	onSecurityError(message) {
		throw new Error(message);
	},
});

publisher.publish({
	instanceId: "publisher-explicit-token-instance",
	generation,
	pid: process.pid,
	sessionId: "publisher-explicit-token-session",
	startedAt: "2026-07-21T00:00:00.000Z",
	inputRequired: false,
	viewLink: "VIEW_CAPABILITY_FIXTURE",
	controlLink: "CONTROL_CAPABILITY_FIXTURE",
});

const shutdown = () => {
	publisher.shutdown(generation);
	process.exit();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise(() => {});
