import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Usage,
} from '@earendil-works/pi-ai';
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import piUsageExtension from '../extensions/pi-usage';
import { closeDb, getDb } from '../extensions/db';

it('accounts real codemode classifier/image and nested tool usage once, then imports idempotently', async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-codemode-'));
	const previous = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
	process.env.HOME = home;
	process.env.XDG_STATE_HOME = path.join(home, 'state');
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
	} satisfies Usage;
	const script = `
 const classifier = {provider:'usage-test', id:'judge'};
 const painter = {provider:'usage-test', id:'painter'};
 await models.classify(classifier, {state:{ok:true}, questions:{ok:{type:'bool', instructions:'Check', criteria:{true:'ok',false:'bad'}}}});
 await models.generateImages(painter, {input:[{type:'text',text:'fox'}]});
 await tools.nested({});
 throw new Error('failed after billable work');`;
	let turn = 0;
	const fakeProvider: ExtensionFactory = (pi) => {
		pi.on('session_start', () => {
			pi.registerProvider('usage-test', {
				apiKey: 'fake-key',
				api: 'usage-chat',
				baseUrl: 'https://fake.invalid',
				models: [
					{
						id: 'chat',
						name: 'Chat',
						api: 'usage-chat',
						reasoning: false,
						input: ['text'],
						contextWindow: 100000,
						maxTokens: 1000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
					{
						type: 'classifier',
						id: 'judge',
						name: 'Judge',
						api: 'usage-classifier',
						input: ['text'],
						contextWindow: 10000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
					{
						type: 'image',
						id: 'painter',
						name: 'Painter',
						api: 'usage-image',
						input: ['text'],
						output: ['image'],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
				streamSimple: (model) => {
					const stream = createAssistantMessageEventStream();
					const first = turn++ === 0;
					const message = {
						role: 'assistant',
						provider: model.provider,
						model: model.id,
						api: model.api,
						timestamp: Date.now(),
						usage,
						content: first
							? [{ type: 'toolCall', id: 'script', name: 'codemode', arguments: { code: script } }]
							: [{ type: 'text', text: 'done' }],
						stopReason: first ? 'toolUse' : 'stop',
					} satisfies AssistantMessage;
					stream.push({ type: 'start', partial: message });
					stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message });
					stream.end();
					return stream;
				},
				classifiers: {
					'usage-classifier': {
						classify: async () => ({
							provider: 'usage-test',
							model: 'judge',
							api: 'usage-classifier',
							timestamp: Date.now(),
							answers: { ok: { type: 'bool', probability: 1 } },
							usage,
							stopReason: 'stop',
						}),
					},
				},
				images: {
					'usage-image': {
						generateImages: async () => ({
							role: 'assistant',
							provider: 'usage-test',
							model: 'painter',
							api: 'usage-image',
							output: [],
							usage,
							stopReason: 'stop',
							timestamp: Date.now(),
						}),
					},
				},
			});
		});
		pi.registerTool({
			name: 'nested',
			label: 'Nested',
			description: 'Nested usage',
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: 'text', text: 'nested' }],
				details: undefined,
				usage,
			}),
		});
	};
	const settingsManager = SettingsManager.inMemory({
		defaultProvider: 'usage-test',
		defaultModel: 'chat',
		defaultTools: ['codemode'],
		compaction: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: home,
		agentDir: path.join(home, '.pi', 'agent'),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [fakeProvider, createCodemodeExtension(), piUsageExtension],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
	try {
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		expect(resourceLoader.getExtensions().extensions).toHaveLength(3);
		({ session } = await createAgentSession({
			cwd: home,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.create(home),
		}));
		const errors: unknown[] = [];
		await session.bindExtensions({
			onError: (error) => {
				errors.push(error);
			},
		});
		expect(errors).toEqual([]);
		const chat = session.modelRuntime.getModel('usage-test', 'chat');
		if (!chat) throw new Error('Fake chat provider did not register');
		await session.setModel(chat);
		await session.prompt('Run the script');
		const tool = session.messages.find((message) => message.role === 'toolResult');
		expect(tool).toMatchObject({
			role: 'toolResult',
			toolName: 'codemode',
			isError: true,
			usage: { totalTokens: usage.totalTokens * 3 },
		});
		const totals = () =>
			getDb()
				.prepare('SELECT SUM(total_tokens) AS tokens, COUNT(*) AS events FROM usage_events')
				.get();
		expect(totals()).toEqual({ tokens: usage.totalTokens * 5, events: 3 });
		const charges = getDb()
			.prepare(
				"SELECT c.total_amount FROM usage_charges c JOIN usage_events e ON e.unique_key=c.event_key WHERE e.provider='tools'"
			)
			.all();
		expect(charges).toEqual([{ total_amount: expect.closeTo(usage.cost.total * 3) }]);
		await session.prompt('/usage import');
		expect(totals()).toEqual({ tokens: usage.totalTokens * 5, events: 3 });
		await session.prompt('/usage import');
		expect(totals()).toEqual({ tokens: usage.totalTokens * 5, events: 3 });
	} finally {
		session?.dispose();
		closeDb();
		for (const key of ['HOME', 'XDG_STATE_HOME'] as const) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		fs.rmSync(home, { recursive: true, force: true });
	}
}, 30000);
