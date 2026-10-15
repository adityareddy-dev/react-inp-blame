// Reactive Resume (amruthpillai/reactive-resume, MIT) at the pinned upstream commit 19e0518eb5ea1b2c84d785bc5ea2b6d6c9d7b043.
//
// The app is a Hono server (apps/server, a tsdown build) that serves the Vite SPA from apps/web/dist and needs
// PostgreSQL 16; its migrations run at server start. Each configuration has its own database, reactive_resume_a,
// _b and _c, on the PostgreSQL instance at 127.0.0.1:5444. Configuration A builds the seed: the server starts on
// an empty database, the seeded user signs up through the auth API, the seeded resume is inserted, the user signs
// in once, and the database is dumped to bench/state/reactive-resume/seed.sql with the session in the dump. Every
// run restores that dump into its database (beforeRun) and starts signed in, through a storageState file.
//
// The server is started through a bench-only launcher, bench-launch.mjs, written into the disposable clone. It only
// makes the server listen on 127.0.0.1, which the upstream entry point does not do. The seed script, bench-seed.mjs,
// is written there too. Neither is committed upstream.
//
// Configuration A has no library. B and C import react-inp-blame@1.0.0's Vite plugin with runtime
// { debugGlobal: true } (C adds overlay: true) and enabled: true, because the plugin leaves itself out of a
// production build unless enabled is set.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, pollFor, waitForHttp } from '../helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLONE = path.join(HERE, '..', 'clones', 'reactive-resume');
const WEB = path.join(CLONE, 'apps', 'web');
const SERVER = path.join(CLONE, 'apps', 'server');
const STATE = path.join(HERE, '..', 'state', 'reactive-resume');
const LAUNCHER = path.join(CLONE, 'bench-launch.mjs');
const SEED_SCRIPT = path.join(CLONE, 'bench-seed.mjs');
// The engines field requires Node 24.x. pnpm 12.11.2 (the root packageManager) runs under it.
const NODE24_BIN = '/opt/node24/bin';
const NODE24 = path.join(NODE24_BIN, 'node');
const PNPM = ['--yes', 'pnpm@12.11.2'];
const LIBRARY_PIN_LINE = '\t\t"react-inp-blame": "1.0.0",';
const LIBRARY_ANCHOR = '\t\t"babel-plugin-react-compiler": "^1.0.0",';

// PostgreSQL 16 on 127.0.0.1:5444. The instance is started by the operator; this adapter never starts or stops it.
const PG_PORT = 5444;
const LETTER = { A: 'a', B: 'b', C: 'c' };
// The port configuration A's seed server listens on: the adapter's own A port in apps.mjs (5310 + 3 * 4).
const SEED_PORT = 5322;
// Every run opens the builder of this resume. The seed inserts it for the seeded user.
const RESUME_ID = 'bench-resume';
const RESUME_PATH = `/builder/${RESUME_ID}`;
// The username is required by the schema, and the sign-up path does not make one for a named user.
const SEED_USER = { name: 'Alex Morgan', email: 'bench.user@example.com', username: 'bench-user' };
const SESSION_COOKIE = 'better-auth.session_token';

// The bench-only Vite configuration. It wraps the upstream vite.config.ts and adds the library's build plugin
// for configurations B and C only. Configuration A never loads the library, not even its build plugin.
const BENCH_VITE_CONFIG = `// Bench-only Vite configuration, written into the disposable clone by bench/adapters/reactive-resume.mjs.
// It is not upstream source. It wraps the upstream vite.config.ts and adds the react-inp-blame build plugin
// for configurations B and C only.
import base from "./vite.config";

const configuration = process.env.BENCH_CONFIG ?? "";

export default async () => {
	const plugins: any[] = [...((base as any).plugins ?? [])];
	if (configuration !== "") {
		// Imported only for B and C, so configuration A never loads the library, not even its build plugin.
		const { inpBlame } = await import("react-inp-blame/vite");
		// enabled defaults to 'development', which would leave the library out of this production build.
		const runtime = configuration === "c" ? { debugGlobal: true, overlay: true } : { debugGlobal: true };
		// The React plugin group (vite:react-babel and friends) is one array entry; the library goes right after it.
		const framework = plugins.findIndex(
			(plugin) => Array.isArray(plugin) && plugin.some((p) => typeof p?.name === "string" && p.name.startsWith("vite:react")),
		);
		if (framework === -1) throw new Error("bench: no React plugin group found in the upstream Vite config");
		plugins.splice(framework + 1, 0, ...inpBlame({ enabled: true, runtime }));
	}
	return { ...(base as any), plugins };
};
`;

// Bench-only launcher. Hono's Node server calls listen(port) with no host, which binds every interface. The bench
// serves 127.0.0.1 only, so a listen call that names no host gets the loopback address. Otherwise it runs the
// upstream entry point's main(), which runs the migrations, then serves.
const BENCH_LAUNCHER = `// Bench-only launcher, written into the disposable clone by bench/adapters/reactive-resume.mjs. Not upstream source.
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
	const [first, second] = args;
	if (typeof first === "number" || typeof first === "string") {
		if (second === undefined || typeof second === "function") args.splice(1, 0, "127.0.0.1");
	} else if (first && typeof first === "object" && first.host === undefined && first.path === undefined) {
		args[0] = { ...first, host: "127.0.0.1" };
	}
	return listen.apply(this, args);
};

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = await import(pathToFileURL(path.join(here, "apps", "server", "dist", "index.mjs")).href);
export const main = entry.main;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
`;

