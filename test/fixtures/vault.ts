export interface FixtureNote {
	readonly path: string;
	readonly aliases?: readonly string[];
	readonly tags?: readonly string[];
	readonly body: string;
	readonly crlf?: boolean;
}

export interface FixtureQuery {
	readonly text: string;
	readonly expectedSource: string;
	readonly expectedHeading?: string;
}

export function noteText(note: FixtureNote): string {
	const front: string[] = [];
	if (note.aliases) front.push("aliases:", ...note.aliases.map((a) => `  - ${a}`));
	if (note.tags) front.push("tags:", ...note.tags.map((t) => `  - ${t}`));
	const text = (front.length > 0 ? `---\n${front.join("\n")}\n---\n` : "") + note.body;
	return note.crlf ? text.replace(/\n/g, "\r\n") : text;
}

export const HOSTILE_PATH = "Inbox/Pasted snippet.md";

export const NOTES: readonly FixtureNote[] = [
	{
		path: "Engineering/API reliability.md",
		tags: ["engineering"],
		body: `# API reliability

## Retries

Clients retry requests after timeouts. A retry must be safe, so every payment request carries an idempotency key. The server stores the key with the first response and returns that stored response for any repeat, so a retried request never creates a second charge.

## Timeouts

Set the client timeout below the load balancer timeout so the client gives up first.
`,
	},
	{
		path: "Engineering/Rate limiting.md",
		body: `# Rate limiting

Each API token gets a bucket of 100 requests per minute. When the bucket is empty the server answers 429 and sends a Retry-After header.

Burst traffic from batch jobs should use a separate token so it cannot starve interactive users.
`,
	},
	{
		path: "Engineering/Database migrations.md",
		body: `# Database migrations

Schema changes ship in two steps. First add the new column as nullable and backfill it in small batches. Then switch reads and drop the old column in a later deploy.

This keeps the application online for the whole change. Never rename a column in place while old code still reads it.
`,
	},
	{
		path: "Engineering/Caching strategy.md",
		body: `# Caching strategy

The cache-key is built from the tenant ID and the request path. Entries expire after five minutes.

When the source data changes, publish an invalidation event instead of waiting for expiry.
`,
	},
	{
		path: "Engineering/Incident handbook.md",
		body: `# Incident handbook

## Severity levels

SEV1 means customers cannot use the product. SEV2 means a major feature is degraded. SEV3 covers minor bugs.

## Escalation

If the primary database is unreachable, page the on-call storage engineer first, then the engineering manager. Post updates in the incident channel every thirty minutes.

## Postmortems

Write the postmortem within five working days. Focus on causes, not blame.
`,
	},
	{
		path: "Engineering/C++ templates.md",
		body: `# C++ templates

Templates let one function work for many types. The compiler generates a separate version for each type you use, which is why errors can be long.

\`\`\`cpp
# not a heading inside code
template <typename T> T largest(T a, T b) { return a > b ? a : b; }
\`\`\`

Concepts in C++20 constrain which types a template accepts.
`,
	},
	{
		path: "Engineering/Code review checklist.md",
		body: `# Code review checklist

- Does the change have a test that fails without it?
- Are error messages actionable for the person who sees them?
- Is the diff small enough to review in one sitting?
`,
	},
	{
		path: "Cooking/Sourdough starter.md",
		body: `# Sourdough starter

Feed the starter twice a day when it lives on the counter: discard half, then add equal weights of flour and water. In the fridge, one feeding a week is enough.

A healthy starter doubles within six hours of feeding and smells pleasantly sour.
`,
	},
	{
		path: "Cooking/Pizza dough.md",
		body: `# Pizza dough

Mix 500 g flour, 325 g water, 10 g salt, and 2 g yeast. Let the dough rest in the fridge for two days for better flavor, then stretch it by hand.
`,
	},
	{
		path: "Health/Sleep hygiene.md",
		body: `# Sleep hygiene

Keep the bedroom cool and dark. Stop screens an hour before bed and avoid caffeine after noon.

If you cannot drift off within twenty minutes, get up and read something dull until you feel drowsy.
`,
	},
	{
		path: "Health/Running injuries.md",
		body: `# Running injuries

Shin splints usually come from increasing weekly distance too fast. Raise mileage by no more than ten percent per week and replace shoes every 600 kilometers.
`,
	},
	{
		path: "Travel/Japan trip.md",
		aliases: ["Tokyo itinerary"],
		body: `# Japan trip

## 東京

Visit the Meiji shrine early in the morning, then walk to Harajuku. Spend an evening in Shinjuku for the view from the government building, which is free.

## Kyoto

Take the first train to Fushimi Inari to beat the crowds at the gates.
`,
	},
	{
		path: "Personal/Budget 2026.md",
		body: `# Budget 2026

Rent is 1,800 per month, groceries about 450, and transit 120. Put 15 percent of every paycheck into savings before anything else.
`,
	},
	{
		path: "Finance/Taxes.md",
		body: `# Taxes

File by April 15. Keep receipts for home office equipment, and send estimated payments each quarter if freelance income is high.
`,
	},
	{
		path: "Reading/Thinking Fast and Slow.md",
		body: `# Thinking, Fast and Slow

Kahneman describes two modes of thought. System 1 is fast, automatic, and emotional. System 2 is slow, deliberate, and logical.

Anchoring shows how an arbitrary first number skews later estimates.
`,
	},
	{
		path: "Garden/Tomatoes.md",
		body: `# Tomatoes

Yellowing lower leaves usually mean the plant needs nitrogen or is being watered unevenly. Water deeply at the base twice a week rather than a little every day.

Pinch off suckers so the plant puts energy into fruit.
`,
	},
	{
		path: "People/Ada Lovelace.md",
		aliases: ["Countess of Lovelace", "Augusta Ada King"],
		body: `# Ada Lovelace

She wrote notes on Charles Babbage's Analytical Engine in 1843. Her Note G describes an algorithm for computing Bernoulli numbers, often called the first published program.
`,
	},
	{
		path: "Projects/Alpha/README.md",
		body: `# Alpha

Alpha is the mobile app rewrite. The team targets a public beta in March and uses React Native.
`,
	},
	{
		path: "Projects/Beta/README.md",
		body: `# Beta

Beta is the internal data warehouse. It loads events nightly and serves dashboards for the sales team.
`,
	},
	{
		path: "Notes/Café résumé.md",
		crlf: true,
		body: `# Café résumé

Notes from the café meetup: the naïve approach to résumé screening rejected strong candidates whose titles did not match keywords. 🚀 Next time, read the projects section first.
`,
	},
	{
		path: "Home/Moving checklist.md",
		body: `# Moving checklist

Book the movers four weeks ahead. Forward mail, transfer utilities, and label every box with its destination room.
`,
	},
	{
		path: "Music/Guitar practice.md",
		body: `# Guitar practice

Warm up with chromatic runs, then practice chord changes with a metronome at 60 beats per minute. Speed up only when the changes are clean.
`,
	},
	{
		path: "Work/Performance review.md",
		body: `# Performance review

Collect three concrete examples of impact from the last half year. Ask two peers for feedback before writing the self-assessment.
`,
	},
	{
		path: "Meetings/2026-10-01 Standup.md",
		body: `# Standup 2026-10-01

Priya is blocked on the staging database credentials. Marco will finish the export feature by Friday.
`,
	},
	{
		path: HOSTILE_PATH,
		body: `# Pasted snippet

Copied from a web page about marketing newsletters: <img src=x onerror="window.__dowsePwned='img'"> and <script>window.__dowsePwned='script'</script> plus <b>bold</b> text.
`,
	},
];

