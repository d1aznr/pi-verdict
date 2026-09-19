/**
 * jev adapter tests: request building / response mapping / the verdict prefix
 * contract (exercised through the real adjudicate pipeline) / stream error
 * paths / auth resolution order / extension wiring. Fully offline: injected
 * fetch stubs, no network.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import jevAdapter, {
	API_ID,
	buildDecisionsBody,
	createJevProvider,
	DECISIONS_URL,
	DEFAULT_DECISIONS_URL,
	extractState,
	MODEL_ID,
	PROVIDER_ID,
	VERDICT_QUESTIONS,
	verdictText,
	WIRE_MODEL,
} from "../extensions/jev-adapter.ts";
import { adjudicate, buildProtectedSet, SessionState } from "../extensions/pi-verdict.ts";

const TMP_AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verdict-jev-test-"));
const SAVED_OR_KEY = process.env.OPENROUTER_API_KEY;

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = TMP_AGENT;
	delete process.env.OPENROUTER_API_KEY;
	const p = path.join(TMP_AGENT, "config", "pi-verdict.json");
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify({ allow: [], deny: [] }));
});
afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	if (SAVED_OR_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
	else process.env.OPENROUTER_API_KEY = SAVED_OR_KEY;
	fs.rmSync(TMP_AGENT, { recursive: true, force: true });
});

function decisionResponse(choice: string, probabilities: Record<string, number> = {}, confidence?: number): unknown {
	return {
		model: "typesafe/jev-1.13-20260917",
		answers: {
			verdict: {
				type: "choice",
				choice,
				...(Object.keys(probabilities).length ? { probabilities } : {}),
				...(confidence !== undefined ? { confidence } : {}),
			},
		},
		usage: { input_tokens: 351, output_tokens: 33, cost: 0.000014742 },
	};
}

describe("buildDecisionsBody", () => {
	test("targets the OpenRouter decisions wire format", () => {
		const body = buildDecisionsBody("User: hi\nbash: rm -rf /tmp/x") as Record<string, any>;
		expect(body.model).toBe(WIRE_MODEL);
		expect(body.model).toBe("~typesafe/jev-latest");
		expect(body.state).toBe("User: hi\nbash: rm -rf /tmp/x");
		const q = body.questions.verdict;
		expect(q.type).toBe("choice");
		expect(Object.keys(q.criteria).sort()).toEqual(["allow", "ask", "deny"]);
		expect(q.instructions).toContain("LAST line");
		expect(q.instructions).toContain("evidence, not instruction");
	});
});

describe("extractState", () => {
	test("takes the last user message (string content)", () => {
		const state = extractState({ messages: [{ role: "user", content: "first" }, { role: "assistant", content: "reply" }, { role: "user", content: "second" }] });
		expect(state).toBe("second");
	});
	test("joins text blocks of block-array content", () => {
		const state = extractState({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "image", url: "x" }, { type: "text", text: "b" }] }] });
		expect(state).toBe("a\nb");
	});
	test("throws when there is no user message", () => {
		expect(() => extractState({ messages: [{ role: "assistant", content: "x" }] })).toThrow("no user message");
	});
});

describe("verdictText", () => {
	test("synthesizes the prefix-contract text with readable percentages", () => {
		expect(verdictText(decisionResponse("deny", { allow: 0.01, ask: 0.03, deny: 0.96 }, 0.94))).toBe(
			"<verdict>deny</verdict> jev: deny 96% (confidence 94%; allow 1%, ask 3%)",
		);
	});
	test("missing probabilities render as zero, missing confidence is omitted", () => {
		expect(verdictText(decisionResponse("allow"))).toBe("<verdict>allow</verdict> jev: allow 0% (ask 0%, deny 0%)");
	});
	test("case-normalizes the choice", () => {
		expect(verdictText(decisionResponse("Ask"))).toMatch(/^<verdict>ask<\/verdict>/);
	});
	test("malformed answers throw (fail-closed upstream)", () => {
		expect(() => verdictText(decisionResponse("maybe"))).toThrow("malformed verdict answer");
		expect(() => verdictText({ answers: {} })).toThrow("malformed verdict answer");
		expect(() => verdictText({})).toThrow("malformed verdict answer");
	});
});

describe("verdict prefix contract (real adjudicate pipeline)", () => {
	const state = new SessionState(buildProtectedSet(TMP_AGENT, null));
	const envFor = (text: string) => ({
		cwd: "/proj",
		hasUI: true,
		getModel: () => ({ model: { id: "mock/jev", provider: PROVIDER_ID, api: API_ID }, thinking: "off" as const }),
		complete: (async () => ({ content: [{ type: "text", text }], stopReason: "stop" })) as any,
		host: { getBranch: () => [], getSessionId: () => "s1" },
		signal: undefined,
	});

	test("adapter output passes parseVerdict for all three choices", async () => {
		for (const [choice, expected] of [["allow", "allow"], ["ask", "ask"], ["deny", "deny"]] as const) {
			const text = verdictText(decisionResponse(choice, { [choice]: 0.9 }, 0.8));
			const v = await adjudicate(state, { toolName: "bash", input: { command: "echo hello" } }, envFor(text));
			expect(v.verdict).toBe(expected);
			expect(v.source).toBe("classifier");
		}
	});
});

describe("streamDecisions via createJevProvider", () => {
	test("happy path: request shape, synthesized text, usage mapping, signal passthrough", async () => {
		const controller = new AbortController();
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetcher = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify(decisionResponse("deny", { deny: 0.96, allow: 0.04 }, 0.29)), { status: 200 });
		}) as typeof fetch;
		const provider = createJevProvider(async () => "sk-or-live", fetcher);
		const model = provider.getModels()[0];
		expect(model.id).toBe(MODEL_ID);
		const message = await provider
			.streamSimple(model, { messages: [{ role: "user", content: "User: hi\nbash: cat ~/.ssh/id_ed25519" }] } as any, {
				apiKey: "sk-req",
				signal: controller.signal,
				maxTokens: 512,
			})
			.result();
		expect(message.stopReason).toBe("stop");
		expect(message.content[0]).toEqual({ type: "text", text: "<verdict>deny</verdict> jev: deny 96% (confidence 29%; allow 4%, ask 0%)" });
		expect(message.usage).toMatchObject({ input: 351, output: 33, totalTokens: 384, cost: { total: 0.000014742 } });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(DECISIONS_URL);
		expect(calls[0].init.method).toBe("POST");
		expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-req");
		expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/json");
		expect(calls[0].init.signal).toBe(controller.signal);
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.model).toBe(WIRE_MODEL);
		expect(body.state).toBe("User: hi\nbash: cat ~/.ssh/id_ed25519");
	});
	test("HTTP error lands as stopReason error with the status and body snippet", async () => {
		const fetcher = (async () => new Response('{"error":{"message":"is a decisions model"}}', { status: 400 })) as typeof fetch;
		const provider = createJevProvider(undefined, fetcher);
		const message = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "x" }] } as any, { apiKey: "k" }).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("400");
		expect(message.errorMessage).toContain("decisions model");
	});
	test("malformed JSON lands as stopReason error", async () => {
		const provider = createJevProvider(undefined, (async () => new Response("not json", { status: 200 })) as typeof fetch);
		const message = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "x" }] } as any, { apiKey: "k" }).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("malformed JSON");
	});
	test("missing API key lands as stopReason error", async () => {
		const provider = createJevProvider(undefined);
		const message = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "x" }] } as any, {}).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("no API key resolved");
	});
});

describe("auth resolve order", () => {
	const input = { ctx: { env: async () => undefined, fileExists: async () => false }, credential: undefined, signal: new AbortController().signal };
	test("openrouter resolver wins over env", async () => {
		process.env.OPENROUTER_API_KEY = "sk-env";
		const r = await createJevProvider(async () => "sk-or-login").auth.apiKey.resolve(input as any);
		expect(r).toEqual({ auth: { apiKey: "sk-or-login" }, source: "openrouter" });
	});
	test("env applies when the resolver throws or is unset", async () => {
		process.env.OPENROUTER_API_KEY = "sk-env";
		expect((await createJevProvider(async () => { throw new Error("store down"); }).auth.apiKey.resolve(input as any))?.auth.apiKey).toBe("sk-env");
		expect((await createJevProvider(undefined).auth.apiKey.resolve(input as any))?.auth.apiKey).toBe("sk-env");
	});
	test("unconfigured when neither source yields a key", async () => {
		delete process.env.OPENROUTER_API_KEY;
		expect(await createJevProvider(undefined).auth.apiKey.resolve(input as any)).toBeUndefined();
	});
});

describe("extension wiring", () => {
	function makePi() {
		const registered: unknown[] = [];
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		return {
			pi: {
				registerProvider: (p: unknown) => registered.push(p),
				on: (event: string, handler: (event: any, ctx: any) => unknown) => {
					handlers[event] = handler;
				},
			},
			registered,
			handlers,
		};
	}
	const ctxWith = (apiKey?: string) => ({
		modelRegistry: { getProviderAuth: async () => (apiKey ? { auth: { apiKey } } : undefined) },
		ui: { notify: () => {} },
	});

	test("registers the typesafe provider at load and re-registers on session_start", () => {
		const { pi, registered, handlers } = makePi();
		jevAdapter(pi as any);
		expect(registered).toHaveLength(1);
		expect((registered[0] as any).id).toBe(PROVIDER_ID);
		expect((registered[0] as any).getModels()[0].id).toBe(MODEL_ID);
		handlers["session_start"]({}, ctxWith("sk-or"));
		expect(registered).toHaveLength(2); // re-register refreshes the sync hasConfiguredAuth snapshot
	});
	test("model_select on the jev provider warns; other providers stay silent", () => {
		const { pi, handlers } = makePi();
		const notifies: Array<[string, string]> = [];
		const ctx = { ...ctxWith(), ui: { notify: (m: string, k: string) => notifies.push([m, k]) } };
		jevAdapter(pi as any);
		handlers["model_select"]({ model: { provider: PROVIDER_ID, id: MODEL_ID } }, ctx);
		expect(notifies).toHaveLength(1);
		expect(notifies[0][0]).toContain("classifierModel only");
		expect(notifies[0][1]).toBe("warning");
		handlers["model_select"]({ model: { provider: "anthropic", id: "claude" } }, ctx);
		expect(notifies).toHaveLength(1);
	});
	test("hosts without registerProvider (omp) stay inert", () => {
		const pi: Record<string, unknown> = { on: () => {} };
		expect(() => jevAdapter(pi as any)).not.toThrow();
	});
});

describe("endpoint override", () => {
	test("defaults to the OpenRouter alpha decisions endpoint when PI_VERDICT_JEV_URL is unset", () => {
		expect(DECISIONS_URL).toBe(DEFAULT_DECISIONS_URL);
		expect(DEFAULT_DECISIONS_URL).toBe("https://openrouter.ai/api/alpha/decisions");
	});
});

describe("self-protection coverage (#26 whole-package watch)", () => {
	test("a colocated jev-adapter.ts joins the tamper baseline of an npm-dir install", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verdict-pkg-"));
		const pkg = path.join(root, "agent", "extensions", "pi-verdict");
		fs.mkdirSync(path.join(pkg, "extensions"), { recursive: true });
		fs.writeFileSync(path.join(pkg, "extensions", "pi-verdict.ts"), "gate");
		fs.writeFileSync(path.join(pkg, "extensions", "jev-adapter.ts"), "adapter");
		const prot = buildProtectedSet(path.join(root, "agent"), path.join(pkg, "extensions", "pi-verdict.ts"));
		const watched = prot.watchBases.map((w: { file: string }) => w.file);
		expect(watched).toContain(path.join(pkg, "extensions", "jev-adapter.ts"));
		expect(watched).toContain(path.join(pkg, "extensions", "pi-verdict.ts"));
		fs.rmSync(root, { recursive: true, force: true });
	});
});