// Bench-only seed. Starts the server on an empty database (its migrations run first), creates the seeded user
// through the auth API, inserts the seeded resume, signs in once, and writes the session cookie to a storageState
// file. The dump taken afterwards keeps that session, so every run starts signed in.
const BENCH_SEED = `// Bench-only seed, written into the disposable clone by bench/adapters/reactive-resume.mjs. Not upstream source.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { main } from "./bench-launch.mjs";

const input = JSON.parse(fs.readFileSync(process.env.BENCH_SEED_INPUT, "utf8"));
const base = process.env.APP_URL;
const pg = input.db;
const sql = (text) => "'" + text.replaceAll("'", "''") + "'";

function psql(statement) {
	execFileSync("psql", ["-h", "127.0.0.1", "-p", String(pg.port), "-U", pg.user, "-d", pg.database, "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], {
		env: { ...process.env, PATH: process.env.PATH, PGPASSWORD: pg.password },
		stdio: ["ignore", "inherit", "inherit"],
	});
}

await main();
for (let attempt = 0; ; attempt++) {
	try {
		const res = await fetch(base + "/api/health");
		if (res.status > 0) break;
	} catch {
		/* not listening yet */
	}
	if (attempt > 300) throw new Error("the seed server never answered /api/health");
	await new Promise((resolve) => setTimeout(resolve, 300));
}

const post = (route, body) =>
	fetch(base + route, {
		method: "POST",
		headers: { "content-type": "application/json", origin: base },
		body: JSON.stringify(body),
	});

const signUp = await post("/api/auth/sign-up/email", input.user);
if (!signUp.ok) throw new Error("sign-up failed: " + signUp.status + " " + (await signUp.text()));
const signIn = await post("/api/auth/sign-in/email", { email: input.user.email, password: input.user.password });
if (!signIn.ok) throw new Error("sign-in failed: " + signIn.status + " " + (await signIn.text()));
const { user } = await signIn.json();
const cookie = signIn.headers.getSetCookie().find((value) => value.startsWith(input.cookieName + "="));
if (!cookie) throw new Error("sign-in set no " + input.cookieName + " cookie");
const value = cookie.slice(input.cookieName.length + 1).split(";")[0];

psql(
	"INSERT INTO resume (id, name, slug, data, user_id) VALUES (" +
		[sql(input.resume.id), sql(input.resume.name), sql(input.resume.slug)].join(", ") +
		", " +
		sql(JSON.stringify(input.resume.data)) +
		"::jsonb, " +
		sql(user.id) +
		");",
);

fs.writeFileSync(
	input.storageState,
	JSON.stringify(
		{
			cookies: [
				{ name: input.cookieName, value, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" },
			],
			origins: [],
		},
		null,
		2,
	) + "\\n",
	{ mode: 0o600 },
);
console.log("seed: user " + user.id + " and resume " + input.resume.id + " written");
process.exit(0);
`;

function nodeEnv(env) {
	return { ...env, PATH: `${NODE24_BIN}:${env.PATH ?? process.env.PATH}` };
}

/** Adds the exact library pin to the web app's devDependencies, if it is not there yet. */
function pinLibrary() {
	const file = path.join(WEB, 'package.json');
	const text = fs.readFileSync(file, 'utf8');
	if (text.includes('"react-inp-blame"')) return;
	if (!text.includes(LIBRARY_ANCHOR)) throw new Error('apps/web/package.json: devDependencies anchor not found');
	fs.writeFileSync(file, text.replace(LIBRARY_ANCHOR, `${LIBRARY_ANCHOR}\n${LIBRARY_PIN_LINE}`));
}

function jsFiles(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) jsFiles(file, out);
		else if (/\.(js|mjs|html)$/.test(entry.name)) out.push(file);
	}
	return out;
}

/**
 * Checks the build before it is used: production React, and the library present in B and C only. Throws on
 * any violation, so a wrong build cannot be measured as if it were right.
 */
function verifyBuild(dir, config) {
	const files = jsFiles(dir);
	const text = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
	const hits = (needle) => [...text].filter(([, body]) => body.includes(needle)).map(([file]) => path.relative(dir, file));
	const failures = [];
	if (hits('process.env.NODE_ENV').length) failures.push('an unresolved process.env.NODE_ENV is in the bundle');
	if (!hits('Minified React error').length) failures.push('no production React error strings: React may be the development build');
	if (config === '') {
		if (hits('REACT_INP_BLAME').length || hits('react-inp-blame').length) failures.push('configuration A carries the library');
	} else {
		if (!hits('__REACT_INP_BLAME__').length) failures.push(`configuration ${config} has no __REACT_INP_BLAME__`);
		const install = files.find((file) => path.basename(file).startsWith('react-inp-blame-install') && file.endsWith('.js'));
		if (!install) failures.push(`configuration ${config} has no install module`);
		else {
			const body = text.get(install);
			const wanted = config === 'c' ? 'overlay:!0' : null;
			if (!body.includes('debugGlobal:!0')) failures.push(`configuration ${config} install module lacks debugGlobal`);
			if (wanted && !body.includes(wanted)) failures.push(`configuration ${config} install module lacks overlay`);
			if (!wanted && body.includes('overlay')) failures.push(`configuration ${config} install module has overlay`);
		}
	}
	if (failures.length) throw new Error(`${dir}: ${failures.join('; ')}`);
}

// ---------------------------------------------------------------- PostgreSQL

/** The bench does not start database servers. A stopped PostgreSQL is a blocker, reported here, not repaired. */
function requirePostgres() {
	const r = spawnSync('pg_isready', ['-h', '127.0.0.1', '-p', String(PG_PORT)], { encoding: 'utf8' });
	if (r.status !== 0) {
		throw new Error(`PostgreSQL is not accepting connections on 127.0.0.1:${PG_PORT}; the bench does not start database servers`);
	}
}

/** The bench credentials: the operator's superuser (pg.admin), the adapter's role (pg.user), and the seeded login. */
function credentials() {
	const file = path.join(STATE, 'credentials.json');
	fs.mkdirSync(STATE, { recursive: true });
	const body = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
	const secret = (bytes = 18) => crypto.randomBytes(bytes).toString('hex');
	const before = JSON.stringify(body);
	body.pg ??= { admin: 'postgres', adminPassword: secret(), user: 'bench_app', password: secret() };
	// AUTH_SECRET and ENCRYPTION_SECRET (at least 32 characters) sign sessions and encrypt stored secrets.
	body.app ??= { authSecret: secret(32), encryptionSecret: secret(18) };
	body.user ??= { ...SEED_USER, password: secret() };
	if (JSON.stringify(body) !== before) fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
	return body;
}

const dbName = (letter) => `reactive_resume_${letter}`;

function pgEnv(password) {
	return { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ''}`, PGPASSWORD: password };
}

function psql(sql, { user, password, database }) {
	const r = spawnSync(
		'psql',
		['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', user, '-d', database, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', sql],
		{ env: pgEnv(password), encoding: 'utf8' },
	);
	if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr).trim().slice(0, 400)}`);
	return r.stdout.trim();
}

/** The role and the three databases, created once. The databases are owned by the adapter's role. */
function ensureRoleAndDatabases(c) {
	const admin = { user: c.pg.admin, password: c.pg.adminPassword, database: 'postgres' };
	if (psql(`SELECT count(*) FROM pg_roles WHERE rolname = '${c.pg.user}'`, admin) === '0') {
		psql(`CREATE ROLE ${c.pg.user} LOGIN PASSWORD '${c.pg.password}'`, admin);
	}
	for (const letter of Object.values(LETTER)) {
		if (psql(`SELECT count(*) FROM pg_database WHERE datname = '${dbName(letter)}'`, admin) === '0') {
			psql(`CREATE DATABASE ${dbName(letter)} OWNER ${c.pg.user}`, admin);
		}
	}
}