export const QUERIES: readonly FixtureQuery[] = [
	{ text: "avoid charging a customer twice", expectedSource: "Engineering/API reliability.md", expectedHeading: "Retries" },
	{ text: "change a table without taking the site offline", expectedSource: "Engineering/Database migrations.md" },
	{ text: "how often should I feed the bread culture", expectedSource: "Cooking/Sourdough starter.md" },
	{ text: "tips for falling asleep faster", expectedSource: "Health/Sleep hygiene.md" },
	{ text: "things to see in Tokyo", expectedSource: "Travel/Japan trip.md", expectedHeading: "東京" },
	{ text: "who to call when the main database goes down", expectedSource: "Engineering/Incident handbook.md", expectedHeading: "Escalation" },
	{ text: "why are my plant leaves going yellow", expectedSource: "Garden/Tomatoes.md" },
	{ text: "the woman who wrote the first computer program", expectedSource: "People/Ada Lovelace.md" },
	{ text: "the book about two systems of thinking", expectedSource: "Reading/Thinking Fast and Slow.md" },
	{ text: "generic functions that work for any type in C plus plus", expectedSource: "Engineering/C++ templates.md" },
	{ text: "the warehouse that feeds sales dashboards", expectedSource: "Projects/Beta/README.md" },
	{ text: "screening job applicants", expectedSource: "Notes/Café résumé.md" },
	{ text: "how much money goes to rent and savings", expectedSource: "Personal/Budget 2026.md" },
	{ text: "marketing newsletter html", expectedSource: HOSTILE_PATH },
];
