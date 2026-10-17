import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { fakeDeployment } from "../../../../test/fake-deployment";

const runDir = process.env.VERIFY_RUN;
if (runDir === undefined || runDir === "") {
	process.stderr.write("VERIFY_RUN is not set\n");
	process.exit(1);
}

const orgName = "Hope Shelter";
const deployment = fakeDeployment({ host: "give.example.org", name: orgName });
const logPath = `${runDir}/deployment.ndjson`;

const server = createServer(
	{
		key: readFileSync(`${runDir}/server.key`),
		cert: readFileSync(`${runDir}/server.crt`),
	},
	(req, res) => {
		handle(req, res).catch(() => {
			if (res.headersSent) return;
			res.writeHead(500);
			res.end();
		});
	},
);

async function handle(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const body = Buffer.concat(chunks);
	const host = req.headers.host ?? "give.example.org";
	const url = `https://${host}${req.url ?? "/"}`;
	const headers = new Headers();
	for (const name of [
		"content-type",
		"authorization",
		"accept",
		"idempotency-key",
	]) {
		const value = req.headers[name];
		if (typeof value === "string") headers.set(name, value);
	}
	const method = req.method ?? "GET";
	const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
	const response = await deployment.handle(
		new Request(url, {
			method,
			headers,
			body: hasBody ? body : undefined,
		}),
	);
	const payload = Buffer.from(await response.arrayBuffer());
	const path = new URL(url).pathname;
	appendFileSync(
		logPath,
		`${JSON.stringify({ method, path, status: response.status })}\n`,
	);
	const out: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		out[key] = value;
	});
	res.writeHead(response.status, out);
	res.end(payload);
}

server.listen(443, "127.0.0.1", () => {
	writeFileSync(`${runDir}/fake.pid`, `${process.pid}\n`);
	process.stdout.write(`fake ready org=${orgName}\n`);
});