/**
 * Drops the app's schema and Drizzle's migration ledger (its own schema), then recreates public, as the superuser.
 * The ledger must go with the tables: a ledger that says the migrations ran over missing tables refuses to start.
 */
function resetSchema(c, letter) {
	psql(
		'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION ' + c.pg.user + ';',
		{
		user: c.pg.admin,
		password: c.pg.adminPassword,
		database: dbName(letter),
	});
}

// ---------------------------------------------------------------- the seeded resume

const SECTION = (icon, items) => ({
	title: '',
	icon,
	columns: 1,
	hidden: false,
	showHeading: true,
	keepTogether: false,
	startOnNewPage: false,
	items,
});
const NO_WEBSITE = { url: '', label: '' };

/**
 * The seeded resume. It is written out in full, so no value depends on the day it runs. It has one experience
 * entry, one education entry, one skill and a summary, which are what the cases edit or hide.
 */
function seedResume() {
	return {
		id: RESUME_ID,
		name: 'Alex Morgan resume',
		slug: 'bench-resume',
		data: {
			picture: {
				hidden: false,
				fit: 'cover',
				url: '',
				size: 80,
				rotation: 0,
				aspectRatio: 1,
				borderRadius: 0,
				borderColor: 'rgba(0, 0, 0, 0.5)',
				borderWidth: 0,
				shadowColor: 'rgba(0, 0, 0, 0.5)',
				shadowWidth: 0,
			},
			basics: {
				name: SEED_USER.name,
				headline: 'Frontend engineer',
				email: 'alex.morgan@example.com',
				phone: '+351 900 000 000',
				location: 'Lisbon',
				website: NO_WEBSITE,
				customFields: [],
			},
			summary: {
				title: '',
				icon: 'article',
				columns: 1,
				hidden: false,
				showHeading: true,
				keepTogether: false,
				startOnNewPage: false,
				content: '<p>Frontend engineer who builds fast, accessible interfaces for small product teams.</p>',
			},
			sections: {
				profiles: SECTION('messenger-logo', []),
				experience: {
					...SECTION('briefcase', [
						{
							id: 'exp-seed-1',
							hidden: false,
							company: 'Northwind Labs',
							position: 'Frontend engineer',
							location: 'Lisbon',
							period: '2021 – 2024',
							dates: { start: '2021-03', end: '2024-06', present: false },
							website: NO_WEBSITE,
							description: '<p>Built the design system used by three products.</p>',
							roles: [],
						},
						{
							id: 'exp-seed-2',
							hidden: false,
							company: 'Cais Digital',
							position: 'Product engineer',
							location: 'Porto',
							period: '2018 – 2021',
							dates: { start: '2018-02', end: '2021-08', present: false },
							website: NO_WEBSITE,
							description: '<p>Shipped the checkout flow.</p>',
							roles: [],
						},
					]),
				},
				education: {
					...SECTION('graduation-cap', [
						{
							id: 'edu-seed-1',
							hidden: false,
							school: 'University of Porto',
							degree: 'BSc',
							area: 'Computer Science',
							grade: '',
							location: 'Porto',
							period: '2016 – 2019',
							dates: { start: '2016-09', end: '2019-07', present: false },
							website: NO_WEBSITE,
							description: '',
						},
					]),
				},
				projects: SECTION('code-simple', []),
				skills: {
					...SECTION('compass-tool', [
						{
							id: 'skill-seed-1',
							hidden: false,
							icon: '',
							iconColor: '',
							name: 'TypeScript',
							proficiency: 'Advanced',
							level: 4,
							keywords: ['React', 'Node.js'],
						},
					]),
					layout: 'default',
					keywordLayout: 'inline',
				},
				languages: SECTION('translate', []),
				interests: SECTION('football', []),
				awards: SECTION('trophy', []),
				certifications: SECTION('certificate', []),
				publications: SECTION('books', []),
				volunteer: SECTION('hand-heart', []),
				references: SECTION('phone', []),
			},
			customSections: [],
			metadata: {
				template: 'onyx',
				layout: {
					sidebarWidth: 35,
					pages: [
						{
							fullWidth: false,
							main: ['profiles', 'summary', 'education', 'experience', 'projects', 'volunteer', 'references'],
							sidebar: ['skills', 'certifications', 'awards', 'languages', 'interests', 'publications'],
						},
					],
				},
				page: {
					gapX: 4,
					gapY: 6,
					marginX: 14,
					marginY: 12,
					format: 'a4',
					locale: 'en-US',
					dateFormat: 'short',
					hideLinkUnderline: false,
					hideIcons: false,
					hideSectionIcons: true,
				},
				design: {
					colors: { primary: 'rgba(220, 38, 38, 1)', text: 'rgba(0, 0, 0, 1)', background: 'rgba(255, 255, 255, 1)' },
					level: { icon: 'star', type: 'circle' },
				},
				typography: {
					body: { fontFamily: 'IBM Plex Serif', fontWeights: ['400', '500'], fontSize: 10, lineHeight: 1.5 },
					heading: { fontFamily: 'IBM Plex Serif', fontWeights: ['600'], fontSize: 14, lineHeight: 1.5 },
				},
				notes: '',
				styleRules: [],
			},
		},
	};
}

/** Seeds configuration A's database and writes the dump every run restores. */
function seedDatabase(run) {
	const c = credentials();
	resetSchema(c, LETTER.A);
	const inputFile = path.join(STATE, 'seed-input.json');
	const storageState = path.join(STATE, 'storage-state.json');
	fs.writeFileSync(
		inputFile,
		JSON.stringify({
			db: { port: PG_PORT, user: c.pg.user, password: c.pg.password, database: dbName(LETTER.A) },
			user: { name: c.user.name, email: c.user.email, username: SEED_USER.username, password: c.user.password },
			cookieName: SESSION_COOKIE,
			resume: seedResume(),
			storageState,
		}),
		{ mode: 0o600 },
	);
	run(NODE24, [SEED_SCRIPT], {
		cwd: CLONE,
		env: {
			...nodeEnv(process.env),
			BENCH_SEED_INPUT: inputFile,
			APP_URL: `http://127.0.0.1:${SEED_PORT}`,
			...serverEnv(c, LETTER.A, SEED_PORT),
		},
	});
	const dump = path.join(STATE, 'seed.sql');
	run('pg_dump', ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', c.pg.user, '-d', dbName(LETTER.A), '--no-owner', '--no-privileges', '--clean', '--if-exists', '-f', dump], {
		env: pgEnv(c.pg.password),
	});
	fs.rmSync(inputFile, { force: true });
}

function restoreSeed(c, letter) {
	const dump = path.join(STATE, 'seed.sql');
	if (!fs.existsSync(dump)) throw new Error('no seed yet: build configuration A first');
	const r = spawnSync(
		'psql',
		['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', c.pg.user, '-d', dbName(letter), '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', dump],
		{ env: pgEnv(c.pg.password), encoding: 'utf8' },
	);
	if (r.status !== 0) throw new Error(`restoring the seed failed: ${String(r.stderr).slice(0, 400)}`);
}

// ---------------------------------------------------------------- the server

function serverEnv(c, letter, port) {
	return {
		PATH: `${NODE24_BIN}:/usr/local/bin:/usr/bin:/bin`,
		NODE_ENV: 'production',
		PORT: String(port),
		APP_URL: `http://127.0.0.1:${port}`,
		DATABASE_URL: `postgresql://${c.pg.user}:${c.pg.password}@127.0.0.1:${PG_PORT}/${dbName(letter)}`,
		AUTH_SECRET: c.app.authSecret,
		ENCRYPTION_SECRET: c.app.encryptionSecret,
		STORAGE_BACKEND: 'local',
		LOCAL_STORAGE_PATH: path.join(STATE, `storage-${letter}`),
		// The rate limit is for the public deployment. The bench signs in many times per run.
		FLAG_DISABLE_API_RATE_LIMIT: 'true',
	};
}

/** Writes the bench-only launcher and seed script into the clone. They are rebuilt with each build. */
function writeBenchFiles() {
	fs.writeFileSync(LAUNCHER, BENCH_LAUNCHER);
	fs.writeFileSync(SEED_SCRIPT, BENCH_SEED);
}

/** apps/web/dist is the path the server reads, so each configuration's build is linked there while it runs. */
function linkDist(letter) {
	unlinkDist();
	fs.symlinkSync(path.join(CLONE, `dist-${letter}`), path.join(WEB, 'dist'), 'dir');
	fs.symlinkSync(path.join(CLONE, `dist-${letter}-prerender`), path.join(WEB, 'dist-prerender'), 'dir');
}

/** Removes only the links made by linkDist, never a real directory. */
function unlinkDist() {
	for (const name of ['dist', 'dist-prerender']) {
		const link = path.join(WEB, name);
		if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
	}
}

// ---------------------------------------------------------------- steps

// ---------------------------------------------------------------- the steps

/** The configuration whose database the stored reads use. beforeRun sets it before each run. */
let activeLetter = 'a';
/** What a step records for a later step to assert: C06 reads both states, C10 to C14 follow one new entry. */
const observed = {};

const SUMMARY_SENTENCE = 'Now leads frontend work for a payments team and mentors two engineers.';
const DENSITY_COMPACT = { lineHeight: 1.35, gapY: 4 }; // design/presets.ts DENSITIES.compact
const ACCENT_MOSS = 'rgba(62, 107, 79, 1)'; // design/presets.ts ACCENTS "Moss" (#3E6B4F) through hexToRgba
const MARGINS_WIDE = { marginX: 19, marginY: 16 }; // design/presets.ts MARGINS.wide

/** The stored resume in this run's database. The app saves as you type, so every read that asserts polls. */
function storedResume() {
	const c = credentials();
	const text = psql(`SELECT data::text FROM resume WHERE id = '${RESUME_ID}'`, {
		user: c.pg.user,
		password: c.pg.password,
		database: dbName(activeLetter),
	});
	return JSON.parse(text);
}

/** Polls the stored resume until `check` holds, or returns the last read after 15 s. The caller asserts it. */
const storedUntil = (check) => pollFor(storedResume, (data) => check(data), 15000);

const basics = (page) => page.locator('#sidebar-basics');
const basicsHeader = (page) => basics(page).locator('button[aria-expanded]').first();
const rowOf = (page, id) => page.locator(`#sidebar-${id}`);
const rowTitle = (page, id) => rowOf(page, id).locator('button[aria-expanded]').first();
const rowBadge = async (page, id) =>
	(await rowOf(page, id).locator('span.font-mono > span[aria-hidden="true"]').first().innerText()).trim();
const cardsOf = (page, id) => rowOf(page, id).locator('[data-entry-id]');
const cardById = (page, id, entryId) => rowOf(page, id).locator(`[data-entry-id="${entryId}"]`);
const newestCard = (page, id) => cardsOf(page, id).last();
const designTab = (page) => page.getByRole('tab', { name: 'Design', exact: true });

/** Opens a section when it is closed, then waits for its add control, which is only shown while open. */
async function openSection(page, id, addName) {
	if ((await rowTitle(page, id).getAttribute('aria-expanded')) !== 'true') await rowTitle(page, id).click();
	await rowOf(page, id).getByRole('button', { name: addName, exact: true }).waitFor({ state: 'visible' });
}

/** Adds an entry from a section's add control and records the new entry's id for the steps that follow. */
async function addEntry(page, id, addName, key) {
	await openSection(page, id, addName);
	const before = await cardsOf(page, id).count();
	await rowOf(page, id).getByRole('button', { name: addName, exact: true }).click();
	await pollFor(() => cardsOf(page, id).count(), (n) => n === before + 1, 10000);
	observed[key] = await newestCard(page, id).getAttribute('data-entry-id');
	return observed[key];
}

/** Waits until the Design mode is the one shown; the editor bar tab is labelled Design. */
async function ensureDesign(page) {
	if ((await designTab(page).getAttribute('aria-selected')) !== 'true') await designTab(page).click();
	await page.getByRole('radiogroup', { name: 'Density', exact: true }).waitFor({ state: 'visible' });
}

const design = (page, group) => page.getByRole('radiogroup', { name: group, exact: true });

/** Titles a section through its options menu. The prompt is a dialog with a text field and a Confirm button. */
async function renameSection(page, id, optionsName, title) {
	await rowOf(page, id).getByRole('button', { name: optionsName, exact: true }).click();
	await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
	const dialog = page.getByRole('alertdialog').last();
	await dialog.getByRole('textbox').fill(title);
	await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
}

/** Polls a locator's visibility until it matches `want`, or returns the last reading after two seconds. */
async function visibleSettles(locator, want) {
	let last = await locator.isVisible();
	const deadline = Date.now() + 2000;
	while (last !== want && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		last = await locator.isVisible();
	}
	return last;
}

const STEPS = [
	{
		name: 'C01 replace the Full name in the Basics card',
		run: async (page) => {
			if ((await basicsHeader(page).getAttribute('aria-expanded')) !== 'true') await basicsHeader(page).click();
			await basics(page).getByLabel('Full name', { exact: true }).fill('Jordan Reyes');
		},
		assert: async (page) => {
			const header = (await basicsHeader(page).innerText()).replace(/\s+/g, ' ');
			if (!header.includes('Jordan Reyes')) throw new Error(`the Basics header reads "${header}"`);
			const initials = (await basicsHeader(page).locator('span[aria-hidden="true"]').first().innerText()).trim();
			if (initials !== 'JR') throw new Error(`the avatar reads "${initials}", not JR`);
			const data = await storedUntil((d) => d.basics.name === 'Jordan Reyes');
			if (data.basics.name !== 'Jordan Reyes') throw new Error(`stored basics.name is "${data.basics.name}"`);
		},
	},
	{
		name: 'C02 replace the Headline in the Basics card',
		run: async (page) => {
			await basics(page).getByLabel('Headline', { exact: true }).fill('Design engineer');
		},
		assert: async (page) => {
			const header = (await basicsHeader(page).innerText()).replace(/\s+/g, ' ');
			if (!header.includes('Design engineer')) throw new Error(`the Basics header reads "${header}"`);
			const data = await storedUntil((d) => d.basics.headline === 'Design engineer');
			if (data.basics.headline !== 'Design engineer') throw new Error(`stored basics.headline is "${data.basics.headline}"`);
		},
	},
	{
		name: 'C03 replace the Location in the Basics card',
		run: async (page) => {
			await basics(page).getByLabel('Location', { exact: true }).fill('Porto');
		},
		assert: async (page) => {
			const header = (await basicsHeader(page).innerText()).replace(/\s+/g, ' ');
			if (!header.includes('Porto')) throw new Error(`the Basics header reads "${header}"`);
			const data = await storedUntil((d) => d.basics.location === 'Porto');
			if (data.basics.location !== 'Porto') throw new Error(`stored basics.location is "${data.basics.location}"`);
		},
	},
	{
		name: 'C04 replace the Phone in the Basics card',
		run: async (page) => {
			await basics(page).getByLabel('Phone', { exact: true }).fill('+351 912 345 678');
		},
		assert: async (page) => {
			const value = await basics(page).getByLabel('Phone', { exact: true }).inputValue();
			if (value !== '+351 912 345 678') throw new Error(`the Phone field reads "${value}"`);
			const data = await storedUntil((d) => d.basics.phone === '+351 912 345 678');
			if (data.basics.phone !== '+351 912 345 678') throw new Error(`stored basics.phone is "${data.basics.phone}"`);
		},
	},
	{
		name: 'C05 replace the Email in the Basics card with a valid address',
		run: async (page) => {
			const email = basics(page).getByLabel('Email', { exact: true });
			await email.fill('jordan.reyes@example.org');
			// Validation runs after the field is left, so the field is left before the assert looks for a message.
			await email.blur();
		},
		assert: async (page) => {
			const value = await basics(page).getByLabel('Email', { exact: true }).inputValue();
			if (value !== 'jordan.reyes@example.org') throw new Error(`the Email field reads "${value}"`);
			const messages = await basics(page).locator('[data-slot="form-message"]').count();
			if (messages !== 0) throw new Error(`${messages} validation message(s) shown for a valid address`);
			const data = await storedUntil((d) => d.basics.email === 'jordan.reyes@example.org');
			if (data.basics.email !== 'jordan.reyes@example.org') throw new Error(`stored basics.email is "${data.basics.email}"`);
		},
	},
	{
		name: 'C06 collapse and expand the Basics card header',
		run: async (page) => {
			const header = basicsHeader(page);
			const email = basics(page).getByLabel('Email', { exact: true });
			await header.click();
			observed.c06 = {
				collapsed: await header.getAttribute('aria-expanded'),
				collapsedEmailVisible: await visibleSettles(email, false),
			};
			await header.click();
			observed.c06.expanded = await header.getAttribute('aria-expanded');
			observed.c06.expandedEmailVisible = await visibleSettles(email, true);
		},
		assert: async () => {
			const c = observed.c06;
			if (c.collapsed !== 'false') throw new Error(`after collapsing, aria-expanded is ${c.collapsed}`);
			if (c.collapsedEmailVisible) throw new Error('the contact fields are still visible when the card is collapsed');
			if (c.expanded !== 'true') throw new Error(`after expanding, aria-expanded is ${c.expanded}`);
			if (!c.expandedEmailVisible) throw new Error('the contact fields are hidden after expanding the card');
		},
	},
	{
		name: 'C07 replace the Summary text with a new sentence',
		run: async (page) => {
			const row = rowOf(page, 'summary');
			if ((await rowTitle(page, 'summary').getAttribute('aria-expanded')) !== 'true') {
				await rowTitle(page, 'summary').click();
			}
			const editor = row.locator('[role="textbox"]');
			await editor.waitFor({ state: 'visible' });
			await editor.click();
			await page.keyboard.press('Control+A');
			await page.keyboard.type(SUMMARY_SENTENCE);
		},
		assert: async (page) => {
			const editor = rowOf(page, 'summary').locator('[role="textbox"]');
			const text = await pollFor(() => editor.innerText(), (t) => t.includes(SUMMARY_SENTENCE), 10000);
			if (!text.includes(SUMMARY_SENTENCE)) throw new Error(`the Summary editor reads "${text.slice(0, 120)}"`);
			const data = await storedUntil((d) => d.summary.content.includes(SUMMARY_SENTENCE));
			if (!data.summary.content.includes(SUMMARY_SENTENCE)) throw new Error('stored summary.content lacks the sentence');
		},
	},
	{
		name: 'C08 hide the Skills section from the page',
		run: async (page) => {
			await rowOf(page, 'skills').getByRole('button', { name: 'Hide Skills from the page', exact: true }).click();
		},
		assert: async (page) => {
			const toggle = rowOf(page, 'skills').getByRole('button', { name: 'Show Skills on the page', exact: true });
			await toggle.waitFor({ state: 'visible', timeout: 5000 });
			if ((await toggle.getAttribute('aria-pressed')) !== 'true') throw new Error('the eye button is not pressed');
			const title = (await rowTitle(page, 'skills').getAttribute('class')) ?? '';
			if (!title.includes('line-through')) throw new Error('the Skills outline row does not show the hidden style');
			const data = await storedUntil((d) => d.sections.skills.hidden === true);
			if (data.sections.skills.hidden !== true) throw new Error('stored sections.skills.hidden is not true');
		},
	},
	{
		name: 'C09 show the Skills section on the page again',
		run: async (page) => {
			await rowOf(page, 'skills').getByRole('button', { name: 'Show Skills on the page', exact: true }).click();
		},
		assert: async (page) => {
			const toggle = rowOf(page, 'skills').getByRole('button', { name: 'Hide Skills from the page', exact: true });
			await toggle.waitFor({ state: 'visible', timeout: 5000 });
			if ((await toggle.getAttribute('aria-pressed')) !== 'false') throw new Error('the eye button is still pressed');
			const data = await storedUntil((d) => d.sections.skills.hidden === false);
			if (data.sections.skills.hidden !== false) throw new Error('stored sections.skills.hidden is not false');
		},
	},
	{
		name: 'C10 add an entry to the Experience section',
		before: () => ({ items: storedResume().sections.experience.items.length }),
		run: async (page) => {
			await addEntry(page, 'experience', 'Add experience', 'newExperienceId');
		},
		assert: async (page, before) => {
			const count = await pollFor(() => cardsOf(page, 'experience').count(), (n) => n === before.items + 1, 10000);
			if (count !== before.items + 1) throw new Error(`the Experience section shows ${count} entry cards`);
			const badge = await rowBadge(page, 'experience');
			if (badge !== String(before.items + 1)) throw new Error(`the Experience count reads ${badge}`);
			const data = await storedUntil((d) => d.sections.experience.items.length === before.items + 1);
			if (data.sections.experience.items.length !== before.items + 1) {
				throw new Error(`stored experience items: ${data.sections.experience.items.length}`);
			}
			if (!data.sections.experience.items.some((item) => item.id === observed.newExperienceId)) {
				throw new Error('the stored items lack the new entry');
			}
		},
	},
	{
		name: 'C11 type a position into the new Experience entry',
		run: async (page) => {
			await cardById(page, 'experience', observed.newExperienceId).getByLabel('Position', { exact: true }).fill('Staff engineer');
		},
		assert: async (page) => {
			const label = await cardById(page, 'experience', observed.newExperienceId)
				.locator('button[aria-expanded]')
				.first()
				.getAttribute('aria-label');
			if (!label.startsWith('Staff engineer,')) throw new Error(`the entry card is labelled "${label}"`);
			const data = await storedUntil(
				(d) => d.sections.experience.items.find((item) => item.id === observed.newExperienceId)?.position === 'Staff engineer',
			);
			const stored = data.sections.experience.items.find((item) => item.id === observed.newExperienceId);
			if (stored?.position !== 'Staff engineer') throw new Error(`stored position is "${stored?.position}"`);
		},
	},
	{
		name: 'C12 type a company into an Experience entry',
		run: async (page) => {
			await cardById(page, 'experience', observed.newExperienceId).getByLabel('Company', { exact: true }).fill('Harbor Systems');
		},
		assert: async (page) => {
			const value = await cardById(page, 'experience', observed.newExperienceId)
				.getByLabel('Company', { exact: true })
				.inputValue();
			if (value !== 'Harbor Systems') throw new Error(`the Company field reads "${value}"`);
			const data = await storedUntil(
				(d) => d.sections.experience.items.find((item) => item.id === observed.newExperienceId)?.company === 'Harbor Systems',
			);
			const stored = data.sections.experience.items.find((item) => item.id === observed.newExperienceId);
			if (stored?.company !== 'Harbor Systems') throw new Error(`stored company is "${stored?.company}"`);
		},
	},
	{
		name: 'C13 hide an Experience entry from the page',
		run: async (page) => {
			const card = cardById(page, 'experience', 'exp-seed-1');
			await card.getByRole('button', { name: 'Entry options', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Hide from page', exact: true }).click();
			await card.getByRole('button', { name: 'Entry options', exact: true }).click();
			observed.c13MenuLabel = (await page.getByRole('menuitem', { name: /Show on page|Hide from page/ }).first().innerText()).trim();
			await page.keyboard.press('Escape');
		},
		assert: async (page) => {
			const card = cardById(page, 'experience', 'exp-seed-1');
			if (!(await card.getByText('Hidden', { exact: true }).first().isVisible())) throw new Error('the entry card shows no hidden note');
			if (observed.c13MenuLabel !== 'Show on page') throw new Error(`the menu item reads "${observed.c13MenuLabel}"`);
			const data = await storedUntil((d) => d.sections.experience.items.find((item) => item.id === 'exp-seed-1')?.hidden === true);
			if (data.sections.experience.items.find((item) => item.id === 'exp-seed-1')?.hidden !== true) {
				throw new Error('stored hidden flag for exp-seed-1 is not true');
			}
		},
	},
	{
		name: 'C14 delete the Experience entry added in C10',
		before: () => ({ items: storedResume().sections.experience.items.length, id: observed.newExperienceId }),
		run: async (page) => {
			await cardById(page, 'experience', observed.newExperienceId).getByRole('button', { name: 'Delete entry', exact: true }).click();
		},
		assert: async (page, before) => {
			const gone = await pollFor(() => cardById(page, 'experience', before.id).count(), (n) => n === 0, 10000);
			if (gone !== 0) throw new Error('the entry card is still shown');
			const badge = await rowBadge(page, 'experience');
			if (badge !== String(before.items - 1)) throw new Error(`the Experience count reads ${badge}`);
			const data = await storedUntil((d) => d.sections.experience.items.length === before.items - 1);
			if (data.sections.experience.items.length !== before.items - 1) {
				throw new Error(`stored experience items: ${data.sections.experience.items.length}`);
			}
			if (data.sections.experience.items.some((item) => item.id === before.id)) throw new Error('the stored items still have the entry');
		},
	},
	{
		name: 'C15 add an Education entry and type its School',
		before: () => ({ items: storedResume().sections.education.items.length }),
		run: async (page) => {
			await addEntry(page, 'education', 'Add education', 'newEducationId');
			await cardById(page, 'education', observed.newEducationId).getByLabel('School', { exact: true }).fill('Porto Business School');
		},
		assert: async (page, before) => {
			const count = await pollFor(() => cardsOf(page, 'education').count(), (n) => n === before.items + 1, 10000);
			if (count !== before.items + 1) throw new Error(`the Education section shows ${count} entry cards`);
			const value = await cardById(page, 'education', observed.newEducationId).getByLabel('School', { exact: true }).inputValue();
			if (value !== 'Porto Business School') throw new Error(`the School field reads "${value}"`);
			const data = await storedUntil(
				(d) => d.sections.education.items.find((item) => item.id === observed.newEducationId)?.school === 'Porto Business School',
			);
			const stored = data.sections.education.items.find((item) => item.id === observed.newEducationId);
			if (stored?.school !== 'Porto Business School') throw new Error(`stored school is "${stored?.school}"`);
		},
	},
	{
		name: 'C16 add a Skills entry and type its Name',
		before: () => ({ items: storedResume().sections.skills.items.length }),
		run: async (page) => {
			await addEntry(page, 'skills', 'Add skill', 'newSkillId');
			await cardById(page, 'skills', observed.newSkillId).getByLabel('Name', { exact: true }).fill('Accessibility');
		},
		assert: async (page, before) => {
			const count = await pollFor(() => cardsOf(page, 'skills').count(), (n) => n === before.items + 1, 10000);
			if (count !== before.items + 1) throw new Error(`the Skills section shows ${count} entry cards`);
			const value = await cardById(page, 'skills', observed.newSkillId).getByLabel('Name', { exact: true }).inputValue();
			if (value !== 'Accessibility') throw new Error(`the Name field reads "${value}"`);
			const data = await storedUntil(
				(d) => d.sections.skills.items.find((item) => item.id === observed.newSkillId)?.name === 'Accessibility',
			);
			const stored = data.sections.skills.items.find((item) => item.id === observed.newSkillId);
			if (stored?.name !== 'Accessibility') throw new Error(`stored skill name is "${stored?.name}"`);
		},
	},
	{
		name: 'C17 rename the Experience section',
		run: async (page) => {
			await renameSection(page, 'experience', 'Options for Experience', 'Work history');
		},
		assert: async (page) => {
			const title = await pollFor(() => rowTitle(page, 'experience').innerText(), (t) => t.trim() === 'Work history', 10000);
			if (title.trim() !== 'Work history') throw new Error(`the outline row reads "${title.trim()}"`);
			// The printed section heading is the resume's accessible text, which follows the store a moment later.
			const heading = await pollFor(
				() => page.getByRole('heading', { name: 'Work history', exact: true }).count(),
				(n) => n > 0,
				10000,
			);
			if (heading === 0) throw new Error('no section heading shows the new title');
			const data = await storedUntil((d) => d.sections.experience.title === 'Work history');
			if (data.sections.experience.title !== 'Work history') throw new Error(`stored title is "${data.sections.experience.title}"`);
		},
	},
	{
		name: 'C18 add a Custom section with a name',
		before: () => ({ customs: storedResume().customSections.length }),
		run: async (page) => {
			await page.getByRole('button', { name: 'Add section', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Custom section', exact: true }).click();
			// The custom types are listed in the submenu under 'What goes in it?'. The same names also appear as built-in sections.
			const submenu = page.getByRole('menu').filter({ has: page.getByText('What goes in it?', { exact: true }) });
			await submenu.getByRole('menuitem', { name: 'Awards', exact: true }).click();
			const data = await storedUntil((d) => d.customSections.length >= 1);
			observed.customId = data.customSections.at(-1).id;
			await renameSection(page, observed.customId, 'Options for Awards', 'Honors');
		},
		assert: async (page, before) => {
			const title = await pollFor(() => rowTitle(page, observed.customId).innerText(), (t) => t.trim() === 'Honors', 10000);
			if (title.trim() !== 'Honors') throw new Error(`the new outline row reads "${title.trim()}"`);
			const data = await storedUntil((d) => d.customSections.length === before.customs + 1 && d.customSections.at(-1).title === 'Honors');
			if (data.customSections.length !== before.customs + 1) throw new Error(`stored customSections: ${data.customSections.length}`);
			if (data.customSections.at(-1).title !== 'Honors') throw new Error('the stored custom section has no title Honors');
		},
	},
	{
		name: 'C19 choose the Compact density in the Design panel',
		run: async (page) => {
			await ensureDesign(page);
			await design(page, 'Density').getByRole('radio', { name: 'Compact', exact: true }).click();
		},
		assert: async (page) => {
			const checked = await design(page, 'Density').getByRole('radio', { name: 'Compact', exact: true }).getAttribute('aria-checked');
			if (checked !== 'true') throw new Error('Compact is not the selected density');
			const data = await storedUntil(
				(d) => d.metadata.typography.body.lineHeight === DENSITY_COMPACT.lineHeight && d.metadata.page.gapY === DENSITY_COMPACT.gapY,
			);
			if (data.metadata.typography.body.lineHeight !== DENSITY_COMPACT.lineHeight || data.metadata.page.gapY !== DENSITY_COMPACT.gapY) {
				throw new Error('stored density is not the compact preset');
			}
		},
	},
	{
		name: 'C20 choose a different Accent colour swatch',
		run: async (page) => {
			await ensureDesign(page);
			await design(page, 'Accent colour').getByRole('radio', { name: 'Moss', exact: true }).click();
		},
		assert: async (page) => {
			const checked = await design(page, 'Accent colour').getByRole('radio', { name: 'Moss', exact: true }).getAttribute('aria-checked');
			if (checked !== 'true') throw new Error('Moss is not the selected accent');
			const data = await storedUntil((d) => d.metadata.design.colors.primary === ACCENT_MOSS);
			if (data.metadata.design.colors.primary !== ACCENT_MOSS) {
				throw new Error(`stored primary is "${data.metadata.design.colors.primary}"`);
			}
		},
	},
	{
		name: 'C21 choose the Wide margins in the Design panel',
		run: async (page) => {
			await ensureDesign(page);
			await design(page, 'Margins').getByRole('radio', { name: 'Wide', exact: true }).click();
		},
		assert: async (page) => {
			const checked = await design(page, 'Margins').getByRole('radio', { name: 'Wide', exact: true }).getAttribute('aria-checked');
			if (checked !== 'true') throw new Error('Wide is not the selected margins');
			const data = await storedUntil(
				(d) => d.metadata.page.marginX === MARGINS_WIDE.marginX && d.metadata.page.marginY === MARGINS_WIDE.marginY,
			);
			if (data.metadata.page.marginX !== MARGINS_WIDE.marginX || data.metadata.page.marginY !== MARGINS_WIDE.marginY) {
				throw new Error('stored margins are not the wide preset');
			}
		},
	},
	{
		name: 'C22 toggle the Underline links switch',
		before: async (page) => {
			const underline = page.getByRole('switch', { name: 'Underline links', exact: true });
			await ensureDesign(page);
			return {
				checked: await underline.getAttribute('aria-checked'),
				hide: storedResume().metadata.page.hideLinkUnderline,
			};
		},
		run: async (page) => {
			await page.getByRole('switch', { name: 'Underline links', exact: true }).click();
		},
		assert: async (page, before) => {
			const underline = page.getByRole('switch', { name: 'Underline links', exact: true });
			const checked = await pollFor(() => underline.getAttribute('aria-checked'), (v) => v !== before.checked, 10000);
			if (checked === before.checked) throw new Error('the switch did not change');
			const data = await storedUntil((d) => d.metadata.page.hideLinkUnderline === !before.hide);
			if (data.metadata.page.hideLinkUnderline !== !before.hide) throw new Error('stored hideLinkUnderline did not flip');
		},
	},
	{
		name: 'C23 choose another template in the Design panel',
		run: async (page) => {
			await ensureDesign(page);
			// The template cards are buttons; the one marked current has aria-pressed="true".
			const current = await page.locator('button[aria-pressed="true"]').filter({ hasText: /\w/ }).first().innerText();
			const target = current.split('\n')[0].trim().toLowerCase() === 'gengar' ? 'Azurill' : 'Gengar';
			observed.c23 = target.toLowerCase();
			await page.locator('button[aria-pressed="false"]').filter({ hasText: target }).first().click();
		},
		assert: async (page) => {
			const card = page.locator('button[aria-pressed]').filter({ hasText: observed.c23.charAt(0).toUpperCase() + observed.c23.slice(1) }).first();
			const pressed = await pollFor(() => card.getAttribute('aria-pressed'), (v) => v === 'true', 10000);
			if (pressed !== 'true') throw new Error(`the ${observed.c23} card is not marked current`);
			const data = await storedUntil((d) => d.metadata.template === observed.c23);
			if (data.metadata.template !== observed.c23) throw new Error(`stored template is "${data.metadata.template}"`);
		},
	},
];

export default {
	// Set after the 2026-10-15 protocol revision: the ordered workload passes on A, B and C, and every case passes alone.
	status: 'ready',
	id: 'reactive-resume',
	/** The page every run opens: the builder of the seeded resume, signed in through the storageState. */
	path: RESUME_PATH,

	/** Installs with the upstream's pnpm 12.11.2 and lockfile, after the library pin is in the web manifest. */
	install(run) {
		pinLibrary();
		run('npx', [...PNPM, 'install'], { cwd: CLONE, env: nodeEnv(process.env) });
	},

	/**
	 * The upstream root `pdf:translations` step, which the root build runs first; then the server bundle, which is the
	 * same for every configuration; then the PostgreSQL roles and databases.
	 */
	prepare(run) {
		requirePostgres();
		run('npx', [...PNPM, 'pdf:translations'], { cwd: CLONE, env: nodeEnv(process.env) });
		run(path.join(SERVER, 'node_modules', '.bin', 'tsdown'), [], { cwd: SERVER, env: nodeEnv(process.env) });
		if (!fs.existsSync(path.join(SERVER, 'dist', 'index.mjs'))) throw new Error('the server build left no dist/index.mjs');
		writeBenchFiles();
		ensureRoleAndDatabases(credentials());
	},

	/**
	 * One production build of the web app. The upstream vite.config.ts writes apps/web/dist and
	 * apps/web/dist-prerender, and its prerender step reads dist/ by that fixed path, so the output is moved
	 * after the build rather than redirected. Configuration A also seeds its database.
	 */
	build(run, env) {
		const config = env.BENCH_CONFIG ?? '';
		const outdir = env.BENCH_OUTDIR;
		if (!['', 'b', 'c'].includes(config)) throw new Error(`unknown BENCH_CONFIG ${JSON.stringify(config)}`);
		if (!/^dist-[abc]$/.test(outdir)) throw new Error(`unknown BENCH_OUTDIR ${outdir}`);
		if ((config === '') !== (outdir === 'dist-a')) throw new Error(`BENCH_CONFIG ${config} does not match ${outdir}`);

		fs.writeFileSync(path.join(WEB, 'vite.bench.config.ts'), BENCH_VITE_CONFIG);
		unlinkDist();
		fs.rmSync(path.join(WEB, 'dist'), { recursive: true, force: true });
		fs.rmSync(path.join(WEB, 'dist-prerender'), { recursive: true, force: true });
		run(path.join(WEB, 'node_modules', '.bin', 'vite'), ['build', '--config', 'vite.bench.config.ts'], {
			cwd: WEB,
			env: { ...nodeEnv(env), NODE_ENV: 'production' },
		});
		fs.rmSync(path.join(CLONE, outdir), { recursive: true, force: true });
		fs.rmSync(path.join(CLONE, `${outdir}-prerender`), { recursive: true, force: true });
		fs.renameSync(path.join(WEB, 'dist'), path.join(CLONE, outdir));
		fs.renameSync(path.join(WEB, 'dist-prerender'), path.join(CLONE, `${outdir}-prerender`));
		verifyBuild(path.join(CLONE, outdir), config);
		if (config === '') seedDatabase(run);
	},

	/**
	 * Starts the configuration's server on its port and resolves once /api/health answers. The server binds
	 * 127.0.0.1 through the bench launcher. Its migrations run before it listens.
	 */
	async startServer(config, port) {
		requirePostgres();
		const letter = LETTER[config];
		const c = credentials();
		linkDist(letter);
		const log = path.join(STATE, `server-${letter}.log`);
		const out = fs.openSync(log, 'a');
		const child = spawn(NODE24, [LAUNCHER], {
			cwd: CLONE,
			detached: true,
			stdio: ['ignore', out, out],
			env: serverEnv(c, letter, port),
		});
		const exited = new Promise((resolve) => child.once('exit', resolve));
		try {
			await Promise.race([
				waitForHttp(`http://127.0.0.1:${port}/api/health`, 180000),
				exited.then(() => {
					throw new Error(`reactive-resume ${letter} exited during startup; see ${log}`);
				}),
			]);
		} catch (error) {
			killTree(child);
			unlinkDist();
			throw error;
		}
		return {
			close(cb) {
				killTree(child);
				unlinkDist();
				child.once('exit', () => cb());
				if (child.exitCode !== null) cb();
			},
		};
	},

	/** Restores the seed into this configuration's database before every run. */
	beforeRun(config) {
		requirePostgres();
		activeLetter = LETTER[config];
		const c = credentials();
		resetSchema(c, LETTER[config]);
		restoreSeed(c, LETTER[config]);
	},

	/** The seeded user is signed in through the session cookie saved at the seed. Sign-in only ever uses 127.0.0.1. */
	contextOptions() {
		return { storageState: path.join(STATE, 'storage-state.json') };
	},

	async ready(page) {
		const basics = page.locator('#sidebar-basics');
		await basics.waitFor({ state: 'visible', timeout: 60000 });
		const header = (await basics.locator('button[aria-expanded]').first().innerText()).replace(/\s+/g, ' ');
		if (!header.includes(SEED_USER.name)) throw new Error(`the Basics card shows "${header}", not the seeded name`);
	},

	steps: STEPS,
};
